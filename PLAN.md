# Field guide app — plan

A client-side JS app (GitHub Pages, `field-guide.pdp8.se`) that identifies PDP-11 /
VAX Q-bus and UNIBUS boards. Two eventual halves:

1. **Read** the module number off a board's handle (image recognition).
2. **Look it up** in `field-guide-02.txt` and present what the hardware is.

No build tooling: the app fetches and parses the read-only `field-guide-02.txt` at
runtime, keeping that file the single source of truth. (`field-guide-99.txt`, the
1999 edition, is kept for reference; the app uses the 2002 edition.)

## Core use case

A user with a stack of unknown boards enters/scans their module numbers. The app:
- identifies each board,
- bundles boards into the **option** they belong to (even if some are missing),
- suggests the **system** the options fit into,
- indicates when enough is present to form a complete option / system.

## Data model (from `field-guide-02.txt`, Megan Gentry, 27 Jul 2002)

- Two tables: a **module list** and a **third-party option list** (blank MODULE),
  split by `#####` and spaced-caps headings; file ends at `-*-EndText-*-`.
- Table columns: `MODULE  OPTION  BUS  DESCRIPTION`.
- **MODULE** — board number on the handle (OCR target). A revision suffix (`-YA`,
  `-EB`, …) is a variant of the same board, not a separate board. ~1464 numbers.
- **OPTION** — DEC option name; `--------` means none. ~882 options; many span >1 board.
- **BUS** — `U` UNIBUS, `Q` Qbus, `CTI` CTI-Bus (Professional), `M` M-Bus, `D` D-Bus,
  `Q/U` both, `-` none.
- **DESCRIPTION** — free text; **continuation lines repeat the module number** and hold
  wraps plus `PN:` (part number) and `Refs:` (documentation) metadata.
- Entries are delimited by blank lines (the only reliable boundary in 2002).
- Boards collapse by **base module number** for membership/completeness; revisions are
  listed on the base board's row.
- Abbreviations kept verbatim for now; glossary is a later phase.

## Architecture

- `index.html` — landing page: two boxes (Scan / Identify) with an arrow showing
  the workflow direction; links to `ocr.html` and `guide.html`.
- `guide.html` / `guide.js` — the identify tool: three-column layout (input ·
  results · export). `guide.js` handles fetch, DOM render, and file download;
  imports `core.js`. Also reads a scan handed off from `ocr.js` via
  `sessionStorage` on load, in place of the built-in sample stack.
- `core.js` — pure logic: parse, index (by module / base / option), resolve, group,
  export text. No DOM — imported by `guide.js` and the tests.
- `ocr.html` / `ocr.js` — the scan tool: load/rotate/pan/zoom a board photo, run
  OCR against `backend/server.py`, edit the resulting boxes, then hand the
  recognized module numbers to `guide.html`. Imports `geometry.js`.
- `geometry.js` — pure view-transform/hit-testing math for `ocr.js`'s canvas. No
  DOM — imported by `ocr.js` and its test.
- `backend/` — the Python OCR service (`server.py`, `Dockerfile`); see Phase 2b.
  Not client-side, so it stays a separate service from the rest of the app.
- `test/` — Node built-in test runner (`node --test`), zero dependencies:
  `core.test.js` + `guide.test.js` (parser/lookup logic) and `geometry.test.js`
  (canvas math).
- `field-guide-02.txt` — read-only source data (2002 edition).

## Roadmap

### Phase 1 — list → presentation  (in progress)
- [x] Runtime parser (tolerant of tab/space columns, dupes, wrapped descriptions)
- [x] Indexes: by module, by base (suffix-insensitive), by option
- [x] Input: editable textarea, pre-filled sample stack
- [x] Output: option groups with present/missing members + complete/partial badge
- [x] Standalone-module cards; unknown-number list
- [x] Rough system hints mined from descriptions
- [x] Migrate parser to the 2002 edition (two tables, module-repeat continuations,
      CTI/M/D/- bus codes, PN:/Refs: metadata, third-party list)
