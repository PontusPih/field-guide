// Scan tool frontend. Load a photo, rotate in 90-degree steps, pan/zoom,
// run OCR against the backend, edit the resulting boxes (select, delete,
// draw new ones), then hand the recognized module numbers to guide.js.
// Coordinate transforms and hit-testing live in geometry.js as pure,
// DOM-free functions. The loaded image and its boxes persist in IndexedDB
// (see session-store.js), so reopening the page restores them.
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
// declarations (helpers, detection ops, session lifecycle), and finally the
// wiring block that instantiates the modules, attaches listeners, and boots.

import { boundsOf, overlapArea } from "./geometry.js";
import { selectNonOverlapping } from "./detections.js";
import { resolveTileSize, TILE_SIZE_STORAGE_KEY } from "./tiling.js";
import { resolveBackendUrl, BACKEND_URL_STORAGE_KEY, LOCALHOST_NAMES } from "./backend-config.js";
import {
  persistImage, persistState, loadSession, clearStoredSession,
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
// Interaction-transient state lives inside interaction.js's closure, not here:
// only the pointer handlers touch it, so it needs no cross-module sharing.
const state = {
  img: null,           // loaded HTMLImageElement, full source resolution
  fileName: "",        // original filename of the loaded image, shown in the info line
  rotation: 0,         // 0 | 90 | 180 | 270, clockwise
  full: null,          // offscreen canvas: full-res image at current rotation
  view: { scale: 1, x: 0, y: 0 },
  minScale: 1,

  detections: [],      // [{ id, box: [[x,y]x4] in source coords, text, score }]
  nextId: 1,

  // A whole-photo "OCR full photo" and a drawn box are both just regions; each is
  // reduced at enqueue time to tile-sized crops in full-image coordinates,
  // drained by one worker (see ensureWorkerRunning()).
  // [{ box: [x0,y0,x1,y1], kind: "auto" | "manual", placeholderId? }]
  scanQueue: [],
  // placeholderId -> { placeholder, remaining, found: [], gotUpscaleBoost }.
  // A manual region may span several tiles; its placeholder is spliced out
  // only once every tile it produced has reported back.
  pendingPlaceholders: new Map(),
  // [{ box: [x0,y0,x1,y1], done }] in source coords, one entry per queued/
  // in-flight/completed tile for the whole current drain -- empty when idle.
  tileOverlay: [],
  // Non-null while the queue worker is draining -- both the "scan running"
  // flag and the means to cancel it (cancelScanBtn, clearSession(),
  // clearDetections(), and loading a new photo all call .abort()). Rotation is
  // disabled while it's set, since rotate() doesn't remap tileOverlay.
  scanAbortController: null,
  // One-shot: tells ensureWorkerRunning()'s finally to skip its completion
  // message. Set by clearDetections(), which keeps `img` set and so isn't
  // caught by the worker's own `if (img)` guard.
  suppressScanSummary: false,
  // Last message passed to setStatusMessage(), or null when idle (bare info
  // line only). updateInfoLine() re-renders it, so a pan/zoom/rotate refresh
  // doesn't wipe a message that's still active.
  lastStatusMessage: null,

  selectedId: null,
  draftBox: null,      // { x0, y0, x1, y1 } in source coords, while drawing a new box
  hoverDeleteId: null, // id of the box whose delete-X is currently shown
  hoverBoxId: null,    // id of the box the cursor is currently over (declutter: reveals full label)
};


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

function resetView({ preserveDetections = false } = {}) {
  state.full = rotatedCanvas(state.img, state.rotation);
  display.width = Math.min(MAX_VIEWPORT_W, window.innerWidth - 48);
  display.height = Math.min(MAX_VIEWPORT_H, Math.round(window.innerHeight * 0.6));
  state.minScale = Math.min(1, display.width / state.full.width, display.height / state.full.height);
  state.view = { scale: state.minScale, x: 0, y: 0 };
  updateViewOffsets();
  if (!preserveDetections) {
    state.detections = [];
    state.selectedId = null;
  }
  state.draftBox = null;
  state.hoverDeleteId = null;
  updateInfoLine();
  redraw();
}

// Info-line text: filename (if known), resolution, rotation, zoom. Shared by
// updateInfoLine() and setStatusMessage(), which prepends it to a message.
function infoLine() {
  if (!state.full) return "";
  const name = state.fileName ? `${state.fileName} · ` : "";
  return `${name}${state.full.width}×${state.full.height}px · rotation ${state.rotation}° · zoom ${Math.round(state.view.scale * 100)}%`;
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
  persistState({ rotation: state.rotation, detections: state.detections });
}


// ─── Detection operations ───────────────────────────────────────────────────

// Editing a box invalidates its recognition (the region it covers changed),
// so it goes back to pending and is marked "manual".
function applyEditedBox(detection, newBox) {
  detection.box = newBox;
  detection.text = null;
  detection.score = null;
  detection.attempted = false;
  detection.source = "manual";
}

// Detections whose bounding rects intersect — likely duplicate reads of the
// same physical label. Keyed by detection id -> the other overlapping boxes'
// display numbers (1-based), for the list warning.
function computeOverlapWarnings() {
  const warnings = new Map();
  for (let i = 0; i < state.detections.length; i++) {
    const boundsI = boundsOf(state.detections[i].box);
    for (let j = i + 1; j < state.detections.length; j++) {
      if (overlapArea(boundsI, boundsOf(state.detections[j].box)) <= 0) continue;
      if (!warnings.has(state.detections[i].id)) warnings.set(state.detections[i].id, []);
      if (!warnings.has(state.detections[j].id)) warnings.set(state.detections[j].id, []);
      warnings.get(state.detections[i].id).push(j + 1);
      warnings.get(state.detections[j].id).push(i + 1);
    }
  }
  return warnings;
}

// Shared cleanup for any bulk removal: drop the ids from `detections` and
// clear any selection/hover state that would otherwise dangle on a removed id.
function removeDetections(idsToRemove) {
  if (idsToRemove.size === 0) return 0;
  state.detections = state.detections.filter((d) => !idsToRemove.has(d.id));
  if (state.selectedId != null && idsToRemove.has(state.selectedId)) state.selectedId = null;
  if (state.hoverDeleteId != null && idsToRemove.has(state.hoverDeleteId)) state.hoverDeleteId = null;
  if (state.hoverBoxId != null && idsToRemove.has(state.hoverBoxId)) state.hoverBoxId = null;
  return idsToRemove.size;
}

function pruneOverlapping() {
  const keptIds = new Set(selectNonOverlapping(state.detections).map((d) => d.id));
  const removedIds = new Set(state.detections.filter((d) => !keptIds.has(d.id)).map((d) => d.id));
  return removeDetections(removedIds);
}

// "Empty" = recognition was tried and found nothing (dark-red dashed).
// Never-tried boxes (gray dashed) are left alone.
function pruneEmpty() {
  const emptyIds = new Set(
    state.detections.filter((d) => d.score == null && d.attempted).map((d) => d.id),
  );
  return removeDetections(emptyIds);
}

// Reachable via Delete/Backspace (interaction.js); the canvas and list delete-X
// hotspots remove directly rather than through this.
function deleteSelected() {
  if (state.selectedId == null) return;
  state.detections = state.detections.filter((d) => d.id !== state.selectedId);
  state.selectedId = null;
  updateButtons();
  redraw();
}

// Maps one box corner through a 90-degree canvas rotation. oldW/oldH are the
// pre-rotation `full` canvas dimensions.
function rotatePoint([x, y], delta, oldW, oldH) {
  return delta > 0 ? [oldH - y, x] : [y, oldW - x];
}

function rotate(delta) {
  if (!state.img || state.scanAbortController) return;
  const oldW = state.full.width;
  const oldH = state.full.height;
  state.detections = state.detections.map((d) => ({
    ...d,
    box: d.box.map((pt) => rotatePoint(pt, delta, oldW, oldH)),
  }));
  state.rotation = (state.rotation + delta + 360) % 360;
  thumbnails.clear(); // `full` is re-rendered, so every cached crop is stale
  resetView({ preserveDetections: true });
  updateButtons();
}


// ─── Button enablement ──────────────────────────────────────────────────────

function updateButtons() {
  const hasImage = !!state.img;
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
  recognizePendingBtn.disabled = !state.detections.some((d) => d.score == null && !d.attempted);
  pruneOverlappingBtn.disabled = computeOverlapWarnings().size === 0;
  pruneEmptyBtn.disabled = !state.detections.some((d) => d.score == null && d.attempted);
  goToGuideBtn.disabled = !state.detections.some((d) => d.score != null);
  clearBtn.disabled = !hasImage && state.detections.length === 0;
  clearBoxesBtn.disabled = state.detections.length === 0;
}


// ─── Session lifecycle ──────────────────────────────────────────────────────

async function clearSession() {
  if (!state.img && state.detections.length === 0) return;
  if (!confirm("Clear the loaded photo and all boxes?")) return;

  // Stop any in-flight scan against the session being wiped.
  if (state.scanAbortController) state.scanAbortController.abort();

  state.img = null;
  state.fileName = "";
  state.full = null;
  state.rotation = 0;
  state.view = { scale: 1, x: 0, y: 0 };
  state.minScale = 1;
  state.detections = [];
  state.nextId = 1;
  state.selectedId = null;
  state.draftBox = null;
  state.hoverDeleteId = null;
  state.hoverBoxId = null;
  thumbnails.clear();

  fileInput.value = "";
  ctx.clearRect(0, 0, display.width, display.height);
  state.lastStatusMessage = null; // don't let a stale message survive the clear
  updateInfoLine();
  updateButtons();
  renderResultsList();

  await clearStoredSession();
}

// Narrower than clearSession(): drops every box (drawn, pending, or
// recognized) but keeps the loaded photo.
function clearDetections() {
  if (state.detections.length === 0) return;
  if (!confirm("Clear all boxes? The loaded photo is kept.")) return;

  // Stop any in-flight scan against the box list being wiped. `img` stays
  // set here, so suppressScanSummary is what keeps the worker from posting a
  // completion summary over the now-empty list.
  if (state.scanAbortController) {
    state.suppressScanSummary = true;
    state.scanAbortController.abort();
  }

  state.detections = [];
  state.nextId = 1;
  state.selectedId = null;
  state.draftBox = null;
  state.hoverDeleteId = null;
  state.hoverBoxId = null;
  thumbnails.clear();
  state.lastStatusMessage = null; // don't let a stale message survive the clear

  updateInfoLine(); // re-renders the (now blank) status line
  updateButtons();
  redraw();
}

// On boot, restore a previously-remembered image + boxes, if any. Runs
// unawaited; nothing else on the page depends on it finishing.
async function restoreSession() {
  const stored = await loadSession();
  if (!stored) return; // storage unreadable; session-store.js has logged it
  const { blob, state: saved } = stored;
  if (!blob) return; // nothing saved yet

  const url = URL.createObjectURL(blob);
  const nextImg = new Image();
  const loaded = await new Promise((resolve) => {
    nextImg.onload = () => resolve(true);
    nextImg.onerror = () => resolve(false);
    nextImg.src = url;
  });
  URL.revokeObjectURL(url);
  if (!loaded) return;

  state.img = nextImg;
  state.fileName = blob.name || ""; // set before resetView() so its info-line update includes it
  state.rotation = saved?.rotation || 0;
  // Sessions saved before thumbnails moved into thumbnailCache carry a data
  // URL per box; drop those fields rather than persisting them onward.
  state.detections = (saved?.detections || []).map(({ _thumbKey, _thumbUrl, ...d }) => d);
  state.nextId = state.detections.reduce((max, d) => Math.max(max, d.id), 0) + 1;
  resetView({ preserveDetections: true });
  updateButtons();
  const label = state.fileName ? `"${state.fileName}"` : "previous scan";
  setStatusMessage(`Restored ${label} (${state.detections.length} box(es))`);
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
// by name (redraw() and clearSession() call it).
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

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  // Stop any in-flight scan against the photo being replaced.
  if (state.scanAbortController) state.scanAbortController.abort();
  const url = URL.createObjectURL(file);
  const nextImg = new Image();
  nextImg.onload = () => {
    state.img = nextImg;
    state.fileName = file.name; // set before resetView() so its info-line update includes it
    state.rotation = 0;
    state.detections = [];
    state.selectedId = null;
    thumbnails.clear();
    state.lastStatusMessage = null; // new photo: don't carry over the previous one's status
    resetView();
    updateButtons();
    URL.revokeObjectURL(url);
    persistImage(file); // new photo: overwrite whatever session was remembered before
  };
  nextImg.src = url;
});

// Hands every recognized detection's text to guide.js via sessionStorage.
// Not deduped: a real board pile can hold several copies of the same board,
// and guide.js counts quantities to allocate complete sets. Use "Prune
// overlapping" first if a region got detected more than once by mistake;
// every box left after that counts as one real board.
goToGuideBtn.addEventListener("click", () => {
  const numbers = state.detections
    .filter((d) => d.score != null && d.text && d.text.trim())
    .map((d) => d.text.trim());
  if (numbers.length === 0) return;
  sessionStorage.setItem(SCAN_HANDOFF_KEY, numbers.join("\n"));
  location.href = "guide.html";
});

restoreSession();
