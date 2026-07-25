# Scan tool — fix & refactor plan

Working plan for the review findings on `ocr.js` / `geometry.js` (July 2026). Ordered so
each step is small, independently verifiable, and leaves the app working. Behavioural
fixes come before any code movement, so the restructuring steps don't have to preserve
buggy behaviour.

Steps are checked off as they land. Stop and review after each.

## Verification baseline

`npm test` runs 62 tests covering `core.js`, `geometry.js`, `guide.js`, and
`backend-config.js`. **None of them execute `ocr.js`** — it is DOM-driven, and the repo has
no browser automation. For every step below, automated verification means `node --check`
plus the existing suite; anything specific to `ocr.js` needs the listed manual browser
check. Each step names its own.

Local run for manual checks:

```
python3 -m http.server 8123        # frontend, from the repo root
                                   # backend: see backend/README.md, OCR_MAX_DIMENSION=0
```

## Step 1 — thumbnails out of persisted state, and out of the pan path

- [x] **Change.** `thumbnailDataUrl()` caches base64 PNGs as `_thumbKey`/`_thumbUrl` on the
      detection objects themselves. `persistState()` serialises `detections` wholesale, and
      `redraw()` calls `persistState()` — so the pan branch of `pointermove`, the wheel pan
      branch, and `zoomTo()` each write every thumbnail to IndexedDB on every pointer event,
      and rebuild the full results-list DOM alongside it.
      Move the cache to a module-level `Map` keyed by detection id (invalidated by the same
      box key as today, cleared by `clearSession()`/`clearDetections()` since `nextId` restarts
      at 1). Switch the three view-only call sites to `redrawCanvas()`: pan and zoom change no
      persisted state and no list content, so neither the DOM rebuild nor the write is needed.
      Landed as a module-level `thumbnailCache` (id -> `{ key, url }`), cleared by
      `clearSession()`, `clearDetections()`, `rotate()`, and loading a new photo.
      `restoreSession()` strips `_thumbKey`/`_thumbUrl` from sessions saved before the
      change, so an existing session stops carrying its data URLs forward.
- [ ] **Verify.** `node --check ocr.js` and `npm test` pass. Reload restores the session with
      boxes intact, and rotating re-crops the list thumbnails — both confirmed in a browser.
      **Deliberately still open:** the pan/zoom smoothness check with ~20 boxes present.
      Whether motion feels smooth and the list doesn't flicker is a judgement to make by
      hand; the author will do it at some later stage. Nothing else depends on it.
- [x] **Consider.** Resolved as yes — `rotate()` clears the cache. Box coordinates change
      under rotation, so the key check catches it in almost every case, but a centrally
      symmetric box on a square image can rotate onto its own coordinates while `full`'s
      contents change beneath it. Clearing is cheap; relying on the key is not sound.

## Step 2 — count HTTP failures as failures

- [x] **Change.** `recognizeTile()` does `resp.ok ? await resp.json() : []`, and the worker's
      `errorCount` only counts thrown errors. A scan whose tiles all return 503 (backend
      queue full — an expected condition under load) currently reports "Scan complete,
      nothing found". Throw on a non-OK response; the worker's existing `catch` already
      treats that as a tile that found nothing *and* increments `errorCount`, which is the
      wanted behaviour.
      The summary also names the first error, since "3 tile(s) failed" alone doesn't
      distinguish a busy backend from a misconfigured one. Slightly beyond the change as
      first written, but the step exists to stop the status line misleading.
- [x] **Verify.** `node --check` and `npm test` pass (62/62). Behaviour confirmed in a real
      browser: pointing the `fieldGuideBackendUrl` override at the static file server (which
      returns 501 for POST) produced `1 tile(s) failed (HTTP 501)`, where the pre-fix code
      reported `Scan complete, nothing found` for the identical request.
- [x] **Consider.** Resolved: **no automatic retry.** A failed region stays the user's to
      re-run, which keeps soft and transient backend problems visible instead of smoothing
      them over — an automatic `Retry-After` loop would hide exactly the flakiness worth
      noticing. What this does need is for a failed box to stay retryable, which it
      currently isn't; see step 8.

## Step 3 — don't discard work enqueued during scan teardown

- [x] **Change.** After `abort()`, `scanAbortController` stays non-null until the worker's
      `finally` runs. Clicking Run OCR in that window pushes tiles onto `scanQueue`,
      `ensureWorkerRunning()` early-returns, and the `finally` then does `scanQueue = []` and
      throws them away — the button appears dead. Tag items enqueued while
      `scanAbortController.signal.aborted` is true, and carry those into the next drain
      instead of clearing them.
      Landed as an `enqueueTile()` helper that tags each item with
      `enqueuedAfterAbort`, plus a teardown that keeps the tagged items (and their tile
      overlay entries), discards only the cancelled drain's own leftovers, and restarts the
      worker when anything carried over.
