// Scan tool frontend. Load one or more photos, rotate in 90-degree steps,
// pan/zoom, run OCR against the backend, edit the resulting boxes (select,
// delete, draw new ones), then hand the recognized module numbers to guide.js.
// Coordinate transforms and hit-testing live in geometry.js as pure,
// DOM-free functions. The current batch of images persists in IndexedDB
// (see session-store.js), so reopening the page restores where you left off.
//
// Gesture model:
//   - plain left-drag on empty canvas  -> draw a new box
//   - click (no real drag) on a box    -> select it (again to deselect)
//   - Ctrl+left-drag, or two-finger
//     scroll (wheel without ctrlKey)   -> pan
//   - pinch (wheel WITH ctrlKey)       -> zoom, anchored at the cursor
//   - Delete/Backspace                 -> remove the selected box
//
// Newly-drawn boxes hold text/score = null ("pending") until "Recognize new
// boxes" runs: each is cropped with a small margin and sent through the same
// /ocr endpoint used for full images, so RapidOCR's own detector re-finds the
// tight text region inside the crop.
//
// This file is the composition root. It reads top-to-bottom in bands: imports,
// config/constants, DOM refs, the shared `state` object, the function
// declarations (helpers, detection ops, batch lifecycle), and finally the
// wiring block that instantiates the modules, attaches listeners, and boots.
//
// See PLAN.md, "Multi-image workflow", for the design behind `state.images`/
// `state.active`: an "image" is one loaded photo and its working state; a
// "batch" is the current set of loaded images (state.images collectively).
// "Session" (session-store.js) keeps its original, broader meaning -- the
// tool's whole persisted working state -- and is never used for one image.

import { boundsOf, overlapArea } from "./geometry.js";
import { selectNonOverlapping } from "./detections.js";
import { resolveTileSize, TILE_SIZE_STORAGE_KEY } from "./tiling.js";
import { resolveBackendUrl, BACKEND_URL_STORAGE_KEY, LOCALHOST_NAMES } from "./backend-config.js";
import { sha256Hex } from "./hashing.js";
import {
  loadBatch, loadLabelsFor, persistLabel, persistBatchMeta, replaceImages, clearStoredBatch,
  deleteLabels,
} from "./session-store.js";
import { createScan } from "./scan.js";
import { createCanvasView } from "./canvas-view.js";
import { createThumbnailCache } from "./thumbnails.js";
import { createResultsList } from "./results-list.js";
import { createInteraction } from "./interaction.js";


// ─── Config and constants ───────────────────────────────────────────────────

// Dev/prod switch, the same signal backend-config.js uses for BACKEND_URL.
// Dev skips the size limits a memory-constrained prod backend needs -- see
// TILE_SIZE below, and OCR_MAX_DIMENSION server-side.
const IS_LOCAL_DEV = LOCALHOST_NAMES.includes(location.hostname);

// The OCR backend runs in Python, so it's a separate origin from this static
// page; backend/server.py sends the CORS headers the cross-origin fetch
// needs. Which URL -- dev, prod, or an explicit override -- is resolved by
// backend-config.js.
const BACKEND_URL = resolveBackendUrl({
  hostname: location.hostname,
  storedOverride: localStorage.getItem(BACKEND_URL_STORAGE_KEY),
});
console.log(`OCR backend: ${BACKEND_URL}`);

// Key guide.js reads on boot to pre-fill its input instead of the sample text.
const SCAN_HANDOFF_KEY = "fieldGuideScan";

const MAX_VIEWPORT_W = 900;
const MAX_VIEWPORT_H = 650;
const MAX_SCALE = 8;
const ZOOM_SENSITIVITY = 0.008; // tuned so a typical pinch tick feels gradual, not stepped
const CLICK_THRESHOLD_PX = 4; // display px; below this, pointerup is a "click" not a drag
const DELETE_HOTSPOT_RADIUS = 8; // display px, drawn size of the delete-X
const DELETE_HOVER_RADIUS = 16; // display px, how close the cursor must get to reveal it
const RESIZE_HANDLE_RADIUS = 6; // display px, drawn half-size of each corner handle
const RESIZE_HANDLE_HIT_RADIUS = 12; // display px, how close a click must land to grab a handle

