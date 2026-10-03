// Lamplight — the player. Owns the one <audio> element, the position in the book,
// the read-ahead cache, the lock-screen controls and saving progress. Nothing else
// in the app touches audio. The reader screen subscribes with Player.on(fn) and is
// told about every change: 'position', 'state', 'chapter', 'tick', 'visible'.
//
// A clip is one sentence (Kokoro, in-browser Piper) or one whole paragraph (Piper
// on a voice server). Either way the position advances per sentence: a paragraph
// clip carries where each of its sentences starts, and timeupdate moves the mark.
//
// iPhone is strict about audio a page starts by itself. An <audio> element may only
// play once it has been started inside a tap, and a page whose audio falls quiet in
// the background can be suspended and refused the next clip. So a tap on Play starts
// the element at once, on silence, and the silence keeps looping whenever the next
// clip isn't ready yet; a clip that is refused anyway stays loaded for the next tap.

const NORMAL_LOOKAHEAD_SEC = 45;            // seconds of audio prepared ahead during normal playback
const BACKGROUND_BURST_LOOKAHEAD_SEC = 240; // ...and the one-time burst when the screen goes dark
const GEN_IN_FLIGHT = 2; // clips asked for at once: one being made, the next waiting right behind it

// A clip is made whole before any of it plays, so how far ahead playback needs to be
// depends on how long the next clips are, not on a fixed number of words. Starting
// from a standstill (Play, a jump, or a clip that wasn't ready in time), playback
// waits until every clip due in the next START_HORIZON_SEC is predicted to be ready
// when it's needed: one wait up front instead of a second stop a sentence later.
const START_HORIZON_SEC = 30;
const START_MAX_WAIT_SEC = 20; // ...but never holds the start longer than this
const GEN_SAFETY = 1.15;       // ...and treats each clip as taking this much longer than predicted

