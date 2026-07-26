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
  recognized module numbers to `guide.html`. Imports `geometry.js` and `tiling.js`.
- `geometry.js` — pure view-transform/hit-testing/box math for `ocr.js`'s canvas. No
  DOM — imported by `ocr.js` and its test.
- `tiling.js` — pure region-tiling math for the OCR backend (`axisTiles`/`tileGrid`).
  Split from `geometry.js`: it encodes the backend's size constraints, not anything
  about the canvas. No DOM — imported by `ocr.js` and its test.
- `backend/` — the Python OCR service (`server.py`, `Dockerfile`); see Phase 2b.
  Not client-side, so it stays a separate service from the rest of the app.
- `test/` — Node built-in test runner (`node --test`), zero dependencies:
  `core.test.js` + `guide.test.js` (parser/lookup logic), `geometry.test.js`
  (canvas math), and `tiling.test.js` (region tiling).
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
- [x] Let the user edit a found box's recognized text directly. Shipped as `results-list.js`'s
      inline label editor: clicking a row's label swaps it for a text input (Enter commits,
      Escape/blur cancels); committing a genuine change sets `manual: true` (a new detection
      state, checked first everywhere — `detections.js`) and clears `score`/`attempted`, so a
      hand-corrected box is authoritative and distinct from an OCR result, both visually (✎
      glyph, own colour) and for the `guide.js` handoff (counts as labelled either way).
      Re-entering the *same* text the box already showed is treated as confirming an OCR read
      verbatim, not an edit — the score is left alone rather than being needlessly cleared.
      Also sticky through further edits/rescans: moving/resizing a manual box, or a later
      rescan, leaves its hand-entered text untouched (the box is only an approximate location
      once labelled by hand). Covered by `test/browser/label-editing.spec.mjs`.

**Multi-image workflow**

A real board pile often won't fit in one photo, so the goal is to scan several and combine
them into one identification. Combining is nearly free at the handoff — `guide.js` already
takes a newline list and counts quantities — so the work is in the data model and the UI, not
the merge. This is also the substrate for building `hasso/labels.json` ground truth
(`groundtruth.md`) by hand-labeling many real photos, which is what surfaced the design below:
labeling 221+ images meant confronting IndexedDB growth and vocabulary head-on before writing
code. **Status: implemented** (all six steps below landed and tested — 98 unit + 56 browser
tests green). The one item not done is the further, tagged-provenance refinement to the guide
handoff, noted in its own bullet below; everything else in this section describes what shipped.