// RapidOCR's own config.yaml: Det.limit_side_len (limit_type "min"). A crop
// whose SHORTER side is under this gets auto-upscaled before detection; at
// or above it, the crop runs at native resolution — same effective
// resolution as scanning the full image, no small-crop boost.
const RAPIDOCR_UPSCALE_SHORT_SIDE = 736;

// Tiling config for large regions (PLAN.md, "Tiled scanning for large
// images"). The prod default matches RAPIDOCR_UPSCALE_SHORT_SIDE -- the size
// det never rescales -- but stays a separate constant: that one describes the
// backend's fixed floor, this one is the client's tunable choice, raised for
// a backend with more memory headroom. Dev defaults to Infinity, which makes
// every region a single cell; the localStorage override is how the tiled path
// is reached in dev, and is what the browser tiling spec sets.
const TILE_SIZE = resolveTileSize({
  isLocalDev: IS_LOCAL_DEV,
  storedOverride: localStorage.getItem(TILE_SIZE_STORAGE_KEY),
});
const TILE_OVERLAP_FRAC = 0.15;
// Regions up to this multiple of TILE_SIZE run as one oversized tile instead
// of a grid. Must stay under the backend's OCR_MAX_DIMENSION gate (default
// 1200px = 736 * 1.63) or a single-tile region gets 413-rejected.
const TILE_SINGLE_CELL_FACTOR = 1.4;


// ─── DOM references ─────────────────────────────────────────────────────────

const fileInput = document.getElementById("file");
const display = document.getElementById("stage");
const ctx = display.getContext("2d");
const rotateLeftBtn = document.getElementById("rotateLeft");
const rotateRightBtn = document.getElementById("rotateRight");
const runOcrBtn = document.getElementById("runOcr");
const cancelScanBtn = document.getElementById("cancelScan");
const recognizePendingBtn = document.getElementById("recognizePending");
const pruneOverlappingBtn = document.getElementById("pruneOverlapping");
const pruneEmptyBtn = document.getElementById("pruneEmpty");
const clearBtn = document.getElementById("clearScan");
const clearBoxesBtn = document.getElementById("clearBoxes");
const goToGuideBtn = document.getElementById("goToGuide");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");


// ─── Shared state ───────────────────────────────────────────────────────────

// Mutable state shared across the whole tool, gathered into one object held by
// reference so canvas-view.js, interaction.js, and scan.js can reassign a
// field and have this module observe it -- which an exported `let` binding
// cannot do, module live bindings being import-side read-only.
//
// `images` is the current batch; each entry holds one image's full working
// state. `active` is a getter, not a plain field: it always resolves to
// whichever image `activeId` currently names (or null, if nothing is loaded),
// so `state.active.<field>` reads/writes always reach the right image without
// needing to keep a separate reference in sync after a batch change.
//
// scanQueue/pendingPlaceholders/tileOverlay/scanAbortController/
// suppressScanSummary/lastStatusMessage stay top-level, not per-image: v1
// deliberately keeps scanning exclusive to the active image (see scan.js), and
// the status line is a single line regardless of which image is active.
const state = {
  images: [],
  activeId: null,
  nextImageId: 1, // monotonic id source for images, mirrors each image's own detection nextId

  scanQueue: [],
  pendingPlaceholders: new Map(),
  tileOverlay: [],
  scanAbortController: null,
  suppressScanSummary: false,
  lastStatusMessage: null,
};
Object.defineProperty(state, "active", {
  get() {
    return state.images.find((img) => img.id === state.activeId) ?? null;
  },
});

// Fields a freshly-created image entry starts with; used by both the file
// input handler and restoreBatch() so the two can't drift apart.
function newImageEntry({ id, sha256, fileName, img, rotation, detections }) {
  return {
    id, sha256, fileName, img, rotation,
    full: null, // computed by renderActiveView() once this image is made active
    view: { scale: 1, x: 0, y: 0 },
    minScale: 1,
    detections,
    nextId: detections.reduce((max, d) => Math.max(max, d.id), 0) + 1,
    selectedId: null,
    draftBox: null,
    hoverDeleteId: null,
    hoverBoxId: null,
  };
}


