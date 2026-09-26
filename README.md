# Lamplight Reader

A private, local audiobook player for your browser. Upload an EPUB or PDF and it reads the book aloud using a free neural voice — no account, no server, no upload to anywhere. Everything happens in your own browser tab.

## Features

- **EPUB and PDF support** — drop in a file or choose one from your device
- **Kokoro and Piper AI voices** — free neural text-to-speech (not a robotic browser voice), in this browser or on a voice server you run yourself
- **Reads along, sentence by sentence** — the whole chapter is on screen, the sentence being spoken is highlighted, and a "Now" line in the player always shows it. Follow-along keeps it in view and catches up the moment you unlock your phone; scroll away yourself and a pill brings you back
- **Library with shelves** — book cards with cover, author, percent read and time left; put books on shelves you name yourself (Christian, Biography, Sci-fi, whatever fits)
- **Remembers your place** to the sentence, for every book
- **Tap the chapter title for Contents**; the scrubber is time in the chapter
- **Text size, five fonts, paper or dark theme**
- **Optional language filter** and a pronunciation dictionary for names the voice gets wrong
- **Lock-screen playback controls** with the book's cover
- **Search within the book** from the Contents sheet; tap a match to start reading there
- **Back up and sync** — one file with every book, its shelves and your place in it. Save it to iCloud Drive or Google Drive and restore it on your other device; restoring merges, newer positions win, nothing is deleted
- **Open in Lamplight** — once installed to the home screen on Android or as a desktop app, a book can be shared or opened straight into it. iPhone doesn't offer this to web apps yet, so there the Add a book button and the Files app remain the way in

## How to use it

1. Open the page and add an `.epub` or `.pdf` file; it appears as a card in your Library
2. Tap the card, then **Play** — the first time, the voice is downloaded or the voice server is contacted
3. The chips on the player change **voice** and **speed**; **Aa** changes text size, font, theme and follow-along; the sliders icon opens **Settings** for everything else
4. Just close the tab whenever — every book keeps its own place

## Privacy

Nothing is ever uploaded anywhere. The book file, the voice model, and your reading progress are all stored locally on your own device (in your browser's local storage). No account, no server, no tracking.

## Browser notes

- Works best in **Chrome or Edge**, which can run the voice model on the GPU for faster, smoother playback. It still works in Safari, just slower on longer sentences, since it falls back to CPU-only processing there.
- On **iPhone**, this must be opened as a real web address (a hosted link), not a local file — opening a saved HTML file directly in the Files app won't run it. If you're reading this after publishing to GitHub Pages or similar, you're already set up correctly.
- Browsers periodically clear site data for pages you haven't visited in a while (roughly a week of inactivity in Safari). If that happens, your last book and settings may reset and need to be reopened once.

## Known limitations

- With Piper on a voice server, a paragraph is read as one clip. The highlight moves through it sentence by sentence using timings the server reports (an `X-Sentence-Offsets` header of seconds, one per sentence in the request's `sentences` list, which the server must also name in `Access-Control-Expose-Headers`) or, for a server that doesn't report them, an estimate from sentence length
- PDF paragraph breaks are an approximation based on line spacing, since PDFs don't have real paragraph markup the way EPUBs do
- DRM-protected EPUBs (from most bookstores) can't be opened, since the text itself is encrypted
- Voice quality and speed depend on your device's hardware

## Credits

The code is split by job: `book.js` parses files, `text.js` splits sentences and applies the word rules, `store.js` is the on-device library, `voice.js` is the voice engines and server, `player.js` is playback, `app.js` is the screens.

Built with [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) for text-to-speech, [pdf.js](https://mozilla.github.io/pdf.js/) for PDF parsing, and [JSZip](https://stuk.github.io/jszip/) for EPUB parsing.
