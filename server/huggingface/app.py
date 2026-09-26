"""Lamplight voice server for a Hugging Face Space (Gradio SDK, ZeroGPU or CPU).

Serves the same /kokoro/voices and /kokoro/tts requests the Lamplight app sends
to the Mac server, so the app only needs a different Server address.

Every request must start with the access key as the first path segment:
    https://<user>-<space>.hf.space/<LAMPLIGHT_KEY>/kokoro/voices
The key is read from the LAMPLIGHT_KEY secret in the Space's settings. Putting it
in the path (rather than a header) means the app needs no changes: the key is just
part of the Server address.
"""
# On ZeroGPU Spaces, `spaces` must be imported before anything else touches the
# GPU. It isn't installed elsewhere (e.g. running locally), which is fine.
try:
    import spaces
except ImportError:
    spaces = None

import hmac
import io
import os
import threading
import urllib.request

import gradio as gr
import soundfile as sf
from fastapi import APIRouter, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from starlette.middleware import Middleware
from kokoro_onnx import Kokoro
from pydantic import BaseModel

ACCESS_KEY = os.environ.get("LAMPLIGHT_KEY", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://bidpuck.github.io").split(",") if o.strip()]
MAX_TEXT_CHARS = 5000

# Kokoro v1.0 model and voice pack (about 350 MB). Downloaded on first start and
# again whenever the Space restarts, since free Spaces don't keep files.
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
os.makedirs("models", exist_ok=True)
for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
    path = os.path.join("models", name)
    if not os.path.exists(path):
        print(f"Downloading {name}...", flush=True)
        urllib.request.urlretrieve(MODEL_URL + name, path + ".part")
        os.replace(path + ".part", path)

kokoro = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
# Only the English voices: American (a*) and British (b*).
VOICES = sorted(v for v in kokoro.get_voices() if v[:1] in ("a", "b"))
# The free Space has 2 CPU cores; running one clip at a time keeps each one fast
# instead of letting the app's read-ahead requests fight over the CPU.
generate_lock = threading.Lock()

# Kokoro runs on the CPU, so nothing here needs a GPU. ZeroGPU Spaces still refuse
# to start without at least one @spaces.GPU function, so register one that is never
# called; it uses none of the daily GPU quota.
if spaces is not None:
    @spaces.GPU(duration=1)
    def _zerogpu_placeholder():
        return None

router = APIRouter()


def check_key(key: str):
    if not ACCESS_KEY:
        raise HTTPException(503, "Server has no LAMPLIGHT_KEY secret set.")
    if not hmac.compare_digest(key, ACCESS_KEY):
        raise HTTPException(403, "Wrong access key in the Server address.")


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@router.get("/{key}/kokoro/voices")
def kokoro_voices(key: str):
    check_key(key)
    return {"voices": VOICES}


@router.post("/{key}/kokoro/tts")
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


@router.get("/{key}/piper/voices")
def piper_voices(key: str):
    check_key(key)
    raise HTTPException(404, "This server only has Kokoro voices. Choose Kokoro as the voice engine.")


# A small status page for the Space's own web page. Gradio runs the server itself
# (ZeroGPU only sets up when Gradio's launch() is used); the voice routes and CORS
# go in through app_kwargs, so they're registered ahead of Gradio's own routes.
with gr.Blocks(title="Lamplight voice") as status_page:
    gr.Markdown(
        "## Lamplight voice server is running\n"
        f"{len(VOICES)} Kokoro voices ready. Use this Space's address plus your "
        "access key as the Server address in Lamplight's Settings."
    )

if __name__ == "__main__":
    status_page.launch(
        server_name="0.0.0.0",
        server_port=7860,
        # Server-side rendering starts a separate Node server the voice routes
        # would have to share the port with; the status page doesn't need it.
        ssr_mode=False,
        app_kwargs={
            "routes": router.routes,
            "middleware": [Middleware(
                CORSMiddleware,
                allow_origins=ALLOWED_ORIGINS,
                allow_methods=["GET", "POST"],
                allow_headers=["Content-Type"],
            )],
        },
    )