- [x] **Verify.** `node --check` and `npm test` pass (62/62). Behaviour confirmed in a real
      browser, cancelling and re-scanning inside one `Runtime.evaluate` so the worker cannot
      tear down between the two clicks: post-fix, 2 `/ocr` requests and the second scan
      completes; pre-fix, 1 request and the status stays at
      `cancelled (1 tile(s) left unscanned)`.
- [x] **Consider.** Resolved: the fix belongs at enqueue time, because teardown cannot
      otherwise tell a cancelled drain's leftovers from work that arrived during it. Clear
      boxes → draw → Recognize new boxes is covered by the same tag. A carried-over
      *manual* tile also needs its `pendingPlaceholders` entry preserved, or the next drain
      resolves a placeholder that no longer exists — hence `carriedPlaceholderIds`.

## Step 4 — small hygiene

- [x] **Change.** Dropped the redundant `"use strict"` from all nine ES modules (source and
      tests). Replaced `tileOverlay.find((t) => t.box === item.box)` — an O(n) search that
      worked only because the same array object was pushed to both structures — by having
      each queue item hold its own overlay entry, so marking a tile done is a direct write.
      `cropCanvas.toBlob()` returning `null` now throws instead of posting an empty body,
      which the worker would otherwise have read as a tile that found nothing.
      **Rename not done** — see Consider.
- [x] **Verify.** `node --check` clean on every file; `npm test` 62/62. Three browser checks,
      since none of this has unit coverage: a full scan (exercises the new overlay write),
      cancel-then-rescan (exercises overlay entries being reused on carry-over), and
      `guide.html` (touched only by the `"use strict"` removal, but largely outside the unit
      tests) — 1464 modules parsed, cards rendered, no errors.
- [x] **Consider.** The rename `ensureWorkerRunning()` -> `drainScanQueue()` was dropped,
      reversing the earlier recommendation. `ensureWorkerRunning()` states the contract a
      caller gets: idempotent, starts a worker only if one isn't already running.
      `drainScanQueue()` reads as "drain now", which is precisely what the function does not
      do when a drain is already in progress. The existing name is the more accurate one, so
      churning ten call sites would have made the code slightly worse.

## Step 5 — split tiling out of `geometry.js`

- [x] **Change.** `geometry.js` holds two unrelated clusters: canvas view-transform and
      hit-testing (its stated job), and OCR tiling/dedup (`axisTiles`, `tileGrid`,
      `selectNonOverlapping`) which encodes tile sizes, seam overlap, and score ranking.
      Move the second cluster to `tiling.js`; split `test/geometry.test.js` along the same
      line. Both halves stay pure and Node-testable.
      `axisTiles`/`tileGrid` moved to `tiling.js`; `selectNonOverlapping` did not (see
      Consider below). `PLAN.md` and `README.md` updated to match.
- [x] **Verify.** `npm test` passes, still 62 tests — the same count before and after, which
      is what shows the split moved tests rather than losing or duplicating them. Confirmed
      in a browser too: `node --check` parses but does not resolve imports, so a bad
      specifier would only appear at load. A real scan ran end to end through the moved
      `tileGrid` and produced 21 boxes, with no script or module errors.
- [x] **Consider.** Resolved: `selectNonOverlapping` stays in `geometry.js` for now.
      It is no longer part of the tiling path at all — that call site died in the queue
      refactor — so filing it under `tiling.js` would recreate the same drift this step
      removes. It is box math with a thin scoring policy on top, so it sits acceptably
      beside `boundsOf`/`overlapArea`, and is a candidate to join `detections.js` in step 7
      rather than justifying a module of its own now.

## Step 6 — extract `session-store.js` from `ocr.js`

- [x] **Change.** Landed as `session-store.js` (95 lines): the IndexedDB layer plus four
      exported entry points — `persistImage`, `persistState`, `loadSession`,
      `clearStoredSession`. `ocr.js` is down to 1294 lines and holds no `indexedDB`
      reference at all. The module keeps no state: `persistState(state)` now takes the
      `{ rotation, detections }` snapshot as an argument rather than closing over module
      scope, which is the one real change in shape. `loadSession()` distinguishes "nothing
      saved yet" (a `blob` of undefined) from "storage unreadable" (null), since the caller
      treats those differently.
