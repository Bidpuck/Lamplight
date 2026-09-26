// Lamplight — the voice. One interface over Kokoro and Piper, whether they run in
// this browser (WASM) or on a voice server, plus the audio clean-up every clip goes
// through. Everything the rest of the app needs is on the `Voice` object at the end.
//
// The in-browser engines register as window.KokoroWasmEngine / window.PiperWasmEngine
// once their modules (and, for Piper, its CDN library) have loaded. The server engines
// implement the identical interface (ensureLoaded/isLoaded/listVoices/generateBlob for
// Kokoro; listVoices/storedVoices/ensureVoice/generateBlob for Piper), so the rest of
// this file never cares which one is active.

const VoiceSettings = {
  engine: 'piper',          // 'kokoro' | 'piper'
  useServer: true,          // generate on a voice server instead of in this browser
  serverUrl: 'https://bens-macbook-pro.tail2a16fc.ts.net:8123',
  gapMs: 80,                // longest silent gap kept between/inside sentences (see compressSilence)
  speed: 1,
  kokoroVoice: 'af_heart',
  piperVoice: 'en_US-hfc_female-medium'
};
(function loadVoiceSettings(){
  const e = settingGet('engine', null); if(e === 'kokoro' || e === 'piper') VoiceSettings.engine = e;
  const s = settingGet('useServer', null); if(s !== null) VoiceSettings.useServer = s === '1';
  const u = settingGet('serverUrl', null); if(u) VoiceSettings.serverUrl = u;
  const g = parseInt(settingGet('maxInternalGapMs', ''), 10); if(g) VoiceSettings.gapMs = g;
  const sp = parseFloat(settingGet('speed', '')); if(sp) VoiceSettings.speed = sp;
  const kv = settingGet('voice', null); if(kv) VoiceSettings.kokoroVoice = kv;
  const pv = settingGet('piperVoice', null); if(pv) VoiceSettings.piperVoice = pv;
})();

// Status text ("Downloading voice… 40%", "Generating…") goes to whoever subscribed.
const voiceStatusListeners = [];
function setEngineStatus(text){ voiceStatusListeners.forEach(fn => { try{ fn(text || ''); } catch(e){ /* ignore */ } }); }

function withTimeout(promise, ms, label){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms/1000) + 's')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// The Kokoro/Piper engines live in <script type="module"> files that fetch a library
// from a CDN — they may not be attached to window yet, so wait for whichever one is
// needed rather than assuming it's ready.
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

// ---------------- Voice server ----------------
// Wraps fetch() for every server call so a failure says *what* went wrong. A bare
// fetch() rejection on iOS is just "Load failed" — which covers the Mac being asleep,
// the server not running, Tailscale being off on this device, and the server refusing
// the request (CORS) alike — and an unreachable host can leave a request pending for
// minutes, so voice-list requests also get a timeout.
async function serverFetch(path, options, timeoutMs){
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try{
    return await fetch(VoiceSettings.serverUrl + path, Object.assign({}, options, controller ? { signal: controller.signal } : {}));
  } catch(err){
    const why = err && err.name === 'AbortError' ? 'no answer after ' + Math.round(timeoutMs/1000) + 's' : 'connection failed';
    throw new Error("Can't reach the voice server at " + VoiceSettings.serverUrl + ' (' + why + '). ' +
      'Check that the server is running and awake (a sleeping Hugging Face Space takes a minute or two to wake), ' +
      'and for the Mac server that Tailscale is on for this device.');
  } finally {
    if(timer) clearTimeout(timer);
  }
}
const SERVER_VOICES_TIMEOUT_MS = 15000;

async function serverErrorFrom(res, path){
  let detail = '';
  try{ detail = (await res.json()).detail || ''; } catch(e){ /* not JSON */ }
  return new Error(detail ? 'Voice server: ' + detail : 'Voice server answered with HTTP ' + res.status + ' for ' + path + '.');
}

// Connection popup: shown while the server's voice list is being fetched (the step
// that proves the server is reachable and ready). A Hugging Face Space that has gone
// to sleep takes a minute or two to wake, so this keeps retrying with a visible timer.
const SERVER_WAKE_MAX_MS = 4 * 60 * 1000;
const SERVER_RETRY_DELAY_MS = 4000;
let connectToastTicker = null, connectToastHideTimer = null;
const el = id => document.getElementById(id);