**Vocabulary.** An **image** is one loaded photo and its working state (what the earlier sketch
called a "session" — renamed because `session-store.js`/"the session" already means something
broader: the tool's whole persisted working state). A **batch** is the current *set* of loaded
images — `state.images[]` collectively. "Session" keeps its original meaning; it is never used
for a single image.

**State shape.**
```
state.images = []       // [{ id, sha256, fileName, img, rotation, full, view, minScale,
                         //    detections, nextId, selectedId, draftBox, hoverDeleteId, hoverBoxId }]
state.activeId = null
```
`id` is a small integer, assigned the instant a file is picked — the session's true key.
`sha256` is a separate field, filled in once `crypto.subtle.digest` resolves (hashing is
async, so identity can't wait on it). `state.active` is a getter (`images.find(i => i.id ===
activeId)`) so the `state.<field>` → `state.active.<field>` repoint (the step-9 rename
pattern) reads/writes the right image automatically. Unlike step 9, this repoint is **not**
done as a blind tokenizer pass: `state.active` can be `null` (nothing loaded yet), so every
*read* guard becomes `state.active?.field` while every *write* stays bare `state.active.field
= …` (writes only ever happen once an image is known to exist) — a per-call-site judgement,
not a mechanical substitution.
`scanQueue`, `pendingPlaceholders`, `tileOverlay`, `scanAbortController`, `suppressScanSummary`,
`lastStatusMessage` stay top-level, not per-image: **v1 deliberately keeps scanning exclusive
to the active image** (switching images is disabled while a scan is in flight, the same gating
rotate already uses) rather than making the scan queue per-image — real added complexity,
not needed yet.

**IndexedDB: three stores, replacing the single-slot schema.**
- `images` (keyed by `sha256`) — blobs for the *current batch only*. Cleared and replaced
  wholesale on every batch change. This is what bounds growth: at most one batch's worth of
  image bytes is ever persisted, not a cumulative archive (`hasso/` alone is ~114MB across 221
  images — fine for a single batch on any non-mobile browser, not something to let accumulate
  forever across every batch ever loaded).
- `labels` (keyed by `sha256`) — `{filename, rotation, detections}`, permanent, upserted on
  every edit to the image that's currently active (only the active image can be edited, so
  there is nothing to "catch up" when the batch changes — every image's ledger entry is always
  current the moment its edit happens). Never purged except by the two Clear operations below
  that name it explicitly. Small forever (KBs/entry even at thousands of images) — and doubles
  as the working draft of `hasso/labels.json` (`groundtruth.md`) for that step's export.
- `batch` (single record) — `{order: [sha256, …], active: sha256}`, describing the current
  batch's composition and order, so a reload can reconstruct `state.images[]` faithfully
  without needing files re-selected (their bytes are still in `images`).

**Loading a batch:** hash each incoming file, check `labels` for a match, reattach
`rotation`/`detections` if found (a previously-labeled image "remembers" its boxes even with
freshly-supplied pixels), then write the new `images` + `batch`. Selecting one file is a batch
of size one — no special-casing anywhere in this design.

**Five "Clear"-family operations**, an escalation by scope, only two of which ever touch the
permanent ledger:

| # | Action | Batch membership | `labels` ledger | Confirm? |
|---|---|---|---|---|
| 1 | Clear image | active image's boxes only, image stays | reflects the edit normally (no special-casing — clearing to zero boxes is just an edit) | yes |
| 2 | Drop image | active image removed from batch | untouched | yes |
| 3 | **Finish batch** | entire batch emptied | untouched | **no** — reversible: re-selecting the same files reattaches everything from the ledger |
| 4 | Clear batch | entire batch emptied | deleted, scoped to this batch's images | yes |
| 5 | Clear all | entire batch emptied | deleted, every image ever labeled | yes |

1/2/4/5 live behind a single "Clear ▾" menu (too many destructive actions to leave as top-level
buttons); "Finish batch" stands alone as the routine, low-friction action — it's what "loading a
new batch of files" already does as a side effect (fold + purge), offered explicitly for
finishing up without a next batch ready yet.

**Known follow-up, not blocking:** naming a batch (e.g. "hasso") so returning to it later and
adding more images reads as the same effort, for filtering/export/provenance. Not needed
mechanically — the sha256-keyed ledger already lets you re-select a folder that's grown since
last time and get correct reattach-old/blank-new behavior with no name at all — so this is
purely organizational polish, addable later as an optional field on the `batch` record and each
ledger entry, no rework of anything above.

- [x] `session-store.js`: rewritten to the three-store schema above (`loadBatch`,
      `clearStoredBatch`, `persistLabel`, `persistBatchMeta`, `replaceImages`, `deleteImage`,
      `deleteLabels`, `clearAllLabels`); `hashing.js`'s `sha256Hex(blob)` (`crypto.subtle.digest`),
      unit-tested against known vectors cross-checked with Node's own `crypto.createHash`. Every
      write that a caller might want to surface logs, then rethrows (rather than the old
      swallow-only pattern), so a failed save is never silently invisible.
- [x] Repointed `canvas-view`/`interaction`/`results-list`/`scan`/`thumbnails`/`ocr.js` onto
      `state.active.<field>` (a getter resolving `state.images.find(i => i.id === activeId)`).
      Done as a careful per-call-site pass, not the step-9 tokenizer script: `state.active` can be
      `null`, so every *read* guard became `state.active?.field` (or an early-return
      `const active = state.active; if (!active) return;`), while every *write* stayed bare
      `active.field = …`. `scan.js` captures `state.active` once at the top of
      `ensureWorkerRunning()` and uses that reference throughout, so a scan stays correct even if
      the "no switching mid-scan" UI constraint (image-switcher, below) were ever relaxed.
      One real bug the repoint surfaced and fixed: `thumbnails.js`'s cache was keyed by
      `detection.id` alone, which is only unique *within* one image (each image's ids restart at
      1) — two images could otherwise collide and show each other's cached crop. Now keyed by
      `${imageId}:${detectionId}`, and `clear()` takes an optional image id to scope the
      invalidation instead of always wiping every image's cache.
      `test/browser/fixtures.mjs`'s `readState()`/`readImageName()` rewritten for the new schema
      (resolving the active image via the `batch` store, then its `labels`/`images` entry) — the
      returned shape (`{filename, rotation, detections}`) is a superset of the old one, so no
      spec's assertions needed to change, only the raw-IndexedDB seed helpers three specs use
      (`list-actions`/`interaction`/`label-editing`) to target the new per-image keys. Surfaced
      and fixed a real race along the way: `loadSyntheticPhoto()` only waited for the visual
      "loaded" cue (button enabled), but `ocr.js` hashes and persists the batch afterward,
      unawaited (the same fire-and-forget precedent as the old `persistImage()`) — a seed helper
      reading IndexedDB right after could run before that write landed. Fixed by having the
      fixture wait for the real persisted state, the same precedent as the earlier
      Clear-boxes-then-reload race fix (see "Two mistakes worth recording" above).
      **Verified:** 95 unit + 39 browser tests green, run twice to rule out flakiness from the
      timing change. Batch-of-one behavior (the only shape reachable before task below) is
      unchanged from pre-repoint.
      Interim scope, not yet done: `clearSession()`/`clearDetections()` keep their original
      names/buttons and semantics for now (they already implement what the five-operation table
      calls "Clear batch"/"Clear image" respectively) — the rename, the other three operations,
      and the "Clear ▾" menu are the follow-up step below, reusing this logic rather than
      redoing it. The file input still accepts one file; multi-file + the ledger-reattach flow
      is the next step.
- [x] Multi-file input (`ocr.html`'s file input gained `multiple`) + the real batch-load flow
      (`ocr.js`'s fileInput handler): decode + hash every selected file in parallel
      (`loadOneFile()`), look up existing ledger entries in one batch (`loadLabelsFor()`),
      reattach `rotation`/`detections` for any sha256 hit and start blank otherwise, then
      `replaceImages()` (purges the outgoing batch's bytes, since it clears+repopulates the
      whole `images` store in one transaction) → `persistBatchMeta()` → `persistLabel()` for
      every image. A file that fails to decode is dropped with the rest still loading, rather
      than aborting the whole selection; a status message reports how many images loaded, how
      many reattached previous ground truth, and how many files were unreadable.
      New `test/browser/multi-image.spec.mjs` (3 tests): loading several files at once produces
      one batch in selection order with the first active; re-selecting a previously-loaded
      image (same content, so the same sha256) reattaches its box/label even after an
      intervening batch swap purged its pixels; loading a new batch removes the outgoing
      image's bytes from the `images` store while its `labels` entry survives. Both new
      mechanisms (reattach, purge) mutation-tested.
      **A real bug found via a standalone repro script** (not a unit/browser test — an ad hoc
      `_repro.mjs` dumping raw IndexedDB state at each step, written when a test failed in a
      confusing way and speculation wasn't converging): `test/browser/fixtures.mjs`'s
      `loadSyntheticPhoto()`/`loadSyntheticPhotos()` waited for "is `batch.active` truthy" (or
      "does `order.length` match") rather than confirming *this specific* load's own data had
      landed -- a second load in the same test could see the *first* load's already-truthy
      state and proceed before its own writes completed. `readImageName()` was resolving `null`
      for the second-loaded image because `batch.current` still pointed at the first image's
      hash while the `images` store had already been replaced with the second's. Fixed by
      waiting for the freshly-loaded image's own filename to appear in its ledger entry (a
      value that can only be true once *that* load's `persistBatchMeta`/`persistLabel` calls --
      awaited in sequence after `replaceImages` in `ocr.js` -- have actually resolved).
      **Verified:** 98 unit + 44 browser tests green, run twice for stability.
- [x] The five Clear-family operations + the "Clear ▾" menu + the standalone "Finish batch"
      button. `clearSession`/`clearDetections` renamed to `clearBatch`/`clearImage` (logic
      unchanged, already matched); added `dropImage()`, `finishBatch()`, `clearAll()`, and a
      shared `emptyBatch()` helper the three whole-batch operations (Finish/Clear
      batch/Clear all) call to reset `state.images`/UI/`clearStoredBatch()` in common, differing
      only in whether they also touch `labels` (`deleteLabels`/`clearAllLabels`) and whether
      they `confirm()` first. `ocr.html`: `dropImage`/`clearBatch`/`clearAll` live behind a
      plain-JS "Clear ▾" `.dropdown` (open on toggle click, close on outside click/Escape/
      choosing an item); `finishBatch` stays a standalone button, the only one of the five with
      no confirmation, since nothing is lost.
      **Correction, made unprompted then reverted on the author's say-so:** Clear image
      (the original "Clear boxes" icon button next to the results list) was first folded into
      the "Clear ▾" menu alongside the other three for consistency — the author's own call to
      make, not something asked for, and on trying it the standalone button turned out more
      intuitive (it's used often enough that a menu click was a step backward). Reverted:
      Clear image is back as the standalone `clearBoxes` icon button; the menu holds only
      Drop image / Clear batch / Clear all.
      New `test/browser/clear-operations.spec.mjs` (4 tests) covers what's new: Drop image
      changes only batch membership (ledger entry survives, the next image becomes active);
      Finish batch skips confirmation entirely and every dropped image's ground truth
      reattaches later; Clear all reaches images that were never even in the current batch
      (unlike Clear batch, scoped to it) -- the distinction that makes the two meaningfully
      different; and the menu opens/closes without misfiring an action. Existing specs
      (`session`/`list-actions`) updated to open the menu before clicking the operations that
      moved into it, and renamed to match ("Clear" → "Clear batch", "Clear boxes" → "Clear
      image").
      All three of the newly-added operations mutation-tested (dropImage leaving the ledger
      untouched; finishBatch's missing confirm; clearAll's whole-ledger vs. clearBatch's
      scoped-to-batch reach) — each confirmed to fail without its defining behavior.
      **Two more instances of the same persistence race** (see the batch-load flow above)
      surfaced while writing the new tests -- `dropImage()`/`clearAll()` are fire-and-forget
      from their click handlers, so a test checking IndexedDB immediately after the click could
      race their internal `await`s. Fixed the same way: poll for the specific persisted change
      (the batch's new size, the ledger's emptiness) rather than asserting immediately.
      **Verified:** 98 unit + 49 browser tests green, run twice for stability.
- [x] Image-switcher UI: new `image-switcher.js` (mirrors results-list.js's own pattern --
      `createImageSwitcher({ state, listEl, summaryEl, switchTo })` → `{ renderImageSwitcher }`,
      rebuilt wholesale on every render). A row of chips above `#workspace`, one per
      `state.images` entry, active one highlighted; clicking a chip calls `switchActiveImage(id)`
      (`ocr.js`), which changes only `state.activeId` and persists it (`persistBatchMeta`) --
      deliberately not routed through `renderActiveView()`/`redraw()`, so switching never resets
      the target image's own pan/zoom or re-persists its (unchanged) label. Switching is
      disabled mid-scan at two independent layers: the switcher skips wiring a click handler for
      any non-active chip while `state.scanAbortController` is set, and `switchActiveImage()`
      itself guards the same condition -- v1 keeps scanning exclusive to the active image (see
      scan.js), so the image a scan targets must not change underneath it. `renderImageSwitcher()`
      folded into `redraw()` (board counts change as boxes are edited) plus the direct
      `renderResultsList()` call sites it doesn't cover (`dropImage`/`emptyBatch`).
      New `test/browser/image-switcher.spec.mjs` (4 tests): chips list every image with the
      active one highlighted; clicking a chip switches (results list, canvas, and the persisted
      `batch.active` all update); switching is refused mid-scan and works again once the scan
      finishes; the "N board(s) across M image(s)" summary counts across the *whole* batch, not
      just the active image (confirmed by loading a second, unlabelled image alongside a
      labelled one and checking the board count doesn't move while the image count does).
      Mutation-tested the scan-exclusivity guard specifically in `switchActiveImage()`
      (`ocr.js`) -- the layer that actually matters, since removing the switcher's own
      redundant check made no observable difference (defense in depth working as intended;
      `ocr.js`'s guard alone is sufficient and is what the test was actually pinned against).
      **A UI change surfaced an already-known bug and got it fixed as a side effect:** the new
      chip bar adds enough page height that, at the test suite's viewport, the page itself now
      needs to scroll for `#resultsPanel` to be fully visible -- exposing the "selecting a box
      scrolls the whole page, not just the results list" bug filed earlier (see "Known
      follow-ups" above) in a real test for the first time. Fixed now rather than deferred:
      `results-list.js`'s scroll-into-view no longer calls the native, ancestor-walking
      `li.scrollIntoView()`; it computes the row/panel `getBoundingClientRect()` delta and
      adjusts `#resultsPanel.scrollTop` directly, which by construction cannot touch the page's
      own scroll position. Getting the mutation test to actually discriminate fixed-from-broken
      took two follow-up fixes of its own: the suite's normal 1400x1000 viewport is tall enough
      that the page never needed to scroll regardless, so the first version of the test couldn't
      tell the two apart (fixed by shrinking the viewport for just this test, restored after);
      and doing that shrink mid-test moved the canvas's on-screen position, which made the
      test's own click coordinates (captured against the pre-shrink layout) land in the wrong
      place (fixed by re-fetching the canvas's bounding rect after the resize).
      **Also reverted mid-task, on the author's say-so:** "Clear image" was briefly folded into
      the "Clear ▾" menu during task 4 (see that entry) and restored as the standalone icon
      button once the author found the menu placement less intuitive in practice.
      **Verified:** 98 unit + 54 browser tests green, run twice for stability.
      **A real bug found by the author testing the shipped feature, not by any test:** clicking
      a chip for a never-before-active image showed a blank canvas, made "OCR full photo" a
      silent no-op, and made rotate throw `active.full is null`. Root cause: loading several
      files at once only computes the offscreen `full` canvas for whichever image is active
      *at that instant* (`renderActiveView()`, called once by the batch-load flow) -- every
      other image in the same batch starts with `full: null` and, before this fix, stayed that
      way forever, since `switchActiveImage()` deliberately skips `renderActiveView()` (it would
      otherwise reset a previously-viewed image's pan/zoom back to a fresh fit every time you
      switched back to it). `dropImage()`'s switch to the next remaining image had the identical
      gap. Fixed with `ensureActiveViewInitialized()`: a no-op if the newly-active image already
      has `full` (preserves its view, as intended), otherwise runs `renderActiveView()` exactly
      once -- the missing first-time case, not a change to the "don't reset an already-viewed
      image" behavior. Deliberately lazy (computed on first switch-to, not eagerly for the whole
      batch at load time): eager computation for every image in a large batch (`hasso/`'s 221)
      would waste work on images the user may never look at.
      New coverage: `image-switcher.spec.mjs` gained a test switching to a never-viewed image
      and confirming rotate doesn't throw and "OCR full photo" actually enqueues a request (not a
      silent no-op); `clear-operations.spec.mjs`'s existing Drop-image test (which already
      exercised the identical path) gained the same rotate-doesn't-throw assertion. Both
      mutation-tested by reverting `ensureActiveViewInitialized()` to a no-op, reproducing the
      original bug exactly -- both new assertions failed as expected.
      **Verified again:** 98 unit + 55 browser tests green.
- [x] The handoff unions recognized text across the whole batch, not just the active image:
      `goToGuideBtn`'s handler (`ocr.js`) changed from `state.active.detections` to
      `state.images.flatMap((img) => img.detections)`, so labelling boards across several
      photos and clicking "Handoff to identify" once sends all of them together.
      `updateButtons()`'s enablement check for the button changed to match (enabled if *any*
      image in the batch has a labelled box, not just the active one). This is a flat union of
      text, matching the plain newline-list format `guide.js` has always consumed (even for a
      single image, there was never per-entry provenance) -- it is not the richer, tagged
      version below.
      New test in `multi-image.spec.mjs`: seeds a labelled box directly into two images'
      ledger entries, clicks the handoff, and reads `sessionStorage` in the same script that
      does the click (before the real navigation to `guide.html` — which would otherwise race
      `guide.js`'s own consumption/removal of that key) to confirm both images' text landed in
      one union, not just the active image's. Mutation-tested: reverting the flatMap back to
      `state.active.detections` fails the new test.
      **Verified:** 98 unit + 56 browser tests green.
- [ ] **Not done, a further refinement:** curate one combined list where each entry is tagged
      with which image and the coordinates within that image it came from (the original ambition
      for this bullet, before it was scoped down to "union the text"). Would need a richer
      handoff payload than the plain newline list `guide.js` parses today, so it's a `guide.js`
      change too, not just `ocr.js`'s. Not yet designed in detail.

**Next up — scan tool UX**, flagged from real use of the multi-image workflow on `hasso/`'s
221 images. Not yet designed in detail; ordered roughly by how soon they'll bite.
- [ ] **Browsing/selecting an image doesn't scale past a handful.** The image-switcher
      renders one chip per `state.images` entry in a row above `#workspace`; with 200+ images
      that's 200+ chips to hunt through. Simplest fix floated: previous/next buttons stepping
      through `state.images` in order, alongside the chip row (or instead of it — may also want
      paging/virtualization for the chips themselves). Not yet designed in detail.
- [ ] **Drop image: move off the "Clear ▾" menu onto an X near the canvas; skip the confirm
      for never-scanned images.** Currently one of the four operations behind "Clear ▾" (see
      the five-operation table above), always confirmed first. Two changes floated: (1) an
      always-visible X near the canvas/image-switcher instead of a menu item — dropping one
      image out of a large batch is routine, not a rare destructive action; (2) skip the
      confirmation dialog when the image being dropped was never scanned (no boxes drawn) —
      nothing is lost, so nothing to confirm.
- [ ] **Clarify Browse / Finish batch / Clear batch, and support adding images to an ongoing
      batch.** The three don't yet read as one coherent story: "Browse" (the file input)
      always starts a brand-new batch — `replaceImages()` purges the outgoing one wholesale,
      in the same transaction, with no way to add more files to what's already loaded; "Finish
      batch" and "Clear batch" both empty the batch and differ only in whether the ledger is
      left alone or wiped (see the five-operation table above), a distinction that isn't
      obvious from the names alone. Wanted: a way to add photos to an in-progress batch
      instead of only ever replacing it outright.
      **Author's simplification proposal, floated for discussion:** rename "Finish batch" to
      "Clear loaded images" — unloads the batch, saved boxes untouched, still no confirmation
      needed (nothing is lost). Question whether "Clear batch" (wipe saved boxes, scoped to
      just this batch) is worth keeping as its own tier: redoing a whole batch's boxes is
      already covered by using "Clear image" per image, one at a time, so a bulk batch-scoped
      ledger wipe may not earn its place as a separate operation from "Clear all." Leaning
      toward three operations instead of five: "Clear image" (per-image boxes, unchanged),
      "Clear loaded images" (unload only, was "Finish batch"), and "Clear saved boxes" (wipe
      the whole ledger, was "Clear all") — dropping "Clear batch" as the redundant middle
      tier. Still needs discussion/experimentation, in particular whether losing a
      batch-scoped (rather than whole-ledger) bulk wipe is actually fine in practice. Needs
      design work regardless of where this lands — likely touches `replaceImages()` and the
      file input's handler in `ocr.js`.
- [ ] **"Ground truth" should not appear in code.** The term leaked from `groundtruth.md`'s
      design vocabulary into comments across `hashing.js`/`session-store.js`/`ocr.js`, and
      into two user-facing `confirm()` dialog strings in `ocr.js` (Drop image, Clear batch) —
      ML jargon a labeler shouldn't need to know. Sweep: reword those confirm() strings in
      plain end-user terms (e.g. "saved labels for this image"), and reword the comments to
      describe the mechanism (the permanent `labels` ledger, content-hash reattachment)
      rather than naming the ML concept it happens to serve. `groundtruth.md` itself keeps the
      term — it's the design doc for the eval-harness concept, not code.

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
- [x] Migrated off the EOL `rapidocr-onnxruntime==1.4.4` to the maintained unified
      `rapidocr` package (3.9.2, Jul 2026). `server.py` moved to the 3.x API (`params`
      config dict instead of constructor kwargs; results as a `RapidOCROutput` with
      parallel `boxes`/`txts`/`scores` instead of the 1.x `(list, elapse)` tuple), and
      the other deps went to latest stable (`onnxruntime` 1.28.0, `tqdm` 4.69.1, plus
      rapidocr's new runtime deps `omegaconf`/`requests`/`colorlog` pinned in
      `requirements.txt`). The key behavioural change: `rapidocr` 3.x downloads models on
      demand rather than bundling them, so the `Dockerfile` now **pre-downloads them at
      build time** into `/app/models` (`OCR_MODEL_ROOT_DIR`) — keeping the running
      container offline for model fetches and enabling the egress lockdown in
      `security.md`. **Needs on-box validation** (not run here): reinstall, run the
      regression suite, and re-baseline `test_server.py`'s expected scores if the newer
      models shifted them; then rebuild the image to confirm the model bake lands in a
      runtime-readable path. The earlier memory-profiling caveat (peak RSS ~545MB,
      dominated by pipeline buffer copies at RapidOCR's ~2000px working resolution) still
      applies and should be re-measured on 3.x.
      **Model choice benchmarked and pinned (`eval_models.py`):** rapidocr 3.x's own
      default (PP-OCRv6 "small") both misread the sample labels (`M8295` → `M2295`) and ran
      heavier; a sweep across v4/v5/v6 × tiers found **PP-OCRv4 "mobile"** the only variant
      reading every sample label correctly while staying fast (~2s) and under the memory
      ceiling (~760MB peak on a full image, far less per tile). It is the same family the
      retired 1.4.4 used, so accuracy/memory match the pre-migration baseline. Pinned as the
      `server.py` default (`OCR_DET_VERSION`/`OCR_REC_VERSION`=PP-OCRv4,
      `OCR_DET_MODEL_TYPE`/`OCR_REC_MODEL_TYPE`=mobile), overridable via env; the regression
      suite re-baselined against it, 18/18 green.

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
would hit the ~700MB ceiling directly. Implemented (`ocr.js`, `tiling.js`,
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
      non-square tiles. Implemented as `tiling.js`'s `axisTiles`/`tileGrid`
      (Node-tested, `test/tiling.test.js`) — folds the single-tile threshold above
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
- [x] Rotating the photo while a tiled scan is in flight desyncs the live tile-outline
      overlay: `rotate()` remaps `detections`' boxes via `rotatePoint()` but not
      `tileOverlay` (added for live per-tile progress), leaving the outlines in stale
      pre-rotation coordinates once rotated. Fixed by disabling `rotateLeftBtn`/
      `rotateRightBtn` while a scan is in flight rather than live-remapping the overlay:
      a module-level `scanInProgress` flag is set around both `recognizeTiled` callers
      (`runOcrBtn`'s handler and `recognizePendingBoxes()`), factored into
      `updateButtons()`'s rotate-button disabled state, plus a defensive check directly
      in `rotate()` for any non-button caller.
- [x] "Clear scan" doesn't cancel an in-flight tiled scan: the old `recognizeTiled`'s
      sequential per-tile loop kept awaiting/sending remaining tiles after the user
      cleared, and whatever came back still got applied (or at least kept occupying the
      backend's job queue) regardless. Fixed with a shared `scanAbortController`,
      non-null for the duration of any scan: passed as `signal` into every tile's
      `fetch` (actually cancels an in-flight request, freeing the backend's job queue
      slot) and rechecked right after each tile's `await` resolves, since an
      already-settled fetch can't retroactively be un-resolved by a later `abort()` —
      that result is discarded instead of being applied. `clearSession()` and loading a
      new photo both call `.abort()` before proceeding. A new "Cancel scan" button does
      the same without the rest of Clear's reset, keeping whatever boxes the scan
      already found.
      Landed together with a follow-on refactor (**shared queue for tiles and new
      boxes**, floated alongside this fix): a whole-photo "Run OCR" is just a region
      that happens to cover the full image, and a drawn box is a smaller region — both
      are now reduced at click time to the same thing, a flat `scanQueue` of
      already-tile-sized crops in full-image coordinates, drained by one
      `ensureWorkerRunning()` worker loop. This replaced the old
      `recognizeTile`/`recognizeTiled` pair (region-local tiling done fresh inside each
      call, with a provisional-then-reconciled result and per-call cross-tile dedup) and
      resolved the interim mutual-exclusion this fix first shipped with: `runOcrBtn` and
      `recognizePendingBtn` no longer lock each other out, since both just push onto the
      same queue and (re)start the worker — clicking either while a scan is already
      running adds more work to it instead of being blocked, including drawing and
      recognizing new boxes while a whole-photo scan is still going.
      **Dedup is now a manual step, not automatic.** The old per-call
      `selectNonOverlapping` cross-tile dedup is gone; overlapping tiles' duplicate
      detections are left for the existing "Prune overlapping" button — one dedup path
      instead of two, and the raw per-tile results stay inspectable before anything's
      merged (explicit tradeoff, chosen over auto-dedup for visibility/control). The
      scan-complete status message nudges toward that button when
      `computeOverlapWarnings()` finds anything to clean up.
      **Also resolved as a side effect:** the separate "too easy to click Run OCR and
      lose work" bug below — Run OCR no longer wipes-then-refills the auto-detected
      layer on every click (that whole provisional/reconcile mechanism is gone), so nothing
      gets silently destroyed by a re-scan; old and new auto boxes coexist until pruned.
- [x] ~~Too easy to click "Run OCR" and lose work~~ — see above; superseded by the
      shared-queue refactor rather than fixed with the originally-proposed `confirm()`
      dialog.
- [x] **"Clear boxes" button**, top right of the results list header (next to "Boxes").
      Narrower than the existing "Clear" button: drops every box (`clearDetections()`)
      but keeps the loaded photo, so re-drawing/re-scanning doesn't need reloading the
      file first. Cancels an in-flight scan the same way `clearSession()` does; since it
      (unlike `clearSession()`) leaves `img` set, a `suppressScanSummary` flag tells
      `ensureWorkerRunning()`'s completion handler to skip its own status message this
      one time, so a scan's summary can't get posted over the just-emptied list.
- [ ] **Dedup checks text before pruning.** `pruneOverlapping()`/`selectNonOverlapping`
      (geometry.js) currently judge duplicates by spatial overlap alone (bounding-box
      area + score), blind to the recognized text. Two boxes that overlap but hold
      different text are more likely two distinct nearby labels than one label read
      twice, and pruning on overlap alone risks silently discarding the wrong one.
      Worth factoring text similarity into the keep/drop decision (e.g. only treat an
      overlapping pair as a true duplicate if their text also matches or is a close
      fuzzy match) rather than pure geometry. Not yet designed in detail.
- [ ] **Order the results list by closeness/overlap, or by scan order.** `renderResultsList()`
      currently just walks `detections` in array order (insertion order — whichever
      order tiles/regions happened to report back). With dedup now a manual step (see
      above), overlapping/duplicate entries are more visible in the list than before;
      grouping or sorting spatially-close/overlapping boxes next to each other (or at
      least keeping them in a stable, predictable order — e.g. scan order, or grid
      position) would make it easier to spot and compare them before pruning. Not yet
      designed in detail (worth deciding against the closeness-grouping idea vs. a
      simpler fixed sort key first).
- [x] **Moved "Prune overlapping" and "Prune empty" next to "Clear boxes."** All three
      now live in `#resultsHeader` (ocr.html) as icon-only `.icon-btn` buttons — the
      same pattern already used for find/delete in the results list rows — each with a
      `title` tooltip carrying the full description: &#10697; prune overlapping,
      &#8709; prune empty, &#128465; clear boxes. Documented in the cheatsheet
      alongside the list-row icon row. Keeps the header compact at the panel's 280px
      width without shortening any text.
- [ ] **Invalidate and re-scan every box.** One action that resets all existing boxes to
      pending — clearing `text`, `score`, and `attempted` — and enqueues them for
      recognition again, without redrawing them by hand. Wanted when a first pass read
      badly, when the photo has been rotated since, or when the backend or its settings
      changed underneath the results. The queue already supports this shape: it is what
      `recognizePendingBoxes()` does, applied to boxes that are no longer pending.
      **Decided:** re-runs only the existing boxes, never the whole-photo pass; includes
      hand-drawn boxes alongside auto-detected ones; and asks for confirmation first, since
      it discards every recognized text in one click.
- [ ] **Review box and tile color/look for status and position clarity.** Box outlines
      (`colorFor`, detections.js) currently pack four states into color alone — green/
      yellow/red confidence bands, grey "not yet recognized", dark red "no text found",
      and (new, step 8 of `refactor-plan.md`) "failed — try again" reads as the same grey
      as never-tried. Tile progress overlay (`drawTileOverlay()`, ocr.js) is a single fixed
      cyan, dashed-vs-solid for pending-vs-done. With many boxes/tiles on screen at once,
      worth a deliberate pass over the whole palette — and general legibility of position
      (overlapping outlines, label placement) — rather than colors and states having
      accreted one at a time as features landed. Not yet designed in detail.
- [ ] **Hover/selection UX pass on canvas <-> list linkage.** Four related fixes:
      1. Hovering a box on the canvas should highlight its row in the results list — today
         only the reverse direction exists: list-row hover reveals the full label on canvas
         (`hoverBoxId`/`showFullLabel`, canvas-view.js).
      2. The canvas delete-X (`deleteHotspotDisplayPos`, canvas-view.js) floats above the
         box's top-center; move it to the top-left instead.
      3. List-row hover should change the box's canvas color/outline, not swap in the full
         text label — the label reveal should stay tied to selection only.
      4. The selected row's list highlight (`li.style.fontWeight = "bold"`, results-list.js)
         is too subtle to spot at a glance; make it clearly distinct (e.g. a background tint
         or border, not just font-weight).
      Not yet designed in detail.
- [x] **Selecting a box scrolls the whole page, not just the results list.** Was calling
      `li.scrollIntoView({ block: "nearest", inline: "nearest" })`, which walks *every*
      scrollable ancestor of the row, not just `#resultsPanel` — if the page itself is
      scrolled (the tool sits below the fold), selecting a box whose row needs scrolling
      within the panel also dragged the whole page's scroll position along with it.
      Fixed as a side effect of the image-switcher task (see "Multi-image workflow" above):
      `results-list.js` now computes `#resultsPanel.scrollTop` directly from the row's
      `getBoundingClientRect()` against the panel's own, rather than the browser's native
      ancestor-walking `scrollIntoView()`. Still open: the "make the selected row clearly
      distinct" need from item 4 above (bold text alone is easy to miss) — not done in the
      same pass after all, since the scroll fix landed separately, driven by a real test
      needing it rather than this bullet.

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