- [x] **Verify.** `node --check` clean, `npm test` 62/62. Both directions confirmed in a
      browser: two drawn boxes survive a reload with the filename intact (proving the
      `File`, not just its bytes, still round-trips), and Clear followed by a reload brings
      back neither boxes nor photo. The `confirm()` dialog is answered over CDP, so the
      Clear path is genuinely exercised rather than skipped.
      The check was then validated against a deliberately botched version of this same
      extraction — `persistState()` called without its argument, the classic failure mode
      when a closed-over value becomes a parameter. It failed as it should, restoring
      `Restored "IMG_0664.jpg" (0 box(es))`: image kept, boxes silently lost.
- [x] **Consider.** Not worth a fake-IndexedDB unit test. The module is a thin wrapper over
      browser APIs, so a fake would mostly assert that the fake was called — the real
      coverage is the round-trip above, which exercises actual storage.

## Step 7 — extract the pure helpers

- [x] **Change.** Split by concern rather than into one file. `cornersOf`, `resizedBounds`
      and `normalizedRectBox` are rectangle math and went to `geometry.js`, which is exactly
      its stated job — no new module needed. `colorFor`, `canvasLabelFor` and `listLabelFor`
      went to a new `detections.js`, which `selectNonOverlapping` also moved into, settling
      the question left open in step 5. `marginFor` stayed in `ocr.js`: four lines, specific
      to the recognize flow, and moving it would have made `detections.js` a grab bag.
      `ocr.js` is down to 1247 lines.
- [x] **Verify.** 77 tests, up from 62 — 15 new, the first coverage for logic that used to
      live in `ocr.js`. Browser-checked too, since these functions are only reachable through
      pointer interaction: draw, then resize by the top-left handle (the grabbed corner moves,
      the opposite one stays pinned), then move (the box shifts, its size preserved), with the
      list label reading "not yet recognized" in pending grey.
      The new tests were then mutation-tested: swapping a corner case in `resizedBounds` and
      making `colorFor` test truthiness instead of `!= null` both got caught, each by the test
      written for it. Notably the simpler resize test did *not* catch the swap — it only
      exercises corners 0 and 2 — which is why the exhaustive four-corner test is there.
- [x] **Consider.** The line held. The temptation was a single `detections.js` holding
      everything moved; splitting rect math from detection display kept each destination
      honest, and `marginFor` staying put is the same judgement in the other direction.

## Step 8 — a failed box stays retryable

- [x] **Change.** A manual region whose tiles all failed was indistinguishable from one that
      genuinely holds no text: the worker's `catch` (ocr.js:922-929) turned a failure into
      `found = []`, and the manual-completion branch then set `placeholder.attempted = true`.
      The box rendered "no text found", dropped out of "Recognize new boxes" (which filters
      on `!d.attempted`), and became eligible for "Prune empty" — so a transient 503 silently
      presented as a settled negative result, and the work was thrown away rather than left
      to retry. This applies regardless of region size: a hand-drawn box under the
      single-cell threshold (`tile * 1.4`, ~1030px at the 736px prod tile size) still gets
      exactly one `pendingPlaceholders` entry with `remaining: 1`, so it goes through the same
      completion branch as a region split into many tiles.
      Landed as:
      - The per-tile catch (ocr.js:922-929) now sets `entry.errored = true` on
        `pendingPlaceholders.get(item.placeholderId)` when `item.kind === "manual"`, beside
        the existing `errorCount++`/`firstError`. The entry always exists here —
        `recognizePendingBoxes()` (ocr.js:877) creates it before any of the region's tiles are
        enqueued.
      - The manual-completion branch: when `entry.found.length === 0` and `entry.errored`,
        `placeholder.scanFailed = true` is set and `attempted` stays false — the region
        remains "not yet recognized" and enabled for a re-run. The genuinely-empty case
        (`!entry.errored`) is unchanged (`attempted = true`, `manualEmptyCount++`) and now also
        clears a stale `scanFailed` from an earlier failed attempt on the same placeholder
        object, so a second, truly-empty try doesn't keep showing the old failure state.
      - `detections.js`'s `canvasLabelFor`/`listLabelFor` gained a third unrecognized state:
        `scanFailed` (and not `attempted`) reads as **"failed — try again"**, distinct from
        both "not yet recognized" (never sent) and "no text found" (settled empty). Without
        this the fix would have been invisible — the box would silently behave differently
        (stay retryable) while displaying identically to a never-tried box. `colorFor` was
        deliberately left alone: a `scanFailed` box still colors as never-tried grey, which is
        fine since the label already carries the distinction and the button-enablement logic
        only ever looked at `attempted`.
      Step 2's status line already names the failure count and first error message; this adds
      a durable, per-box signal, since the status line is transient and gets overwritten by
      the next scan action. Deliberately no automatic retry — see step 2's Consider.
      The cancel/abort teardown path (ocr.js:983-991) needed no change: it already deletes an
      unresolved entry without ever setting `attempted = true`, so a region cut off by
      cancellation was already retryable before this step.
