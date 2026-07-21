# Field guide

Identify PDP-11 / VAX Q-bus and UNIBUS boards from a stack of unknowns: scan a
photo of the boards' handles, or paste module numbers directly, and see them
grouped into options and (eventually) systems. Live at `field-guide.pdp8.se`.
See [`PLAN.md`](PLAN.md) for architecture, roadmap, and design decisions.

## Running locally

The app is two independent pieces — for development or just day-to-day use.

**Frontend** — `index.html` (landing page), `guide.html`/`guide.js`
(identify), `ocr.html`/`ocr.js` (scan), plus `core.js`/`geometry.js`/`tiling.js`. Static
files, no build step, no dependencies. Serve the repo root with any static
file server, e.g.:

```
python3 -m http.server 8123
```

then open `http://localhost:8123/index.html`.

**Backend** — `backend/`, a small Python service that runs OCR (RapidOCR)
for the Scan tool. RapidOCR only runs in Python, so this can't be static
like the rest of the app. See [`backend/README.md`](backend/README.md) for
three ways to run it locally (Docker, a venv, or a plain global
`pip install`) — pick whichever fits.

`ocr.js` picks its backend automatically (see `backend-config.js`): serving the
frontend from `localhost`/`127.0.0.1` (as above) talks to
`http://localhost:8642` with no configuration needed; anything else (the real
GitHub Pages host) talks to production. To point at something else instead
(a staging deploy, someone else's local instance), set an override from the
browser console: `localStorage.setItem("fieldGuideBackendUrl", "https://...")`
— clear it with `localStorage.removeItem("fieldGuideBackendUrl")` to go back
to auto-detection.

Running locally also relaxes Render's 512MB-tier-driven limits automatically
on the frontend side (no tiling — one request per scan instead of ~736px
pieces); start the backend with `OCR_MAX_DIMENSION=0` too so it doesn't reject
that now-untiled request — see `backend/README.md`, "Local development".

## Tests

```
npm test              # frontend: core.js / geometry.js / tiling.js (Node's built-in test runner)
cd backend
python -m unittest discover -s test -v   # backend, after installing its deps — see backend/README.md
```
