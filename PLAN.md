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
- [ ] **Ghost card/output preview when the input is empty.** `guide.html` currently
      pre-fills the input textarea with a full sample stack (real placeholder text the
      user has to delete before entering their own). Instead: when the input is empty,
      show a smaller/lighter demo set of module numbers rendered as a "ghost card" in the
      results column (faded/placeholder-styled, visually distinct from a real result) plus
      a matching ghost export-file preview — illustrating what the tool produces without
      committing real sample text into the input. Disappears as soon as real text is
      typed; reappears if the input is cleared back to empty. Not yet designed in detail —
      needs deciding the demo module set, how the ghost card is visually distinguished,
      and how it replaces the current sample-stack-in-textarea approach.

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
- [ ] Let the user edit a found box's recognized text directly — a human eye can often
      correct a box RapidOCR found but slightly misread (one wrong character) without
      needing to redraw/rescan it. Not yet designed: the edit UI (inline in the results
      list vs. a field on the box's detail/hover state), whether an edited detection's
      `source` should count as "manual"/trusted for the `guide.js` handoff, and whether
      `score` should be cleared/flagged once text has been hand-edited (it no longer
      reflects what's actually displayed).

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
      (`https://field-guide.onrender.com`) instead of a relative `/ocr`.
      `backend/server.py` sends
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
      hardcoded constants. Port, worker count, and queue depth done (`$PORT`,
      `$OCR_WORKERS`, `$OCR_QUEUE_MAXSIZE`); rate limits and allowed origins still
      hardcoded/absent. Tile size, the server-side hard dimension cap, and per-level
      thread/core counts (ONNX Runtime, OpenCV) also need to land here — see
      Configurability under Tiled scanning below.
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
      **Render free tier (512MB) OOM'd on a single normal-sized upload** — root-caused,
      and no longer believed to require a bigger host. Earlier profiling here concluded
      peak RSS was ~442-545MB *regardless* of source image resolution; that was wrong —
      it used VmRSS snapshots before/after each pipeline stage, which miss a spike that
      happens *inside* a single call. Redone with `resource.getrusage().ru_maxrss` (a
      kernel-tracked high-water mark that can't miss it), peak RSS scales close to
      linearly with the actual pixel count RapidOCR's detector processes — about 200MB
      per megapixel of det input, on a ~120MB fixed baseline — between a floor (~0.73Mpx,
      from det's own internal ~736px short-side auto-upscale, `Det.limit_side_len`) and a
      ceiling set by `max_side_len` (2000 default, ~3.0Mpx worst case, ~700MB — this is
      what actually OOM'd Render). `cls`/`rec` cost almost nothing regardless of crop
      size (fixed ~48px-tall resize per box); det alone drives this. Fix path is now
      tiling (below), which bounds per-request memory well under 512MB regardless of
      host size — Render's free tier is viable again once that ships. A bigger host
      (Oracle Cloud's Always-Free Ampere VM, 24GB RAM, was the leading alternative
      candidate) remains an option, but becomes a configurability knob (bigger tiles,
      see below) rather than a requirement.
- [x] Explained and fixed: peak RSS climbed further (615MB -> 803MB) across two
      *identical* back-to-back requests in an earlier local test. Root cause:
      `ThreadingHTTPServer` spawned a fresh OS thread per request, and each new thread
      doing heavy allocation got its own glibc malloc arena that was never released back
      — cross-request growth, not a per-request leak. Fixed by moving OCR work off
      request-handling threads entirely: a bounded job queue plus a small, fixed pool of
      persistent worker threads (`OCR_WORKERS`, default 1), each loading its own
      `RapidOCR()` once and reusing it for every job. `ThreadingHTTPServer` still fronts
      lightweight requests (`/healthz`, `/`) immediately even while a scan is in
      progress, since heavy allocation never touches a request thread anymore.
- [ ] TLS termination + routing (own subdomain vs. a path under field-guide.pdp8.se)

**Tiled scanning for large images**
Fixes the memory ceiling above without requiring a bigger host. `recognizeRegion()`
used to send whatever the user drew as one crop, at the photo's native resolution
(`ocr.js` never resizes on capture) — so a box drawn around a whole 12MP phone photo
would hit the ~700MB ceiling directly. Implemented (`ocr.js`, `geometry.js`,
`server.py`).

- [x] **Decided: tile client-side, not server-side.** `recognizeRegion()` already
      crops a region, POSTs it, and translates the returned crop-local boxes into
      full-image coordinates — auto-splitting one large drawn region into a grid of
      tiles through that same pipeline is a natural extension. Doing it server-side
      would duplicate that crop/translate/merge logic in Python for no real safety
      benefit, since `max_side_len` already acts as an unconditional backstop on
      anything reaching `/ocr` regardless of which side tiled it. Client-side also
      gets progressive per-tile results for free (relevant given the ~10s full-frame
      estimate below) and naturally paces requests one at a time against the
      backend's single-worker job queue.
- [x] **Tile size: 736x736 squares, not larger.** 736 is det's own upscale floor —
      smaller tiles cost the same as 736 (nothing saved going below), and a larger
      tile (1140, benchmarked as a "fewer, bigger tiles" alternative) came out
      strictly worse, not a trade-off: half as many tiles but 1.85x the total wall
      time for the same test image (3.31s vs 6.13s, single core/thread), and ~54%
      slower per megapixel of actual work even after accounting for the bigger
      tile's greater overlap redundancy. Read as single-threaded CPU inference being
      sensitive to cache locality — a 736^2 tile's intermediate feature maps likely
      still fit in cache, a 1140^2 tile's probably don't. Per-tile timing sampled
      across both example images (30 tiles, 50%-overlap grid): mean 0.35s, p90
      0.62s, p99 0.71s — content-dependent (empty-background tiles ~0.14s,
      text-dense tiles up to ~0.71s).
- [x] **Graduated single-tile threshold.** A region only modestly larger than one
      tile (e.g. 800x800) must not be forced into a multi-tile grid — the overlap
      needed to avoid missing text at the seam approaches 90%+ at that size,
      multiplying cost for no benefit. Regions up to roughly 1.3-1.5x the tile size
      in both dimensions should run as a single, modestly-oversized tile instead of
      splitting; only clearly-larger regions get the grid treatment.
- [x] **Grid layout: even redistribution, last tile snapped to the far edge**, so no
      axis ever produces a sliver/leftover tile smaller than the target size.
      Computed independently per axis (row count and column count don't depend on
      each other), which handles odd/elongated aspect ratios without needing
      non-square tiles. Implemented as `geometry.js`'s `axisTiles`/`tileGrid`
      (Node-tested, `test/geometry.test.js`) — folds the single-tile threshold above
      into the same function (a region within `tile * singleCellFactor` returns one
      cell spanning the whole axis, subsuming the plain `total <= tile` case too).
- [x] **Server-side hard dimension limit**, independent of whether client-side
      tiling behaves correctly. Reject (413) any `/ocr` upload with
      `max(width, height)` over a configured cap (~1200px, comfortably above the
      largest expected single-tile case) before RapidOCR ever sees the bytes.
      `max_side_len` alone is not a reliable hard limit for arbitrary input shapes —
      it caps the image's longer side, but a sufficiently elongated input (e.g. a
      thin strip) can get downscaled below det's own 736px short-side floor by the
      Global resize, then scaled back *up* past the original cap by det's own
      internal resize, defeating the intended limit. An explicit pre-check on
      decoded dimensions doesn't have that failure mode.
- [x] **Dedup: duplicate removal only, no cross-tile box stitching.** Overlapping
      tiles will often detect the same complete box twice; translate every tile's
      boxes to full-image coordinates, then drop any box whose bounds overlap an
      already-kept box at all, keeping the higher-confidence one — greedy NMS,
      simpler than an IoU threshold in the end (`geometry.js`'s `selectNonOverlapping`,
      which also replaced the ad hoc logic `ocr.js`'s pre-existing manual "prune
      overlapping" button used, so both share one implementation now). Deliberately
      does not attempt to reconstruct a box that got cut in half at a tile seam —
      that surfaces as a visible partial/garbled detection, an acceptable failure
      the user can fix by redrawing the selection so the seam doesn't fall on a label.
- [x] **Configurability, server-side** — every backend-side level identified during
      this investigation is now a config knob, not a hardcoded assumption:
      - The server-side hard dimension cap — `OCR_MAX_DIMENSION` env var (default
        1200; non-positive disables it entirely, e.g. for local dev, see below).
      - `OCR_WORKERS` (pre-existing) — more workers only helps on a host with more
        than one core; stays at 1 on Render's single-core free tier.
      - ONNX Runtime's `intra_op_num_threads`/`inter_op_num_threads` — `OCR_INTRA_OP_THREADS`/
        `OCR_INTER_OP_THREADS` env vars, `-1` (RapidOCR's own "unset, auto-detect"
        sentinel) by default. Auto-detect over-provisions inside a *CPU-restricted*
        container specifically (`os.cpu_count()` sees the host's full core count, not
        any cgroup limit) — confirmed directly: pinning to 1 on a single-core-pinned
        container measured ~22x faster than leaving this at -1 (see Benchmarks).
      - OpenCV's own internal thread pool (`cv2.setNumThreads()`, separate from ONNX
        Runtime's settings) — `OCR_CV2_THREADS` env var, same `-1` convention.
- [ ] **Configurability, client-side — tile size, overlap fraction, and the
      single-tile threshold multiplier are still plain hardcoded constants in
      `ocr.js`** (`TILE_SIZE`/`TILE_OVERLAP_FRAC`/`TILE_SINGLE_CELL_FACTOR`), not a
      runtime config knob — changing them for a bigger production host still needs a
      code edit. Partial exception: `TILE_SIZE` already auto-detects local dev
      (`IS_LOCAL_DEV`, hostname-based like `BACKEND_URL`) and switches to `Infinity`
      (no tiling) there, but that's a fixed dev/prod split, not a general-purpose
      override the way `BACKEND_URL`'s `localStorage` mechanism is. Would need the
      same treatment (or similar) to let a bigger production host raise these without
      editing source.

**Known follow-ups from the implementation above**
- [ ] Rotating the photo while a tiled scan is in flight desyncs the live tile-outline
      overlay: `rotate()` remaps `detections`' boxes via `rotatePoint()` but not
      `tileOverlay` (added for live per-tile progress), leaving the outlines in stale
      pre-rotation coordinates once rotated. Simplest fix is probably disabling
      `rotateLeftBtn`/`rotateRightBtn` while a scan is in flight (matching how `runOcrBtn`
      etc. already get disabled during processing) rather than live-remapping the overlay.
- [ ] "Clear scan" doesn't cancel an in-flight tiled scan: `recognizeTiled`'s sequential
      per-tile loop keeps awaiting/sending remaining tiles after the user clears, and
      whatever comes back still gets applied (or at least keeps occupying the backend's
      job queue) regardless. Needs some form of cancellation — e.g. a "scan generation"
      counter checked after each `await`, or an `AbortController` wired into the tile
      fetches — so Clear (or loading a new image) can signal the loop to stop early and
      discard results. Not yet designed in detail.
- [ ] Too easy to click "Run OCR" and lose work: it replaces the whole auto-detected
      layer on every click (`source === "manual"` boxes survive, but anything done to
      auto-detected ones — deleted an incorrect box, moved/resized one to be more
      accurate — gets wiped and regenerated fresh, since only literal `source ===
      "manual"` is preserved). Add a `confirm()` dialog before running if there's
      something at risk (matching the existing pattern `clearSession()` already uses,
      "Clear the loaded photo and all boxes?") — manual boxes present, and/or evidence
      auto-detected boxes have been deleted since the last scan. Not yet designed in
      detail (deciding how to detect "deleted since last scan" specifically).

**Benchmarks**
Raw data behind the design above, kept for reference. All measured on this dev
machine pinned to one core (`taskset -c 0`), ONNX Runtime and OpenCV threads both
capped to 1, approximating Render's single-core free tier — not any particular
production host.

Memory vs. det input size (single process, one `RapidOCR()` instance, crops of
`IMG_0664.jpg` at increasing size, each run to a stable `ru_maxrss` plateau):

| crop size | boxes found | plateau RSS |
|---|---|---|
| 240x180 | 3 | 262MB |
| 360x270 | 5 | 263MB |
| 480x360 | 7 | 263MB |
| 672x504 | 11 | 263MB |
| 960x720 | 29 | 263MB |
| 1320x990 | 38 | 381MB |
| 1680x1260 | 41 | 545MB |
| 2040x1530 | 45 | 706MB |
| 2400x1800 (full; downscaled to 2000x1500 by `max_side_len`) | 47 | 708MB |

Flat from 360x270 to 960x720 because det's own internal resize (`Det.limit_type:
min`, `limit_side_len: 736`) upscales anything with a shorter side under 736px up to
exactly 736px — all of those crops land on the identical resized tensor regardless
of their own size. Real growth starts only once a crop's shorter side already
clears 736 unscaled.

Same data reworked to the *actual* post-resize det input (crop size above, after
both `max_side_len` and the 736-floor resize, rounded to a multiple of 32) — this
is the table to use when picking a tile size for a given memory budget:

| det input (post-resize) | megapixels | measured total RSS | marginal over ~120MB baseline | MB/Mpx |
|---|---|---|---|---|
| 736x992 (the floor — every crop below it lands here) | 0.73 | 263MB | 143MB | 196 |
| 992x1312 | 1.30 | 381MB | 261MB | 200 |
| ~1248x1680 | 2.10 | 545MB | 425MB | 203 |
| 1504x1984 (`max_side_len`-capped ceiling) | 2.98 | 706MB | 586MB | 196 |

~200MB/Mpx holds within a few percent across the whole range, giving a general
sizing formula: `peak RSS ≈ 120MB + 200MB x (tile megapixels)`, clamped between the
0.73Mpx floor and whatever `max_side_len` allows at the top. E.g. a target budget of
320MB total (200MB marginal) implies a tile around 1.0Mpx (~832x1202 at a 736 short
side); 420MB total (300MB marginal) implies ~1.5Mpx (~736x2040, though by the
tile-size timing benchmark below that's already past the point where bigger tiles
stop paying for themselves in wall time, not just memory).

Per-stage breakdown (full 2400x1800 image, two calls to separate cold-start cost
from steady state):

| stage | call 0 | call 1 |
|---|---|---|
| det | +404MB | +133MB |
| cls | +0MB | +0MB |
| rec | +0MB | +0MB |

Confirms det alone drives the memory cost; `cls`/`rec` are negligible regardless of
box count (47 boxes both calls).

Tile-size timing, grid over the full 2400x1800 image (15% overlap):

| tile size S | tiles | total wall time | avg per-tile |
|---|---|---|---|
| 736 | 12 | 3.31s | 0.274s |
| 1140 | 6 | 6.13s | 1.019s |

Half the tiles at S=1140, but 1.85x the total time — bigger tiles are worse, not a
trade-off (cache-locality read in Tiled scanning above).

Per-tile timing at the chosen S=736, sampled across both example images (50%
overlap grid, 30 tiles total, within the largest exact multiple of 736 in each
image):

| image | tiles | min | median | mean | max | stdev |
|---|---|---|---|---|---|---|
| IMG_0664.jpg | 15 | 0.135s | 0.234s | 0.269s | 0.499s | 0.128s |
| IMG_0648.jpg | 15 | 0.135s | 0.506s | 0.430s | 0.714s | 0.199s |
| combined | 30 | 0.135s | 0.278s | 0.349s | 0.714s | 0.184s |

p90 0.621s, p99 0.714s. Same tile size, same resolution, but `IMG_0648.jpg` tiles
ran ~60% slower on average than `IMG_0664.jpg` tiles — content-dependent (det's
postprocessing and the downstream cls/rec crop count scale with how much text a
tile actually contains, not just its pixel count).

**Security & cost control** — free, unauthenticated, public-facing service
- [ ] Per-IP rate limiting / throttling
- [x] Bounded concurrency — done via the job-queue + persistent-worker-pool design
      above (`OCR_QUEUE_MAXSIZE`, default 2). A full queue returns 503 with
      `Retry-After` rather than letting requests pile up for a client that's likely
      already given up. Sizing (worker count, queue depth) is a config knob now, not
      yet tuned against real host numbers.
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
