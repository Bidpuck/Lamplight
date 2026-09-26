// Lamplight — the player. Owns the one <audio> element, the position in the book,
// the read-ahead cache, the lock-screen controls and saving progress. Nothing else
// in the app touches audio. The reader screen subscribes with Player.on(fn) and is
// told about every change: 'position', 'state', 'chapter', 'tick', 'visible'.
//
// A clip is one sentence (Kokoro, in-browser Piper) or one whole paragraph (Piper
// on a voice server). Either way the position advances per sentence: a paragraph
// clip carries where each of its sentences starts, and timeupdate moves the mark.

const NORMAL_LOOKAHEAD = 6;            // sentence clips prepared ahead during normal playback
const BACKGROUND_BURST_LOOKAHEAD = 40; // ...and the one-time burst when the screen goes dark
const NORMAL_PARAGRAPH_LOOKAHEAD = 2;
const BACKGROUND_BURST_PARAGRAPH_LOOKAHEAD = 8;

const Player = {
  chapters: [],
  ch: 0, s: 0,
  state: 'idle',            // 'idle' | 'preparing' | 'playing'
  skipUnit: settingGet('skipUnit', 'sentence'), // what the skip buttons move: 'sentence' | 'paragraph'
  finished: false,
  book: null,               // {progressKey, id, title, author, artworkUrl}
  listeners: [],
  audio: null,
  token: 0,
  cache: new Map(),         // clip key -> Promise<Blob>
  clip: null,               // {first, last, offsets, blob} for the clip now loaded
  secPerChar: parseFloat(settingGet('secPerChar', '')) || 0.075, // seconds of speech per character at 1.0×
  lastSummarySave: 0,

  on(fn){ this.listeners.push(fn); },
  emit(type, detail){ this.listeners.forEach(fn => { try{ fn(type, detail); } catch(e){ console.error(e); } }); },

  init(){
    this.audio = el('ttsAudio');
    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    if('mediaSession' in navigator){
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    }
    // Locking the screen doesn't stop the <audio> element, but it throttles the work
    // needed to generate what comes next. So the moment the page hides, prepare a big
    // run of clips while it still can. Coming back, tell the reader to catch up.
    document.addEventListener('visibilitychange', () => {
      if(document.hidden){
        if(this.state !== 'idle' && this.chapters.length) this.prefetch(true);
        this.saveSummary(true);
      } else {
        this.emit('visible');
      }
    });
    window.addEventListener('beforeunload', () => { this.stopAudio(); this.saveSummary(true); });
    window.addEventListener('pagehide', () => this.saveSummary(true));
  },

  // ---------------- Loading a book ----------------
  load(chapters, book, pos){
    this.stopAudio();
    this.chapters = chapters;
    this.book = book;
    this.cache.clear();
    this.finished = false;
    this.state = 'idle';
    // Character counts drive the time estimates for the scrubber and the library card.
    let bookChars = 0;
    chapters.forEach(ch => {
      ch.charBefore = [];
      let acc = 0;
      ch.sentences.forEach(t => { ch.charBefore.push(acc); acc += t.length; });
      ch.charTotal = acc;
      ch.bookCharBefore = bookChars;
      bookChars += acc;
    });
    this.bookChars = bookChars;
    this.ch = pos && chapters[pos.chapter] ? pos.chapter : 0;
    this.s = pos && chapters[this.ch].sentences[pos.sentence] ? pos.sentence : 0;
    this.updateMetadata();
    this.emit('chapter'); this.emit('position'); this.emit('state');
  },
  unload(){
    this.stopAudio();
    this.saveSummary(true);
    this.chapters = []; this.book = null; this.cache.clear(); this.state = 'idle';
    this.emit('state');
  },

  // ---------------- Position ----------------
  chapter(){ return this.chapters[this.ch]; },
  sentenceText(){ const ch = this.chapter(); return ch ? ch.sentences[this.s] : ''; },
  paragraphOf(chIdx, sIdx){ const ch = this.chapters[chIdx]; return ch ? ch.sentenceParagraph[sIdx] : 0; },
  secPerCharNow(){ return this.secPerChar / (Voice.settings.speed || 1); },

  // Where we are, in seconds, for the chapter bar and the library card.
  positionInfo(){
    const ch = this.chapter();
    if(!ch) return { chapterElapsed: 0, chapterTotal: 0, bookFraction: 0, bookSecLeft: 0 };
    const spc = this.secPerCharNow();
    let within = 0;
    if(this.clip && this.state === 'playing' && this.audio){
      const k = this.s - this.clip.first;
      const start = this.clip.offsets[k] || 0;
      within = Math.max(0, this.audio.currentTime - start);
      within = Math.min(within, (ch.sentences[this.s] || '').length * spc);
    }
    const charsDone = this.finished ? ch.charTotal : ch.charBefore[this.s] || 0;
    const chapterElapsed = charsDone * spc + within;
    const chapterTotal = ch.charTotal * spc;
    const bookDone = this.finished ? this.bookChars : ch.bookCharBefore + charsDone;
    return {
      chapterElapsed, chapterTotal,
      bookFraction: this.bookChars ? bookDone / this.bookChars : 0,
      bookSecLeft: (this.bookChars - bookDone) * spc
    };
  },

  setPosition(chIdx, sIdx, opts){
    opts = opts || {};
    const chapterChanged = chIdx !== this.ch;
    this.ch = chIdx; this.s = sIdx; this.finished = false;
    this.saveProgress();
    if(chapterChanged){ this.updateMetadata(); this.emit('chapter'); }
    this.emit('position', opts);
  },

  // Jump anywhere. Playback continues from there if it was playing.
  seek(chIdx, sIdx){
    const ch = this.chapters[chIdx];
    if(!ch) return;
    sIdx = Math.max(0, Math.min(ch.sentences.length - 1, sIdx));
    const wasPlaying = this.state !== 'idle';
    this.stopAudio();
    this.setPosition(chIdx, sIdx, { jump: true });
    if(wasPlaying) this.speakCurrent();
  },
  seekChapterFraction(fraction){
    const ch = this.chapter(); if(!ch) return;
    const target = fraction * ch.charTotal;
    let s = 0;
    while(s + 1 < ch.sentences.length && ch.charBefore[s + 1] <= target) s++;
    this.seek(this.ch, s);
  },
  next(){ this.step(1); },
  prev(){ this.step(-1); },
  step(dir){
    const ch = this.chapter(); if(!ch) return;
    let c = this.ch, s = this.s;
    if(this.skipUnit === 'paragraph'){
      const p = ch.sentenceParagraph[s];
      if(dir > 0){
        if(ch.paragraphs[p + 1]) s = ch.paragraphs[p + 1].sentenceIndices[0];
        else if(this.chapters[c + 1]){ c++; s = 0; }
      } else {
        const atStart = s === ch.paragraphs[p].sentenceIndices[0];
        if(atStart && p > 0) s = ch.paragraphs[p - 1].sentenceIndices[0];
        else if(atStart && c > 0){ c--; s = this.chapters[c].paragraphs.slice(-1)[0].sentenceIndices[0]; }
        else s = ch.paragraphs[p].sentenceIndices[0];
      }
    } else {
      s += dir;
      if(s >= ch.sentences.length){ if(this.chapters[c + 1]){ c++; s = 0; } else s = ch.sentences.length - 1; }
      if(s < 0){ if(c > 0){ c--; s = this.chapters[c].sentences.length - 1; } else s = 0; }
    }
    this.seek(c, s);
  },
  setSkipUnit(unit){ this.skipUnit = unit; settingSet('skipUnit', unit); },

  // ---------------- Play / pause ----------------
  play(){
    if(!this.chapters.length || this.state !== 'idle') return;
    if(this.finished){ this.finished = false; this.ch = 0; this.s = 0; this.emit('chapter'); this.emit('position'); }
    this.speakCurrent();
  },
  pause(){
    if(this.state === 'idle') return;
    this.stopAudio();
    this.setState('idle');
    this.saveProgress();
    this.saveSummary(true);
  },
  toggle(){ if(this.state === 'idle') this.play(); else this.pause(); },
  setState(state){
    if(this.state === state) return;
    this.state = state;
    if('mediaSession' in navigator) navigator.mediaSession.playbackState = state === 'idle' ? 'paused' : 'playing';
    this.emit('state');
  },
  stopAudio(){
    this.token++;
    this.clip = null;
    if(this.audio){ this.audio.onended = null; this.audio.pause(); }
  },

  // Everything generated so far assumed the old voice/speed/filter — drop it.
  clearAudio(){
    const wasPlaying = this.state !== 'idle';
    this.stopAudio();
    this.cache.clear();
    if(wasPlaying) this.speakCurrent();
  },

  // ---------------- The clip loop ----------------
  // The unit of audio that covers sentence `s` of chapter `c`.
  unitFor(c, s){
    const ch = this.chapters[c];
    if(Voice.batchesParagraphs()){
      const p = ch.sentenceParagraph[s];
      const idx = ch.paragraphs[p].sentenceIndices;
      return { key: 'para-' + c + '-' + p, c, first: idx[0], last: idx[idx.length - 1] };
    }
    return { key: c + '-' + s, c, first: s, last: s };
  },
  unitAfter(unit){
    const ch = this.chapters[unit.c];
    if(unit.last + 1 < ch.sentences.length) return this.unitFor(unit.c, unit.last + 1);
    for(let c = unit.c + 1; c < this.chapters.length; c++){
      if(this.chapters[c].sentences.length) return this.unitFor(c, 0);
    }
    return null;
  },
  getAudio(unit){
    if(!this.cache.has(unit.key)){
      const ch = this.chapters[unit.c];
      const sentences = [];
      for(let i = unit.first; i <= unit.last; i++) sentences.push(speechFilteredText(ch.sentences[i]) || ' ');
      const chars = sentences.reduce((a, t) => a + t.length, 0);
      const promise = Voice.generate(sentences).then(blob => {
        // Learn how fast this voice actually reads, so the time estimates fit it.
        if(blob.durationSec && chars > 40){
          const observed = blob.durationSec * (Voice.settings.speed || 1) / chars;
          this.secPerChar = this.secPerChar * 0.8 + observed * 0.2;
          settingSet('secPerChar', this.secPerChar.toFixed(4));
        }
        return blob;
      });
      promise.catch(() => this.cache.delete(unit.key)); // a failure isn't worth remembering
      this.cache.set(unit.key, promise);
    }
    return this.cache.get(unit.key);
  },
  prefetch(burst){
    const paragraphs = Voice.batchesParagraphs();
    let count = paragraphs ? (burst ? BACKGROUND_BURST_PARAGRAPH_LOOKAHEAD : NORMAL_PARAGRAPH_LOOKAHEAD)
                           : (burst ? BACKGROUND_BURST_LOOKAHEAD : NORMAL_LOOKAHEAD);
    let unit = this.unitFor(this.ch, this.s);
    while(count-- > 0){
      unit = this.unitAfter(unit);
      if(!unit) break;
      this.getAudio(unit).catch(() => {});
    }
  },

  async speakCurrent(){
    const myToken = ++this.token;
    const ch = this.chapter();
    if(!ch || this.s >= ch.sentences.length){
      // Chapter finished: on to the next, or the book is done.
      if(this.ch < this.chapters.length - 1){ this.setPosition(this.ch + 1, 0); this.speakCurrent(); }
      else { this.finished = true; this.s = ch ? ch.sentences.length - 1 : 0; this.setState('idle'); this.saveProgress(); this.saveSummary(true); this.emit('position'); this.emit('finished'); }
      return;
    }
    this.setState('preparing');
    const ready = await Voice.ensureReady();
    if(myToken !== this.token) return;
    if(!ready){ this.setState('idle'); return; }

    const unit = this.unitFor(this.ch, this.s);
    setEngineStatus('Generating…');
    let blob;
    try{ blob = await this.getAudio(unit); }
    catch(err){
      console.error(err);
      if(myToken !== this.token) return;
      setEngineStatus('Voice generation failed (' + (err && err.message ? err.message : 'unknown error') + ') — skipping.');
      const nextUnit = this.unitAfter(unit);
      if(nextUnit){ this.setPosition(nextUnit.c, nextUnit.first); this.speakCurrent(); }
      else this.setState('idle');
      return;
    }
    if(myToken !== this.token || !blob) return;
    setEngineStatus('');

    const audio = this.audio;
    if(audio.dataset.blobUrl) URL.revokeObjectURL(audio.dataset.blobUrl);
    const url = URL.createObjectURL(blob);
    audio.src = url;
    audio.dataset.blobUrl = url;
    const offsets = blob.sentenceOffsets && blob.sentenceOffsets.length === (unit.last - unit.first + 1) ? blob.sentenceOffsets : [0];
    this.clip = { first: unit.first, last: unit.last, offsets, estimated: !!blob.offsetsEstimated };

    // Resume inside a paragraph clip at the sentence we're on, not its start.
    const startAt = offsets[this.s - unit.first] || 0;
    if(startAt > 0.05){
      const seekIn = () => { try{ audio.currentTime = startAt; } catch(e){ /* not seekable yet */ } };
      if(audio.readyState >= 1) seekIn(); else audio.addEventListener('loadedmetadata', seekIn, { once: true });
    }

    const lastText = ch.sentences[unit.last];
    audio.onended = () => {
      if(myToken !== this.token) return;
      this.clip = null;
      const nextUnit = this.unitAfter(unit);
      if(!nextUnit){ this.s = ch.sentences.length; this.speakCurrent(); return; }
      this.setPosition(nextUnit.c, nextUnit.first);
      // A closing quote with nothing after it is a natural end-of-exchange beat.
      const extraPause = endsQuotedDialogue(lastText) ? DIALOGUE_END_PAUSE_MS : 0;
      if(extraPause) setTimeout(() => { if(myToken === this.token) this.speakCurrent(); }, extraPause);
      else this.speakCurrent();
    };
    this.setState('playing');
    this.emit('position');
    audio.play().catch(err => { console.error(err); setEngineStatus('Playback was blocked: ' + err.message); this.setState('idle'); });
    this.prefetch(false);
  },

  onTimeUpdate(){
    if(this.state !== 'playing' || !this.clip) return;
    const t = this.audio.currentTime + 0.08; // the mark leads the voice by a hair, which reads as "in time"
    const offs = this.clip.offsets;
    let k = 0;
    while(k + 1 < offs.length && offs[k + 1] <= t) k++;
    const s = this.clip.first + k;
    if(s !== this.s && s <= this.clip.last){
      this.s = s;
      this.saveProgress();
      this.emit('position');
    }
    this.emit('tick');
    this.saveSummary(false);
  },

  // ---------------- Saving ----------------
  saveProgress(){
    if(!this.book) return;
    saveProgressFor(this.book.progressKey, { chapter: this.ch, sentence: this.s });
  },
  // The library card's summary (percent, time left) is written at most every few
  // seconds, and always when asked to force it (pause, hide, unload).
  saveSummary(force){
    if(!this.book || !this.book.id) return;
    const now = Date.now();
    if(!force && now - this.lastSummarySave < 8000) return;
    this.lastSummarySave = now;
    const info = this.positionInfo();
    const ch = this.chapter();
    updateLibraryBook(this.book.id, { progress: {
      chapter: this.ch, sentence: this.s, chapterTitle: ch ? ch.title : '',
      fraction: this.finished ? 1 : info.bookFraction, secLeft: this.finished ? 0 : info.bookSecLeft,
      finished: this.finished, at: now
    }});
  },

  // ---------------- Lock screen ----------------
  updateMetadata(){
    if(!('mediaSession' in navigator) || !this.book) return;
    const ch = this.chapter();
    const meta = { title: ch ? ch.title : 'Reading', artist: this.book.title || 'Lamplight Reader', album: 'Lamplight Reader' };
    if(this.book.artworkUrl) meta.artwork = [{ src: this.book.artworkUrl, sizes: '512x512', type: this.book.artworkType || 'image/jpeg' }];
    try{ navigator.mediaSession.metadata = new MediaMetadata(meta); } catch(e){ /* ignore */ }
  }
};