- [x] **Verify.** `node --check` clean, `npm test` 85/85 (up from 84 — one new unit test for
      the `scanFailed` label state, plus two existing tests extended). Browser spec added to
      `test/browser/scan-lifecycle.spec.mjs`: stub `/ocr` to 503 for a manual region, confirm
      the box stays pending (`recognizePending` still enabled, `pruneEmpty` still disabled),
      that its label reads "failed — try again", and that a second run with the stub restored
      to normal resolves it to real text. `npm run test:browser` 32/32 (up from 31).
      Mutation-tested per the plan's own bar: reverting the `entry.errored` gate (making the
      completion branch unconditionally set `attempted = true` again, as before this step)
      failed the new spec's first assertion — the box became ineligible for
      "Recognize new boxes" again, confirming the spec actually exercises the fix rather than
      passing regardless.
- [x] **Consider.** Resolved: splice the partial result whenever `entry.found.length > 0`,
      regardless of `entry.errored` — same as today, no special case added. A region that got
      some text back is treated as a completed (if incomplete) result rather than held back,
      because keeping it pending would discard text genuinely found and there's no way to
      re-request only the failed tiles later anyway (the whole region gets re-tiled and
      re-sent on the next "Recognize new boxes" run, redoing the tiles that already
      succeeded). `errorCount`/`firstError` already carry the failure into the status line, so
      the user still sees that the region's result is incomplete even though the box itself
      moves on. Only the all-failed (`entry.found.length === 0`) case gets the new
      stays-pending behaviour above.
      The auto path needs nothing here: a failed whole-photo tile produces no box to mark,
      and the status line already reports the count.

## The full `ocr.js` restructure

`ocr.js` is ~1260 lines spanning roughly ten concerns (config, persistence, canvas rendering,
pointer interaction, scan queue, results-list DOM, status line, detection operations, button
wiring, handoff). Steps 6 and 7 removed the parts that came out cleanly. What remains is glued
by ~25 module-level mutable `let`s (`detections`, `nextId`, `view`, `img`, `full`, `selectedId`,
`hoverBoxId`, the scan-queue set, …) and by `redraw()` — `redrawCanvas()` + `renderResultsList()`
+ `persistState()` — which nearly every mutation calls.

**Approach: one shared state object first, dependency-injected callbacks over pub/sub.** ES
module live bindings are read-only from the importer's side, so `export let detections` cannot be
reassigned inside an extracted `scan.js` and observed back here — sharing reassignable state
across modules requires a single object held by reference. Consolidating the scattered `let`s
into one `state` object is therefore the precondition every extraction shares, and is step 9
below, done first. The subscribe/emit machinery floated in the earlier sketch is deferred, not
adopted: once `state` is one passable object, the render coupling can most likely be met by
passing `state` plus the flush callbacks into each module — the dependency-injection style the
repo already uses (`resolveTileSize({ … })`, `persistState({ rotation, detections })`) — which is
simpler and lands in smaller verifiable steps than a pub/sub layer. Whether pub/sub is ever
needed is left until the first real extraction (step 11) shows whether plain callbacks suffice.

The characterization suite below is the safety net that makes this a mechanical, test-backed
refactor rather than one "verified only by clicking."

**The tooling question is settled.** `npm run test:browser` (July 2026) drives headless
Chrome over the DevTools Protocol using only Node's own APIs — no dependency, no build
step, so the repo conventions hold. It owns every resource it uses: its own static server
and Chrome instance on OS-assigned ports, a throwaway profile removed on exit, and it
skips itself when no Chrome is installed. Waits poll for an observable condition; there
are no fixed sleeps.

**Characterization coverage is now in place.** `test/browser/` holds five specs, 32 tests
total, all green against the current code and all mutation-tested against the specific
behaviour each one exists to pin down:

- `tiling.spec.mjs` (4) — region tiling, from step 5/the tile-size override work.
- `interaction.spec.mjs` (11) — draw, select/deselect, resize (both a grabbed and an
  un-grabbed corner — see below), move, edit-invalidates-recognition, and all three ways
  to delete a box (keyboard, canvas hotspot, list button).
- `list-actions.spec.mjs` (7) — Prune overlapping (score-ranked keep, no-op when nothing
  overlaps), Prune empty (vs. never-tried, vs. recognized), Clear boxes (including a
  declined confirmation).