// ─── View, info line, and the redraw flush ──────────────────────────────────

function rotatedCanvas(image, rotationDeg) {
  const c = document.createElement("canvas");
  const swap = rotationDeg % 180 !== 0;
  c.width = swap ? image.naturalHeight : image.naturalWidth;
  c.height = swap ? image.naturalWidth : image.naturalHeight;
  const rctx = c.getContext("2d");
  rctx.translate(c.width / 2, c.height / 2);
  rctx.rotate((rotationDeg * Math.PI) / 180);
  rctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  return c;
}

// (Re)renders the active image into its offscreen canvas and computes its
// initial view/minScale against the shared display's current size. Called
// once, the first time an image becomes active, and again after rotating it.
// An already-initialized image keeps its own view across switches (each is a
// field on the image itself, not shared), so switching back to one never
// resets pan/zoom -- see the image-switcher.
function renderActiveView() {
  const active = state.active;
  active.full = rotatedCanvas(active.img, active.rotation);
  display.width = Math.min(MAX_VIEWPORT_W, window.innerWidth - 48);
  display.height = Math.min(MAX_VIEWPORT_H, Math.round(window.innerHeight * 0.6));
  active.minScale = Math.min(1, display.width / active.full.width, display.height / active.full.height);
  active.view = { scale: active.minScale, x: 0, y: 0 };
  updateViewOffsets();
  active.draftBox = null;
  active.hoverDeleteId = null;
  updateInfoLine();
  redraw();
}

// Info-line text: filename (if known), resolution, rotation, zoom, for the
// active image. Shared by updateInfoLine() and setStatusMessage(), which
// prepends it to a message.
function infoLine() {
  const active = state.active;
  if (!active?.full) return "";
  const name = active.fileName ? `${active.fileName} · ` : "";
  return `${name}${active.full.width}×${active.full.height}px · rotation ${active.rotation}° · zoom ${Math.round(active.view.scale * 100)}%`;
}

// Refreshes the info portion of the status line, called on every
// pan/zoom/rotate. Re-renders through setStatusMessage() while a message is
// active, so the refresh doesn't overwrite it; falls back to the bare info
// line when idle.
function updateInfoLine() {
  if (state.lastStatusMessage != null) {
    setStatusMessage(state.lastStatusMessage);
  } else {
    statusEl.textContent = infoLine();
  }
}

// The info line stays regular text; the message half is wrapped in a
// monospace span so it reads as a distinct system message.
function setStatusMessage(msg) {
  state.lastStatusMessage = msg;
  const info = infoLine();
  statusEl.textContent = "";
  if (info) statusEl.append(`${info} — `);
  const span = document.createElement("span");
  span.className = "status-msg";
  span.textContent = msg;
  statusEl.append(span);
}

function redraw() {
  redrawCanvas();
  renderResultsList();
  const active = state.active;
  // sha256 is null for the brief window between an image being loaded and its
  // hash resolving (see the file input handler); nothing to key a save on yet.
  if (active?.sha256) {
    persistLabel(active.sha256, {
      filename: active.fileName, rotation: active.rotation, detections: active.detections,
    }).catch(() => setStatusMessage("Could not save — storage may be full"));
  }
}


// ─── Detection operations ───────────────────────────────────────────────────

// Moving/resizing a box invalidates its OCR recognition (the region it covers
// changed), so it goes back to pending. A hand-entered label is exempt: it is
// authoritative and the box is only an approximate location, so a geometry edit
// (or any later rescan) leaves the manual text untouched.
function applyEditedBox(detection, newBox) {
  detection.box = newBox;
  detection.source = "manual";
  if (detection.manual) return;
  detection.text = null;
  detection.score = null;
  detection.attempted = false;
}

