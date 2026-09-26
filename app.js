pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---------------- No pinch / double-tap zoom ----------------
// touch-action + the viewport meta tag aren't reliably enough on their own on iOS —
// Safari's native two-finger pinch gesture and double-tap-to-zoom fire independently
// of those. gesturestart/gesturechange are the WebKit-specific events behind pinch;
// canceling them (and debouncing fast-repeat touchend, which is what a double-tap
// looks like) blocks zoom without touching normal single-finger scrolling.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
let lastTouchEndAt = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if(now - lastTouchEndAt <= 300) e.preventDefault();
  lastTouchEndAt = now;
}, { passive: false });

// ---------------- State ----------------
let chapters = [];     // [{title, sentences: [string,...]}]
let curChapter = 0;
let curSentence = 0;
let isPlaying = false;
let bookKey = null;    // for localStorage progress
let currentAudioEl = null;   // <audio> element used for kokoro playback
const neuralAudioCache = new Map(); // "chapter-sentence" -> Promise<Blob>
let playToken = 0;            // increments whenever playback is stopped, to cancel stale async work
let filterEnabled = true;
let engine = 'piper'; // default for new users; 'kokoro' is the other available choice
let pronunciationRules = []; // [{find, replace, matchCase}] — applied to speech only
let customBadWords = [];

const el = id => document.getElementById(id);
const uploadView = el('uploadView');
const readerView = el('readerView');
const chapterList = el('chapterList');
const proseText = el('proseText');
const player = el('player');
const loadStatus = el('loadStatus');

// ---------------- Modals ----------------
function openModal(modalEl){ modalEl.classList.remove('hidden'); }
function closeModal(modalEl){ modalEl.classList.add('hidden'); }

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => { if(e.target === backdrop) closeModal(backdrop); });
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    document.querySelectorAll('.modal-backdrop').forEach(m => closeModal(m));
  }
});

el('tocBtn').addEventListener('click', () => openModal(el('tocModal')));
el('tocModalClose').addEventListener('click', () => closeModal(el('tocModal')));

el('settingsBtn').addEventListener('click', async () => {
  openModal(el('settingsModal'));
  if(engine === 'kokoro' && !window.KokoroEngine.isLoaded()){
    const sel = el('voiceSelect');
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.textContent = 'Loading voices…';
    sel.appendChild(placeholder);
    ensureKokoroReadyGuarded(); // populates voiceSelect itself once the model finishes loading (or falls back to Piper on iOS if declined)
  } else if(!el('voiceSelect').options.length){
    // Only (re)build the list if it's empty — reopening Settings shouldn't reset
    // a voice the person already picked.
    if(engine === 'piper'){
      await populatePiperVoiceSelect();
      const voiceId = el('voiceSelect').value;
      if(voiceId) ensurePiperVoiceReady(voiceId);
    } else {
      refreshVoiceSelect();
    }
  }
});
el('settingsModalClose').addEventListener('click', () => closeModal(el('settingsModal')));

loadFilterSettings();
el('filterToggle').checked = filterEnabled;
el('filterWords').value = customBadWords.join(', ');

el('filterToggle').addEventListener('change', () => {
  filterEnabled = el('filterToggle').checked;
  saveFilterSettings();
  neuralAudioCache.clear();
  if(chapters.length) renderReadingWindow();
});
el('filterWords').addEventListener('input', () => {
  customBadWords = el('filterWords').value.split(',').map(w => w.trim()).filter(Boolean);
  saveFilterSettings();
  neuralAudioCache.clear();
  if(chapters.length) renderReadingWindow();
});

loadPronunciationRules();
renderPronunciationList();
el('pronPreviewBtn').addEventListener('click', () => {
  const find = el('pronFindInput').value.trim();
  const replace = el('pronReplaceInput').value.trim();
  speakPreviewText(replace || find, el('pronPreviewBtn'));
});
el('pronAddBtn').addEventListener('click', () => {
  const find = el('pronFindInput').value.trim();
  if(!find) return;
  const replace = el('pronReplaceInput').value.trim();
  const matchCase = el('pronMatchCase').checked;
  pronunciationRules.push({ find, replace, matchCase });
  savePronunciationRules();
  renderPronunciationList();
  el('pronFindInput').value = '';
  el('pronReplaceInput').value = '';
  el('pronMatchCase').checked = false;
  neuralAudioCache.clear();
});

// ---------------- Display settings: font size + dark mode ----------------
function applyFontSize(px){
  document.documentElement.style.setProperty('--prose-font-size', px + 'px');
  el('fontSizeReadout').textContent = px + 'px';
}
let fontSizePx = 19;
try{
  const savedSize = localStorage.getItem('lamplight:fontSize');
  if(savedSize) fontSizePx = parseInt(savedSize, 10) || 19;
} catch(e){ /* ignore */ }
el('fontSizeSlider').value = fontSizePx;
applyFontSize(fontSizePx);
el('fontSizeSlider').addEventListener('input', () => {
  fontSizePx = parseInt(el('fontSizeSlider').value, 10);
  applyFontSize(fontSizePx);
  try{ localStorage.setItem('lamplight:fontSize', fontSizePx); } catch(e){ /* ignore */ }
});

let darkMode = false;
try{ darkMode = localStorage.getItem('lamplight:darkMode') === '1'; } catch(e){ /* ignore */ }
document.body.classList.toggle('dark', darkMode);
el('darkModeToggle').checked = darkMode;
el('darkModeToggle').addEventListener('change', () => {
  darkMode = el('darkModeToggle').checked;
  document.body.classList.toggle('dark', darkMode);
  try{ localStorage.setItem('lamplight:darkMode', darkMode ? '1' : '0'); } catch(e){ /* ignore */ }
});

// ---------------- Voice engine (Kokoro vs. Piper) ----------------
try{
  const savedEngine = localStorage.getItem('lamplight:engine');
  if(savedEngine === 'kokoro' || savedEngine === 'piper') engine = savedEngine;
} catch(e){ /* ignore */ }
el('engineSelect').value = engine;

// ---------------- Local server backend (self-hosted Kokoro/Piper over Tailscale) ----------------
// Runs the exact same Kokoro/Piper models on the person's own Mac instead of in-browser
// WASM, so a phone doesn't have to do the heavy lifting itself. This works by swapping
// out which object window.KokoroEngine / window.PiperEngine point to — the server-backed
// versions below implement the identical interface the WASM engines already expose
// (ensureLoaded/isLoaded/listVoices/generateBlob for Kokoro; listVoices/storedVoices/
// ensureVoice/generateBlob for Piper), so every existing call site (speakCurrentKokoro,
// speakCurrentPiper, speakPreviewText, populate*VoiceSelect, etc.) needs no changes at all.
let useServer = true; // default on for new users; respects an explicit prior choice either way
try{
  const savedUseServer = localStorage.getItem('lamplight:useServer');
  if(savedUseServer !== null) useServer = savedUseServer === '1';
} catch(e){ /* ignore */ }
el('useServerToggle').checked = useServer;

let serverUrl = 'https://bens-macbook-pro.tail2a16fc.ts.net:8123';
try{
  const savedServerUrl = localStorage.getItem('lamplight:serverUrl');
  if(savedServerUrl) serverUrl = savedServerUrl;
} catch(e){ /* ignore */ }
el('serverUrlInput').value = serverUrl;

// How long a silent gap between sentences (or after a comma) is allowed to stay,
// after each engine's own baked-in pauses get measured and capped — see
// compressSilence(). Below the natural word-to-word micro-pause floor (~45-75ms)
// sentence boundaries stop reading as sentence boundaries at all; the slider's max
// (500ms) is set well past a natural sentence break so the high end of the range
// actually sounds different, not just technically different, from the low end.
// Applies to both engines — Kokoro's raw clips actually carry even more lead/trail
// silence than Piper's.
//
// This one slider controls the gap wherever two sentences end up, not just one
// case: when they're batched into the same clip (Piper's paragraphs), it's the cap
// on the internal gap between them; when they're separate clips (Kokoro is always
// per-sentence), the actual pause a listener hears is the *sum* of clip A's trailing
// edge trim and clip B's leading edge trim — so edgePadMs is derived as half this
// value at each call site, making both cases converge on roughly the same target gap.
let maxInternalGapMs = 80;
try{
  const savedGap = localStorage.getItem('lamplight:maxInternalGapMs');
  if(savedGap) maxInternalGapMs = parseInt(savedGap, 10) || 80;
} catch(e){ /* ignore */ }
el('pauseTightnessSlider').value = maxInternalGapMs;
el('pauseTightnessLabel').textContent = maxInternalGapMs + 'ms';
el('pauseTightnessSlider').addEventListener('input', () => {
  maxInternalGapMs = parseInt(el('pauseTightnessSlider').value, 10);
  el('pauseTightnessLabel').textContent = maxInternalGapMs + 'ms';
  try{ localStorage.setItem('lamplight:maxInternalGapMs', maxInternalGapMs); } catch(e){ /* ignore */ }
  neuralAudioCache.clear(); // already-generated clips baked in the old cap
});

function updateServerRowsVisibility(){
  el('serverUrlRow').classList.toggle('hidden', !useServer);
  // Header dot: bright green while audio is actually coming from the local server
  // over the network, dark green when generation is fully on-device (toggle off).
  document.querySelector('header h1 .dot').classList.toggle('online', useServer);
}
updateServerRowsVisibility();

// Wraps fetch() for every server call so a failure says *what* went wrong. A bare
// fetch() rejection on iOS is just "Load failed" — which covers the Mac being asleep,
// the server not running, Tailscale being off on this device, and the server refusing
// the request (CORS) alike — and an unreachable tailnet host can leave a request
// pending for minutes, so voice-list requests also get a timeout.
async function serverFetch(path, options, timeoutMs){
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try{
    return await fetch(serverUrl + path, Object.assign({}, options, controller ? { signal: controller.signal } : {}));
  } catch(err){
    const why = err && err.name === 'AbortError' ? 'no answer after ' + Math.round(timeoutMs/1000) + 's' : 'connection failed';
    throw new Error("Can't reach the voice server at " + serverUrl + ' (' + why + '). ' +
      'Check that the server is running and awake (a sleeping Hugging Face Space takes a minute or two to wake), ' +
      'and for the Mac server that Tailscale is on for this device.');
  } finally {
    if(timer) clearTimeout(timer);
  }
}
const SERVER_VOICES_TIMEOUT_MS = 15000;

// The server's own explanation (e.g. "Wrong access key") beats a bare status code.
async function serverErrorFrom(res, path){
  let detail = '';
  try{ detail = (await res.json()).detail || ''; } catch(e){ /* not JSON */ }
  return new Error(detail ? 'Voice server: ' + detail : 'Voice server answered with HTTP ' + res.status + ' for ' + path + '.');
}

// ---------------- Voice server connection popup ----------------
// Shown while the app is fetching the server's voice list — the step that proves the
// server is reachable and ready — and cleared once voices are in. A Hugging Face Space
// that has gone to sleep takes a minute or two to wake, so this keeps retrying (with a
// visible timer) instead of giving up after one timed-out request.
const SERVER_WAKE_MAX_MS = 4 * 60 * 1000;
const SERVER_RETRY_DELAY_MS = 4000;
let connectToastTicker = null, connectToastHideTimer = null;

function setConnectToast(state, title, detail){
  const toast = el('connectToast');
  clearTimeout(connectToastHideTimer);
  toast.classList.remove('hidden', 'fading', 'is-ready', 'is-error');
  if(state !== 'connecting') toast.classList.add('is-' + state);
  el('connectTitle').textContent = title;
  el('connectDetail').textContent = detail || '';
  el('connectActions').classList.toggle('hidden', state !== 'error');
}

