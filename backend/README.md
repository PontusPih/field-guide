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

## Local development

`ocr.js` already auto-detects a local frontend (serving from
`localhost`/`127.0.0.1`) and switches to fast, permissive defaults on its own
— no tiling (`TILE_SIZE = Infinity`, one request per scan instead of ~736px
pieces) and, via `backend-config.js`, `http://localhost:8642` as the backend.
See the root `README.md`.

That untiled request can be much bigger than Render's 512MB-tier-driven 1200px
default `OCR_MAX_DIMENSION` allows, so it'll get 413-rejected unless the
backend is told to relax too. There's no reliable way for the backend itself
to tell "a dev machine" from "a misconfigured deploy", so this doesn't happen
automatically — set it explicitly when running locally, whichever option
below you use, e.g. for the venv option:

```
OCR_MAX_DIMENSION=0 .venv/bin/python3 server.py
```

(`0`, or any non-positive value, disables the check entirely.) Leave it unset
everywhere memory is actually constrained — the 1200px default is there on
purpose. The three run commands below all show this flag inline.

A second gate, `OCR_MAX_UPLOAD_BYTES` (default 10 MB), rejects an oversized
*request body* before it is read into memory — the backstop against a hostile
or malformed upload, independent of pixel dimensions (see `../security.md`). A
typical untiled dev photo is well under it, so it rarely needs touching; raise
or disable it (`OCR_MAX_UPLOAD_BYTES=0`) only if a genuinely large untiled
image is 413-rejected locally. The per-connection socket timeout is
`OCR_SOCKET_TIMEOUT` (default 30 s); its default is fine for local runs.

Cross-origin reads of `/ocr` are restricted to an allow-list
(`OCR_ALLOWED_ORIGINS`, default the deployed frontend origin; see
`../security.md`). A `localhost`/`127.0.0.1` frontend on any port is always
allowed, so local development needs no override; set `OCR_ALLOWED_ORIGINS="*"`
only to reproduce the old blanket policy.

Thread counts (`OCR_INTRA_OP_THREADS`/`OCR_INTER_OP_THREADS`/`OCR_CV2_THREADS`)
don't need a matching local override — their `-1` (auto-detect) default is
already correct and fast for an unrestricted local run, container or not; the
slowdown that motivated pinning these (see `PLAN.md` Benchmarks) is specific
to a *CPU-restricted* container (e.g. `docker run --cpuset-cpus=...`) where
auto-detect sees more cores than the container can actually use. Only pin
them locally if you're deliberately reproducing that restriction.

All three options below install the exact same pinned versions
(`requirements.txt`), so pick whichever fits how you work — they're not
different setups, just different ways of installing the same thing.

## Option 1 — Docker

No local Python needed at all; the image builds RapidOCR and its
dependencies inside the container.

```
docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t field-guide-ocr .
docker run -p 8642:8642 -e OCR_MAX_DIMENSION=0 field-guide-ocr
```

`--build-arg` is optional — omit it and the image just logs `unknown` for the
commit. Render builds this Dockerfile itself and doesn't use this arg; it
sets `RENDER_GIT_COMMIT` directly instead (see `server.py`).

## Option 2 — Python venv (recommended for development)

Keeps these dependencies isolated from anything else on your machine —
matches how this project's own dev environment is set up.

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps rapidocr==3.9.2
OCR_MAX_DIMENSION=0 .venv/bin/python3 server.py
```

## Option 3 — Global pip install

Same packages, installed system-wide instead of into a venv. Simplest if you
just want the Scan tool working locally and don't care about isolating it
from other Python projects on the machine.

```
pip install -r requirements.txt
pip install --no-deps rapidocr==3.9.2
OCR_MAX_DIMENSION=0 python3 server.py
```

## Why `rapidocr` is a separate install step

In all three options above, `rapidocr` is installed on its own with `--no-deps`,
after everything in `requirements.txt`. Left to its own dependency list, it
pulls in `opencv-python` — the full GUI build, which drags in X11/Qt libraries
this headless server never touches. `requirements.txt` installs
`opencv-python-headless` instead (and pins rapidocr's other runtime deps —
`omegaconf`, `requests`, `colorlog`, …); `--no-deps` stops pip from then
reaching for the GUI build anyway.

## Models: bundled vs. downloaded

`rapidocr` 3.x does **not** bundle its ONNX models — it downloads them on first
use (into its package dir by default, or `OCR_MODEL_ROOT_DIR` if set). Two
consequences:

- **Local dev (venv / global):** the first OCR call after install fetches the
  default models over the network — a one-time download, cached thereafter.
- **Docker:** the image pre-downloads the models at build time into
  `/app/models` (`OCR_MODEL_ROOT_DIR`), so the running container needs no
  outbound network to fetch them and cold starts don't pay a download. This is
  what lets egress be locked down at the platform (see `../security.md`).

### Which models (pinned)

`server.py` pins **PP-OCRv4 "mobile"** for detection and recognition (the
`OCR_DET_VERSION` / `OCR_REC_VERSION` / `OCR_DET_MODEL_TYPE` / `OCR_REC_MODEL_TYPE`
defaults), not rapidocr 3.x's own PP-OCRv6 "small" default. On this app's small
board-label digits, v6 misread labels (`M8295` → `M2295`) and cost far more
memory; a sweep (`eval_models.py`) found v4-mobile the only variant reading every
sample label correctly while staying fast and under the memory ceiling — and it
matches the models the retired `rapidocr-onnxruntime` used, so accuracy is
unchanged from before the migration. **End users get this automatically** — it's
the code default, so the venv first-run download and the Docker build-time bake
both fetch exactly these pinned models. To re-benchmark, run
`eval_models.py <combo>` and override the env knobs.

## Tests

```
pip install -r requirements.txt          # or the venv equivalent above
pip install --no-deps rapidocr==3.9.2
python -m unittest discover -s test -v
```
