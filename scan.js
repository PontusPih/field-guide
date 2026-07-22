// The OCR scan queue and its single worker.
//
// A whole-photo "Run OCR" and a hand-drawn box are both just regions: each is
// reduced at enqueue time to backend-sized tile crops in full-image
// coordinates, pushed onto one queue, and drained one tile at a time by a
// single worker (the backend's own job queue is bounded, so parallel requests
// would just 503). Boxes can be added mid-scan; the worker picks them up on its
// next iteration.
//
// Extracted from ocr.js (refactor-plan.md, "The full ocr.js restructure",
// step 11). Holds no module state of its own: createScan() binds the queue and
// worker to the shared `state` object, the render callbacks they trigger, and
// the OCR/tiling config, and returns the three entry points ocr.js wires to
// buttons. `state.full`, `document`, `fetch`, and `AbortController` are the
// browser/globals this relies on; the rest arrives through the params.

import { tileGrid } from "./tiling.js";
import { boundsOf } from "./geometry.js";

export function createScan({
  state,
  config: {
    BACKEND_URL, TILE_SIZE, TILE_OVERLAP_FRAC, TILE_SINGLE_CELL_FACTOR,
    RAPIDOCR_UPSCALE_SHORT_SIDE,
  },
  redraw,
  redrawCanvas,
  updateButtons,
  setStatusMessage,
  computeOverlapWarnings,
}) {

  // Crops [x0,y0,x1,y1] (full-image coordinates) from `full` and posts it to
  // /ocr, returning results translated back into full-image space.
  async function recognizeTile([x0, y0, x1, y1], signal) {
    const tw = x1 - x0;
    const th = y1 - y0;
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = tw;
    cropCanvas.height = th;
    cropCanvas.getContext("2d").drawImage(state.full, x0, y0, tw, th, 0, 0, tw, th);
    const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));
    // toBlob yields null if the canvas can't be encoded; posting that would send
    // an empty body and read as a tile that found nothing.
    if (!blob) throw new Error("could not encode tile");

    const resp = await fetch(`${BACKEND_URL}/ocr`, { method: "POST", body: blob, signal });
    // Throwing rather than returning [] keeps a rejected tile (503 queue full,
    // 413 oversized, 5xx) distinguishable from one that genuinely found no text
    // -- the worker's catch counts it instead of reporting "nothing found".
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const found = await resp.json();
    // f.box is in tile-local coordinates; translate back to full-image space.
    return found.map((f) => ({
      box: f.box.map(([x, y]) => [x + x0, y + y0]),
      text: f.text,
      score: f.score,
    }));
  }

  // Splits the (x0,y0)-(x0+w,y0+h) region of `full` into tile-sized crops in
  // full-image coordinates (PLAN.md, "Tiled scanning for large images").
  // Shared by the whole-photo "Run OCR" button and per-drawn-box recognition;
  // keeps every upload under the backend's OCR_MAX_DIMENSION limit.
  function tileBoxesFor(x0, y0, w, h) {
    if (w <= 0 || h <= 0) return [];
    const tiles = tileGrid(w, h, TILE_SIZE, {
      overlapFrac: TILE_OVERLAP_FRAC,
      singleCellFactor: TILE_SINGLE_CELL_FACTOR,
    });
    return tiles.map(([tx0, ty0, tx1, ty1]) => [x0 + tx0, y0 + ty0, x0 + tx1, y0 + ty1]);
  }

  // A tile enqueued while a cancelled scan is still tearing down belongs to the
  // next drain, not the one being cancelled. ensureWorkerRunning()'s teardown
  // reads the flag to tell the two apart.
  function enqueueTile(item) {
    // The queue item holds its own overlay entry, so marking a tile done is a
    // direct write rather than a search keyed on shared array identity.
    const overlay = { box: item.box, done: false };
    state.scanQueue.push({
      ...item,
      overlay,
      enqueuedAfterAbort: state.scanAbortController?.signal.aborted === true,
    });
    state.tileOverlay.push(overlay);
  }

  // Margin around the user's rough box, giving the detector room to find the
  // tight text region itself.
  function marginFor(bounds) {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    return Math.max(6, 0.15 * Math.min(w, h));
  }

  // Whole-photo scan: the full image is just a region that covers everything,
  // tiled and queued the same way a drawn box is.
  function runFullScan() {
    if (!state.full) return;
    for (const box of tileBoxesFor(0, 0, state.full.width, state.full.height)) {
      enqueueTile({ box, kind: "auto" });
    }
    redrawCanvas();
    ensureWorkerRunning();
  }

  function cancelScan() {
    if (state.scanAbortController) state.scanAbortController.abort();
  }

  // A drawn box is a region to scan — it may hold one label or several, so
  // it's tiled the same way the whole photo is. Each pending box gets a
  // placeholder entry so its tiles can be reassembled once all report back.
  function recognizePendingBoxes() {
    // Skips boxes already queued: one placeholder entry per box, so a second
    // click can't overwrite bookkeeping the first click's tiles still refer to.
    const pending = state.detections.filter(
      (d) => d.score == null && !d.attempted && !state.pendingPlaceholders.has(d.id),
    );
    if (pending.length === 0) return;

    for (const placeholder of pending) {
      const bounds = boundsOf(placeholder.box);
      const margin = marginFor(bounds);
      const x0 = Math.max(0, Math.floor(bounds.minX - margin));
      const y0 = Math.max(0, Math.floor(bounds.minY - margin));
      const x1 = Math.min(state.full.width, Math.ceil(bounds.maxX + margin));
      const y1 = Math.min(state.full.height, Math.ceil(bounds.maxY + margin));
      const w = x1 - x0;
      const h = y1 - y0;
      const gotUpscaleBoost = Math.min(w, h) < RAPIDOCR_UPSCALE_SHORT_SIDE;

      const boxes = tileBoxesFor(x0, y0, w, h);
      if (boxes.length === 0) continue; // degenerate (zero-area) region -- nothing to scan
      state.pendingPlaceholders.set(placeholder.id, { placeholder, remaining: boxes.length, found: [], gotUpscaleBoost });
      for (const box of boxes) {
        enqueueTile({ box, kind: "manual", placeholderId: placeholder.id });
      }
    }
    redrawCanvas();
    ensureWorkerRunning();
  }

  // Drains scanQueue one tile at a time -- sequential, since the backend's own
  // job queue is bounded (OCR_QUEUE_MAXSIZE) and parallel requests would just
  // 503. Callers push onto the queue and call this; if a drain is already
  // running this is a no-op, and the loop picks up newly-pushed items on its
  // next iteration -- that's what lets boxes be added mid-scan.
  //
  // Overlapping tiles' duplicate results are not deduped here; that's left to
  // the manual "Prune overlapping" button, so the raw per-tile results stay
  // inspectable. The completion message points at it when there's cleanup to do.
  async function ensureWorkerRunning() {
    if (state.scanAbortController) return;
    state.scanAbortController = new AbortController();
    const signal = state.scanAbortController.signal;
    updateButtons();

    let autoFoundCount = 0;
    let manualFoundCount = 0;
    let manualRegionCount = 0;
    let manualEmptyCount = 0;
    let manualNoBoostCount = 0;
    let errorCount = 0;
    let firstError = null; // reported in the summary: "N failed" alone isn't actionable

    // Cleanup lives in finally so it always runs: a throw that left
    // scanAbortController non-null would wedge every future scan, since
    // ensureWorkerRunning() early-returns whenever it's set.
    try {
      while (state.scanQueue.length > 0) {
        if (signal.aborted) break;
        const item = state.scanQueue.shift();
        setStatusMessage(`Scanning… ${state.scanQueue.length} tile(s) queued`);

        let found;
        try {
          found = await recognizeTile(item.box, signal);
        } catch (err) {
          if (err.name === "AbortError" || signal.aborted) break;
          // A per-tile failure counts as "found nothing", so one bad tile
          // doesn't lose its placeholder bookkeeping or abort the rest.
          found = [];
          errorCount++;
          firstError ??= err.message;
          // Tag the region so a manual completion below can tell "this tile
          // errored" apart from "this tile genuinely found nothing" -- see the
          // entry.errored check further down.
          if (item.kind === "manual") state.pendingPlaceholders.get(item.placeholderId).errored = true;
        }
        if (signal.aborted) break; // discard a result that arrived the instant abort() landed

        item.overlay.done = true;
        redrawCanvas();

        if (item.kind === "auto") {
          const newDetections = found.map((d) => ({ id: state.nextId++, ...d, source: "auto" }));
          autoFoundCount += newDetections.length;
          state.detections = [...state.detections, ...newDetections];
          redraw();
          continue;
        }

        // manual: accumulate until every tile this placeholder produced has
        // reported back, then splice its results in (or mark it "no text
        // found" if none of them found anything).
        const entry = state.pendingPlaceholders.get(item.placeholderId);
        entry.found.push(...found);
        entry.remaining--;
        if (entry.remaining > 0) continue;
        state.pendingPlaceholders.delete(item.placeholderId);
        manualRegionCount++;
        if (!entry.gotUpscaleBoost) manualNoBoostCount++;
        if (entry.found.length === 0) {
          if (entry.errored) {
            // A tile errored and none of the region's tiles found anything --
            // leave attempted false so the region stays "not yet recognized"
            // (retryable) instead of settling as a genuine empty result.
            entry.placeholder.scanFailed = true;
          } else {
            entry.placeholder.attempted = true; // stays visible, marked "no text found"
            entry.placeholder.scanFailed = false; // clear a stale flag from an earlier failed attempt
            manualEmptyCount++;
          }
        } else {
          const newDetections = entry.found.map((d) => ({ id: state.nextId++, ...d, source: "manual" }));
          manualFoundCount += newDetections.length;
          const idx = state.detections.indexOf(entry.placeholder);
          if (idx >= 0) state.detections.splice(idx, 1, ...newDetections);
          if (state.selectedId != null && !state.detections.some((d) => d.id === state.selectedId)) state.selectedId = null;
        }
        redraw();
      }
    } finally {
      const cancelled = signal.aborted;
      // Tiles enqueued after the abort landed belong to the next drain, so only
      // this drain's own leftovers are discarded.
      const carried = state.scanQueue.filter((t) => t.enqueuedAfterAbort);
      const leftoverCount = state.scanQueue.length - carried.length;
      const carriedPlaceholderIds = new Set(
        carried.filter((t) => t.placeholderId != null).map((t) => t.placeholderId),
      );
      state.scanQueue = carried.map((t) => ({ ...t, enqueuedAfterAbort: false }));
      // Carried tiles were never drained, so their overlay entries are still
      // undone and can be reused as-is.
      state.tileOverlay = carried.map((t) => t.overlay);

      // A cancelled region keeps whatever tiles came back before the cancel
      // landed, matching the auto layer's partial-keep above. A placeholder
      // whose tiles carried over is left intact for the next drain to finish,
      // rather than being resolved here and orphaning those tiles.
      for (const [placeholderId, entry] of state.pendingPlaceholders) {
        if (carriedPlaceholderIds.has(placeholderId)) continue;
        if (entry.found.length > 0) {
          const newDetections = entry.found.map((d) => ({ id: state.nextId++, ...d, source: "manual" }));
          const idx = state.detections.indexOf(entry.placeholder);
          if (idx >= 0) state.detections.splice(idx, 1, ...newDetections);
        }
        state.pendingPlaceholders.delete(placeholderId);
      }
      state.scanAbortController = null;

      // Clear ran mid-scan (img null), or Clear boxes did (suppressScanSummary,
      // since img stays set there) -- either way, don't post a stale summary
      // over the clean state it just left behind.
      if (state.img && !state.suppressScanSummary) {
        const parts = [];
        if (autoFoundCount > 0) parts.push(`found ${autoFoundCount} box(es) from the full photo`);
        if (manualRegionCount > 0) {
          parts.push(`found ${manualFoundCount} box(es) from ${manualRegionCount} drawn region(s)`);
        }
        if (manualEmptyCount > 0) parts.push(`${manualEmptyCount} region(s) found no text`);
        if (manualNoBoostCount > 0) {
          parts.push(
            `${manualNoBoostCount} region(s) shortest side ≥${RAPIDOCR_UPSCALE_SHORT_SIDE}px `
            + "(no scale boost, same as full image scan)",
          );
        }
        if (errorCount > 0) {
          parts.push(`${errorCount} tile(s) failed${firstError ? ` (${firstError})` : ""}`);
        }
        if (cancelled) parts.push(`cancelled${leftoverCount > 0 ? ` (${leftoverCount} tile(s) left unscanned)` : ""}`);
        const overlapCount = computeOverlapWarnings().size;
        if (overlapCount > 0) parts.push(`${overlapCount} box(es) overlap — Prune overlapping to clean up`);
        setStatusMessage(parts.length > 0 ? parts.join("\n") : "Scan complete, nothing found");
      }
      state.suppressScanSummary = false;
      updateButtons();
      redraw();

      // Work arrived while this drain was tearing down -- pick it up, rather
      // than leaving it queued with nothing running to consume it.
      if (state.scanQueue.length > 0) ensureWorkerRunning();
    }
  }

  return { runFullScan, cancelScan, recognizePendingBoxes };
}
