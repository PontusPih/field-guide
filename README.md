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

Running locally also relaxes the production tier's memory-driven limits
automatically on the frontend side (no tiling — one request per scan instead of
~736px pieces); start the backend with `OCR_MAX_DIMENSION=0` too so it doesn't
reject that now-untiled request — see `backend/README.md`, "Local development".

Because the local default disables tiling entirely, the tiled path is not
reachable in dev at any region size. To exercise it, set a tile size explicitly:
`localStorage.setItem("fieldGuideTileSize", "300")` — clear it with
`localStorage.removeItem("fieldGuideTileSize")`. This is the seam the browser
tiling spec uses, and the way to reproduce a production-only tiling problem
locally.

## Tests

```
npm test              # frontend units: pure modules, no browser (Node's built-in test runner)
npm run test:browser  # frontend in a real browser — see below
cd backend
python -m unittest discover -s test -v   # backend, after installing its deps — see backend/README.md
```

`npm test` covers the pure modules. It cannot reach `ocr.js`, which is DOM-driven.

`npm run test:browser` drives headless Chrome over the DevTools Protocol, with no
dependency beyond Node itself. Each run starts its own static server on an
OS-assigned port, its own Chrome on a fresh throwaway profile, and removes both
afterwards — it never touches a dev server or browser profile already running.
It skips itself if no Chrome is installed; set `CHROME_PATH` to point at a
specific one. `/ocr` is stubbed in the page, so the backend need not be running.
