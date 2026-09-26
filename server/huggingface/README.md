---
title: Lamplight Voice
emoji: 🕯️
colorFrom: yellow
colorTo: gray
sdk: gradio
sdk_version: 6.28.0
app_file: app.py
pinned: false
---

# Lamplight voice server

Runs the Kokoro voice for the Lamplight Reader app on a free Hugging Face Space,
so reading aloud works without the Mac server or Tailscale.

## Set it up

1. Sign in at huggingface.co and choose **New Space**.
2. Pick a name (for example `lamplight-voice`), choose **Gradio** → **Blank**, keep
   the free **CPU basic** hardware, and set visibility to **Public**.
   (A private Space would need a Hugging Face token the app can't send; the access
   key below protects it instead.)
3. In the new Space, open **Files → Add file → Upload files** and upload the three
   files from this folder: `README.md`, `app.py`, `requirements.txt`. Replace the
   `README.md` the Space started with.
4. Open **Settings → Variables and secrets → New secret**.
   Name: `LAMPLIGHT_KEY`. Value: a long random password you make up (letters and
   numbers only, no slashes).
5. Wait for the Space to show **Running**. The first start takes a few minutes,
   including downloading the voice model.

## Connect the app

In Lamplight, open **Settings**:

- **Voice engine:** Kokoro AI voice
- **Use local server:** on
- **Server address:** `https://<your-username>-<space-name>.hf.space/<your LAMPLIGHT_KEY>`

For example `https://btarcau-lamplight-voice.hf.space/Xk29fq7Lm3Pz8Rt`.

## Good to know

- **It sleeps.** After about 48 hours unused, the Space goes to sleep. The first
  request after that takes a minute or two while it wakes and re-downloads the
  voice model; press Refresh next to
  Voice, or Play again, once it's up.
- **Your book text goes to this server** to be turned into speech. Nothing is
  stored, but it does leave your device, unlike the Mac server.
- **Kokoro only.** Piper voices aren't included.
- **Using the app from a different address?** Add a variable `ALLOWED_ORIGINS`
  with a comma-separated list of the web addresses allowed to use the server
  (default `https://bidpuck.github.io`).