- `session.spec.mjs` (5) — reload restores photo + boxes exactly, Clear removes both and
  stays cleared, rotation remaps box coordinates.
- `scan-lifecycle.spec.mjs` (5) — plain cancel, the step-3 carry-over fix (re-running
  while a cancelled drain is still tearing down), a cancelled manual region staying
  retryable rather than wedging behind a stale placeholder, and the step-8 503 fix (an
  errored manual region reads "failed — try again" and stays retryable, not settled empty).

Shared boot/gesture helpers live in `fixtures.mjs`, factored out once a second spec needed
them, so they can't drift between specs the way `harness.mjs`'s job is to prevent Chrome
lifecycle from drifting. `harness.mjs` also gained `dialogAccept`: `confirm()` is answered
automatically (accept by default), since an unhandled dialog blocks the page indefinitely.

Two mistakes worth recording, since both are the same class of gap the tiling spec's own
mutation testing found in step 7:

- **A test can pass by accident.** `interaction.spec.mjs`'s first resize test only ever
  grabbed the drawn box's original (top-left) corner — hardcoding the handle index to 0
  didn't fail it, because that's the corner it always grabs. A second test dragging the
  *opposite* corner was needed to actually exercise "resize from wherever was grabbed."
- **A race can hide in the test, not the app.** The Clear-boxes-then-reload test reloaded
  immediately after the click, racing `clearSession()`'s `await clearStoredSession()` —
  which runs *after* the synchronous UI reset, so the assertions passed but the reload
  could occasionally beat the delete. Fixed by polling IndexedDB directly for the delete
  to land, rather than a fixed sleep.

The steps below hold the same discipline as 1–8: each lands behaviour-preserving, green on
both suites, and is reviewed before the next. Only step 9 is detailed — the exact shape of
10–12 depends on what step 9 and the first extraction reveal, so they are sketched, not fixed.

## Step 9 — consolidate shared mutable state into one `state` object

- [x] **Change.** Landed as a single `const state = {…}` (18 fields: `img, fileName, rotation,
      full, view, minScale, detections, nextId, selectedId, hoverBoxId, hoverDeleteId, draftBox,
      scanQueue, pendingPlaceholders, tileOverlay, scanAbortController, suppressScanSummary,
      lastStatusMessage`) with every read/write rewritten to `state.<field>` — 308 references.
      These are the fields more than one future module reads or reassigns; a shared object is
      the only way an extracted module can reassign them and have `ocr.js` observe it (module
      live bindings are import-side read-only). No behavioural change, no file moved. The
      `restoreSession()` local named `state` (the persisted snapshot) was renamed to `saved` to
      free the name. The rename was done with a small string/comment/template-aware scanner
      rather than a blind regex, so the target words that also appear in prose ("full" in
      "full photo", "view" in "view-only", "rotation" in the meta line) stayed bare in the
      strings and comments that contain them — only code and `${…}` interpolations were rewritten.
