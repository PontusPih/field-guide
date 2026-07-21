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
- [ ] **Verify.** `node --check ocr.js` and `npm test` pass (62/62). **Manual check still
      outstanding:** load a photo, scan, then pan and zoom with ~20 boxes present — motion
      should stay smooth and the list must not flicker. Reload and confirm the session
      restores with boxes intact (this is what proves the persistence path still works after
      the cache moved off it). Rotate with boxes present and confirm the list thumbnails
      re-crop to match.
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
- [ ] **Consider.** Whether 503 specifically deserves a bounded retry with `Retry-After`
      rather than being reported as a failure — the backend returns it precisely because the
      request is worth resending. Possibly its own step.

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

## Deferred — the full `ocr.js` restructure

`ocr.js` is ~1300 lines spanning roughly ten concerns (config, persistence, canvas rendering,
pointer interaction, scan queue, results-list DOM, status line, detection operations, button
wiring, handoff). Steps 6 and 7 remove the parts that come out cleanly. What remains is glued
by module-level mutable state (`detections`, `view`, `img`, `full`, `selectedId`,
`hoverBoxId`) and by `redraw()`, which nearly everything calls; splitting it further means
introducing an explicit state module with subscribe/emit first, then dividing into
`canvas-view.js` / `interaction.js` / `scan.js` / `results-list.js`.

That is a real refactor of code with no test coverage, verified only by clicking. **Open
question for the author:** whether to add browser-level test tooling (Playwright or similar)
before attempting it. That means adding a dependency and a build step, which the repo
conventions rule out without an explicit decision. Until that is settled, this stays
deferred rather than scheduled.

## Related backlog

Already recorded in `PLAN.md` under "Known follow-ups", not part of this plan:

- Dedup checks text before pruning.
- Order the results list by closeness/overlap, or by scan order.
- Move "Prune overlapping" and "Prune empty" next to "Clear boxes".