function setConnectToast(state, title, detail){
  const toast = el('connectToast'); if(!toast) return;
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
    const toast = el('connectToast'); if(!toast) return;
    toast.classList.add('fading');
    connectToastHideTimer = setTimeout(() => toast.classList.add('hidden'), 260);
  }, delayMs || 0);
}

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
        if(!VoiceSettings.useServer) throw new Error('Voice server was turned off.');
        let res = null;
        try{ res = await serverFetch(path, {}, SERVER_VOICES_TIMEOUT_MS); }
        catch(err){ lastErr = err; }
        if(res && res.ok){
          try{
            const data = await res.json();
            clearInterval(connectToastTicker);
            const count = voiceIdsFrom(data.voices).length;
            setConnectToast('ready', 'Voice server ready', count + ' voices available.');
            hideConnectToast(1400);
            return data.voices;
          } catch(err){ lastErr = new Error('The voice server sent back something other than a voice list.'); }
        } else if(res && (res.status >= 500 || res.status === 429)){
          lastErr = await serverErrorFrom(res, path);
        } else if(res){
          throw await serverErrorFrom(res, path);
        }
        if(Date.now() - started > SERVER_WAKE_MAX_MS) throw lastErr;
        await new Promise(resolve => setTimeout(resolve, SERVER_RETRY_DELAY_MS));
      }
    } catch(err){
      clearInterval(connectToastTicker);
      if(VoiceSettings.useServer) setConnectToast('error', "Couldn't connect to the voice server", err && err.message ? err.message : String(err));
      else hideConnectToast(0);
      throw err;
    } finally {
      serverVoicesInFlight.delete(path);
    }
  })();
  serverVoicesInFlight.set(path, attempt);
  return attempt;
}

function voiceIdsFrom(voices){
  if(Array.isArray(voices)) return voices.map(v => typeof v === 'string' ? v : (v && (v.id || v.name))).filter(Boolean);
  return (voices && typeof voices === 'object') ? Object.keys(voices) : [];
}