// Detections whose bounding rects intersect — likely duplicate reads of the
// same physical label. Keyed by detection id -> the other overlapping boxes'
// display numbers (1-based), for the list warning. Empty when nothing is
// loaded (state.active is null).
function computeOverlapWarnings() {
  const warnings = new Map();
  const detections = state.active?.detections ?? [];
  for (let i = 0; i < detections.length; i++) {
    const boundsI = boundsOf(detections[i].box);
    for (let j = i + 1; j < detections.length; j++) {
      if (overlapArea(boundsI, boundsOf(detections[j].box)) <= 0) continue;
      if (!warnings.has(detections[i].id)) warnings.set(detections[i].id, []);
      if (!warnings.has(detections[j].id)) warnings.set(detections[j].id, []);
      warnings.get(detections[i].id).push(j + 1);
      warnings.get(detections[j].id).push(i + 1);
    }
  }
  return warnings;
}

// Shared cleanup for any bulk removal on the active image: drop the ids from
// `detections` and clear any selection/hover state that would otherwise
// dangle on a removed id. Only ever called with a non-empty idsToRemove that
// pruneOverlapping()/pruneEmpty() derived from the active image's own
// detections, so state.active is guaranteed non-null here.
function removeDetections(idsToRemove) {
  if (idsToRemove.size === 0) return 0;
  const active = state.active;
  active.detections = active.detections.filter((d) => !idsToRemove.has(d.id));
  if (active.selectedId != null && idsToRemove.has(active.selectedId)) active.selectedId = null;
  if (active.hoverDeleteId != null && idsToRemove.has(active.hoverDeleteId)) active.hoverDeleteId = null;
  if (active.hoverBoxId != null && idsToRemove.has(active.hoverBoxId)) active.hoverBoxId = null;
  return idsToRemove.size;
}

function pruneOverlapping() {
  const detections = state.active?.detections ?? [];
  const keptIds = new Set(selectNonOverlapping(detections).map((d) => d.id));
  const removedIds = new Set(detections.filter((d) => !keptIds.has(d.id)).map((d) => d.id));
  return removeDetections(removedIds);
}

// "Empty" = recognition was tried and found nothing (dark-red dashed).
// Never-tried boxes (gray dashed) are left alone.
function pruneEmpty() {
  const detections = state.active?.detections ?? [];
  const emptyIds = new Set(
    detections.filter((d) => d.score == null && d.attempted).map((d) => d.id),
  );
  return removeDetections(emptyIds);
}

// Reachable via Delete/Backspace (interaction.js); the canvas and list delete-X
// hotspots remove directly rather than through this.
function deleteSelected() {
  const active = state.active;
  if (!active || active.selectedId == null) return;
  active.detections = active.detections.filter((d) => d.id !== active.selectedId);
  active.selectedId = null;
  updateButtons();
  redraw();
}

// Maps one box corner through a 90-degree canvas rotation. oldW/oldH are the
// pre-rotation `full` canvas dimensions.
function rotatePoint([x, y], delta, oldW, oldH) {
  return delta > 0 ? [oldH - y, x] : [y, oldW - x];
}

function rotate(delta) {
  const active = state.active;
  if (!active?.img || state.scanAbortController) return;
  const oldW = active.full.width;
  const oldH = active.full.height;
  active.detections = active.detections.map((d) => ({
    ...d,
    box: d.box.map((pt) => rotatePoint(pt, delta, oldW, oldH)),
  }));
  active.rotation = (active.rotation + delta + 360) % 360;
  thumbnails.clear(active.id); // this image's `full` is re-rendered; other images' caches stay valid
  renderActiveView(); // recomputes full/view/minScale and calls redraw()
  updateButtons();
}


// ─── Button enablement ──────────────────────────────────────────────────────