function hideConnectToast(delayMs){
  clearTimeout(connectToastHideTimer);
  connectToastHideTimer = setTimeout(() => {
    const toast = el('connectToast');
    toast.classList.add('fading');
    connectToastHideTimer = setTimeout(() => toast.classList.add('hidden'), 260);
  }, delayMs || 0);
}

el('connectClose').addEventListener('click', () => hideConnectToast(0));
el('connectRetry').addEventListener('click', async () => {
  kokoroServerVoicesCache = null;
  piperServerVoicesCache = null;
  setEngineStatus('');
  await refreshVoiceListForCurrentEngine();
});

// Fetches a server voice list, retrying while the server is unreachable or waking.
// Errors the server states plainly (wrong key, Kokoro-only server, ...) stop at once.
// Concurrent callers for the same list share one attempt, so there's only ever one popup.
const serverVoicesInFlight = new Map();
function fetchServerVoices(path){
  if(serverVoicesInFlight.has(path)) return serverVoicesInFlight.get(path);
  const attempt = (async () => {
    const started = Date.now();
    const elapsed = () => Math.round((Date.now() - started) / 1000);
    setConnectToast('connecting', 'Connecting to voice server…', '');
    clearInterval(connectToastTicker);
    connectToastTicker = setInterval(() => {
      if(Date.now() - started < 6000) return;
      el('connectTitle').textContent = 'Waking up the voice server…';
      el('connectDetail').textContent = 'This can take a minute or two after it has been idle. (' + elapsed() + 's)';
    }, 1000);
    try{
      let lastErr = null;
      while(true){
        if(!useServer) throw new Error('Local server was turned off.');
        let res = null;
        try{
          res = await serverFetch(path, {}, SERVER_VOICES_TIMEOUT_MS);
        } catch(err){ lastErr = err; } // unreachable or timed out: worth retrying
        if(res && res.ok){
          try{
            const data = await res.json();
            clearInterval(connectToastTicker);
            const count = voiceIdsFrom(data.voices).length;
            setConnectToast('ready', 'Voice server ready', count + ' voices available.');
            hideConnectToast(1400);
            return data.voices;
          } catch(err){
            lastErr = new Error('The voice server sent back something other than a voice list.'); // e.g. a "starting up" page
          }
        } else if(res && (res.status >= 500 || res.status === 429)){
          lastErr = await serverErrorFrom(res, path); // still starting up, or overloaded
        } else if(res){
          throw await serverErrorFrom(res, path); // a definite answer; retrying won't change it
        }
        if(Date.now() - started > SERVER_WAKE_MAX_MS) throw lastErr;
        await new Promise(resolve => setTimeout(resolve, SERVER_RETRY_DELAY_MS));
      }
    } catch(err){
      clearInterval(connectToastTicker);
      if(useServer){
        setConnectToast('error', "Couldn't connect to the voice server", err && err.message ? err.message : String(err));
      } else {
        hideConnectToast(0);
      }
      throw err;
    } finally {
      serverVoicesInFlight.delete(path);
    }
  })();
  serverVoicesInFlight.set(path, attempt);
  return attempt;
}

// The server's voices list may come back as an array of ids or as an object keyed by id.
function voiceIdsFrom(voices){
  if(Array.isArray(voices)) return voices.map(v => typeof v === 'string' ? v : (v && (v.id || v.name))).filter(Boolean);
  return (voices && typeof voices === 'object') ? Object.keys(voices) : [];
}

async function generateViaServer(enginePath, text, voice, speed){
  const res = await serverFetch('/' + enginePath + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed })
  });
  if(!res.ok){
    let detail = 'HTTP ' + res.status;
    try{ const errBody = await res.json(); if(errBody.detail) detail = errBody.detail; } catch(e){ /* ignore */ }
    throw new Error(detail);
  }
  return await res.blob();
}

let kokoroServerVoicesCache = null;
const kokoroServerEngine = {
  async ensureLoaded(){
    if(kokoroServerVoicesCache) return true;
    kokoroServerVoicesCache = voiceIdsFrom(await fetchServerVoices('/kokoro/voices'));
    return true;
  },
  isLoaded(){ return !!kokoroServerVoicesCache; },
  listVoices(){ return kokoroServerVoicesCache || []; },
  async generateBlob(text, voice, speed){ return generateViaServer('kokoro', text, voice, speed); }
};

let piperServerVoicesCache = null;
const piperServerEngine = {
  async listVoices(){
    piperServerVoicesCache = (await fetchServerVoices('/piper/voices')) || [];
    return piperServerVoicesCache;
  },
  async storedVoices(){
    // Nothing to download — the server already has every voice ready — so report the
    // full catalog as "stored" and ensurePiperVoiceReady() takes its instant-return path.
    if(piperServerVoicesCache) return piperServerVoicesCache;
    return await piperServerEngine.listVoices();
  },
  // Only reached when storedVoices() above failed — i.e. the server couldn't be reached —
  // so retry the listing to surface that error instead of reporting the voice as ready.
  async ensureVoice(){ await piperServerEngine.listVoices(); return true; },
  async generateBlob(text, voiceId){ return generateViaServer('piper', text, voiceId, parseFloat(el('rateSlider').value)); }
};

// The in-browser engines register as window.KokoroWasmEngine / window.PiperWasmEngine
// once their modules (and, for Piper, its CDN library) have loaded; window.KokoroEngine /
// window.PiperEngine are set only here. The server engines don't depend on those modules
// at all, so they're installed straight away — a slow or blocked CDN no longer leaves
// server mode without an engine.
let kokoroWasmEngine = null, piperWasmEngine = null;
function applyEngineBackends(){
  const ke = useServer ? kokoroServerEngine : kokoroWasmEngine;
  const pe = useServer ? piperServerEngine : piperWasmEngine;
  if(ke) window.KokoroEngine = ke;
  if(pe) window.PiperEngine = pe;
}
applyEngineBackends();
// Swapping in the right backend and prepping the restored engine (so nothing has to
// download/connect later when Play is first pressed) happen in the same callback,
// deliberately — keeping them as one sequence avoids a race against the "which engine
// is this book restoring?" logic below running before the server/WASM swap has happened.
// Deferred until the rest of this script has run, so everything these touch is defined.
if(useServer) Promise.resolve().then(() => {
  if(engine === 'kokoro') ensureKokoroReadyGuarded();
  else if(engine === 'piper'){
    populatePiperVoiceSelect().then(() => {
      const voiceId = el('voiceSelect').value;
      if(voiceId) ensurePiperVoiceReady(voiceId);
    });
  }
});
waitForGlobal('KokoroWasmEngine').then(ke => {
  if(!ke) return;
  kokoroWasmEngine = ke;
  applyEngineBackends();
  if(engine === 'kokoro' && !useServer) ensureKokoroReadyGuarded();
});
waitForGlobal('PiperWasmEngine').then(pe => {
  if(!pe) return;
  piperWasmEngine = pe;
  applyEngineBackends();
  if(engine === 'piper' && !useServer){
    populatePiperVoiceSelect().then(() => {
      const voiceId = el('voiceSelect').value;
      if(voiceId) ensurePiperVoiceReady(voiceId);
    });
  }
});

async function refreshVoiceListForCurrentEngine(){
  if(engine === 'kokoro' && !window.KokoroEngine.isLoaded()){
    const sel = el('voiceSelect');
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.textContent = 'Loading voices…';
    sel.appendChild(placeholder);
    ensureKokoroReadyGuarded();
  } else if(engine === 'piper'){
    await populatePiperVoiceSelect();
    const voiceId = el('voiceSelect').value;
    if(voiceId) ensurePiperVoiceReady(voiceId);
  } else {
    refreshVoiceSelect();
  }
}

el('useServerToggle').addEventListener('change', async () => {
  useServer = el('useServerToggle').checked;
  try{ localStorage.setItem('lamplight:useServer', useServer ? '1' : '0'); } catch(e){ /* ignore */ }
  applyEngineBackends();
  neuralAudioCache.clear();
  updateServerRowsVisibility();
  if(!useServer) hideConnectToast(0);
  await refreshVoiceListForCurrentEngine();
});

el('serverUrlInput').addEventListener('change', async () => {
  serverUrl = el('serverUrlInput').value.trim().replace(/\/+$/, '');
  try{ localStorage.setItem('lamplight:serverUrl', serverUrl); } catch(e){ /* ignore */ }
  kokoroServerVoicesCache = null;
  piperServerVoicesCache = null;
  neuralAudioCache.clear();
  if(useServer) await refreshVoiceListForCurrentEngine();
});

// The Kokoro/Piper engines live in <script type="module"> blocks that fetch a
// library from a CDN — they may not be attached to window yet at this exact point
// in page load, so wait for whichever one we need rather than assuming it's ready.
function waitForGlobal(name, timeoutMs){
  return new Promise(resolve => {
    const start = Date.now();
    (function check(){
      if(window[name]){ resolve(window[name]); return; }
      if(Date.now() - start > (timeoutMs || 8000)){ resolve(null); return; }
      setTimeout(check, 100);
    })();
  });
}

el('refreshVoicesBtn').addEventListener('click', async () => {
  if(useServer){
    // Ask the server again rather than re-rendering a cached (or failed) list.
    kokoroServerVoicesCache = null;
    piperServerVoicesCache = null;
    setEngineStatus('');
    await refreshVoiceListForCurrentEngine();
  } else if(engine === 'piper'){
    await populatePiperVoiceSelect();
    const voiceId = el('voiceSelect').value;
    if(voiceId) ensurePiperVoiceReady(voiceId); // confirms the shown voice is actually the one that will play
  } else {
    refreshVoiceSelect();
  }
});

el('engineSelect').addEventListener('change', async () => {
  stopPlayback();
  isPlaying = false;
  updatePlayButton();
  engine = el('engineSelect').value;
  try{ localStorage.setItem('lamplight:engine', engine); } catch(e){ /* ignore */ }
  neuralAudioCache.clear();
  updateServerRowsVisibility();
  await refreshVoiceListForCurrentEngine();
});