- [x] **Verify.** `node --check ocr.js` clean, `npm test` 85/85, `npm run test:browser` 32/32
      (all interaction/scan/session/list/tiling paths, so a missed reference on any exercised
      path would throw a `ReferenceError` the specs' `consoleErrors` assertions catch). Backed by
      a static sweep re-running the same classifier in check mode: the only bare target names
      left in code regions are the `const state` property keys and the two object-literal keys in
      `persistState({ rotation:, detections: })` — zero stray references in executable code.
      Two mechanical gotchas the blind form of this rename would have shipped, both caught here
      and worth heeding for the rename-heavy steps to come:
      - **Object-literal keys look like bare reads.** `persistState({ rotation, detections })`
        was hand-expanded to `{ rotation: state.rotation, … }` before the pass, and the scanner
        then prefixed the *keys* too (`{ state.rotation: … }`) — a parse error, caught by
        `node --check`. Fixed by leaving the keys bare.
      - **Spread has a leading dot.** `[...detections, …]` was skipped by the `(?<!\.)`
        property-access guard, because `...` ends in `.`. That produced a live
        `ReferenceError: detections is not defined` in `ensureWorkerRunning`, caught by the
        tiling spec, not by `node --check`. Fixed to `[...state.detections, …]`; a grep for
        `\.\.\.(<names>)` confirmed it was the only spread of a target.
- [x] **Consider.** Done in one pass, not staged by concern-group: the suite verifies the whole,
      and a partial rename would leave a mixed `state.x` / bare-`y` idiom mid-file for no gain.
      The interaction-transient `let`s — `dragging, panStart, selectCandidateId,
      pointerDownDisplayPos, editStartBounds, editStartSource, resizeHandleIndex` — stayed bare
      as planned: only the pointer handlers touch them, so they need no cross-module sharing
      until `interaction.js` is extracted (they consolidate then, into `state` or an
      interaction-scoped object).

## Step 10 — establish the render/flush seam

- [x] **Resolved: folded into step 11, not done standalone** — as the sketch anticipated. An
      extracted module needs only the flush functions it actually calls back into, passed as
      named params of the factory (`redraw`, `redrawCanvas`, `updateButtons`, `setStatusMessage`,
      plus `computeOverlapWarnings`). Routing `ocr.js`'s own internal `redraw()` calls through a
      shared `render` object would have been pure churn, since those calls never cross a module
      boundary. So the "seam" is just the named callbacks in the factory's parameter object — no
      separate pass, no `render` bundle, no `updateMeta`/`renderResultsList` in the set (the
      worker never calls those directly; `redraw()` reaches `renderResultsList` for it).

## Step 11 — extract `scan.js`

- [x] **Change.** The scan queue and worker moved to `scan.js` (300 lines) as a
      `createScan({ state, config, redraw, redrawCanvas, updateButtons, setStatusMessage,
      computeOverlapWarnings })` factory returning the three entry points `ocr.js` wires to the
      Run OCR / Cancel / Recognize buttons — `runFullScan`, `cancelScan`, `recognizePendingBoxes`.
      The queue, per-tile worker (`ensureWorkerRunning`), and tiling helpers (`recognizeTile`,
      `tileBoxesFor`, `enqueueTile`, `marginFor`) stay private to the closure. Because step 9 had
      already turned every shared read into a `state.` access, the code moved verbatim — only
      re-indented into the closure, no identifier rewritten: config names resolve through the
      destructured `config`, render names through the params, `state` through its param, and
      `tileGrid`/`boundsOf` through `scan.js`'s own imports. `ocr.js` is down to 1029 lines (from
      1273) and holds no scan/queue/tiling logic; the dependency is one-directional (`ocr.js` →
      `scan.js` → `tiling.js`/`geometry.js`, no cycle). The config constants and the button
      elements stay in `ocr.js` as bootstrap/wiring.
- [x] **Verify.** `node --check` clean on both files; `npm test` 85/85; `npm run test:browser`
      32/32 — the tiling spec drives `runFullScan`/`recognizePendingBoxes` end to end, and
      `scan-lifecycle` drives cancel, the carry-over teardown, and the 503 retry, so the moved
      worker is exercised on every branch that matters. `createScan` runs at module init but only
      captures the hoisted render functions; they are invoked later on interaction, so defining
      `renderResultsList`/`setStatusMessage` further down the file poses no temporal-dead-zone
      hazard.
- [x] **Consider.** Plain dependency-injected callbacks sufficed — the pub/sub question raised in
      the approach note stays closed. The synchronous `redraw()`/`updateButtons()` calls the
      worker makes reassign shared `state` and repaint immediately, with no ordering a direct call
      hides, so nothing here argues for an event bus. `computeOverlapWarnings` is passed in rather
      than moved: it is a detection-op still shared with `updateButtons`/`renderResultsList` in
      `ocr.js`, and belongs with the detection operations if those are later grouped, not with the
      scan worker.

## Step 12 — extract `canvas-view.js`

- [x] **Change.** The render core moved to `canvas-view.js` (235 lines) as a
      `createCanvasView({ state, ctx, display, config, updateMeta })` factory. It holds the view
      transform (`updateViewOffsets`, `clampView`, `zoomTo`, `zoomToBox`) and all drawing
      (`redrawCanvas` plus the private `strokeBoxPath`, `drawLabelText`, `drawDetection`,
      `drawResizeHandles`, `drawDeleteHotspot`, `drawTileOverlay`), and returns the eight entry
      points the rest of the app calls (`redrawCanvas`, `zoomTo`, `zoomToBox`,
      `updateViewOffsets`, `clampView`, `selectedDetection`, `deleteHotspotDisplayPos`,
      `visibleDeleteHotspotIds`). Injected deps: `state`, the canvas `display` + its `ctx`, the
      three drawing constants (`MAX_SCALE`, `RESIZE_HANDLE_RADIUS`, `DELETE_HOTSPOT_RADIUS`), and
      `updateMeta` — the one retained function the view ops call after a view change to refresh
      the zoom%. Geometry/detections helpers come through `canvas-view.js`'s own imports.
      **Key move to keep the diff small:** the factory's return is destructured back into consts
      of the same names in `ocr.js` (`const { redrawCanvas, zoomTo, … } = createCanvasView(…)`),
      so the ~30 call sites in `ocr.js`'s retained code (resetView, the interaction handlers,
      the results list, `redraw`) did **not** change — only the definitions moved. `redraw`
      stays in `ocr.js` as the composition root's flush (`redrawCanvas()` + `renderResultsList()`
      + `persistState()`), so `canvas-view.js` has no dependency on the results list. `ocr.js` is
      down to 838 lines (from 1029). `rotatedCanvas`, `resetView`, and the status-line functions
      (`metaLine`, `updateMeta`) stayed in `ocr.js` — orchestration and status, not pure render.