function updateButtons() {
  const active = state.active;
  const hasImage = !!active?.img;
  const detections = active?.detections ?? [];
  for (const b of [rotateLeftBtn, rotateRightBtn]) b.disabled = !hasImage || !!state.scanAbortController;
  // Disabled once a whole-photo scan is outstanding, so repeat clicks can't
  // re-tile and re-queue the same photo. Checks signal.aborted rather than
  // just the controller's presence so cancelScan()'s own updateButtons()
  // call re-enables this right away, without waiting for the aborted drain's
  // async teardown to null out scanAbortController.
  runOcrBtn.disabled = !hasImage
    || (!!state.scanAbortController && !state.scanAbortController.signal.aborted);
  cancelScanBtn.disabled = !state.scanAbortController;
  // Guards against a second click overwriting the first's placeholder
  // bookkeeping (see recognizePendingBoxes()), so this can stay enabled and
  // just add to the shared queue rather than needing the same gating as
  // "OCR full photo".
  recognizePendingBtn.disabled = !detections.some((d) => d.score == null && !d.attempted && !d.manual);
  pruneOverlappingBtn.disabled = computeOverlapWarnings().size === 0;
  pruneEmptyBtn.disabled = !detections.some((d) => d.score == null && d.attempted);
  // Enabled when any box carries usable text -- an OCR read or a hand-entered
  // label (which has no score). A blank manual label ("no label here") doesn't count.
  goToGuideBtn.disabled = !detections.some((d) => d.text && d.text.trim());
  clearBtn.disabled = !hasImage && detections.length === 0;
  clearBoxesBtn.disabled = detections.length === 0;
}


// ─── Batch lifecycle ─────────────────────────────────────────────────────────

// Today's "Clear" button: wipes the current batch entirely, including these
// images' ground truth. This is what PLAN.md's five-operation design calls
// "Clear batch" -- kept under its original name/button for now; the other
// four operations (Clear image / Drop image / Finish batch / Clear all) and
// the "Clear ▾" menu are a follow-up step.
async function clearSession() {
  if (state.images.length === 0) return;
  if (!confirm("Clear the loaded photo and all boxes?")) return;

  if (state.scanAbortController) state.scanAbortController.abort();

  const shaList = state.images.filter((img) => img.sha256).map((img) => img.sha256);
  state.images = [];
  state.activeId = null;

  fileInput.value = "";
  ctx.clearRect(0, 0, display.width, display.height);
  state.lastStatusMessage = null; // don't let a stale message survive the clear
  updateInfoLine();
  updateButtons();
  renderResultsList();

  await clearStoredBatch();
  if (shaList.length > 0) await deleteLabels(shaList).catch(() => {});
}

// Today's "Clear boxes" button: drops every box on the active image (drawn,
// pending, or recognized) but keeps it loaded. PLAN.md's "Clear image".
function clearDetections() {
  const active = state.active;
  if (!active || active.detections.length === 0) return;
  if (!confirm("Clear all boxes? The loaded photo is kept.")) return;

  // Stop any in-flight scan against the box list being wiped. The image stays
  // loaded here, so suppressScanSummary is what keeps the worker from posting
  // a completion summary over the now-empty list.
  if (state.scanAbortController) {
    state.suppressScanSummary = true;
    state.scanAbortController.abort();
  }

  active.detections = [];
  active.nextId = 1;
  active.selectedId = null;
  active.draftBox = null;
  active.hoverDeleteId = null;
  active.hoverBoxId = null;
  thumbnails.clear(active.id);
  state.lastStatusMessage = null; // don't let a stale message survive the clear

  updateInfoLine(); // re-renders the (now blank) status line
  updateButtons();
  redraw(); // persists the now-empty detections, the same as any other edit
}