// ---------------- Media Session: lock-screen controls + background playback ----------------
function updateMediaSessionMetadata(){
  if(!('mediaSession' in navigator)) return;
  const ch = chapters[curChapter];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ch ? ch.title : 'Reading',
    artist: el('bookTitle').textContent || 'Lamplight Reader',
    album: 'Lamplight Reader'
  });
}
if('mediaSession' in navigator){
  navigator.mediaSession.setActionHandler('play', () => {
    if(!isPlaying){ isPlaying = true; speakCurrent(); updatePlayButton(); }
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if(isPlaying){ isPlaying = false; stopPlayback(); updatePlayButton(); }
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => el('prevBtn').click());
  navigator.mediaSession.setActionHandler('nexttrack', () => el('nextBtn').click());
}

// Locking the screen (or backgrounding the app) doesn't stop the <audio> element
// itself from playing — iOS keeps that going — but it heavily throttles the JS/
// network work needed to generate the *next* sentence once the current one ends.
// The fix is to already have several sentences' worth of audio sitting in
// neuralAudioCache before that happens: a normal amount ahead during regular
// playback, and a much bigger one-time burst the instant the page goes hidden,
// since that's the last real chance to get ahead of the throttling.
const NORMAL_LOOKAHEAD = 6;
const BACKGROUND_BURST_LOOKAHEAD = 40;

function prefetchAhead(chapterIdx, sentenceIdx, count, getAudioFn){
  let c = chapterIdx, s = sentenceIdx;
  for(let n = 0; n < count; n++){
    s++;
    if(s >= chapters[c].sentences.length){
      c++; s = 0;
      if(c >= chapters.length || !chapters[c].sentences.length) break;
    }
    getAudioFn(c, s);
  }
}

document.addEventListener('visibilitychange', () => {
  if(!document.hidden || !isPlaying || !chapters.length) return;
  if(engine === 'piper' && useServer){
    const ch = chapters[curChapter];
    prefetchParagraphsAhead(curChapter, ch.sentenceParagraph[curSentence], BACKGROUND_BURST_PARAGRAPH_LOOKAHEAD);
  } else {
    const getAudioFn = engine === 'kokoro' ? getKokoroAudio : getPiperAudio;
    prefetchAhead(curChapter, curSentence, BACKGROUND_BURST_LOOKAHEAD, getAudioFn);
  }
});

// ---------------- File handling ----------------
el('fileInput').addEventListener('change', e => { if(e.target.files[0]) handleFile(e.target.files[0]); });
const dropZone = el('dropZone');
['dragover','dragenter'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.style.background='rgba(173,138,82,0.15)'; }));
['dragleave','drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.style.background=''; }));
dropZone.addEventListener('drop', e => { if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

el('newBookBtn').addEventListener('click', () => {
  stopPlayback();
  isPlaying = false;
  readerView.classList.add('hidden');
  uploadView.classList.remove('hidden');
  player.classList.remove('visible');
  el('headerActions').classList.add('hidden');
  el('headerTag').classList.remove('hidden');
  chapters = [];
  chapterList.innerHTML = '';
  neuralAudioCache.clear();
  renderLibraryList();
});

// ---------------- Book library (IndexedDB) ----------------
// Stores the raw bytes of every book that's been opened locally (never uploaded
// anywhere), so any of them can reopen instantly without re-choosing the file.
const LAST_BOOK_DB = 'lamplight-reader';
const LAST_BOOK_STORE = 'files';

function openLibraryDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LAST_BOOK_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(LAST_BOOK_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBookToLibrary(file, buf){
  try{
    const db = await openLibraryDB();
    const id = file.name.trim().toLowerCase(); // same filename = same book, regardless of minor byte differences
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_BOOK_STORE, 'readwrite');
      const store = tx.objectStore(LAST_BOOK_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        store.put({
          id,
          name: file.name,
          type: file.type,
          data: buf,
          savedAt: Date.now(),
          displayName: existing ? existing.displayName : undefined // keep any custom name across re-opens
        });
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch(err){
    console.warn('Could not save book to library:', err);
  }
}

// Returns every stored book, most recently opened first.
async function listLibraryBooks(){
  try{
    const db = await openLibraryDB();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_BOOK_STORE, 'readonly');
      const req = tx.objectStore(LAST_BOOK_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    records.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return records;
  } catch(err){
    console.warn('Could not list library:', err);
    return [];
  }
}

async function deleteBookFromLibrary(id){
  try{
    const db = await openLibraryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_BOOK_STORE, 'readwrite');
      tx.objectStore(LAST_BOOK_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch(err){
    console.warn('Could not remove book from library:', err);
  }
}

async function renameBookInLibrary(id, displayName){
  try{
    const db = await openLibraryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_BOOK_STORE, 'readwrite');
      const store = tx.objectStore(LAST_BOOK_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec) return;
        rec.displayName = displayName;
        store.put(rec);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch(err){
    console.warn('Could not rename book:', err);
  }
}

function libraryBookTitle(rec){
  return rec.displayName || rec.name.replace(/\.(epub|pdf)$/i, '');
}

// Renders the tappable list of previously-opened books on the upload/library screen.
// Pass a pre-fetched array to avoid a redundant DB read; otherwise it fetches its own.
async function renderLibraryList(books){
  if(!books) books = await listLibraryBooks();
  const wrap = el('libraryListWrap');
  const container = el('libraryList');
  container.innerHTML = '';
  if(!books.length){ wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  books.forEach(rec => {
    const row = document.createElement('div');
    row.className = 'toc-row';

    const label = document.createElement('span');
    label.textContent = libraryBookTitle(rec);
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    row.appendChild(label);

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '8px';
    btnGroup.style.flexShrink = '0';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'preview-btn';
    renameBtn.setAttribute('aria-label', 'Rename book');
    renameBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    renameBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      startLibraryRename(rec, label, row);
    });
    btnGroup.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'modal-close';
    delBtn.setAttribute('aria-label', 'Remove from library');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await deleteBookFromLibrary(rec.id);
      renderLibraryList();
    });
    btnGroup.appendChild(delBtn);
    row.appendChild(btnGroup);

    row.addEventListener('click', () => {
      const file = new File([rec.data], rec.name, { type: rec.type || '' });
      handleFile(file, { isAutoOpen: false, displayName: rec.displayName || null });
    });
    container.appendChild(row);
  });
}

function startLibraryRename(rec, labelEl, rowEl){
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pron-input';
  input.style.flex = '1';
  input.value = libraryBookTitle(rec);
  input.addEventListener('click', ev => ev.stopPropagation());

  let settled = false;
  const confirmRename = async () => {
    if(settled) return;
    settled = true;
    const newName = input.value.trim();
    if(newName) await renameBookInLibrary(rec.id, newName);
    renderLibraryList();
  };
  input.addEventListener('keydown', ev => {
    if(ev.key === 'Enter'){ ev.preventDefault(); confirmRename(); }
    else if(ev.key === 'Escape'){ ev.preventDefault(); settled = true; renderLibraryList(); }
  });
  input.addEventListener('blur', confirmRename);

  labelEl.replaceWith(input);
  input.focus();
  input.select();
}

async function handleFile(file, opts){
  opts = opts || {};
  neuralAudioCache.clear();
  loadStatus.textContent = opts.isAutoOpen ? ('Reopening ' + file.name + ' …') : ('Reading ' + file.name + ' …');
  try{
    const name = file.name.toLowerCase();
    let title = file.name.replace(/\.(epub|pdf)$/i,'');
    const buf = await file.arrayBuffer();
    if(name.endsWith('.epub')){
      chapters = await parseEpub(buf);
    } else if(name.endsWith('.pdf')){
      chapters = await parsePdf(buf.slice(0)); // pdf.js's worker can detach the buffer it's given, so hand it a copy
    } else {
      loadStatus.textContent = 'Please choose an .epub or .pdf file.';
      return;
    }
    if(chapters.length === 0){ loadStatus.textContent = 'Could not find readable text in that file.'; return; }

    bookKey = 'lamplight:' + title + ':' + file.size;
    el('bookTitle').textContent = opts.displayName || title;
    el('bookSub').textContent = chapters.length + (chapters.length===1?' chapter':' chapters') + ' · ' + file.name;

    renderChapterList();
    const saved = loadProgress();
    curChapter = saved ? saved.chapter : 0;
    curSentence = saved ? saved.sentence : 0;
    renderReadingWindow();

    uploadView.classList.add('hidden');
    readerView.classList.remove('hidden');
    player.classList.add('visible');
    el('headerActions').classList.remove('hidden');
    el('headerTag').classList.add('hidden');
    loadStatus.textContent = '';

    if(saved && (saved.chapter>0 || saved.sentence>0)){
      showToast('Resumed where you left off (chapter ' + (saved.chapter+1) + ').');
    }

    saveBookToLibrary(file, buf); // fire-and-forget — adds/updates this book in the library
  } catch(err){
    console.error(err);
    loadStatus.textContent = opts.isAutoOpen
      ? 'Could not reopen your last book automatically — choose a file below.'
      : 'Something went wrong opening that file: ' + err.message;
  }
}

function showToast(msg){
  loadStatus.textContent = msg;
}

// ---------------- Shared: build a chapter from an ordered list of paragraph strings ----------------
function buildChapterFromParagraphTexts(title, paraTexts){
  const sentences = [];
  const sentenceParagraph = [];
  const paragraphs = [];
  paraTexts.forEach(pText => {
    const sents = splitSentences(pText);
    if(!sents.length) return;
    const startIdx = sentences.length;
    sents.forEach(s => { sentences.push(s); sentenceParagraph.push(paragraphs.length); });
    paragraphs.push({ sentenceIndices: sents.map((_, k) => startIdx + k) });
  });
  if(!sentences.length) return null;
  return { title, sentences, sentenceParagraph, paragraphs };
}

// ---------------- EPUB parsing ----------------
// Resolves a possibly-relative href against a base directory the same way a browser
// resolves relative URLs (handling "./", "../", etc.), without ever hitting the network —
// the "file:///" scheme just gives URL something absolute to resolve against.
function resolveEpubPath(baseDir, href){
  const clean = href.split('#')[0];
  try{
    const resolved = new URL(clean, 'file:///' + baseDir).pathname;
    return decodeURIComponent(resolved.replace(/^\//, ''));
  } catch(e){
    return (baseDir + clean).replace(/\/\.\//g, '/');
  }
}

// Real chapter titles live in the EPUB's own navigation document — nav.xhtml (EPUB3)
// or toc.ncx (EPUB2) — not in each content file's own <title>/<h1>. (Per-file <title>
// tags are frequently just the book's own title repeated in every single file, which
// is why using them was producing an identical "chapter title" over and over.)
// Returns a Map from resolved-file-path -> chapter title, keyed by the first spine
// file that title's TOC entry points to.
async function loadEpubTocMap(zip, opfDoc, opfDir, manifest){
  const tocMap = new Map();

  const navItem = Array.from(opfDoc.querySelectorAll('manifest > item'))
    .find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc');
  const ncxHref = ncxId ? manifest[ncxId] : Object.values(manifest).find(h => /\.ncx$/i.test(h));

  async function readZipEntry(path){
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    return f ? await f.async('string') : null;
  }

  if(navItem){
    const navHref = navItem.getAttribute('href');
    const navDir = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/')+1) : '';
    const navFullDir = opfDir + navDir;
    const xml = await readZipEntry(opfDir + navHref);
    if(xml){
      const navDoc = new DOMParser().parseFromString(xml, 'text/html'); // lenient parser handles epub:type fine
      const tocNav = Array.from(navDoc.querySelectorAll('nav')).find(n => {
        const t = (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase();
        return t.includes('toc');
      }) || navDoc.querySelector('nav');
      if(tocNav){
        tocNav.querySelectorAll('a[href]').forEach(a => {
          const text = a.textContent.replace(/\s+/g, ' ').trim();
          if(!text) return;
          const resolved = resolveEpubPath(navFullDir, a.getAttribute('href'));
          if(!tocMap.has(resolved)) tocMap.set(resolved, text);
        });
      }
    }
  }
  if(!tocMap.size && ncxHref){
    const ncxDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/')+1) : '';
    const ncxFullDir = opfDir + ncxDir;
    const xml = await readZipEntry(opfDir + ncxHref);
    if(xml){
      const ncxDoc = new DOMParser().parseFromString(xml, 'application/xml');
      ncxDoc.querySelectorAll('navPoint').forEach(np => {
        const text = (np.querySelector('navLabel > text') || {}).textContent;
        const src = (np.querySelector('content') || {}).getAttribute?.('src');
        if(!text || !src) return;
        const resolved = resolveEpubPath(ncxFullDir, src);
        if(!tocMap.has(resolved)) tocMap.set(resolved, text.replace(/\s+/g, ' ').trim());
      });
    }
  }
  return tocMap;
}

async function parseEpub(buf){
  const zip = await JSZip.loadAsync(buf);
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';
  const opfXml = await zip.file(opfPath).async('string');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  });
  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(i => i.getAttribute('idref'));
  const tocMap = await loadEpubTocMap(zip, opfDoc, opfDir, manifest);

  // Chapters are grouped by TOC entry, not by spine file — many real EPUBs split one
  // logical chapter across several physical files (e.g. "chNN_split_001.html",
  // "chNN_split_002.html"), which used to each show up as their own separate,
  // identically-titled "chapter". A spine file with no TOC entry of its own is a
  // continuation of whichever chapter came before it.
  const groups = [];

  for(const id of spineIds){
    const href = manifest[id];
    if(!href) continue;
    const path = opfDir + href;
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    if(!f) continue;
    const html = await f.async('string');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style').forEach(n => n.remove());
    if(!doc.body) continue;

    // <br> carries no text of its own, so without this two lines joined by a <br>
    // would get glued together into one word once we read textContent below.
    doc.querySelectorAll('br').forEach(br => br.replaceWith(' '));

    // Drop elements explicitly hidden in the markup (some EPUBs hide duplicate/
    // accessibility-only text this way) so it doesn't get read aloud.
    doc.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(n => n.remove());
    doc.querySelectorAll('[style]').forEach(n => {
      if(/display\s*:\s*none/i.test(n.getAttribute('style') || '')) n.remove();
    });

    // Some EPUBs mark paragraphs with <p>, others just use <div>. Match both, but
    // keep only the innermost ("leaf") matches so a wrapper <div> around several
    // <p> tags doesn't get counted as its own paragraph on top of its children.
    const blockSelector = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, div';
    let blocks = Array.from(doc.body.querySelectorAll(blockSelector));
    blocks = blocks.filter(b => !b.querySelector(blockSelector));

    // textContent (unlike innerText) doesn't depend on the page actually being
    // rendered/laid out — this document never gets attached to the page, and
    // innerText silently returns empty text for detached nodes in some browsers.
    let paraTexts = blocks.map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0);
    if(!paraTexts.length){
      const rawWithBreaks = doc.body.textContent; // keep original newlines for a rough paragraph split
      paraTexts = rawWithBreaks.split(/\n\s*\n+/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if(!paraTexts.length){
        const raw = rawWithBreaks.replace(/\s+/g, ' ').trim();
        paraTexts = raw.length ? [raw] : [];
      }
    }
    if(!paraTexts.length) continue;

    const tocTitle = tocMap.get(path);
    if(tocTitle){
      // A real TOC entry always starts a fresh chapter, even if (rarely) its title
      // text happens to repeat an earlier one.
      groups.push({ title: tocTitle, paraTexts: [] });
    } else if(!groups.length){
      // No TOC entry has matched yet at all — front matter (cover, title page, etc.)
      // ahead of the book's first real TOC-listed chapter. Prefer an actual heading
      // in the body over the document's <title> (which is often just the book's own
      // title repeated in every file, not this file's own heading).
      const heading = (doc.body.querySelector('h1,h2,h3') || {}).textContent;
      groups.push({ title: (heading || '').trim() || 'Front Matter', paraTexts: [] });
    }
    // else: continuation file of whichever TOC chapter is currently open — falls
    // through and gets appended to it below, with no new chapter created.
    groups[groups.length - 1].paraTexts.push(...paraTexts);
  }

  const result = [];
  groups.forEach(g => {
    const chapterObj = buildChapterFromParagraphTexts(g.title, g.paraTexts);
    if(chapterObj) result.push(chapterObj);
  });
  return result;
}

// ---------------- PDF parsing ----------------
// Groups a page's text items into lines by vertical position, then splits those
// lines into paragraphs wherever the gap between lines is noticeably bigger than
// the page's own typical line spacing.
async function extractPdfPageParagraphs(page){
  const content = await page.getTextContent();
  const items = content.items;

  const lines = [];
  let curLine = null;
  items.forEach(it => {
    const y = Math.round(it.transform[5]);
    if(curLine && Math.abs(y - curLine.y) <= 2){
      curLine.text += it.str;
    } else {
      curLine = { y, text: it.str };
      lines.push(curLine);
    }
  });

  const gaps = [];
  for(let k=1;k<lines.length;k++) gaps.push(Math.abs(lines[k-1].y - lines[k].y));
  const sortedGaps = gaps.slice().sort((a,b)=>a-b);
  const median = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length/2)] : 14;

  const paras = [];
  let paraLines = [];
  lines.forEach((ln, idx) => {
    if(idx > 0){
      const gap = Math.abs(lines[idx-1].y - ln.y);
      if(gap > median * 1.6 && paraLines.length){
        paras.push(paraLines.join(' '));
        paraLines = [];
      }
    }
    if(ln.text.trim()) paraLines.push(ln.text.trim());
  });
  if(paraLines.length) paras.push(paraLines.join(' '));
  return paras;
}

// Resolves an outline entry's destination to a 1-indexed page number. `dest` is
// either an explicit destination array already, or a named destination string that
// has to be looked up first — either way it ultimately points at a page reference.
async function resolvePdfOutlineDest(pdf, dest){
  try{
    let d = dest;
    if(typeof d === 'string') d = await pdf.getDestination(d);
    if(!d || !d[0]) return null;
    const pageIndex = await pdf.getPageIndex(d[0]);
    return pageIndex + 1;
  } catch(e){ return null; }
}

async function parsePdf(buf){
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;
  const result = [];

  // Real chapter titles and boundaries live in the PDF's own outline/bookmarks when
  // the publisher included one (most converted ebooks do) — far more useful than an
  // arbitrary page count, and gives real chapter names instead of "Pages 9–16". Only
  // top-level entries are used, not nested sub-headings, so this stays at chapter
  // granularity rather than every subsection.
  let plannedChapters = null;
  try{
    let outline = await pdf.getOutline();
    // Some PDFs wrap their entire outline under a single root bookmark named after
    // the book itself, with the real chapter-level entries one level down as its
    // children — unwrap that (repeatedly, in case of more than one such wrapper)
    // rather than treating that lone root as the only "chapter".
    while(outline && outline.length === 1 && outline[0].items && outline[0].items.length){
      outline = outline[0].items;
    }
    if(outline && outline.length){
      const resolved = [];
      for(const item of outline){
        if(!item.dest) continue;
        const page = await resolvePdfOutlineDest(pdf, item.dest);
        const title = (item.title || '').replace(/\s+/g, ' ').trim();
        if(page && title) resolved.push({ title, page });
      }
      resolved.sort((a,b) => a.page - b.page);
      // Some PDFs point several outline entries at the exact same page (e.g. a
      // cover/title page listed twice) — keep only the first for any given page.
      const deduped = resolved.filter((r,i) => i === 0 || r.page !== resolved[i-1].page);
      if(deduped.length){
        plannedChapters = deduped.map((r,i) => ({
          title: r.title,
          startPage: r.page,
          endPage: (i+1 < deduped.length) ? deduped[i+1].page - 1 : pdf.numPages,
        }));
        // Anything before the first bookmark (unlisted front matter) still gets read —
        // just not silently dropped — rather than assuming it's always skippable.
        if(plannedChapters[0].startPage > 1){
          plannedChapters.unshift({ title: 'Front Matter', startPage: 1, endPage: plannedChapters[0].startPage - 1 });
        }
      }
    }
  } catch(e){ console.warn('PDF outline unavailable, falling back to page buckets:', e); }

  if(plannedChapters){
    for(const ch of plannedChapters){
      const paras = [];
      for(let i = ch.startPage; i <= ch.endPage; i++){
        const page = await pdf.getPage(i);
        paras.push(...(await extractPdfPageParagraphs(page)));
      }
      const chapterObj = buildChapterFromParagraphTexts(ch.title, paras);
      if(chapterObj) result.push(chapterObj);
    }
    return result;
  }

  // Fallback for PDFs with no usable outline: bucket every few pages together.
  const PAGES_PER_CHAPTER = 8;
  let bucketParas = [];
  let bucketStart = 1;
  for(let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    bucketParas.push(...(await extractPdfPageParagraphs(page)));
    if(i % PAGES_PER_CHAPTER === 0 || i === pdf.numPages){
      const label = bucketStart === i ? ('Page ' + i) : ('Pages ' + bucketStart + '–' + i);
      const chapterObj = buildChapterFromParagraphTexts(label, bucketParas);
      if(chapterObj) result.push(chapterObj);
      bucketParas = [];
      bucketStart = i+1;
    }
  }
  return result;
}

// ---------------- Sentence splitting ----------------
// Small TTS models like Kokoro can clip the end of very long inputs (their duration
// prediction isn't reliable that far out), so beyond MAX_TTS_CHARS we further split
// at natural pause points — this affects TTS/highlight granularity only, not meaning.
const MAX_TTS_CHARS = 200;

function splitOnPunct(text, punct){
  const re = new RegExp('[^' + punct + ']+' + punct + '+(?:\\s+|$)|[^' + punct + ']+$', 'g');
  const m = text.match(re);
  if(!m || m.length < 2) return [text];
  return m.map(s => s.trim()).filter(Boolean);
}

function hardWrap(text, maxChars){
  const words = text.split(' ');
  const out = [];
  let cur = '';
  words.forEach(w => {
    if(cur && (cur.length + 1 + w.length) > maxChars){
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  });
  if(cur) out.push(cur);
  return out;
}

function splitLongClause(text, maxChars){
  if(text.length <= maxChars) return [text];
  let parts = splitOnPunct(text, ';');
  if(parts.length === 1) parts = splitOnPunct(text, ',');
  if(parts.length === 1) return hardWrap(text, maxChars);
  const out = [];
  parts.forEach(p => out.push(...splitLongClause(p.trim(), maxChars)));
  return out;
}

// Protects common abbreviations and initials (Mr. Mrs. Dr. St. — and things like "C. S. Lewis")
// from being mistaken for sentence endings, by temporarily hiding their periods.
const ABBR_RE = /\b(Mr|Mrs|Ms|Dr|St|Mt|Prof|Rev|Gen|Col|Capt|Lt|Sgt|Sr|Jr|vs|etc|Ph\.D|i\.e|e\.g)\./g;
const INITIAL_RE = /\b([A-Z])\.(?=\s*[A-Z]\.|\s+[A-Z]\b)/g;
function protectAbbreviations(text){
  return text.replace(ABBR_RE, (m, word) => word + '\u0001')
             .replace(INITIAL_RE, (m, letter) => letter + '\u0001');
}
function restoreAbbreviations(text){
  return text.replace(/\u0001/g, '.');
}

// A sentence terminator is very often followed immediately by a closing quote or
// bracket with no space ("...that means." with no gap before the closing quote) —
// without allowing for that, the regex below fails to match at all and silently
// drops the whole sentence.
const SENT_RE = /[^.!?]+[.!?]+[)\]'"\u2019\u201D]*(?:\s+|$)|[^.!?]+$/g;

// Common verbs used in dialogue attribution tags ("...," said Peter / "...?" asked Susan).
const DIALOGUE_TAG_VERBS = 'said|asked|replied|answered|cried|shouted|whispered|muttered|exclaimed|continued|added|began|called|retorted|murmured|sighed|snapped|gasped|sobbed|roared|growled|chuckled|laughed|wondered|declared|announced|remarked|grumbled|protested|went on';

// A quoted question or exclamation immediately followed by its attribution tag
// ("Are you coming?" asked Peter.) is one continuous thought, not two sentences —
// but SENT_RE would otherwise treat the ?/! as a hard sentence break, giving it
// its own separate TTS chunk with an audible gap before "asked Peter." Hide the
// punctuation here (same trick as protectAbbreviations) so it stays one chunk;
// the real ? or ! is restored below, so its intonation still comes through.
const DIALOGUE_END_RE = new RegExp('([?!])([\'"\u2019\u201D]+)(\\s+)(?=(?:\\w+\\s+)?(?:' + DIALOGUE_TAG_VERBS + ')\\b)', 'gi');
function protectDialogueEndings(text){
  return text.replace(DIALOGUE_END_RE, (m, punct, quote, space) => (punct === '?' ? '\u0002' : '\u0003') + quote + space);
}
function restoreDialogueEndings(text){
  return text.replace(/\u0002/g, '?').replace(/\u0003/g, '!');
}

// A sentence ending in terminal punctuation immediately followed by a closing quote
// mark, with nothing else after it, means quoted dialogue is finishing here with no
// attribution tag trailing it — a natural "end of the exchange" moment where a
// narrator would actually take a slightly longer beat before continuing. Cases where
// a tag *does* follow right away ("...?" asked Peter.) were already merged into one
// sentence by protectDialogueEndings above, so they never reach this check — only
// genuine ends of a line of dialogue match.
const QUOTED_SENTENCE_END_RE = /[.!?][)\]'"\u2019\u201D]+\s*$/;
function endsQuotedDialogue(text){
  return QUOTED_SENTENCE_END_RE.test((text || '').trim());
}
const DIALOGUE_END_PAUSE_MS = 220; // extra pause after quoted dialogue ends, on top of the normal between-sentence gap

function splitSentences(text){
  const cleaned = protectDialogueEndings(protectAbbreviations(text.replace(/\s+/g, ' ').trim()));
  if(!cleaned) return [];
  const matches = cleaned.match(SENT_RE) || [cleaned];
  const rough = matches.map(s => restoreDialogueEndings(restoreAbbreviations(s.trim()))).filter(s => s.length > 1);
  const out = [];
  rough.forEach(s => out.push(...splitLongClause(s, MAX_TTS_CHARS)));
  return out;
}

// ---------------- Language filter ----------------
const DEFAULT_BAD_WORDS = ['fuck','shit','bitch','bastard','asshole','cunt','slut','whore','dick','cock','pussy','twat','douche','goddamn','bullshit'];

function loadFilterSettings(){
  try{
    const raw = localStorage.getItem('lamplight:filterSettings');
    if(raw){
      const obj = JSON.parse(raw);
      filterEnabled = !!obj.enabled;
      customBadWords = Array.isArray(obj.custom) ? obj.custom : [];
    }
  } catch(e){ /* ignore */ }
}
function saveFilterSettings(){
  try{
    localStorage.setItem('lamplight:filterSettings', JSON.stringify({enabled: filterEnabled, custom: customBadWords}));
  } catch(e){ /* ignore */ }
}

function badWordsRegex(){
  const words = [...DEFAULT_BAD_WORDS, ...customBadWords].map(w => w.trim()).filter(Boolean);
  if(!words.length) return null;
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + escaped.join('|') + ')\\w*', 'gi');
}

function displayFilteredText(text){
  if(!filterEnabled) return text;
  const re = badWordsRegex();
  if(!re) return text;
  return text.replace(re, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
}

// Em dashes and opening parentheses read naturally with a short breath-pause,
// but VITS/Kokoro/system voices don't treat those marks as pause cues on their
// own — they either glide straight through or (for open-paren) go silent for a
// beat. Swapping in a comma gives the model a pause cue it already knows how to
// render, without being as long as a full sentence break. Speech only — the
// on-screen text is untouched.
function insertNaturalPauses(text){
  return text.replace(/\s*—\s*/g, ', ').replace(/\(/g, ', ');
}

// A title like "Mr." or "Dr." keeps its period once restored from the sentence-
// splitting stage, and a voice model has no way to tell that period apart from a
// real sentence break — it reads the same length pause either way. Expanding to
// the full spoken word removes the period entirely, so there's nothing left to
// misread as a stop. Limited to titles with one unambiguous spoken form (skips
// "St."/"Mt." — Saint or Street, Mount — and "vs."/"etc.", which read fine as-is).
const TITLE_EXPANSIONS = {
  Mr: 'Mister', Mrs: 'Missus', Dr: 'Doctor', Prof: 'Professor',
  Gen: 'General', Col: 'Colonel', Capt: 'Captain', Lt: 'Lieutenant',
  Sgt: 'Sergeant', Rev: 'Reverend', Sr: 'Senior', Jr: 'Junior'
};
const TITLE_RE = new RegExp('\\b(' + Object.keys(TITLE_EXPANSIONS).join('|') + ')\\.', 'g');
function expandSpokenTitles(text){
  return text.replace(TITLE_RE, (m, word) => TITLE_EXPANSIONS[word]);
}

function speechFilteredText(text){
  let out = applyPronunciationRules(text);
  out = expandSpokenTitles(out);
  if(filterEnabled){
    const re = badWordsRegex();
    if(re) out = out.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  }
  out = insertNaturalPauses(out);
  return smoothDialogueTags(out);
}

// ---------------- Pronunciation dictionary ----------------
// Lets the person fix names/words the voice mispronounces — matches the "as
// written" text anywhere it appears and swaps in the "say instead" text, for
// speech only. Blank "say instead" means skip that word/phrase entirely.
function loadPronunciationRules(){
  try{
    const raw = localStorage.getItem('lamplight:pronunciationRules');
    pronunciationRules = raw ? (JSON.parse(raw) || []) : [];
  } catch(e){ pronunciationRules = []; }
}
function savePronunciationRules(){
  try{ localStorage.setItem('lamplight:pronunciationRules', JSON.stringify(pronunciationRules)); } catch(e){ /* ignore */ }
}
function applyPronunciationRules(text){
  if(!pronunciationRules.length) return text;
  let out = text;
  pronunciationRules.forEach(rule => {
    if(!rule || !rule.find) return;
    const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, rule.matchCase ? 'g' : 'gi');
    out = out.replace(re, rule.replace || '');
  });
  return out.replace(/\s{2,}/g, ' ').trim();
}

function renderPronunciationList(){
  const container = el('pronunciationGroup');
  container.innerHTML = '';
  if(!pronunciationRules.length){
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('span');
    label.className = 'settings-row-label';
    label.style.fontWeight = '400';
    label.style.color = 'var(--ink-soft)';
    label.textContent = 'No rules yet';
    row.appendChild(label);
    container.appendChild(row);
    return;
  }
  pronunciationRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('span');
    label.className = 'settings-row-label';
    label.style.fontWeight = '400';
    label.textContent = '"' + rule.find + '" → ' + (rule.replace ? ('"' + rule.replace + '"') : 'Skip') + (rule.matchCase ? ' · match case' : '');
    const delBtn = document.createElement('button');
    delBtn.className = 'modal-close';
    delBtn.setAttribute('aria-label', 'Remove rule');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    delBtn.addEventListener('click', () => {
      pronunciationRules.splice(idx, 1);
      savePronunciationRules();
      renderPronunciationList();
      neuralAudioCache.clear();
    });
    const previewBtn = document.createElement('button');
    previewBtn.className = 'preview-btn';
    previewBtn.setAttribute('aria-label', 'Preview pronunciation');
    previewBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 8,19 19,12"/></svg>';
    previewBtn.addEventListener('click', () => speakPreviewText(rule.replace || rule.find, previewBtn));
    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '8px';
    btnGroup.style.flexShrink = '0';
    btnGroup.appendChild(previewBtn);
    btnGroup.appendChild(delBtn);
    row.appendChild(label);
    row.appendChild(btnGroup);
    container.appendChild(row);
  });
}