// How long a clip takes to make: fixed + perChar × characters, fitted to the clips
// this voice setup made lately. Until it has made some, it assumes Kokoro measured on
// two CPU cores like the free Hugging Face Space (0.30 s + 21.7 ms a character, with
// speech at 62 ms a character), plus time on the network.
const GEN_PRIOR = { fixed: 0.8, perChar: 0.025 };
const GEN_MODEL_DECAY = 0.95; // each new clip counts this much more than the one before
const DROPPED = 'dropped';    // a queued clip given up because the reader moved on

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
  cache: new Map(),         // clip key -> {unit, chars, promise, blob}; blob is set once it's ready
  genQueue: [],             // clips waiting their turn to be made, in reading order
  genRunning: [],           // ...and the ones being made now: {key, chars, sentAt}
  lastGenDone: 0,           // when the voice last finished a clip (performance.now())
  genModels: settingGetJSON('genModels', {}), // voice setup -> weighted sums for the fit
  clip: null,               // {first, last, offsets, blob} for the clip now loaded
  holding: false,           // the element is looping silence while a clip is made
  blocked: false,           // the loaded clip was refused by the browser; Play starts it
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
    if(this.book) this.saveSummary(true); // the outgoing book's card keeps its latest progress
    this.stopAudio();
    this.chapters = chapters;
    this.book = book;
    this.cache.clear();
    this.dropQueued(() => true);
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
    this.positionAt = pos && pos.at ? pos.at : 0;
    this.updateMetadata();
    this.emit('chapter'); this.emit('position'); this.emit('state');
  },
  unload(){
    this.stopAudio();
    this.saveSummary(true);
    this.chapters = []; this.book = null; this.cache.clear(); this.dropQueued(() => true); this.state = 'idle';
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
  // Called from a tap (or the lock screen), so the audio is started here, before
  // anything is awaited: that is what iPhone accepts as the listener's say-so.
  play(){
    if(!this.chapters.length || this.state !== 'idle') return;
    if(this.blocked && this.clip){
      this.blocked = false;
      setEngineStatus('');
      this.setState('playing');
      this.startClip(this.token);
      this.prefetch(false);
      return;
    }
    if(this.finished){ this.finished = false; this.ch = 0; this.s = 0; this.emit('chapter'); this.emit('position'); }
    this.holdSilence();
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
    this.holding = false;
    if(this.blocked){ this.blocked = false; setEngineStatus(''); }
    if(this.audio){ this.audio.onended = null; this.audio.loop = false; this.audio.pause(); }
  },
  // Loops silence until the next clip replaces it. A refusal is ignored here: it is
  // reported, with a way back, when the real clip is refused the same way.
  holdSilence(){
    const audio = this.audio;
    if(!audio || (this.holding && !audio.paused)) return;
    this.holding = true;
    this.clip = null;
    audio.onended = null;
    audio.loop = true;
    audio.src = silentClipUrl();
    audio.play().catch(() => {});
  },
  startClip(myToken){
    this.audio.play().catch(err => {
      if(myToken !== this.token) return; // a seek, pause or the next clip came first
      console.error(err);
      if(err && err.name === 'NotAllowedError'){
        // Keep the clip and its onended in place, so Play can start it from the tap.
        this.blocked = true;
        setEngineStatus("Paused: the browser wouldn't let the next part start on its own. Tap play to keep listening.");
      } else {
        setEngineStatus('Playback was blocked: ' + err.message);
      }
      this.setState('idle');
      this.saveSummary(true);
    });
  },

  // Everything generated so far assumed the old voice/speed/filter — drop it.
  clearAudio(){
    const wasPlaying = this.state !== 'idle';
    this.stopAudio();
    this.cache.clear();
    if(wasPlaying) this.speakCurrent();
  },

  // ---------------- Making clips ----------------
  // Clips are asked for in reading order, GEN_IN_FLIGHT at a time, so the voice
  // makes them in the order they'll be played (a server given them all at once
  // might not) and how long each takes can be measured.
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
      const entry = { unit, chars: this.unitChars(unit) };
      entry.promise = new Promise((resolve, reject) => {
        this.genQueue.push({ key: unit.key, entry, run: () => Voice.generate(sentences), resolve, reject });
      }).then(blob => {
        // Learn how fast this voice actually reads, so the time estimates fit it.
        if(blob.durationSec && chars > 40){
          const observed = blob.durationSec * (Voice.settings.speed || 1) / chars;
          this.secPerChar = this.secPerChar * 0.8 + observed * 0.2;
          settingSet('secPerChar', this.secPerChar.toFixed(4));
        }
        entry.blob = blob;
        return blob;
      });
      // A failure isn't worth remembering.
      entry.promise.catch(() => { if(this.cache.get(unit.key) === entry) this.cache.delete(unit.key); });
      this.cache.set(unit.key, entry);
      this.pumpGen();
    }
    return this.cache.get(unit.key).promise;
  },
  clipReady(unit){ const entry = this.cache.get(unit.key); return !!(entry && entry.blob); },
  unitChars(unit){
    const ch = this.chapters[unit.c];
    return ch.charBefore[unit.last] + ch.sentences[unit.last].length - ch.charBefore[unit.first];
  },
  // Seconds of speech in a clip: measured once it's made, estimated until then.
  unitSec(unit){
    const entry = this.cache.get(unit.key);
    return entry && entry.blob && entry.blob.durationSec ? entry.blob.durationSec : this.unitChars(unit) * this.secPerCharNow();
  },
  pumpGen(){
    while(this.genRunning.length < GEN_IN_FLIGHT && this.genQueue.length){
      const job = this.genQueue.shift();
      // The cache was cleared since this was asked for (a new voice, a cleared cache).
      if(this.cache.get(job.key) !== job.entry){ job.reject(new Error(DROPPED)); continue; }
      const run = { key: job.key, chars: job.entry.chars, sentAt: performance.now() };
      this.genRunning.push(run);
      const finish = ok => {
        const now = performance.now();
        // Time on the voice: from when it could start on this one (it was asked for,
        // and the one before it was done) until it was done.
        if(ok) this.learnGenTime(run.chars, (now - Math.max(run.sentAt, this.lastGenDone)) / 1000);
        this.lastGenDone = now;
        this.genRunning.splice(this.genRunning.indexOf(run), 1);
        this.pumpGen();
      };
      job.run().then(blob => { finish(true); job.resolve(blob); }, err => { finish(false); job.reject(err); });
    }
  },
  // Gives up queued clips (not ones already being made) that `drop(job)` picks.
  dropQueued(drop){
    this.genQueue = this.genQueue.filter(job => {
      if(!drop(job)) return true;
      if(this.cache.get(job.key) === job.entry) this.cache.delete(job.key);
      job.reject(new Error(DROPPED));
      return false;
    });
  },
  // Asks for the clip at the reading position and the ones after it, up to the
  // lookahead, and gives up queued clips outside that run (the reader moved on).
  prefetch(burst){
    const aheadSec = burst ? BACKGROUND_BURST_LOOKAHEAD_SEC : NORMAL_LOOKAHEAD_SEC;
    const wanted = [];
    let unit = this.unitFor(this.ch, this.s), sec = 0;
    while(unit && (wanted.length < 2 || sec < aheadSec)){
      wanted.push(unit);
      sec += this.unitSec(unit);
      unit = this.unitAfter(unit);
    }
    const order = new Map(wanted.map((u, i) => [u.key, i]));
    this.dropQueued(job => !order.has(job.key));
    wanted.forEach(u => this.getAudio(u).catch(() => {}));
    this.genQueue.sort((a, b) => order.get(a.key) - order.get(b.key)); // after a jump back, the new clips go first
  },

  // ---------------- How long clips take ----------------
  genModelKey(){
    let where = 'device';
    if(Voice.settings.useServer){ try{ where = new URL(Voice.settings.serverUrl).host; } catch(e){ where = 'server'; } }
    return Voice.settings.engine + ' ' + where;
  },
  // Weighted sums for a least-squares line through (characters, seconds). A new voice
  // setup starts from two made-up clips on the GEN_PRIOR line.
  genStats(){
    const key = this.genModelKey();
    if(!this.genModels[key]){
      const m = { w: 0, x: 0, y: 0, xx: 0, xy: 0, clips: 0 };
      [40, 300].forEach(c => { const t = GEN_PRIOR.fixed + GEN_PRIOR.perChar * c; m.w += 1; m.x += c; m.y += t; m.xx += c * c; m.xy += c * t; });
      this.genModels[key] = m;
    }
    return this.genModels[key];
  },
  genFit(){
    const m = this.genStats();
    const den = m.w * m.xx - m.x * m.x;
    const perChar = Math.min(0.5, Math.max(0.0005, den > 1e-9 ? (m.w * m.xy - m.x * m.y) / den : GEN_PRIOR.perChar));
    const fixed = Math.min(10, Math.max(0, (m.y - perChar * m.x) / m.w));
    return { fixed, perChar, clips: m.clips };
  },
  genSecFor(chars){ const f = this.genFit(); return f.fixed + f.perChar * chars; },
  learnGenTime(chars, sec){
    if(!(chars > 0) || !(sec > 0)) return;
    sec = Math.min(sec, 2 * this.genSecFor(chars) + 2); // one stalled request shouldn't throw the fit
    const m = this.genStats();
    ['w', 'x', 'y', 'xx', 'xy'].forEach(k => { m[k] *= GEN_MODEL_DECAY; });
    m.w += 1; m.x += chars; m.y += sec; m.xx += chars * chars; m.xy += chars * sec; m.clips++;
    settingSet('genModels', JSON.stringify(this.genModels));
  },

  // Seconds to hold the start so no clip due in the next START_HORIZON_SEC is late,
  // predicting the clips still to come as made one after another, in order.
  startDelay(){
    const now = performance.now() / 1000;
    const readyAt = new Map();
    let free = this.lastGenDone / 1000; // when the voice gets to the next clip
    this.genRunning.forEach(run => {
      free = Math.max(free, run.sentAt / 1000) + this.genSecFor(run.chars) * GEN_SAFETY;
      free = Math.max(free, now + 0.2); // overdue: assume it's nearly done
      readyAt.set(run.key, free);
    });
    free = Math.max(free, now);
    this.genQueue.forEach(job => { free += this.genSecFor(job.entry.chars) * GEN_SAFETY; readyAt.set(job.key, free); });

    let unit = this.unitFor(this.ch, this.s), startsIn = 0, wait = 0;
    for(let i = 0; unit && startsIn <= START_HORIZON_SEC && i < 60; i++){
      let ready = now;
      if(!this.clipReady(unit)){
        if(!readyAt.has(unit.key)){ free += this.genSecFor(this.unitChars(unit)) * GEN_SAFETY; readyAt.set(unit.key, free); }
        ready = readyAt.get(unit.key);
      }
      wait = Math.max(wait, ready - now - startsIn);
      let sec = this.unitSec(unit);
      if(i === 0 && this.s > unit.first){ // resuming partway into a paragraph clip
        const ch = this.chapters[unit.c];
        sec *= (this.unitChars(unit) - (ch.charBefore[this.s] - ch.charBefore[unit.first])) / this.unitChars(unit);
      }
      startsIn += sec;
      unit = this.unitAfter(unit);
    }
    return wait;
  },
  // Waits out startDelay(), playing silence meanwhile. Resolves false if playback
  // was stopped or moved while waiting.
  async waitForHeadStart(myToken){
    const began = performance.now();
    while(performance.now() - began < START_MAX_WAIT_SEC * 1000){
      const wait = this.startDelay();
      if(wait < 0.3) break;
      this.holdSilence();
      setEngineStatus('Buffering… ' + Math.ceil(wait) + ' s');
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, wait * 1000)));
      if(myToken !== this.token) return false;
    }
    return true;
  },
  // For Settings: how fast this voice setup has been making speech.
  genSummary(){
    const f = this.genFit();
    return { timesFaster: this.secPerCharNow() / f.perChar, fixed: f.fixed, clips: f.clips };
  },

  // ---------------- The clip loop ----------------
  // `continuing` is set when the clip before this one just ended; anything else is a
  // start from a standstill.
  async speakCurrent(continuing){
    const myToken = ++this.token;
    const ch = this.chapter();
    if(!ch || this.s >= ch.sentences.length){
      // Chapter finished: on to the next, or the book is done.
      if(this.ch < this.chapters.length - 1){ this.setPosition(this.ch + 1, 0); this.speakCurrent(continuing); }
      else { this.stopAudio(); this.finished = true; this.s = ch ? ch.sentences.length - 1 : 0; this.setState('idle'); this.saveProgress(); this.saveSummary(true); this.emit('position'); this.emit('finished'); }
      return;
    }
    this.setState('preparing');
    const unit = this.unitFor(this.ch, this.s);
    const stalled = !this.clipReady(unit);
    if(stalled) this.holdSilence();
    const ready = await Voice.ensureReady();
    if(myToken !== this.token) return;
    if(!ready){ this.stopAudio(); this.setState('idle'); return; }

    this.prefetch(document.hidden); // this clip first, then the ones after it
    if(stalled) setEngineStatus('Generating…');
    let blob;
    try{ blob = await this.getAudio(unit); }
    catch(err){
      if(myToken !== this.token) return;
      if(err && err.message === DROPPED){ this.speakCurrent(continuing); return; } // the cache was cleared under it
      console.error(err);
      setEngineStatus('Voice generation failed (' + (err && err.message ? err.message : 'unknown error') + ') — skipping.');
      const nextUnit = this.unitAfter(unit);
      if(nextUnit){ this.setPosition(nextUnit.c, nextUnit.first); this.speakCurrent(); }
      else { this.stopAudio(); this.setState('idle'); }
      return;
    }
    if(myToken !== this.token || !blob) return;
    if((stalled || !continuing) && !(await this.waitForHeadStart(myToken))) return;
    setEngineStatus('');

    const audio = this.audio;
    this.holding = false;
    audio.loop = false;
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
      if(!nextUnit){ this.s = ch.sentences.length; this.speakCurrent(true); return; }
      this.setPosition(nextUnit.c, nextUnit.first);
      // A closing quote with nothing after it is a natural end-of-exchange beat.
      const extraPause = endsQuotedDialogue(lastText) ? DIALOGUE_END_PAUSE_MS : 0;
      if(extraPause) setTimeout(() => { if(myToken === this.token) this.speakCurrent(true); }, extraPause);
      else this.speakCurrent(true);
    };
    this.setState('playing');
    this.emit('position');
    this.startClip(myToken);
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
    this.positionAt = Date.now(); // when the place in the book last moved
    saveProgressFor(this.book.progressKey, { chapter: this.ch, sentence: this.s, at: this.positionAt });
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
      finished: this.finished,
      // Stamped with the time the position last moved, not the time of this save, so a
      // backup merge compares card progress and reading position by the same clock.
      at: this.positionAt || 0
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