// A server may tell us where each sentence of a batched clip starts, as a header of
// comma-separated seconds ("0,2.31,5.02"). Older servers don't; the blob then carries
// no offsets and the player estimates them from sentence length.
async function generateViaServer(enginePath, text, voice, speed, sentences){
  const body = { text, voice, speed };
  if(sentences && sentences.length > 1) body.sentences = sentences;
  const res = await serverFetch('/' + enginePath + '/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if(!res.ok){
    let detail = 'HTTP ' + res.status;
    try{ const errBody = await res.json(); if(errBody.detail) detail = errBody.detail; } catch(e){ /* ignore */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const header = res.headers.get('X-Sentence-Offsets');
  if(header){
    const offsets = header.split(',').map(parseFloat).filter(n => !isNaN(n));
    if(offsets.length) blob.sentenceOffsets = offsets;
  }
  return blob;
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
    if(piperServerVoicesCache) return piperServerVoicesCache;
    return await piperServerEngine.listVoices();
  },
  async ensureVoice(){ await piperServerEngine.listVoices(); return true; },
  async generateBlob(text, voiceId, sentences){ return generateViaServer('piper', text, voiceId, VoiceSettings.speed, sentences); }
};

let kokoroWasmEngine = null, piperWasmEngine = null;
function applyEngineBackends(){
  const ke = VoiceSettings.useServer ? kokoroServerEngine : kokoroWasmEngine;
  const pe = VoiceSettings.useServer ? piperServerEngine : piperWasmEngine;
  if(ke) window.KokoroEngine = ke;
  if(pe) window.PiperEngine = pe;
}
applyEngineBackends();
waitForGlobal('KokoroWasmEngine').then(ke => { if(ke){ kokoroWasmEngine = ke; applyEngineBackends(); } });
waitForGlobal('PiperWasmEngine').then(pe => { if(pe){ piperWasmEngine = pe; applyEngineBackends(); } });

// ---------------- Voice names ----------------
function friendlyVoiceName(id){
  // Kokoro ids look like "af_heart", "bm_george" — a=American, b=British; f=female, m=male
  const region = id[0] === 'a' ? 'American' : id[0] === 'b' ? 'British' : id[0].toUpperCase();
  const gender = id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : '';
  const name = id.slice(3).replace(/^\w/, c => c.toUpperCase());
  return { name, detail: (region + ' ' + gender).trim() };
}
function friendlyPiperVoiceName(id){
  // ids look like "en_US-hfc_female-medium" -> lang_region - name - quality
  const parts = id.split('-');
  const name = (parts[1] || id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const quality = parts[2] ? parts[2].charAt(0).toUpperCase() + parts[2].slice(1) : '';
  const region = parts[0] === 'en_GB' ? 'British' : parts[0] === 'en_US' ? 'American' : parts[0];
  return { name, detail: [region, quality].filter(Boolean).join(' · ') };
}

const FALLBACK_PIPER_VOICES = ['en_GB-alan-low','en_GB-alan-medium','en_GB-alba-medium','en_GB-aru-medium','en_GB-cori-high','en_GB-cori-medium','en_GB-jenny_dioco-medium','en_GB-northern_english_male-medium','en_GB-semaine-medium','en_GB-southern_english_female-low','en_GB-vctk-medium','en_US-amy-low','en_US-amy-medium','en_US-arctic-medium','en_US-bryce-medium','en_US-danny-low','en_US-hfc_female-medium','en_US-hfc_male-medium','en_US-joe-medium','en_US-john-medium','en_US-kathleen-low','en_US-kristin-medium','en_US-kusal-medium','en_US-l2arctic-medium','en_US-lessac-high','en_US-lessac-low','en_US-lessac-medium','en_US-libritts-high','en_US-libritts_r-medium','en_US-ljspeech-high','en_US-ljspeech-medium','en_US-mike-medium','en_US-norman-medium','en_US-reza_ibrahim-medium','en_US-ryan-high','en_US-ryan-low','en_US-ryan-medium','en_US-sam-medium'];
const FALLBACK_KOKORO_VOICES = ['af_heart','af_bella','af_nicole','af_sarah','af_sky','am_adam','am_michael','am_fenrir','bf_emma','bf_isabella','bm_george','bm_lewis'];

// Piper's underlying engine isn't safe for overlapping calls (a download during a
// generate can hang it), so every call goes through one serial queue.
let piperQueue = Promise.resolve();
function runPiperSerial(fn){
  const result = piperQueue.then(fn, fn);
  piperQueue = result.then(() => {}, () => {});
  return result;
}

const piperReadyPromises = new Map();
async function ensurePiperVoiceReady(voiceId){
  if(piperReadyPromises.has(voiceId)) return piperReadyPromises.get(voiceId);
  const promise = runPiperSerial(async () => {
    if(!window.PiperEngine){ setEngineStatus('Piper voice engine is still loading.'); return false; }
    try{
      const stored = await window.PiperEngine.storedVoices();
      if(Array.isArray(stored) && stored.includes(voiceId)) return true;
    } catch(e){ /* fall through and just try to download it */ }
    setEngineStatus('Downloading voice…');
    try{
      await withTimeout(window.PiperEngine.ensureVoice(voiceId, progress => {
        if(progress && progress.total) setEngineStatus('Downloading voice… ' + Math.round(progress.loaded * 100 / progress.total) + '%');
      }), 60000, 'Voice download');
      setEngineStatus('');
      return true;
    } catch(err){
      console.error(err);
      const detail = err && err.message ? err.message : String(err);
      setEngineStatus(VoiceSettings.useServer ? detail : 'Could not download that voice (' + detail + ').');
      return false;
    }
  });
  piperReadyPromises.set(voiceId, promise);
  promise.finally(() => { if(piperReadyPromises.get(voiceId) === promise) piperReadyPromises.delete(voiceId); });
  return promise;
}

async function ensureKokoroReady(){
  if(!window.KokoroEngine){ setEngineStatus('Kokoro voice engine is still loading.'); return false; }
  if(window.KokoroEngine.isLoaded()) return true;
  setEngineStatus(VoiceSettings.useServer ? 'Connecting to voice server…' : 'Downloading neural voice model…');
  try{
    await window.KokoroEngine.ensureLoaded(progress => {
      if(progress && progress.status === 'progress' && progress.progress != null){
        setEngineStatus('Downloading model… ' + Math.round(progress.progress) + '%');
      }
    });
    setEngineStatus('');
    return true;
  } catch(err){
    console.error(err);
    setEngineStatus(VoiceSettings.useServer ? (err && err.message ? err.message : String(err)) : 'Could not load the neural voice (needs internet the first time).');
    return false;
  }
}

// Safari (Mac and iOS share WebKit) has a known bug where kokoro-js's bundled phonemizer
// throws during load, and iOS can crash the tab outright from memory pressure. Detect
// Safari broadly, including iPadOS 13+, which reports as a Mac but exposes multi-touch.
function isLikelySafari(){
  const ua = navigator.userAgent || '';
  const iPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || iPadOS13Plus;
  const isActualSafari = /^((?!chrome|crios|fxios|edgios|android).)*safari/i.test(ua);
  return isIOSDevice || isActualSafari;
}

async function ensureKokoroReadyGuarded(){
  if(window.KokoroEngine && window.KokoroEngine.isLoaded()) return true;
  if(isLikelySafari() && !VoiceSettings.useServer){
    const proceed = window.confirm(
      "Kokoro's neural voice currently has a known bug in Safari (Mac and iPhone/iPad) — " +
      "it fails to load there due to an issue in one of its bundled libraries, and on " +
      "iPhone/iPad it can also crash this tab outright from memory pressure.\n\n" +
      "Piper (the other AI voice) works reliably in Safari.\n\n" +
      "Try loading Kokoro anyway?"
    );
    if(!proceed){
      Voice.setEngine('piper');
      setEngineStatus('Switched to Piper — Kokoro has a known Safari bug right now.');
      return false;
    }
  }
  return ensureKokoroReady();
}

// ---------------- Audio clean-up ----------------
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

// One AudioContext for the life of the page (Safari caps concurrent contexts), resumed
// on every use because browsers suspend a quiet context, and a suspended one makes
// decodeAudioData() hang rather than reject.
let sharedAudioCtx = null;
function getSharedAudioCtx(){
  if(!sharedAudioCtx){
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  if(sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
  return sharedAudioCtx;
}

// Safari can resolve concurrent decodeAudioData() calls with each other's audio, so
// decodes run one at a time.
let decodeQueue = Promise.resolve();
function runDecodeSerial(fn){
  const result = decodeQueue.then(fn, fn);
  decodeQueue = result.then(() => {}, () => {});
  return result;
}

// VITS-based models like Piper (and Kokoro too) bake silence into the start and end of
// every clip, and some voices render a comma as a longer pause than reads naturally.
// This trims the outer edges to a small pad and caps any silent run inside the clip,
// without touching the speech. Detection uses short-window RMS energy rather than raw
// per-sample amplitude, because vocoder "silence" carries low-level noise that would
// otherwise fragment one long pause into many short ones that never get capped.
//
// The returned blob carries `durationSec`, and when `opts.offsetsSec` is given (where
// each sentence starts in the original clip) also `sentenceOffsets`, remapped so they
// still point at the same speech after the trimming.
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
    const rmsThreshold = Math.max(peakRms * 0.04, 0.004);
    const frameSilent = f => frameRms[f] < rmsThreshold;

    let startF = 0, endF = numFrames - 1;
    while(startF < numFrames && frameSilent(startF)) startF++;
    while(endF > startF && frameSilent(endF)) endF--;
    if(endF <= startF){ // clip looked fully silent — keep the original
      blob.durationSec = audioBuffer.duration;
      if(opts.offsetsSec) blob.sentenceOffsets = opts.offsetsSec.slice();
      return blob;
    }

    const edgePadFrames = Math.max(1, Math.ceil(edgePadMs / frameMs));
    const maxInternalGapFrames = Math.max(1, Math.ceil(maxInternalGapMs / frameMs));
    const regionStartF = Math.max(0, startF - edgePadFrames);
    const regionEndF = Math.min(numFrames - 1, endF + edgePadFrames);

    // Walk the speech region, keeping every non-silent frame and capping each run of
    // silent frames. newFrameOf[f] records where an original frame landed, so sentence
    // offsets can be carried across the edit.
    const keptFrames = [];
    const newFrameOf = new Int32Array(numFrames).fill(-1);
    let f = regionStartF;
    while(f <= regionEndF){
      if(!frameSilent(f)){ newFrameOf[f] = keptFrames.length; keptFrames.push(f); f++; continue; }
      const runStart = f;
      while(f <= regionEndF && frameSilent(f)) f++;
      const runLen = f - runStart;
      const cap = Math.min(runLen, maxInternalGapFrames);
      for(let k = 0; k < cap; k++){ newFrameOf[runStart + k] = keptFrames.length; keptFrames.push(runStart + k); }
    }

    const kept = new Float32Array(keptFrames.length * frameLen);
    let w = 0;
    keptFrames.forEach(fi => {
      const s = fi * frameLen;
      const e = Math.min(data.length, s + frameLen);
      for(let i = s; i < e; i++) kept[w++] = data[i];
    });
    const out = encodeWavFloat32(kept.subarray(0, w), sampleRate);
    out.durationSec = w / sampleRate;
    if(opts.offsetsSec){
      out.sentenceOffsets = opts.offsetsSec.map(sec => {
        let fi = Math.min(numFrames - 1, Math.max(0, Math.floor(sec * sampleRate / frameLen)));
        // A sentence boundary usually sits inside trimmed silence: move forward to the
        // first frame that survived so the highlight changes as the speech resumes.
        while(fi < numFrames && newFrameOf[fi] < 0) fi++;
        const nf = fi < numFrames ? newFrameOf[fi] : keptFrames.length;
        return nf * frameLen / sampleRate;
      });
    }
    return out;
  } catch(err){
    console.warn('Silence compression failed, using original audio:', err);
    if(opts.offsetsSec) blob.sentenceOffsets = opts.offsetsSec.slice(); // untrimmed, so the originals still apply
    return blob;
  }
}

// Reads a clip's length without playing it, for clips that skipped compression.
async function blobDuration(blob){
  if(blob.durationSec) return blob.durationSec;
  try{
    const ab = await blob.arrayBuffer();
    const decoded = await runDecodeSerial(() => getSharedAudioCtx().decodeAudioData(ab));
    blob.durationSec = decoded.duration;
  } catch(e){ /* leave unknown */ }
  return blob.durationSec || 0;
}

// ---------------- The one interface the app uses ----------------
const Voice = {
  settings: VoiceSettings,
  onStatus(fn){ voiceStatusListeners.push(fn); },
  isLikelySafari,

  currentVoiceId(){ return VoiceSettings.engine === 'kokoro' ? VoiceSettings.kokoroVoice : VoiceSettings.piperVoice; },
  setVoiceId(id){
    if(VoiceSettings.engine === 'kokoro'){ VoiceSettings.kokoroVoice = id; settingSet('voice', id); }
    else { VoiceSettings.piperVoice = id; settingSet('piperVoice', id); if(!VoiceSettings.useServer) ensurePiperVoiceReady(id); }
  },
  voiceLabel(id){ return VoiceSettings.engine === 'kokoro' ? friendlyVoiceName(id) : friendlyPiperVoiceName(id); },
  setEngine(e){ VoiceSettings.engine = e; settingSet('engine', e); },
  setUseServer(on){ VoiceSettings.useServer = !!on; settingSet('useServer', on ? '1' : '0'); applyEngineBackends(); if(!on) hideConnectToast(0); },
  setServerUrl(url){
    VoiceSettings.serverUrl = (url || '').trim().replace(/\/+$/, ''); settingSet('serverUrl', VoiceSettings.serverUrl);
    kokoroServerVoicesCache = null; piperServerVoicesCache = null;
  },
  setGapMs(ms){ VoiceSettings.gapMs = ms; settingSet('maxInternalGapMs', ms); },
  setSpeed(s){ VoiceSettings.speed = s; settingSet('speed', s); },
  forgetServer(){ kokoroServerVoicesCache = null; piperServerVoicesCache = null; },

  // Server-backed Piper reads a whole paragraph as one clip (tested well past
  // paragraph length with no truncation), which removes the artificial gaps between
  // sentences. Kokoro clips the end of long inputs, so it stays per sentence.
  batchesParagraphs(){ return VoiceSettings.engine === 'piper' && VoiceSettings.useServer; },

  // Loads whatever the current engine needs before it can speak. Resolves false when
  // it can't (and has already shown why through onStatus).
  async ensureReady(){
    if(VoiceSettings.engine === 'kokoro') return ensureKokoroReadyGuarded();
    const id = VoiceSettings.piperVoice;
    if(!id){ setEngineStatus('No Piper voice selected yet.'); return false; }
    return ensurePiperVoiceReady(id);
  },

  // Voices for the current engine, as [{id, name, detail}]. Loads the engine or
  // connects to the server first if that hasn't happened.
  async listVoices(){
    let ids = [];
    if(VoiceSettings.engine === 'kokoro'){
      const ok = await ensureKokoroReadyGuarded();
      if(!ok) return [];
      ids = window.KokoroEngine.listVoices();
      if(!ids || !ids.length) ids = FALLBACK_KOKORO_VOICES;
      if(!ids.includes(VoiceSettings.kokoroVoice)) VoiceSettings.kokoroVoice = ids.includes('af_heart') ? 'af_heart' : ids[0];
    } else {
      if(!window.PiperEngine) await waitForGlobal('PiperWasmEngine');
      if(!window.PiperEngine){ setEngineStatus('Piper voice engine could not load.'); return []; }
      let voices;
      try{ voices = await window.PiperEngine.listVoices(); }
      catch(err){ console.error(err); setEngineStatus(err && err.message ? err.message : String(err)); return []; }
      ids = voiceIdsFrom(voices).filter(id => id.startsWith('en_')).sort();
      if(!ids.length) ids = FALLBACK_PIPER_VOICES;
      if(!ids.includes(VoiceSettings.piperVoice)) VoiceSettings.piperVoice = ids.includes('en_US-hfc_female-medium') ? 'en_US-hfc_female-medium' : ids[0];
      setEngineStatus('');
    }
    return ids.map(id => Object.assign({ id }, Voice.voiceLabel(id)));
  },

  // Generates one clip. `sentences` is the list of spoken sentences the text is made
  // of (one entry for a single sentence). Resolves to a Blob carrying durationSec and,
  // for several sentences, sentenceOffsets in seconds.
  async generate(sentences){
    const text = sentences.join(' ') || ' ';
    const gap = VoiceSettings.gapMs;
    const opts = { maxInternalGapMs: gap, edgePadMs: Math.round(gap / 2) };
    let raw;
    if(VoiceSettings.engine === 'kokoro'){
      raw = await withTimeout(window.KokoroEngine.generateBlob(text, VoiceSettings.kokoroVoice, VoiceSettings.speed), 60000, 'Voice generation');
    } else {
      raw = await runPiperSerial(() => withTimeout(window.PiperEngine.generateBlob(text, VoiceSettings.piperVoice, sentences), 90000, 'Voice generation'));
    }
    if(sentences.length > 1){
      if(raw.sentenceOffsets && raw.sentenceOffsets.length === sentences.length){
        opts.offsetsSec = raw.sentenceOffsets;
      } else {
        // No offsets from the server: split the clip's length by sentence length. Not
        // exact, but it keeps the highlight moving through a long paragraph instead of
        // sitting on its first sentence.
        const dur = await blobDuration(raw);
        const total = sentences.reduce((a, s) => a + s.length + 8, 0);
        let acc = 0;
        opts.offsetsSec = sentences.map(s => { const at = acc / total * dur; acc += s.length + 8; return at; });
        opts.estimated = true;
      }
    }
    const out = await compressSilence(raw, opts);
    if(opts.estimated) out.offsetsEstimated = true;
    if(!out.durationSec) await blobDuration(out);
    return out;
  },

  // Speaks a short snippet through the current voice (pronunciation preview).
  async preview(text){
    text = (text || '').trim();
    if(!text) return;
    const ok = await Voice.ensureReady();
    if(!ok) return;
    const blob = await Voice.generate([speechFilteredText(text) || text]);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
    await audio.play();
  }
};