// Speaks a short one-off snippet through whichever voice engine is currently active —
// used to test a pronunciation rule without touching the book's own playback state.
async function speakPreviewText(text, btn){
  text = (text || '').trim();
  if(!text) return;
  stopPlayback();
  if(isPlaying){ isPlaying = false; updatePlayButton(); }

  let restoreBtn = null;
  if(btn){
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span style="font-size:10px;">…</span>';
    restoreBtn = () => { btn.disabled = false; btn.innerHTML = original; };
  }
  try{
    if(engine === 'kokoro'){
      const ok = await ensureKokoroReadyGuarded();
      if(!ok) return;
      const voice = el('voiceSelect').value || 'af_heart';
      const speed = parseFloat(el('rateSlider').value);
      const blob = await window.KokoroEngine.generateBlob(text, voice, speed);
      playPreviewBlob(blob);
    } else if(engine === 'piper'){
      const voiceId = el('voiceSelect').value;
      if(!voiceId) return;
      const ready = await ensurePiperVoiceReady(voiceId);
      if(!ready) return;
      const blob = await runPiperSerial(() => withTimeout(window.PiperEngine.generateBlob(text, voiceId), 60000, 'Voice generation'));
      playPreviewBlob(blob);
    }
  } catch(err){
    console.error('Preview failed:', err);
  } finally {
    if(restoreBtn) restoreBtn();
  }
}