- [x] **Verify.** `node --check` clean on both; `npm test` 85/85; `npm run test:browser` 32/32 —
      the interaction and session specs drive draw/select/resize/move/delete/pan/zoom/rotate/hover,
      i.e. every render and view path, and a grep confirmed the six now-private draw helpers have
      zero references left in `ocr.js`. Hoisting holds: `createCanvasView` runs at module init but
      only after `state`/`ctx`/`display`/config exist, `updateMeta` is a hoisted declaration, and
      the destructured consts are initialised before any handler or `restoreSession()` runs.
- [x] **Consider.** The destructure-back-to-consts trick is the reason this large-looking move
      was low-churn: it defers touching the interaction/results-list call sites until those
      modules are themselves extracted, rather than rewiring them twice. It does mean `ocr.js`
      still calls these as bare names (via the consts) rather than `canvasView.x` — when
      `interaction.js` and `results-list.js` come out they will take `canvasView` as an injected
      dependency and call its methods explicitly, at which point the consts in `ocr.js` shrink to
      only what the composition root itself still needs.

## Step 13 — extract `thumbnails.js`, `results-list.js`, `interaction.js`

The last three concerns, in one step (three files). After it, `ocr.js` is the composition root,
and the overall shape gets re-evaluated per the standing agreement — including whether to bundle
the render callbacks (`interaction.js` is the heaviest consumer and the concrete test of that).

- [x] **`thumbnails.js`** (55 lines) — `createThumbnailCache({ state })` → `{ thumbnailDataUrl,
      clear }`, owning the memoization `Map` and `MAX_THUMB_HEIGHT`, importing `boundsOf`. **Not
      pure** — it reads the shared source canvas (`state.full`) and does canvas image work — but a
      self-contained memoizing image service, keyed by box coordinates. Its own module rather
      than a detail of the list because `clear()` is driven from *outside* the list: four call
      sites (clearSession, clearDetections, rotate, load-new-photo) invalidate it when the source
      pixels or the ids change. `ocr.js` builds it early (needs only `state`) and calls
      `thumbnails.clear()`; `results-list.js` takes `thumbnailDataUrl` injected.
- [x] **`results-list.js`** (112 lines) — `createResultsList({ state, resultsEl,
      computeOverlapWarnings, thumbnailDataUrl, zoomToBox, updateButtons, redraw, redrawCanvas })`
      → `{ renderResultsList }`, importing `colorFor`/`listLabelFor`. Stays DOM-imperative (builds
      the `<li>`s and their row/find/delete handlers); extracting the cache strips the image work
      out so it is just DOM + wiring. Destructured back to a `renderResultsList` const in `ocr.js`,
      which `redraw` and `clearSession` still call by name.
- [x] **`interaction.js`** (256 lines) — `createInteraction({ state, display, config, … })`,
      which attaches the pointer/keyboard/wheel listeners itself and owns the interaction-transient
      `let`s (`dragging`, `panStart`, `selectCandidateId`, `pointerDownDisplayPos`, `editStart*`,
      `resizeHandleIndex`) as closure privates — settling the deferral from step 9. The heaviest
      dependency surface: `state`, `display`, four thresholds, ten geometry imports, six
      canvas-view functions (`selectedDetection`, `deleteHotspotDisplayPos`,
      `visibleDeleteHotspotIds`, `redrawCanvas`, `zoomTo`, `clampView`), and five `ocr.js`
      callbacks (`updateButtons`, `redraw`, `updateMeta`, `applyEditedBox`, `deleteSelected`).
      `deleteSelected` stayed in `ocr.js` as a detection op and is injected for the keydown
      handler. That 17-entry surface is the concrete input to the re-evaluation below.
- [x] **Verify.** `node --check` clean on all three new files and `ocr.js`; `npm test` 85/85;
      `npm run test:browser` 32/32. The interaction, list-actions, and session specs drive every
      path across the three modules (draw/select/resize/move/delete/keyboard/pan/zoom, row
      click/find/delete/hover, thumbnail crops, clear). A grep confirmed the transients and the
      interaction helpers have zero references left in `ocr.js`. Done in three sub-extractions
      (thumbnails → results-list → interaction), each verified green before the next, to isolate
      any failure — none arose. Factory init order is `thumbnails` (159) → `canvasView` (241) →
      `interaction` (366) → `scan` (431) → `resultsList` (450); every const a later factory reads
      is initialised before it, and the factories only *capture* the hoisted `ocr.js` callbacks
      (invoked later on events / at `restoreSession`), so no temporal-dead-zone hazard.