- [x] Base-collapse revisions (a board is present if any revision is held)
- [x] Three-column layout (input · results · export)
- [x] Export: plain-text list grouped by option, optional missing boards (marked),
      timestamped, downloadable
- [ ] Curated option→system map (make system suggestion precise) — needs sources.
      Note: current heuristic hints don't distinguish a **system** (CPU/computer) from a
      **peripheral** (e.g. RK06 is a disk drive), so drives appear alongside computers.
      Fixing this needs the functional taxonomy (Phase 3) + the option→system map.
- [ ] Add a favicon (currently 404s)
- [ ] Third-party option list is parsed but not yet surfaced (no module to look up)
- [x] **Quantities & set allocation.** Duplicate board numbers (repeated input lines —
      typed twice, or recognized twice by the scan tool) count as separate copies, tracked
      per base board (`core.js`'s `group()`: a `presentCounts` accumulator, one per resolved
      line, replacing the old presence-only `Set`). Packed into as many **complete sets**
      (`fullSets`, the minimum held count across the option's required boards) as possible;
      any surplus is reported as `leftover`, shaped like a second, partial instance of the
      same option — some boards present (real surplus), some "missing" (fully consumed by
      the complete sets). Rendered as a second card in the center column
      (`guide.js`'s `appendOptionCards`, dashed border) and a second block in the export
      (`core.js`'s `buildExport`); board rows show a `×N` count whenever N>1. `ocr.js`'s
      "Go to identification" handoff no longer dedupes recognized text, so a real pile of
      duplicate boards carries its true count through to this.

### Phase 2 — image recognition
- [x] Capture / upload a board photo — first built as `ocr-poc.html`/`ocr-poc.js`:
      file upload, 90°-step rotate, zoom/pan, manual crop-box draw (box stored in
      source-image coordinates so it survives pan/zoom). Retired once `ocr.html`/
      `ocr.js` (Phase 2b) shipped the same capability plus real OCR.
- [x] OCR the handle text (module number, optional revision)
      Tried: Tesseract.js in-browser, tuned hard — PSM.SINGLE_LINE, character whitelist
      narrowed to the alphabet actually used across all 1464 modules in
      `field-guide-02.txt` (no I/Z), grayscale + contrast-stretch + automatic polarity
      detection, upscale to ~120px tall, plus post-hoc Levenshtein fuzzy-match against the
      real module list. Measurably better than raw Tesseract, but still unreliable on
      slightly tilted or lower-quality photos: Tesseract is a document-OCR engine (expects
      near-horizontal, well-resolved scanned text), not a scene-text engine, and no amount
      of preprocessing fixes that mismatch.
      Evaluated PaddleOCR next, via `rapidocr-onnxruntime` (the ONNX-runtime build of the
      same PP-OCR models — lighter than the full PaddlePaddle framework). Confirmed
      measurably better on the same real sample photos: reads printed labels its own
      detector finds automatically, correctly ignores embossed metal text, and — cropped
      to a region under its ~736px auto-upscale threshold (`Det.limit_side_len`) —
      recovers labels too small to read in a full-frame scan. Prototyped as an interactive
      local tool in `rapidocr-poc/` (Python stdlib `http.server` backend + browser
      frontend): load/rotate/pan/zoom, automatic detection, manual box editing
      (draw/select/delete/move/resize/recognize) including multi-result regions and
      overlap/empty cleanup. Node-tested geometry, Python-tested backend.
      Shipped as `ocr.html`/`ocr.js` + `backend/` — see Phase 2b.
- [x] Feed recognized numbers into the Phase-1 lookup — done via Phase 2b's
      integration + export step (the "Go to identification" handoff).

### Phase 2b — RapidOCR service: prototype to production
The `rapidocr-poc/` prototype proved the approach and has since been renamed to
`backend/` and folded into the shipped app (`ocr.html`/`ocr.js`, the prototype's
`poc.html`/`poc.js` retired); shipping it for real still needs productionizing work
the prototype skipped. Roughly in dependency order.

**Decided:** this phase deliberately breaks the "no build tooling / everything
client-side" constraint stated above — RapidOCR's result quality justified it; no
in-browser alternative tested came close. **Budget is $0** — hosting must have a hard
cost ceiling (free tier, self-hosted on existing hardware, or a provider with a hard
spending cap/kill-switch), not pay-per-use exposure.

**Verification**
- [ ] Fuzzy-match recognized text against the real ~1464 module numbers in
      `field-guide-02.txt` (revive the Tesseract POC's Levenshtein approach) — catch
      near-misses and filter junk before anything reaches the user.

**Multi-image workflow**
- [ ] Support uploading several images in one session
- [ ] Curate one combined list of found labels, each tagged with which image and the
      coordinates within that image it came from
- [ ] Resumable per-image sessions, keyed by a SHA-256 checksum of the image (native
      `crypto.subtle.digest`, no library, single-digit ms for a multi-MB photo — MD5 isn't
      available in that API, and isn't needed). Today's single-slot IndexedDB persistence
      (`ocr.js`: one image + its boxes under fixed keys, overwritten by the next upload)
      would become multiple records keyed by hash, plus UI to list/pick which past scan to
      resume. Deliberately not built yet — holding off until this phase is actually
      underway, since it's a real restructure (storage model + a picker UI), not a small
      tweak on top of the current single-image persistence.

**Integration**
- [x] Decide where this lives in the shipped app — `index.html` is now a landing page
      with two boxes (Scan / Identify) and an arrow showing the workflow direction;
      the old `index.html`/`app.js` identify tool moved to `guide.html`/`guide.js`
      unchanged, and a new `ocr.html`/`ocr.js` (adapted from the prototype's
      `poc.html`/`poc.js`) is the shipped scan tool. Once `ocr.html`/`ocr.js` were
      confirmed working end-to-end, the prototype pieces were retired for real:
      `rapidocr-poc/` renamed to `backend/` (it's the real OCR service now, not a
      POC), its `poc.html`/`poc.js` deleted, `geometry.js` moved to the repo root
      (its only consumer is `ocr.js`), and the dead `app.js` plus the older
      Tesseract-based `ocr-poc.html`/`ocr-poc.js` deleted too.
- [x] Export / "send to lookup" step — `ocr.html` has a "Go to identification →"
      button (enabled once at least one box is recognized). It collects every
      detection with non-null text, dedupes case-insensitively, and hands the list to
      `guide.js` via `sessionStorage` (key `fieldGuideScan`, consumed once on load,
      replacing the sample textarea value). No server round-trip needed for the
      handoff since both pages are static/client-side.
- [x] Same-origin problem — `ocr.js` now points at a `BACKEND_URL` constant
      (currently `http://localhost:8642`, needs updating once real hosting is
      picked) instead of a relative `/ocr`. `backend/server.py` sends
      `Access-Control-Allow-Origin: *` (plus an `OPTIONS` preflight handler) on
      `/ocr` responses so the cross-origin fetch works. The backend no longer
      serves any frontend at all (see Refactor bullet below), so same-origin
      requests aren't a case to preserve anymore.

**Refactor for production**
- [x] Drop static file serving — `backend/server.py`'s `Handler` no longer extends
      `SimpleHTTPRequestHandler`/serves `STATIC_DIR` (that only ever existed for
      `poc.html`/`poc.js`, now deleted); serving the whole `backend/` directory
      over HTTP was a latent exposure (e.g. `GET /server.py` would have returned
      source). `do_GET` now handles exactly `/healthz` and `/`, 404s otherwise.
- [ ] Review `backend/server.py` with shipping in mind — the prototype optimized
      for iterating fast, not for running unattended
- [x] Local-run packaging (V1) — `backend/requirements.txt` is now the single source
      of truth for dependency versions (`rapidocr-onnxruntime` stays a separate
      `--no-deps` install everywhere, to keep the GUI `opencv-python` build out — see
      `backend/README.md`). Three documented, verified ways to run it locally: Docker
      (`Dockerfile` now installs from `requirements.txt` instead of an inline list),
      a venv, or a plain global `pip install`. Root `README.md` added alongside, tying
      frontend + backend together for someone running the whole app locally. This is
      about local dev/usage only — the still-open hosting question below is separate.
- [ ] Structured logging — mind the no-retention stance below, don't log image content.
      A first step exists: `run_ocr()` logs upload size + peak RSS before/after each
      request (`resource.getrusage`), which is what surfaced the memory-ceiling finding
      under Deployment. Not structured (plain `print`), and worth keeping even after a
      real logging setup lands, since it's cheap and diagnostic.
- [ ] Flask/FastAPI concurrency model — flagged earlier as worth a closer look
      (sync/WSGI vs. async/ASGI) but never actually discussed before the thread moved
      on to `server.py`'s own `ThreadingHTTPServer` concurrency instead. Still open if
      a framework migration is ever considered.
- [ ] Config via environment variables (port, rate limits, allowed origins), not
      hardcoded constants. Port done (`server.py` reads `$PORT`, defaults to 8642
      locally); rate limits and allowed origins still hardcoded/absent.
- [x] `GET /healthz` — added for Render's health check, returns 200 with no OCR work
      (models are already loaded by the time the process can accept any connection at
      all, since `engine = RapidOCR()` runs before the HTTP server starts listening).
- [ ] Pre-flight ping before `POST /ocr`, driving `statusEl` through distinct stages
      the user can actually tell apart: "waking up server…" (pre-flight in flight —
      catches sleep-tier cold start, e.g. Render free tier's ~30-60s spin-up),
      "queued…" (waiting on the bounded queue once that lands), "processing image…"
      (the real OCR call). A cheap `GET /` works as the pre-flight signal because
      `server.py` loads the RapidOCR models before the HTTP server starts listening,
      so any successful response already implies models are warm. Only relevant if
      hosting ends up on a sleep-tier PaaS — moot under self-hosting.
- [ ] Revisit the `rapidocr-onnxruntime==1.4.4` pin later. That package line has been
      unmaintained since Jan 2025 — the project consolidated into a unified `rapidocr`
      package (multi-backend, at 3.9.1 as of Jul 2026) that superseded it. Not migrating
      now: verified memory profiling (peak RSS ~545MB per request, dominated by pipeline
      buffer copies at RapidOCR's own ~2000px working resolution, not by original image
      size — see the memory-ceiling finding under Deployment) is unlikely to improve
      much from a backend swap alone, and the 2.x/3.x line looks like a real rewrite
      (yanked releases for missing deps / a broken PyTorch engine), not a drop-in bump —
      would need the full accuracy + memory verification redone.

**Deployment**
- [x] Docker image — built, passes the regression suite inside the container, and has
      deployed successfully to Render (confirmed end-to-end: real photo in, correct
      `M8295` detection out). Render performs the actual `docker build` itself
      server-side on every deploy from the repo's Dockerfile — no local build/push step
      needed on our end.
- [ ] Optimize image size before going live — already swapped `opencv-python` for
      `opencv-python-headless` (drops Qt5/X11 GUI libs); further trimming possible
      (e.g. FFmpeg/AVIF/JPEG2000 codec support opencv bundles but this app never uses,
      since it only ever decodes one uploaded still image per request).
      Verified (built+ran a container without them): the Dockerfile's `apt-get install
      libgl1 libglib2.0-0` is currently dead weight — the pinned
      `opencv-python-headless==5.0.0.93` doesn't link against either (confirmed via
      `ldd`, a string scan for `dlopen`, and a real end-to-end OCR run with neither
      package installed). Older headless-opencv releases had a packaging bug that
      needed them; this pin doesn't. Safe to drop both apt-get lines.
- [ ] Pick a hosting provider — must hold to the $0 budget: a free tier, self-hosting on
      existing hardware, or a provider with a hard spending cap/kill-switch. Pay-per-use
      serverless is a poor fit here unless it has an enforced hard cap, since an abuse
      spike would otherwise translate directly into cost.
      **Render free tier (512MB) confirmed too small for real use** — a live deploy
      OOM'd on a single normal-sized upload. Measured why: a single OCR request peaks
      at ~442-545MB RSS *regardless* of source image resolution (tested 2400x1800 and
      a synthetic 12MP image — both landed around the same ~545MB ceiling), because
      RapidOCR resizes internally to its own ~2000px working resolution before the
      expensive det/cls/rec work runs either way. Pre-resizing the upload to match
      doesn't lower the ceiling (only moves when the cost is paid); resizing low enough
      to actually cut memory (~1600px and below) drops real detections, including
      `M8295` from the regression fixture. Fixed onnxruntime thread counts (vs. the
      config's default -1) had no measurable effect either. Conclusion: this is an
      inherent pipeline cost, not a tuning problem — needs a host with real headroom.
      Oracle Cloud's Always-Free VM (Ampere, 24GB RAM) is the leading candidate on
      that basis; not yet decided/committed.
- [ ] Unexplained: peak RSS climbed further (615MB -> 803MB) across two *identical*
      back-to-back requests in a local test, not just holding steady at the
      single-request ceiling. Possibly onnxruntime/opencv allocator not releasing
      memory between calls. Worth investigating before committing to a memory-tight
      host, separately from the per-request ceiling above.
- [ ] TLS termination + routing (own subdomain vs. a path under field-guide.pdp8.se)

**Security & cost control** — free, unauthenticated, public-facing service
- [ ] Per-IP rate limiting / throttling
- [ ] Bounded concurrency — a semaphore in front of the RapidOCR engine so unbounded
      parallel requests can't spike CPU/memory (`server.py`'s `ThreadingHTTPServer`
      currently spawns one thread per connection with no limit). Pair with a **queue
      with a depth cap**: once the cap is hit, reject immediately (e.g. 429) rather
      than let requests pile up — a request that finally gets processed far later is
      likely for a client that's already given up, so accepting it just wastes
      compute for no one. Sizing (concurrency N, queue depth K) needs real numbers
      once a host's actual CPU/RAM allotment and per-request OCR time are known.
- [ ] Upload size limit — reject well before ~10-20MB, checked on both sides: client
      refuses to send an oversized file (saves the round trip), server hard-rejects
      regardless (the client check is a courtesy, not the actual defense)
- [ ] Per-request timeout to kill stuck recognitions
- [ ] Container resource limits (CPU/memory caps; ulimits where meaningful)
- [ ] Restrict to same-origin/referrer — this is meant to serve the field-guide app, not
      act as an open public API, which cuts down casual scraping for free
- [ ] Consider a CDN/edge layer (e.g. Cloudflare) for bot/scraper mitigation rather than
      building that into the app itself
- [ ] Explicit no-retention stance: process uploaded images in memory only, never persist
      or log them — matters for privacy and keeps storage cost at zero
- [ ] Security review pass before going live (repo has a `/security-review` skill)

### Phase 3 — presentation depth
- [ ] Abbreviation glossary / expansions
- [ ] Functional taxonomy (memory, disk ctrl, serial, A/D, CPU, …)
- [ ] Complete-system detection & indication

### Phase 4 — backplane layout
Once a set of cards is identified they usually pair with a specific **backplane** and
must be placed in a defined slot order. Show the backplane and where each card goes.
- [ ] Source backplane data (slot count, per-slot rules, card→slot mapping) — extra sources
- [ ] Map identified options/cards to their backplane(s)
- [ ] Render a backplane diagram with recommended card placement
- [ ] Flag misfits (card that doesn't belong / slot conflicts)

### Phase 5 — more cards & other series
Currently PDP-11 only (this one guide). Extend coverage and add other DEC series.
- [ ] Generalize the data model to multiple **series-tagged** source guides
- [ ] Add more PDP-11 cards as sources surface
- [ ] Add PDP-8 (and other series) guides; tag results by series
- [ ] Series filter / auto-detect series from a mixed stack

### Later / side effects
- [ ] Export a cleaned, normalized version of the field guide
- [x] Hunt for and integrate later versions — 2002 edition found & adopted (likely latest)