function playPreviewBlob(blob){
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  audio.play().catch(err => console.error(err));
}

// A comma right before a closing quote and a speech-tag verb ("...won't," said Peter.)
// is just grammatical glue, not a place anyone would actually pause when speaking —
// but TTS models read it as an ordinary comma pause. Strip it for speech only; the
// displayed text keeps its normal, correctly-punctuated form.
const DIALOGUE_COMMA_RE = new RegExp(',(\\s*[\'"\u2019\u201D]+)(\\s+)(?=(?:\\w+\\s+)?(?:' + DIALOGUE_TAG_VERBS + ')\\b)', 'gi');
function smoothDialogueTags(text){
  return text.replace(DIALOGUE_COMMA_RE, '$1$2');
}

// ---------------- Rendering ----------------
function buildChapterListInto(container){
  container.innerHTML = '';
  chapters.forEach((ch, idx) => {
    const div = document.createElement('div');
    const isActive = idx === curChapter;
    div.className = 'toc-row' + (isActive ? ' active' : '');
    div.dataset.idx = idx;

    const label = document.createElement('span');
    label.textContent = ch.title;
    div.appendChild(label);

    if(isActive){
      div.insertAdjacentHTML('beforeend', '<svg class="check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,13 10,18 19,6"/></svg>');
    }

    div.addEventListener('click', () => {
      stopPlayback();
      isPlaying = false;
      updatePlayButton();
      curChapter = idx; curSentence = 0;
      renderReadingWindow();
      renderChapterList();
      updateProgressBar();
      saveProgress();
      closeModal(el('tocModal'));
    });
    container.appendChild(div);
  });
}

function renderChapterList(){
  buildChapterListInto(chapterList);
  buildChapterListInto(el('tocModalList'));
}

let renderedChapterIdx = -1; // tracks which chapter's text is currently built in the DOM

function renderChapterText(){
  proseText.innerHTML = '';
  const ch = chapters[curChapter];
  if(!ch) return;
  ch.paragraphs.forEach((para, pIdx) => {
    const wrap = document.createElement('div');
    wrap.className = 'para-block';
    wrap.dataset.para = pIdx;
    para.sentenceIndices.forEach(si => {
      const span = document.createElement('span');
      span.className = 's';
      span.textContent = displayFilteredText(ch.sentences[si]) + ' ';
      span.dataset.i = si;
      span.addEventListener('click', () => {
        stopPlayback();
        curSentence = si;
        if(isPlaying) speakCurrent(); else { highlightCurrent(); updateProgressBar(); }
        saveProgress();
      });
      wrap.appendChild(span);
    });
    proseText.appendChild(wrap);
  });
  renderedChapterIdx = curChapter;
}

