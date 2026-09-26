"""Lamplight voice server for a Hugging Face Space.

Serves the same /kokoro/voices and /kokoro/tts requests the Lamplight app sends
to the Mac server, so the app only needs a different Server address.

Every request must start with the access key as the first path segment:
    https://<user>-<space>.hf.space/<LAMPLIGHT_KEY>/kokoro/voices
The key is read from the LAMPLIGHT_KEY secret in the Space's settings. Putting it
in the path (rather than a header) means the app needs no changes: the key is just
part of the Server address.
"""
import hmac
import io
import os
import threading

import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel

ACCESS_KEY = os.environ.get("LAMPLIGHT_KEY", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://bidpuck.github.io").split(",") if o.strip()]
MAX_TEXT_CHARS = 5000

kokoro = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
# Only the English voices: American (a*) and British (b*).
VOICES = sorted(v for v in kokoro.get_voices() if v[:1] in ("a", "b"))
# The free Space has 2 CPU cores; running one clip at a time keeps each one fast
# instead of letting the app's read-ahead requests fight over the CPU.
generate_lock = threading.Lock()

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def check_key(key: str):
    if not ACCESS_KEY:
        raise HTTPException(503, "Server has no LAMPLIGHT_KEY secret set.")
    if not hmac.compare_digest(key, ACCESS_KEY):
        raise HTTPException(403, "Wrong access key in the Server address.")


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.get("/")
def health():
    return {"ok": True}


@app.get("/{key}/kokoro/voices")
def kokoro_voices(key: str):
    check_key(key)
    return {"voices": VOICES}


@app.post("/{key}/kokoro/tts")
def kokoro_tts(key: str, req: TTSRequest):
    check_key(key)
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "No text to read.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text is over {MAX_TEXT_CHARS} characters.")
    if req.voice not in VOICES:
        raise HTTPException(400, f"Unknown voice: {req.voice}")
    speed = min(max(req.speed, 0.5), 2.0)  # Kokoro's supported range
    lang = "en-gb" if req.voice.startswith("b") else "en-us"
    with generate_lock:
        samples, sample_rate = kokoro.create(text, voice=req.voice, speed=speed, lang=lang)
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")


@app.get("/{key}/piper/voices")
def piper_voices(key: str):
    check_key(key)
    raise HTTPException(404, "This server only has Kokoro voices. Choose Kokoro as the voice engine.")
