# Field guide OCR backend

Runs [RapidOCR](https://github.com/RapidAI/RapidOCR) behind a small HTTP service
(`server.py`, Python stdlib `http.server`, no framework) for the Scan tool
(`ocr.html`/`ocr.js`). See `../PLAN.md` (Phase 2b) for the wider design
context — this file only covers running it locally, for development or
day-to-day use.

Exposes:
- `POST /ocr` — run OCR on an uploaded image; returns detected
  `{box, text, score}` triples as JSON.
- `GET /healthz` — liveness check (`200 ok`).
- `GET /` — plain status text.

Listens on `:8642` by default (`$PORT` to override). `ocr.js`'s
`BACKEND_URL` constant must point at wherever this ends up running.

All three options below install the exact same pinned versions
(`requirements.txt`), so pick whichever fits how you work — they're not
different setups, just different ways of installing the same thing.

## Option 1 — Docker

No local Python needed at all; the image builds RapidOCR and its
dependencies inside the container.

```
docker build -t field-guide-ocr .
docker run -p 8642:8642 field-guide-ocr
```

## Option 2 — Python venv (recommended for development)

Keeps these dependencies isolated from anything else on your machine —
matches how this project's own dev environment is set up.

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps rapidocr-onnxruntime==1.4.4
.venv/bin/python3 server.py
```

## Option 3 — Global pip install

Same packages, installed system-wide instead of into a venv. Simplest if you
just want the Scan tool working locally and don't care about isolating it
from other Python projects on the machine.

```
pip install -r requirements.txt
pip install --no-deps rapidocr-onnxruntime==1.4.4
python3 server.py
```

## Why `rapidocr-onnxruntime` is a separate install step

In all three options above, `rapidocr-onnxruntime` is installed on its own
with `--no-deps`, after everything in `requirements.txt`. Left to its own
dependency list, it pulls in `opencv-python` — the full GUI build, which
drags in X11/Qt libraries this headless server never touches.
`requirements.txt` installs `opencv-python-headless` instead; `--no-deps`
stops pip from then reaching for the GUI build anyway.

## Tests

```
pip install -r requirements.txt          # or the venv equivalent above
pip install --no-deps rapidocr-onnxruntime==1.4.4
python -m unittest discover -s test -v
```