// Shows the whole chapter, scrollable, rather than just a few paragraphs — only
// rebuilds the DOM when the chapter actually changed (cheap check), so playing
// through a long chapter sentence-by-sentence doesn't rebuild the whole page each
// time or fight the person's own manual scrolling.
function renderReadingWindow(){
  if(renderedChapterIdx !== curChapter){
    renderChapterText();
  }
  highlightCurrent();
  updateMediaSessionMetadata();
}

function highlightCurrent(){
  proseText.querySelectorAll('.s').forEach(s => s.classList.remove('current'));
  const cur = proseText.querySelector('.s[data-i="'+curSentence+'"]');
  if(cur){ cur.classList.add('current'); cur.scrollIntoView({block:'center', behavior:'smooth'}); }

  const ch = chapters[curChapter];
  const curPara = ch ? (ch.sentenceParagraph[curSentence] ?? -1) : -1;
  proseText.querySelectorAll('.para-block').forEach(block => {
    block.classList.toggle('active-para', Number(block.dataset.para) === curPara);
  });
}

function updateProgressBar(){
  const total = chapters[curChapter].sentences.length;
  const pct = total ? Math.round(((curSentence)/total)*100) : 0;
  el('lampProgressFill').style.width = pct + '%';
  el('posLabel').textContent = (curSentence+1) + ' / ' + total;
}

// ---------------- Speech: shared controls ----------------
function stopPlayback(){
  playToken++; // invalidates any in-flight kokoro generation/playback continuations
  if(currentAudioEl){
    currentAudioEl.onended = null;
    currentAudioEl.pause();
    currentAudioEl = null;
  }
}

function friendlyVoiceName(id){
  // Kokoro ids look like "af_heart", "bm_george" — a=American, b=British; f=female, m=male
  const region = id[0] === 'a' ? 'American' : id[0] === 'b' ? 'British' : id[0].toUpperCase();
  const gender = id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : '';
  const name = id.slice(3).replace(/^\w/, c => c.toUpperCase());
  return `${name} — ${region} ${gender}`.trim();
}

// Fills the shared #voiceSelect with whichever engine is currently active. Kokoro's
// list requires the model to be loaded first, so callers that need that to happen
// (Settings opening, pressing Play) trigger it themselves — this just renders.
function refreshVoiceSelect(){
  if(engine === 'piper'){
    populatePiperVoiceSelect();
  } else if(window.KokoroEngine.isLoaded()){
    populateKokoroVoiceSelect();
  }
}

// ---------------- Piper voice (a lighter alternative neural engine to Kokoro) ----------------
function friendlyPiperVoiceName(id){
  // ids look like "en_US-hfc_female-medium" -> lang_region - name - quality
  const parts = id.split('-');
  const name = (parts[1] || id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const quality = parts[2] ? parts[2].charAt(0).toUpperCase() + parts[2].slice(1) : '';
  return quality ? `${name} - ${quality}` : name;
}

// Known, real Piper voice IDs from the standard rhasspy/piper-voices catalog — used
// only if the library's own voices.json manifest fetch fails (which happens if its
// hardcoded Hugging Face path is unreachable from the browser for any reason).
// Downloading a specific voice is a separate, more specific fetch than that manifest,
// so these should still work even when the manifest lookup itself doesn't.
const FALLBACK_PIPER_VOICES = ['en_GB-alan-low','en_GB-alan-medium','en_GB-alba-medium','en_GB-aru-medium','en_GB-cori-high','en_GB-cori-medium','en_GB-jenny_dioco-medium','en_GB-northern_english_male-medium','en_GB-semaine-medium','en_GB-southern_english_female-low','en_GB-vctk-medium','en_US-amy-low','en_US-amy-medium','en_US-arctic-medium','en_US-bryce-medium','en_US-danny-low','en_US-hfc_female-medium','en_US-hfc_male-medium','en_US-joe-medium','en_US-john-medium','en_US-kathleen-low','en_US-kristin-medium','en_US-kusal-medium','en_US-l2arctic-medium','en_US-lessac-high','en_US-lessac-low','en_US-lessac-medium','en_US-libritts-high','en_US-libritts_r-medium','en_US-ljspeech-high','en_US-ljspeech-medium','en_US-mike-medium','en_US-norman-medium','en_US-reza_ibrahim-medium','en_US-ryan-high','en_US-ryan-low','en_US-ryan-medium','en_US-sam-medium'];

async function populatePiperVoiceSelect(){
  const sel = el('voiceSelect');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.textContent = 'Loading voices…';
  sel.appendChild(placeholder);

  let voices;
  try{
    voices = await window.PiperEngine.listVoices();
  } catch(err){
    // Only the server engine throws here (the in-browser one catches its own errors).
    console.error(err);
    if(engine !== 'piper') return;
    placeholder.textContent = 'No voices — see message below';
    setEngineStatus(err && err.message ? err.message : String(err));
    return;
  }
  if(engine !== 'piper') return; // engine was switched again while this was in flight

  sel.innerHTML = '';
  let ids = voiceIdsFrom(voices).filter(id => id.startsWith('en_')).sort();
  if(!ids.length){
    console.warn('Piper voices() returned nothing — falling back to a known voice list.');
    ids = FALLBACK_PIPER_VOICES;
  }
  ids.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = friendlyPiperVoiceName(id);
    sel.appendChild(opt);
  });
  let saved = null;
  try{ saved = localStorage.getItem('lamplight:piperVoice'); } catch(e){ /* ignore */ }
  if(saved && ids.indexOf(saved) >= 0){
    sel.value = saved;
  } else if(ids.indexOf('en_US-hfc_female-medium') >= 0){
    sel.value = 'en_US-hfc_female-medium';
  }
}

// Piper downloads each voice separately (unlike Kokoro's one bundle), so this
// checks whether the specific selected voice is already cached before fetching it.
// Piper's underlying engine isn't safe for overlapping calls — asking it to download
// a voice while also generating audio (easy to trigger now that downloads can start
// from several places: switching engine, switching voice, opening Settings, the
// refresh button) can leave it hung rather than erroring cleanly. Route every actual
// call to it through one serial queue so it only ever does one thing at a time.
let piperQueue = Promise.resolve();
function runPiperSerial(fn){
  const result = piperQueue.then(fn, fn);
  piperQueue = result.then(() => {}, () => {}); // keep the chain alive even after a failure
  return result;
}

const piperReadyPromises = new Map(); // voiceId -> in-flight readiness Promise, to dedupe repeat calls

async function ensurePiperVoiceReady(voiceId){
  if(piperReadyPromises.has(voiceId)) return piperReadyPromises.get(voiceId);
  const promise = runPiperSerial(async () => {
    try{
      const stored = await window.PiperEngine.storedVoices();
      if(Array.isArray(stored) && stored.includes(voiceId)) return true;
    } catch(e){ /* fall through and just try to download it */ }
    setEngineStatus('Downloading voice…');
    try{
      await withTimeout(window.PiperEngine.ensureVoice(voiceId, progress => {
        if(progress && progress.total){
          setEngineStatus('Downloading voice… ' + Math.round(progress.loaded * 100 / progress.total) + '%');
        }
      }), 60000, 'Voice download');
      setEngineStatus('');
      return true;
    } catch(err){
      console.error(err);
      const detail = err && err.message ? err.message : String(err);
      setEngineStatus(useServer ? detail : 'Could not download that voice (' + detail + ').');
      return false;
    }
  });
  piperReadyPromises.set(voiceId, promise);
  promise.finally(() => {
    if(piperReadyPromises.get(voiceId) === promise) piperReadyPromises.delete(voiceId);
  });
  return promise;
}

const FALLBACK_KOKORO_VOICES = ['af_heart','af_bella','af_nicole','af_sarah','af_sky','am_adam','am_michael','am_fenrir','bf_emma','bf_isabella','bm_george','bm_lewis'];

function populateKokoroVoiceSelect(){
  const sel = el('voiceSelect');
  sel.innerHTML = '';
  let list = window.KokoroEngine.listVoices();
  if(!list || !list.length){
    console.warn('Kokoro listVoices() returned nothing — falling back to a known voice list.');
    list = FALLBACK_KOKORO_VOICES;
  }
  list.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = friendlyVoiceName(id);
    sel.appendChild(opt);
  });
  let saved = null;
  try{ saved = localStorage.getItem('lamplight:voice'); } catch(e){ /* ignore */ }
  if(saved && list.indexOf(saved) >= 0){
    sel.value = saved;
  } else if(list.indexOf('af_heart') >= 0){
    sel.value = 'af_heart';
  }
}

// Loads the Kokoro model on first use (downloads once, then cached by the browser).
async function ensureKokoroReady(){
  if(window.KokoroEngine.isLoaded()){
    if(!el('voiceSelect').options.length) populateKokoroVoiceSelect();
    return true;
  }
  setEngineStatus('Downloading neural voice model…');
  try{
    await window.KokoroEngine.ensureLoaded(progress => {
      if(progress && progress.status === 'progress' && progress.progress != null){
        setEngineStatus('Downloading model… ' + Math.round(progress.progress) + '%');
      }
    });
    populateKokoroVoiceSelect();
    setEngineStatus('');
    return true;
  } catch(err){
    console.error(err);
    if(useServer){
      el('voiceSelect').innerHTML = '<option>No voices — see message below</option>';
      setEngineStatus(err && err.message ? err.message : String(err));
    } else {
      setEngineStatus('Could not load the neural voice (needs internet the first time).');
    }
    return false;
  }
}

// Safari — on both Mac and iOS, since they share the same WebKit/JavaScriptCore engine —
// has a known bug where kokoro-js's bundled phonemizer throws
// "TypeError: undefined is not a function" during load, unrelated to device memory.
// (iOS Safari also separately enforces a per-tab memory ceiling that can crash the tab
// outright before any JS error is even thrown.) Detect Safari broadly — including
// iPadOS 13+, which reports as a Mac but exposes multi-touch — and exclude other
// browsers that also carry "Safari" in their user agent string (Chrome, Firefox, Edge
// on iOS all still use WebKit under the hood there, but their own UA tokens distinguish
// them from actual Safari).
function isLikelySafari(){
  const ua = navigator.userAgent || '';
  const iPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || iPadOS13Plus;
  const isActualSafari = /^((?!chrome|crios|fxios|edgios|android).)*safari/i.test(ua);
  return isIOSDevice || isActualSafari;
}

// Falls back to Piper (much lighter at runtime) and updates every bit of UI/storage that
// tracks the active engine, so the fallback sticks rather than silently reverting to
// trying Kokoro again next time the page loads.
function switchToPiperEngine(){
  engine = 'piper';
  try{ localStorage.setItem('lamplight:engine', 'piper'); } catch(e){ /* ignore */ }
  const engineSel = el('engineSelect');
  if(engineSel) engineSel.value = 'piper';
}

// Does the same job as ensureKokoroReady(), but asks first in Safari — loading Kokoro
// there currently fails via a known upstream phonemizer bug (see isLikelySafari() above),
// and on iOS specifically can also crash the tab outright with no catchable error. Every
// caller that triggers a Kokoro load (manual or automatic) should go through this, not
// ensureKokoroReady() directly, so the warning can't be bypassed by any one entry point.
async function ensureKokoroReadyGuarded(){
  if(window.KokoroEngine.isLoaded()) return true;
  if(isLikelySafari() && !useServer){ // the Safari bug below is specific to the in-browser WASM path
    const proceed = window.confirm(
      "Kokoro's neural voice currently has a known bug in Safari (Mac and iPhone/iPad) — " +
      "it fails to load there due to an issue in one of its bundled libraries, and on " +
      "iPhone/iPad it can also crash this tab outright from memory pressure.\n\n" +
      "Piper (the other AI voice) works reliably in Safari.\n\n" +
      "Try loading Kokoro anyway?"
    );
    if(!proceed){
      switchToPiperEngine();
      await populatePiperVoiceSelect();
      const voiceId = el('voiceSelect').value;
      if(voiceId) ensurePiperVoiceReady(voiceId);
      setEngineStatus('Switched to Piper — Kokoro has a known Safari bug right now.');
      return false;
    }
  }
  return ensureKokoroReady();
}

