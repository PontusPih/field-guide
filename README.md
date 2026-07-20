# Field guide

Identify PDP-11 / VAX Q-bus and UNIBUS boards from a stack of unknowns: scan a
photo of the boards' handles, or paste module numbers directly, and see them
grouped into options and (eventually) systems. Live at `field-guide.pdp8.se`.
See [`PLAN.md`](PLAN.md) for architecture, roadmap, and design decisions.

## Running locally

The app is two independent pieces — for development or just day-to-day use.

**Frontend** — `index.html` (landing page), `guide.html`/`guide.js`
(identify), `ocr.html`/`ocr.js` (scan), plus `core.js`/`geometry.js`. Static
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

`ocr.js`'s `BACKEND_URL` constant points at the production backend
(`https://field-guide.onrender.com`); point it at `http://localhost:8642`
instead when running the backend locally — see `PLAN.md`, Phase 2b.

## Tests

```
npm test              # frontend: core.js / geometry.js (Node's built-in test runner)
cd backend
python -m unittest discover -s test -v   # backend, after installing its deps — see backend/README.md
```