- [x] **After.** `ocr.js` is 541 lines (from 1273 at the restructure's start) and is now the
      composition root: config resolution, the `state` object, the six factory calls + button
      wiring, the orchestration glue (`redraw`, `resetView`, `rotatedCanvas`, `metaLine`/
      `updateMeta`/`setStatusMessage`), the detection ops (`computeOverlapWarnings`,
      `removeDetections`, `pruneOverlapping`, `pruneEmpty`, `applyEditedBox`, `deleteSelected`,
      `rotate`), and session load/restore. See "Re-evaluation" below.

## Re-evaluation — the shape after step 13

The restructure is done: `ocr.js` 1273 → 541 lines, split into six focused modules
(`geometry`, `detections`, `tiling`, `session-store`, `backend-config` — pure/leaf — plus the
stateful factories `scan`, `canvas-view`, `thumbnails`, `results-list`, `interaction`). Every
module is one concern, dependencies are explicit and one-directional (no cycles), and the whole
is backed green by 85 unit + 32 browser tests throughout.

**The standing question — bundle the render callbacks?** `interaction.js` injects 17 things;
`scan.js` and `results-list.js` 8 each. Much of that repetition is the same flush handful —
`redraw`, `redrawCanvas`, `updateButtons`, `updateMeta`, `setStatusMessage` — passed to every
consumer. Options, to decide together:

- **(a) Leave as-is.** The lists are long but honest: each module declares exactly what it
  touches. No indirection to trace. The wiring is concentrated in `ocr.js`, which is what a
  composition root is for.
- **(b) Bundle the flush handful into one `render` object** passed as a single param
  (`createScan({ state, config, render, … })`). Trims each consumer's signature by ~4 entries
  and names the seam; still direct calls (`render.redraw()`), still traceable. This is the
  step-10 idea, now with three consumers to justify it.
- **(c) Event bus.** Consumers emit ("detections changed") and hold no render refs. Fuller
  decoupling, but trades visible wiring for indirection that's harder to follow; step 11 already
  found direct callbacks sufficient. Not recommended unless a concrete ordering problem appears.

Leaning **(b)** — three consumers now share the same flush set, which is the threshold that
turns it from premature churn into a real simplification.

**Status: parked, not scheduled.** The author is sleeping on it. The restructure is complete and
green as-is; this is an optional polish pass to pick up (or drop) later, kept here so the option
and its rationale aren't lost. Revisit before the next structural change to `ocr.js`.

## Step 14 — tidy the composition root: declarations, then wiring

- [ ] **Change.** After step 13, `ocr.js`'s top level interleaves two different jobs —
      *defining* functions and *executing* the wiring that instantiates the modules and
      attaches listeners. A module body is JS's only entry point (there is no `main`), so
      this band is the closest thing to one, and reading it top-to-bottom currently mixes
      hoisted `function` declarations with order-sensitive `const` factory calls and
      `addEventListener` statements. Regroup the file into bands, no logic touched:
      (1) imports, (2) config resolution + constants, (3) DOM refs, (4) the `state` object,
      (5) all `function` declarations (helpers, detection ops, session lifecycle — grouped by
      concern), (6) one composition/wiring block at the end (the six factory calls in
      dependency order, then button wiring, then `restoreSession()`). Function declarations
      hoist, so band 5 can sit above the band-6 consts it references; every band-5 function is
      only *invoked* from a band-6 listener or `restoreSession()`, by which point every factory
      const is initialised — the same temporal-dead-zone reasoning steps 11–13 already relied on.
- [ ] **Verify.** `node --check ocr.js` clean; `npm test` 85/85; `npm run test:browser` 32/32.
      A pure move, so any dropped or mis-ordered reference surfaces as a `ReferenceError` the
      specs' `consoleErrors` assertions catch, or as a parse failure under `node --check`.
- [ ] **Consider.** Whether to keep the light section-banner comments the regroup introduces
      (they name the bands, which is the readability the step is for) or leave the bands to
      speak for themselves.

## Related backlog

Already recorded in `PLAN.md` under "Known follow-ups", not part of this plan:

- Dedup checks text before pruning.
- Order the results list by closeness/overlap, or by scan order.
- Move "Prune overlapping" and "Prune empty" next to "Clear boxes".