// Rejects with a clear message if the wrapped promise never settles in time,
// instead of leaving playback stuck on "Generating…" forever.
// The Settings sheet is a full-screen overlay that sits on top of the mini-player,
// so status text written only to the player (e.g. "Downloading voice…") is invisible
// while Settings is open — exactly when a person is likely to be watching for it.
// Write it to both places so it's visible regardless of which is showing.
function setEngineStatus(text){
  el('engineStatus').textContent = text;
  el('settingsEngineStatus').textContent = text;
}

function withTimeout(promise, ms, label){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms/1000) + 's')), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

// Fetch (and cache) the audio blob for a given sentence, generating it if needed.
function getKokoroAudio(chapterIdx, sentenceIdx){
  const key = chapterIdx + '-' + sentenceIdx;
  if(!neuralAudioCache.has(key)){
    const ch = chapters[chapterIdx];
    if(!ch || !ch.sentences[sentenceIdx]) return null;
    const voice = el('voiceSelect').value || 'af_heart';
    const speed = parseFloat(el('rateSlider').value);
    const text = speechFilteredText(ch.sentences[sentenceIdx]) || ' ';
    console.time('kokoro-generate:' + key);
    // Kokoro clips carry even more baked-in lead/trail silence than Piper's (measured
    // ~330ms lead + 400-500ms trail per clip) — with sentence-by-sentence playback
    // and no trimming, that's up to ~800ms of dead air at every single sentence
    // boundary. Same fix as Piper: run it through compressSilence.
    const promise = withTimeout(window.KokoroEngine.generateBlob(text, voice, speed), 60000, 'Voice generation')
      .finally(() => console.timeEnd('kokoro-generate:' + key))
      .then(blob => compressSilence(blob, { maxInternalGapMs, edgePadMs: Math.round(maxInternalGapMs / 2) }));
    promise.catch(() => { neuralAudioCache.delete(key); }); // don't cache a permanent failure — allow retry next time
    neuralAudioCache.set(key, promise);
  }
  return neuralAudioCache.get(key);
}

function encodeWavFloat32(samples, sampleRate){
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for(let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); };
  writeStr(0,'RIFF'); view.setUint32(4, 36 + samples.length*2, true); writeStr(8,'WAVE');
  writeStr(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate*2, true);
  view.setUint16(32,2,true); view.setUint16(34,16,true);
  writeStr(36,'data'); view.setUint32(40, samples.length*2, true);
  let offset = 44;
  for(let i=0;i<samples.length;i++, offset+=2){
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s*0x8000 : s*0x7FFF, true);
  }
  return new Blob([buffer], {type:'audio/wav'});
}