// On boot, restore a previously-remembered batch, if any. Runs unawaited;
// nothing else on the page depends on it finishing.
async function restoreBatch() {
  const stored = await loadBatch();
  if (!stored) return; // storage unreadable; session-store.js has logged it
  if (stored.images.length === 0) return; // nothing saved yet

  const loaded = await Promise.all(stored.images.map(async (entry) => {
    // Bytes missing (e.g. evicted under storage pressure -- shouldn't happen
    // given batch images are capped to one batch's worth, but not impossible):
    // its ground truth is untouched in the ledger, it just can't be shown
    // without re-selecting the file, so it's dropped from the restored batch
    // rather than shown broken.
    if (!entry.blob) return null;
    const url = URL.createObjectURL(entry.blob);
    const img = new Image();
    const ok = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    URL.revokeObjectURL(url);
    if (!ok) return null;
    return newImageEntry({
      id: state.nextImageId++,
      sha256: entry.sha256,
      fileName: entry.filename,
      img,
      rotation: entry.rotation,
      detections: entry.detections,
    });
  }));

  state.images = loaded.filter((img) => img != null);
  if (state.images.length === 0) return;

  const activeMatch = state.images.find((img) => img.sha256 === stored.active);
  state.activeId = (activeMatch ?? state.images[0]).id;
  renderActiveView(); // recomputes full/view/minScale and calls redraw()
  updateButtons();
  const label = state.images.length === 1 && state.images[0].fileName
    ? `"${state.images[0].fileName}"`
    : `${state.images.length} image(s)`;
  setStatusMessage(`Restored ${label} (${state.active.detections.length} box(es))`);
}


// ─── Composition root: instantiate the modules, wire the buttons, boot ───────

// Memoized results-list thumbnails; built first so the clear-on-image-change
// call sites (clearSession/clearDetections/rotate/new photo) can reach it.
const thumbnails = createThumbnailCache({ state });

// Canvas rendering and the view transform live in canvas-view.js; bind them to
// the shared state, the canvas + its 2D context, the sizing/handle constants,
// and the info-line refresh they trigger on a view change, then rebind the
// entry points the rest of this file calls by their original names.
const {
  redrawCanvas, zoomTo, zoomToBox, updateViewOffsets, clampView,
  selectedDetection, deleteHotspotDisplayPos, visibleDeleteHotspotIds,
} = createCanvasView({
  state,
  ctx,
  display,
  config: { MAX_SCALE, RESIZE_HANDLE_RADIUS, DELETE_HOTSPOT_RADIUS },
  updateInfoLine,
});

// Pointer, keyboard, and wheel interaction is wired in interaction.js; it
// attaches its own listeners and owns the drag-transient state, given the shared
// state and the view/detection callbacks it drives.
createInteraction({
  state,
  display,
  config: { CLICK_THRESHOLD_PX, DELETE_HOVER_RADIUS, RESIZE_HANDLE_HIT_RADIUS, ZOOM_SENSITIVITY },
  selectedDetection,
  deleteHotspotDisplayPos,
  visibleDeleteHotspotIds,
  redrawCanvas,
  zoomTo,
  clampView,
  updateButtons,
  redraw,
  updateInfoLine,
  applyEditedBox,
  deleteSelected,
});

// The scan queue and worker live in scan.js; bind them to the shared state, the
// render callbacks they trigger, and the OCR/tiling config resolved above, then
// wire the three buttons to the entry points they return.
const scan = createScan({
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
});

// The results list lives in results-list.js; bind it to the shared state, the
// list element, and the callbacks its rows trigger, and rebind renderResultsList
// by name (redraw() and the batch-lifecycle functions call it).
const { renderResultsList } = createResultsList({
  state,
  resultsEl,
  computeOverlapWarnings,
  thumbnailDataUrl: thumbnails.thumbnailDataUrl,
  zoomToBox,
  updateButtons,
  redraw,
  redrawCanvas,
});

clearBtn.addEventListener("click", clearSession);
clearBoxesBtn.addEventListener("click", clearDetections);
rotateLeftBtn.addEventListener("click", () => rotate(-90));
rotateRightBtn.addEventListener("click", () => rotate(90));
runOcrBtn.addEventListener("click", scan.runFullScan);
cancelScanBtn.addEventListener("click", scan.cancelScan);
recognizePendingBtn.addEventListener("click", scan.recognizePendingBoxes);

pruneOverlappingBtn.addEventListener("click", () => {
  const removed = pruneOverlapping();
  setStatusMessage(removed > 0 ? `Removed ${removed} overlapping box(es)` : "No overlapping boxes found");
  updateButtons();
  redraw();
});

