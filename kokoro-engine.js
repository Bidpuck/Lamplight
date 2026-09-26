  // Kokoro TTS — 82M-parameter neural voice, runs 100% locally via WASM. Loaded lazily,
  // only when the person actually presses play (it's a real download).
  //
  // Model loading and per-sentence generation both run inside a dedicated Web Worker,
  // not here on the main thread. WASM inference on the main thread can occupy it long
  // enough that the browser's own hang detector kills the tab before our app-level
  // withTimeout() ever gets a chance to run — setTimeout callbacks only fire when the
  // event loop is free, and a busy main thread starves them just like everything else.
  // A worker has its own thread, so the UI (and our timeout) stay responsive regardless
  // of how long a given sentence takes to synthesize.
  //
  // The worker is built from a Blob URL rather than a separate file, since this whole
  // app is one HTML file — module workers support static `import` of a full URL from
  // inside a Blob just like a normal <script type="module"> can, so kokoro-js still
  // loads straight from the CDN, just inside the worker's own thread instead of this one.
  const KOKORO_WORKER_SRC = `
    import { KokoroTTS, env } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";

    // onnxruntime-web (which kokoro-js runs on) locates its .wasm binaries relative to
    // import.meta.url by default. That works fine for a normal <script type="module">
    // loaded from a real CDN path, but this worker is built from a Blob URL — inside it,
    // import.meta.url IS the blob: URL, which has no sibling files to resolve a .wasm
    // path against. Left on auto-detect, the load can hang indefinitely waiting on a
    // fetch to a URL that can never resolve, with no error ever thrown to catch. Pointing
    // wasmPaths at kokoro-js's actual onnxruntime-web dependency version on jsdelivr
    // sidesteps the guesswork entirely. kokoro-js only re-exports a partial 'env' (just
    // cacheDir/wasmPaths, forwarded to transformers.js's underlying onnx backend config)
    // — that's all we need here.
    env.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";

    let ttsInstance = null;
    let loadingPromise = null;

    function encodeWav(samples, sampleRate){
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

    self.onmessage = async (event) => {
      const msg = event.data;
      try{
        if(msg.type === 'load'){
          if(ttsInstance){ self.postMessage({ type: 'load:done' }); return; }
          if(!loadingPromise){
            // Prefer WebGPU when it's available: it's dramatically faster than WASM for
            // this kind of matmul-heavy inference, and every reference implementation
            // (Hugging Face's own kokoro worker included) detects and prefers it the same
            // way. This is safe to do unconditionally here because Safari — the one
            // browser where WebGPU is unstable enough to crash the whole tab — never
            // reaches this code at all: isLikelySafari() in the main script already
            // diverts Safari to Piper before ensureKokoroReadyGuarded() ever tries to
            // load Kokoro. Only non-Safari browsers (Chrome, Edge, Firefox) get here.
            //
            // dtype follows device, not the other way around: Kokoro's own docs
            // recommend fp32 for WebGPU (its 8-bit path is tuned for CPU efficiency and
            // doesn't carry the same benefit on GPU) and q8 for WASM, where q4 would use
            // the MatMulNBits op that onnxruntime-web's WASM backend doesn't reliably
            // support — it can fail the model load entirely, not just run slower.
            const useWebGPU = !!(self.navigator && self.navigator.gpu);
            console.log('[kokoro-worker] navigator.gpu present:', useWebGPU, '-> device:', useWebGPU ? 'webgpu' : 'wasm', 'dtype:', useWebGPU ? 'fp32' : 'q8');
            if(useWebGPU){
              // Diagnostic only — separate from whatever adapter transformers.js requests
              // internally for the actual model; requesting one here doesn't consume or
              // lock anything, it's just a probe so we can see in the console whether the
              // browser handed back a real GPU adapter or a software/CPU-emulated one
              // (which would be slower than plain WASM, not faster).
              self.navigator.gpu.requestAdapter().then(adapter => {
                if(!adapter){ console.log('[kokoro-worker] requestAdapter() returned null — no WebGPU adapter available'); return; }
                console.log('[kokoro-worker] WebGPU adapter info:', adapter.info || '(no .info available)', 'isFallbackAdapter:', adapter.isFallbackAdapter);
              }).catch(err => console.log('[kokoro-worker] requestAdapter() probe failed:', err));
            }
            loadingPromise = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
              dtype: useWebGPU ? "fp32" : "q8",
              device: useWebGPU ? "webgpu" : "wasm",
              progress_callback: (progress) => {
                if(progress && progress.status === 'progress' && progress.progress != null){
                  self.postMessage({ type: 'load:progress', progress: progress.progress });
                }
              }
            }).then(t => { ttsInstance = t; return t; })
              .catch(err => { loadingPromise = null; throw err; });
          }
          await loadingPromise;
          let voices = [];
          try{
            const v = ttsInstance.list_voices ? ttsInstance.list_voices() : Object.keys(ttsInstance.voices || {});
            voices = Array.isArray(v) ? v : Object.keys(v || {});
          } catch(e){ voices = []; }
          self.postMessage({ type: 'load:done', voices });
        } else if(msg.type === 'generate'){
          const label = '[kokoro-worker] generate #' + msg.id + ' (' + msg.text.length + ' chars, voice=' + msg.voice + ')';
          console.time(label);
          const audio = await ttsInstance.generate(msg.text, { voice: msg.voice, speed: msg.speed });
          console.timeEnd(label);
          let blob;
          if(typeof audio.toBlob === 'function'){
            blob = await audio.toBlob();
          } else {
            const samples = audio.audio || audio.data;
            const rate = audio.sampling_rate || audio.sample_rate || 24000;
            blob = encodeWav(samples, rate);
          }
          self.postMessage({ type: 'generate:result', id: msg.id, blob });
        }
      } catch(err){
        const detail = (err && err.message) ? err.message : String(err);
        self.postMessage({ type: (msg.type === 'generate' ? 'generate:error' : 'load:error'), id: msg.id, message: detail });
      }
    };
  `;

  let kokoroWorker = null;
  let kokoroLoaded = false;
  let kokoroVoicesCache = [];
  let kokoroLoadPromise = null;
  let kokoroReqId = 0;
  const kokoroPendingGenerate = new Map(); // id -> {resolve, reject}

  function getKokoroWorker(){
    if(!kokoroWorker){
      const blob = new Blob([KOKORO_WORKER_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      kokoroWorker = new Worker(url, { type: 'module' });
      kokoroWorker.onmessage = (event) => {
        const msg = event.data;
        if(msg.type === 'generate:result'){
          const pending = kokoroPendingGenerate.get(msg.id);
          if(pending){ kokoroPendingGenerate.delete(msg.id); pending.resolve(msg.blob); }
        } else if(msg.type === 'generate:error'){
          const pending = kokoroPendingGenerate.get(msg.id);
          if(pending){ kokoroPendingGenerate.delete(msg.id); pending.reject(new Error(msg.message)); }
        }
        // 'load:progress', 'load:done', 'load:error' are handled by the one-off
        // listener that ensureLoaded() attaches per call, not here.
      };
      kokoroWorker.onerror = (event) => {
        console.error('Kokoro worker error:', event.message || event);
      };
    }
    return kokoroWorker;
  }

  window.KokoroWasmEngine = {
    async ensureLoaded(onProgress){
      if(kokoroLoaded) return true;
      if(!kokoroLoadPromise){
        const worker = getKokoroWorker();
        kokoroLoadPromise = new Promise((resolve, reject) => {
          const onMessage = (event) => {
            const msg = event.data;
            if(msg.type === 'load:progress'){
              if(onProgress) onProgress({ status: 'progress', progress: msg.progress });
            } else if(msg.type === 'load:done'){
              kokoroLoaded = true;
              kokoroVoicesCache = msg.voices || [];
              worker.removeEventListener('message', onMessage);
              resolve(true);
            } else if(msg.type === 'load:error'){
              kokoroLoadPromise = null;
              worker.removeEventListener('message', onMessage);
              reject(new Error(msg.message));
            }
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({ type: 'load' });
        });
      }
      return kokoroLoadPromise;
    },
    isLoaded(){ return kokoroLoaded; },
    listVoices(){ return kokoroVoicesCache; },
    generateBlob(text, voice, speed){
      const worker = getKokoroWorker();
      const id = ++kokoroReqId;
      return new Promise((resolve, reject) => {
        kokoroPendingGenerate.set(id, { resolve, reject });
        worker.postMessage({ type: 'generate', id, text, voice, speed });
      });
    }
  };