// A fresh AudioContext per sentence risks hitting Safari's concurrent-context cap
// after enough sentences, which makes decodeAudioData start silently failing —
// reuse one context for the life of the page instead.
let sharedAudioCtx = null;
function getSharedAudioCtx(){
  if(!sharedAudioCtx){
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  // Browsers auto-suspend AudioContexts that go quiet for a bit — which can happen
  // to this one specifically (it's only used for the brief decode step below, not
  // continuous playback) even while the <audio> element itself is still audibly
  // playing in the background. A suspended context makes decodeAudioData() hang
  // rather than reject, which would silently stall the lookahead buffer. Resuming
  // an already-running context is a harmless no-op, so it's safe to call every time.
  if(sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
  return sharedAudioCtx;
}

// Safari has a long-standing WebKit bug where firing multiple decodeAudioData() calls
// on the same AudioContext concurrently can resolve a promise with a DIFFERENT call's
// audio than the one it was asked to decode — the request doesn't error, it just comes
// back holding someone else's clip. prefetchAhead() deliberately kicks off several
// sentences' worth of generation (and therefore several compressSilence calls) at once,
// so without this queue those decodes race on sharedAudioCtx and a sentence can end up
// playing another sentence's audio. Routing every decode through one serial queue (same
// pattern as runPiperSerial above) means only one is ever in flight, which is cheap —
// each decode is a few ms — and eliminates the race entirely.
let decodeQueue = Promise.resolve();
function runDecodeSerial(fn){
  const result = decodeQueue.then(fn, fn);
  decodeQueue = result.then(() => {}, () => {});
  return result;
}

// VITS-based models like Piper bake silence into the start/end of every clip —
// and with one clip per sentence, those stack into a long gap between sentences.
// Some voices also render a comma as a longer internal pause than reads naturally.
// This trims the outer edges down to a small pad, AND caps any silent run inside
// the clip (e.g. after a comma) at a shorter max, without touching the speech.
//
// Detection is done on short-window RMS energy rather than raw per-sample amplitude.
// VITS-style vocoders rarely output true digital-zero during "silence" — there's
// low-level dither/hum that flickers a handful of samples above a per-sample
// threshold every few dozen samples. A per-sample check treats each of those flickers
// as the end of a silent run, so a real 400ms gap gets fragmented into many tiny
// sub-runs that each individually look "too short to cap" — and the pause survives
// almost entirely uncompressed. Averaging energy over a short frame (15ms) smooths
// past that noise so a genuinely quiet stretch reads as one long run, which is what
// actually lets the cap below do its job.
async function compressSilence(blob, opts){
  opts = opts || {};
  const edgePadMs = opts.edgePadMs != null ? opts.edgePadMs : 60;
  const maxInternalGapMs = opts.maxInternalGapMs != null ? opts.maxInternalGapMs : 150;
  const frameMs = 15;
  try{
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await runDecodeSerial(() => getSharedAudioCtx().decodeAudioData(arrayBuffer));
    const sampleRate = audioBuffer.sampleRate;
    const data = audioBuffer.getChannelData(0);

    const frameLen = Math.max(1, Math.floor(sampleRate * frameMs / 1000));
    const numFrames = Math.ceil(data.length / frameLen);
    const frameRms = new Float32Array(numFrames);
    let peakRms = 0;
    for(let f = 0; f < numFrames; f++){
      const start = f * frameLen;
      const end = Math.min(data.length, start + frameLen);
      let sum = 0;
      for(let i = start; i < end; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      frameRms[f] = rms;
      if(rms > peakRms) peakRms = rms;
    }
    // A frame counts as silent based on its averaged energy, not a single sample —
    // a stray noise spike no longer splits what is really one continuous pause.
    const rmsThreshold = Math.max(peakRms * 0.04, 0.004);
    const frameSilent = f => frameRms[f] < rmsThreshold;

    let startF = 0, endF = numFrames - 1;
    while(startF < numFrames && frameSilent(startF)) startF++;
    while(endF > startF && frameSilent(endF)) endF--;
    if(endF <= startF) return blob; // clip looked fully silent — bail out safely, keep original

    const edgePadFrames = Math.max(1, Math.ceil(edgePadMs / frameMs));
    const maxInternalGapFrames = Math.max(1, Math.ceil(maxInternalGapMs / frameMs));
    const regionStartF = Math.max(0, startF - edgePadFrames);
    const regionEndF = Math.min(numFrames - 1, endF + edgePadFrames);

    // Walk the speech region frame-by-frame, keeping every non-silent frame as-is,
    // but capping the length of any run of consecutive silent frames along the way —
    // this naturally covers both the outer pads (short runs, kept in full) and any
    // internal gap after a comma or title (long runs, trimmed down to the cap).
    const keptFrames = [];
    let f = regionStartF;
    while(f <= regionEndF){
      if(!frameSilent(f)){ keptFrames.push(f); f++; continue; }
      const runStart = f;
      while(f <= regionEndF && frameSilent(f)) f++;
      const runLen = f - runStart;
      const cap = Math.min(runLen, maxInternalGapFrames);
      for(let k = 0; k < cap; k++) keptFrames.push(runStart + k);
    }

    const kept = [];
    keptFrames.forEach(fi => {
      const s = fi * frameLen;
      const e = Math.min(data.length, s + frameLen);
      for(let i = s; i < e; i++) kept.push(data[i]);
    });

    return encodeWavFloat32(Float32Array.from(kept), sampleRate);
  } catch(err){
    console.warn('Silence compression failed, using original audio:', err);
    return blob;
  }
}


function getPiperAudio(chapterIdx, sentenceIdx){
  const key = chapterIdx + '-' + sentenceIdx;
  if(!neuralAudioCache.has(key)){
    const ch = chapters[chapterIdx];
    if(!ch || !ch.sentences[sentenceIdx]) return null;
    const voiceId = el('voiceSelect').value;
    if(!voiceId) return null;
    const text = speechFilteredText(ch.sentences[sentenceIdx]) || ' ';
    console.log('[piper] generating', key, 'with voice:', voiceId);
    console.time('piper-generate:' + key);
    const promise = runPiperSerial(() =>
      withTimeout(window.PiperEngine.generateBlob(text, voiceId), 60000, 'Voice generation')
    ).finally(() => console.timeEnd('piper-generate:' + key))
     .then(blob => compressSilence(blob, { maxInternalGapMs, edgePadMs: Math.round(maxInternalGapMs / 2) })); // strip lead/tail silence, cap any internal gap (e.g. after a comma)
    promise.catch(() => { neuralAudioCache.delete(key); });
    neuralAudioCache.set(key, promise);
  }
  return neuralAudioCache.get(key);
}

// Whole-paragraph generation for server-backed Piper only. Tested against the local
// server up to 3200+ characters with no truncation or quality loss (unlike Kokoro,
// which hits a hard ~500-character wall and silently drops anything past it) — one
// clip per paragraph instead of one per sentence removes almost all of the artificial
// gaps between sentences, at the cost of only being able to highlight/resume at
// paragraph granularity rather than the exact sentence within it.
function getPiperParagraphAudio(chapterIdx, paragraphIdx){
  const key = 'para-' + chapterIdx + '-' + paragraphIdx;
  if(!neuralAudioCache.has(key)){
    const ch = chapters[chapterIdx];
    const para = ch && ch.paragraphs[paragraphIdx];
    if(!para) return null;
    const voiceId = el('voiceSelect').value;
    if(!voiceId) return null;
    const text = para.sentenceIndices.map(si => speechFilteredText(ch.sentences[si])).filter(Boolean).join(' ') || ' ';
    console.log('[piper] generating paragraph', key, 'with voice:', voiceId);
    console.time('piper-para-generate:' + key);
    const promise = runPiperSerial(() =>
      withTimeout(window.PiperEngine.generateBlob(text, voiceId), 90000, 'Voice generation')
    ).finally(() => console.timeEnd('piper-para-generate:' + key))
     .then(blob => compressSilence(blob, { maxInternalGapMs, edgePadMs: Math.round(maxInternalGapMs / 2) }));
    promise.catch(() => { neuralAudioCache.delete(key); });
    neuralAudioCache.set(key, promise);
  }
  return neuralAudioCache.get(key);
}

function speakCurrent(){
  const ch = chapters[curChapter];
  if(!ch || curSentence >= ch.sentences.length){
    // chapter finished — advance
    if(curChapter < chapters.length - 1){
      curChapter++; curSentence = 0;
      renderReadingWindow();
      renderChapterList();
      speakCurrent();
    } else {
      isPlaying = false;
      updatePlayButton();
    }
    return;
  }
  if(engine === 'kokoro') speakCurrentKokoro();
  else speakCurrentPiper();
}

async function speakCurrentKokoro(){
  const myToken = playToken;
  const chapterIdx = curChapter, sentenceIdx = curSentence;
  renderReadingWindow();
  updateProgressBar();

  if(!window.KokoroEngine.isLoaded()){
    const ok = await ensureKokoroReadyGuarded();
    if(myToken !== playToken) return;
    if(!ok){
      if(engine !== 'kokoro' && isPlaying){ speakCurrent(); return; } // fell back to Piper — resume with it
      isPlaying = false; updatePlayButton();
      return;
    }
  }

  setEngineStatus('Generating…');
  let blob;
  try{
    blob = await getKokoroAudio(chapterIdx, sentenceIdx);
  } catch(err){
    console.error(err);
    const detail = err && err.message ? err.message : 'unknown error';
    setEngineStatus('Voice generation failed (' + detail + ') — skipping.');
    if(myToken !== playToken) return;
    if(isPlaying){ curSentence++; saveProgress(); speakCurrent(); }
    return;
  }
  if(myToken !== playToken || !blob) return; // playback was stopped/changed while we waited
  setEngineStatus('');

  const url = URL.createObjectURL(blob);
  const audioEl = el('ttsAudio'); // reuse one persistent element so iOS treats this as one continuous background session
  currentAudioEl = audioEl;
  if(audioEl.dataset.blobUrl) URL.revokeObjectURL(audioEl.dataset.blobUrl);
  audioEl.src = url;
  audioEl.dataset.blobUrl = url;
  const finishedTextKokoro = chapters[chapterIdx].sentences[sentenceIdx];
  audioEl.onended = () => {
    if(myToken !== playToken || !isPlaying) return;
    curSentence++;
    saveProgress();
    const extraPause = endsQuotedDialogue(finishedTextKokoro) ? DIALOGUE_END_PAUSE_MS : 0;
    if(extraPause > 0){
      setTimeout(() => { if(myToken === playToken && isPlaying) speakCurrent(); }, extraPause);
    } else {
      speakCurrent();
    }
  };
  audioEl.play().catch(err => console.error(err));

  // Prefetch several sentences ahead (crossing into the next chapter if needed) —
  // a buffer deep enough to survive the screen locking, not just absorb one slow
  // generation. See the visibilitychange listener above for the bigger burst that
  // fires right as the screen actually locks.
  prefetchAhead(chapterIdx, sentenceIdx, NORMAL_LOOKAHEAD, getKokoroAudio);
}

// First sentence index of whichever paragraph comes after the one containing
// sentenceIdx — across chapter boundaries too. Returns null at the end of the book.
function nextParagraphStart(chapterIdx, sentenceIdx){
  const ch = chapters[chapterIdx];
  const paragraphIdx = ch.sentenceParagraph[sentenceIdx];
  let c = chapterIdx, p = paragraphIdx + 1;
  while(c < chapters.length){
    if(chapters[c].paragraphs[p]) return { chapterIdx: c, sentenceIdx: chapters[c].paragraphs[p].sentenceIndices[0] };
    c++; p = 0;
  }
  return null;
}

const NORMAL_PARAGRAPH_LOOKAHEAD = 2;
const BACKGROUND_BURST_PARAGRAPH_LOOKAHEAD = 8;

function prefetchParagraphsAhead(chapterIdx, paragraphIdx, count){
  let c = chapterIdx, p = paragraphIdx;
  for(let n = 0; n < count; n++){
    p++;
    if(!chapters[c] || p >= chapters[c].paragraphs.length){
      c++; p = 0;
      if(c >= chapters.length || !chapters[c].paragraphs.length) break;
    }
    getPiperParagraphAudio(c, p);
  }
}

async function speakCurrentPiper(){
  const myToken = playToken;
  // Server-backed Piper batches a whole paragraph into one clip (tested reliable well
  // past paragraph length); the in-browser WASM path stays per-sentence since it
  // wasn't part of what was actually tested against here.
  const batching = useServer;
  const chapterIdx = curChapter;
  let ch = chapters[chapterIdx];
  let paragraphIdx = batching ? ch.sentenceParagraph[curSentence] : null;
  if(batching){
    // Snap to the paragraph's first sentence — batched audio can only start there,
    // so the highlight should always match what's actually about to play, even if
    // curSentence pointed mid-paragraph (e.g. from clicking a sentence, or resuming).
    curSentence = ch.paragraphs[paragraphIdx].sentenceIndices[0];
  }
  const sentenceIdx = curSentence;
  renderReadingWindow();
  updateProgressBar();

  const voiceId = el('voiceSelect').value;
  if(!voiceId){
    setEngineStatus('No Piper voice selected yet.');
    isPlaying = false; updatePlayButton();
    return;
  }

  const ready = await ensurePiperVoiceReady(voiceId);
  if(myToken !== playToken) return;
  if(!ready){ isPlaying = false; updatePlayButton(); return; }

  setEngineStatus('Generating…');
  let blob;
  try{
    blob = batching ? await getPiperParagraphAudio(chapterIdx, paragraphIdx) : await getPiperAudio(chapterIdx, sentenceIdx);
  } catch(err){
    console.error(err);
    const detail = err && err.message ? err.message : 'unknown error';
    setEngineStatus('Voice generation failed (' + detail + ') — skipping.');
    if(myToken !== playToken) return;
    if(isPlaying){
      // On failure, skip the whole paragraph when batching (not +1) — retrying the
      // same paragraph text would just fail the same way again.
      const next = batching ? nextParagraphStart(chapterIdx, sentenceIdx) : null;
      if(batching && next){ curChapter = next.chapterIdx; curSentence = next.sentenceIdx; }
      else curSentence++;
      saveProgress(); speakCurrent();
    }
    return;
  }
  if(myToken !== playToken || !blob) return;
  setEngineStatus('');

  const url = URL.createObjectURL(blob);
  const audioEl = el('ttsAudio');
  currentAudioEl = audioEl;
  if(audioEl.dataset.blobUrl) URL.revokeObjectURL(audioEl.dataset.blobUrl);
  audioEl.src = url;
  audioEl.dataset.blobUrl = url;

  // getPiperAudio()/getPiperParagraphAudio() already trim the baked-in lead/tail
  // silence off every clip (see compressSilence), so playback can just run to its
  // natural end.
  const lastSentenceIdx = batching ? ch.paragraphs[paragraphIdx].sentenceIndices.slice(-1)[0] : sentenceIdx;
  let advanced = false;
  const finishedTextPiper = ch.sentences[lastSentenceIdx];
  const advanceToNext = () => {
    if(advanced) return;
    advanced = true;
    if(myToken !== playToken || !isPlaying) return;
    if(batching){
      const next = nextParagraphStart(chapterIdx, sentenceIdx);
      if(next){ curChapter = next.chapterIdx; curSentence = next.sentenceIdx; }
      else { curSentence = lastSentenceIdx + 1; } // past the end — speakCurrent() below handles finishing the book
    } else {
      curSentence++;
    }
    saveProgress();
    const extraPause = endsQuotedDialogue(finishedTextPiper) ? DIALOGUE_END_PAUSE_MS : 0;
    if(extraPause > 0){
      setTimeout(() => { if(myToken === playToken && isPlaying) speakCurrent(); }, extraPause);
    } else {
      speakCurrent();
    }
  };
  audioEl.onended = advanceToNext;
  audioEl.play().catch(err => console.error(err));

  if(batching){
    prefetchParagraphsAhead(chapterIdx, paragraphIdx, NORMAL_PARAGRAPH_LOOKAHEAD);
  } else {
    prefetchAhead(chapterIdx, sentenceIdx, NORMAL_LOOKAHEAD, getPiperAudio);
  }
}

const PLAY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 8,19 19,12"/></svg>';
const PAUSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/></svg>';

function updatePlayButton(){
  const btn = el('playBtn');
  btn.innerHTML = isPlaying ? PAUSE_ICON : PLAY_ICON;
  btn.classList.toggle('is-playing', isPlaying);
  btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  if('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

el('playBtn').addEventListener('click', () => {
  if(isPlaying){
    isPlaying = false;
    stopPlayback();
  } else {
    isPlaying = true;
    speakCurrent();
  }
  updatePlayButton();
});

el('prevBtn').addEventListener('click', () => {
  stopPlayback();
  const ch = chapters[curChapter];
  if(engine === 'piper' && useServer && ch){
    // Jump a full paragraph back, not one sentence — matches the granularity
    // batched Piper playback actually starts clips at.
    const paragraphIdx = ch.sentenceParagraph[curSentence];
    curSentence = paragraphIdx > 0 ? ch.paragraphs[paragraphIdx - 1].sentenceIndices[0] : 0;
  } else if(curSentence > 0){
    curSentence--;
  }
  renderReadingWindow(); updateProgressBar(); saveProgress();
  if(isPlaying) speakCurrent();
});
el('nextBtn').addEventListener('click', () => {
  stopPlayback();
  if(engine === 'piper' && useServer && chapters[curChapter]){
    const next = nextParagraphStart(curChapter, curSentence);
    if(next){ curChapter = next.chapterIdx; curSentence = next.sentenceIdx; }
  } else {
    curSentence++;
    if(curSentence >= chapters[curChapter].sentences.length) curSentence = chapters[curChapter].sentences.length - 1;
  }
  renderReadingWindow(); updateProgressBar(); saveProgress();
  if(isPlaying) speakCurrent();
});
el('rateSlider').addEventListener('input', () => {
  el('rateLabel').textContent = parseFloat(el('rateSlider').value).toFixed(2) + '×';
  neuralAudioCache.clear();
});
el('voiceSelect').addEventListener('change', () => {
  neuralAudioCache.clear();
  try{
    if(engine === 'kokoro'){
      localStorage.setItem('lamplight:voice', el('voiceSelect').value);
    } else if(engine === 'piper'){
      localStorage.setItem('lamplight:piperVoice', el('voiceSelect').value);
      ensurePiperVoiceReady(el('voiceSelect').value); // download now, not when Play is pressed
    }
  } catch(e){ /* ignore */ }
  // Make the switch audible right away — otherwise whatever's already playing (or
  // already generated) keeps using the old voice until the next sentence boundary,
  // which can look like the change did nothing at all.
  if(isPlaying){
    stopPlayback();
    speakCurrent();
  }
});
el('lampProgress').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const total = chapters[curChapter].sentences.length;
  curSentence = Math.min(total-1, Math.max(0, Math.round(pct * total)));
  stopPlayback();
  renderReadingWindow(); updateProgressBar(); saveProgress();
  if(isPlaying) speakCurrent();
});

// ---------------- Progress persistence ----------------
function saveProgress(){
  if(!bookKey) return;
  try{
    localStorage.setItem(bookKey, JSON.stringify({chapter: curChapter, sentence: curSentence}));
  }catch(e){ /* storage full or unavailable — ignore */ }
}
function loadProgress(){
  if(!bookKey) return null;
  try{
    const raw = localStorage.getItem(bookKey);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

window.addEventListener('beforeunload', () => stopPlayback());

// ---------------- Auto-reopen the most recent book on load ----------------
(async function autoOpenLastBook(){
  const books = await listLibraryBooks();
  renderLibraryList(books); // ready in case auto-open fails or the person hits Library later
  const record = books[0];
  if(!record || !record.data || !record.data.byteLength) return;
  loadStatus.textContent = 'Reopening ' + record.name + ' …';
  try{
    const file = new File([record.data], record.name, { type: record.type || '' });
    await handleFile(file, { isAutoOpen: true, displayName: record.displayName || null });
  } catch(err){
    console.warn('Auto-reopen failed:', err);
    loadStatus.textContent = '';
  }
})();
