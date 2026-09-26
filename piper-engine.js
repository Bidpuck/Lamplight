  // Piper TTS — a different, lighter-weight neural voice model than Kokoro, worth
  // offering as an alternative since some devices run it more smoothly. Each voice
  // is its own separate download (unlike Kokoro's one bundle with many voices),
  // fetched only when that specific voice is actually used.
  import * as piperTTS from "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/+esm";

  window.PiperWasmEngine = {
    async listVoices(){
      try{ return await piperTTS.voices(); } catch(e){ console.warn('Piper voices() failed:', e); return null; }
    },
    async storedVoices(){
      try{ return await piperTTS.stored(); } catch(e){ return []; }
    },
    async ensureVoice(voiceId, onProgress){
      await piperTTS.download(voiceId, onProgress);
    },
    async generateBlob(text, voiceId){
      return await piperTTS.predict({ text, voiceId });
    }
  };