pruneEmptyBtn.addEventListener("click", () => {
  const removed = pruneEmpty();
  setStatusMessage(removed > 0 ? `Removed ${removed} empty box(es)` : "No empty boxes found");
  updateButtons();
  redraw();
});

// Decodes one File into an <img> and computes its content hash in parallel
// (independent work -- decoding never needs the hash or vice versa). Returns
// { file, img, ok, sha256 }; ok is false if the browser couldn't decode it as
// an image, in which case sha256 was still computed but is simply unused.
async function loadOneFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  const [ok, sha256] = await Promise.all([
    new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    }),
    sha256Hex(file),
  ]);
  URL.revokeObjectURL(url);
  return { file, img, ok, sha256 };
}

// Loading a new batch replaces the working one entirely (PLAN.md,
// "Multi-image workflow"): the outgoing images' pixels are dropped from
// IndexedDB (replaceImages() below overwrites the whole `images` store), but
// their ground truth is untouched in the permanent `labels` ledger -- nothing
// explicitly "folds" it there, because persistLabel() already keeps every
// image's entry current the instant its own edit happens, so there is
// nothing left to flush in bulk at this point. A file whose content hash
// already has a ledger entry (the same photo re-selected, in this batch or a
// past one) reattaches that entry's rotation/detections instead of starting
// blank -- the mechanism that makes it safe to re-select a growing folder
// (e.g. hasso/ with more photos added) without losing prior labeling work.
fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  if (files.length === 0) return;
  if (state.scanAbortController) state.scanAbortController.abort();

  const loaded = await Promise.all(files.map(loadOneFile));
  const decoded = loaded.filter((f) => f.ok);
  if (decoded.length === 0) return; // nothing usable -- leave the previous batch as it was

  const existingLabels = await loadLabelsFor(decoded.map((f) => f.sha256));

  const images = decoded.map((f) => {
    const existing = existingLabels.get(f.sha256);
    return newImageEntry({
      id: state.nextImageId++,
      sha256: f.sha256,
      fileName: f.file.name,
      img: f.img,
      rotation: existing?.rotation ?? 0,
      detections: existing?.detections ?? [],
    });
  });

  state.images = images;
  state.activeId = images[0].id;
  state.lastStatusMessage = null; // new batch: don't carry over the previous one's status
  renderActiveView(); // recomputes full/view/minScale and calls redraw()
  updateButtons();

  await replaceImages(decoded.map((f) => ({ sha256: f.sha256, blob: f.file })));
  await persistBatchMeta({ order: images.map((img) => img.sha256), active: images[0].sha256 });
  await Promise.all(images.map((img) => persistLabel(img.sha256, {
    filename: img.fileName, rotation: img.rotation, detections: img.detections,
  })));

  const reattachedCount = decoded.filter((f) => existingLabels.has(f.sha256)).length;
  const parts = [];
  if (images.length > 1 || reattachedCount > 0) {
    parts.push(`Loaded ${images.length} image(s)`);
    if (reattachedCount > 0) parts.push(`${reattachedCount} matched previous ground truth`);
  }
  if (decoded.length < loaded.length) parts.push(`${loaded.length - decoded.length} file(s) could not be read as images`);
  if (parts.length > 0) setStatusMessage(parts.join(" — "));
});

// Hands every labelled detection's text (of the active image) to guide.js via
// sessionStorage -- both OCR reads and hand-entered labels (a blank manual
// "no label" box carries no text and is skipped). Not deduped: a real board
// pile can hold several copies of the same board, and guide.js counts
// quantities to allocate complete sets. Use "Prune overlapping" first if a
// region got detected more than once by mistake; every box left after that
// counts as one real board. Unioning across every image in the batch, not
// just the active one, is a follow-up step (PLAN.md, "Multi-image workflow").
goToGuideBtn.addEventListener("click", () => {
  const detections = state.active?.detections ?? [];
  const numbers = detections
    .filter((d) => d.text && d.text.trim())
    .map((d) => d.text.trim());
  if (numbers.length === 0) return;
  sessionStorage.setItem(SCAN_HANDOFF_KEY, numbers.join("\n"));
  location.href = "guide.html";
});

restoreBatch();
