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

import {
  toSource, toDisplay, hitTestBoxes, distance, nearestWithinRadius, pointInPolygon,
  boundsOf, overlapArea, cornersOf, resizedBounds, normalizedRectBox,
} from "./geometry.js";
import {
  colorFor, canvasLabelFor, listLabelFor, selectNonOverlapping,
} from "./detections.js";
import { tileGrid } from "./tiling.js";
import { resolveBackendUrl, BACKEND_URL_STORAGE_KEY, LOCALHOST_NAMES } from "./backend-config.js";
import {
  persistImage, persistState, loadSession, clearStoredSession,
} from "./session-store.js";

// Dev/prod switch, the same signal backend-config.js uses for BACKEND_URL.
// Dev skips the size limits a memory-constrained prod backend needs -- see
// TILE_SIZE below, and OCR_MAX_DIMENSION server-side.
const IS_LOCAL_DEV = LOCALHOST_NAMES.includes(location.hostname);

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
const deleteBtn = document.getElementById("deleteSelected");
const clearBtn = document.getElementById("clearScan");
const clearBoxesBtn = document.getElementById("clearBoxes");
const goToGuideBtn = document.getElementById("goToGuide");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

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
// images"). TILE_SIZE matches RAPIDOCR_UPSCALE_SHORT_SIDE -- the size det
// never rescales -- but stays a separate constant: that one describes the
// backend's fixed floor, this one is the client's tunable choice, raised for
// a backend with more memory headroom. In dev, Infinity fails tileGrid's
// single-cell check, so a scan sends one request covering the whole region
// (pair with OCR_MAX_DIMENSION=0 server-side).
const TILE_SIZE = IS_LOCAL_DEV ? Infinity : 736;
const TILE_OVERLAP_FRAC = 0.15;
// Regions up to this multiple of TILE_SIZE run as one oversized tile instead
// of a grid. Must stay under the backend's OCR_MAX_DIMENSION gate (default
// 1200px = 736 * 1.63) or a single-tile region gets 413-rejected.
const TILE_SINGLE_CELL_FACTOR = 1.4;

let img = null; // loaded HTMLImageElement, full source resolution
let fileName = ""; // original filename of the loaded image, shown in the info line
let rotation = 0; // 0 | 90 | 180 | 270, clockwise
let full = null; // offscreen canvas: full-res image at current rotation
let view = { scale: 1, x: 0, y: 0 };
let minScale = 1;

let detections = []; // [{ id, box: [[x,y]x4] in source coords, text, score }]
let nextId = 1;

// A whole-photo "Run OCR" and a drawn box are both just regions; each is
// reduced at enqueue time to tile-sized crops in full-image coordinates,
// drained by one worker (see ensureWorkerRunning() below).
// [{ box: [x0,y0,x1,y1], kind: "auto" | "manual", placeholderId? }]
let scanQueue = [];
// placeholderId -> { placeholder, remaining, found: [], gotUpscaleBoost }.
// A manual region may span several tiles; its placeholder is spliced out
// only once every tile it produced has reported back.
let pendingPlaceholders = new Map();
// [{ box: [x0,y0,x1,y1], done }] in source coords, one entry per queued/
// in-flight/completed tile for the whole current drain -- empty when idle.
let tileOverlay = [];
// Non-null while the queue worker is draining -- both the "scan running"
// flag and the means to cancel it (cancelScanBtn, clearSession(),
// clearDetections(), and loading a new photo all call .abort()). Rotation is
// disabled while it's set, since rotate() doesn't remap tileOverlay.
let scanAbortController = null;
// One-shot: tells ensureWorkerRunning()'s finally to skip its completion
// message. Set by clearDetections(), which keeps `img` set and so isn't
// caught by the worker's own `if (img)` guard.
let suppressScanSummary = false;
// Last message passed to setStatusMessage(), or null when idle (bare meta
// line only). updateMeta() re-renders it, so a pan/zoom/rotate refresh
// doesn't wipe a message that's still active.
let lastStatusMessage = null;
let selectedId = null;
let draftBox = null; // { x0, y0, x1, y1 } in source coords, while drawing a new box

let dragging = null; // null | "pan" | "draw" | "select-candidate" | "move" | "resize"
let panStart = null; // { px, py, vx, vy }
let selectCandidateId = null;
let pointerDownDisplayPos = null;
let editStartBounds = null; // { minX, minY, maxX, maxY }, source coords, at drag start
let editStartSource = null; // pointer's source-space position at drag start (for "move")
let resizeHandleIndex = null; // which corner (see cornersOf), for "resize"
let hoverDeleteId = null; // id of the box whose delete-X is currently shown
let hoverBoxId = null; // id of the box the cursor is currently over (declutter: reveals full label)

async function clearSession() {
  if (!img && detections.length === 0) return;
  if (!confirm("Clear the loaded photo and all boxes?")) return;

  // Stop any in-flight scan against the session being wiped.
  if (scanAbortController) scanAbortController.abort();

  img = null;
  fileName = "";
  full = null;
  rotation = 0;
  view = { scale: 1, x: 0, y: 0 };
  minScale = 1;
  detections = [];
  nextId = 1;
  selectedId = null;
  draftBox = null;
  hoverDeleteId = null;
  hoverBoxId = null;
  clearThumbnailCache();

  fileInput.value = "";
  ctx.clearRect(0, 0, display.width, display.height);
  lastStatusMessage = null; // don't let a stale message survive the clear
  updateMeta();
  updateButtons();
  renderResultsList();

  await clearStoredSession();
}
clearBtn.addEventListener("click", clearSession);

// Narrower than clearSession(): drops every box (drawn, pending, or
// recognized) but keeps the loaded photo.
function clearDetections() {
  if (detections.length === 0) return;
  if (!confirm("Clear all boxes? The loaded photo is kept.")) return;

  // Stop any in-flight scan against the box list being wiped. `img` stays
  // set here, so suppressScanSummary is what keeps the worker from posting a
  // completion summary over the now-empty list.
  if (scanAbortController) {
    suppressScanSummary = true;
    scanAbortController.abort();
  }

  detections = [];
  nextId = 1;
  selectedId = null;
  draftBox = null;
  hoverDeleteId = null;
  hoverBoxId = null;
  clearThumbnailCache();
  lastStatusMessage = null; // don't let a stale message survive the clear

  updateMeta(); // re-renders the (now blank) status line
  updateButtons();
  redraw();
}
clearBoxesBtn.addEventListener("click", clearDetections);

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

// Letterbox offset centering the rendered image on any axis it doesn't fill
// (e.g. "fit" zoom on an image whose aspect ratio differs from the
// canvas's). toSource()/toDisplay() (geometry.js) read view.offsetX/offsetY,
// so this must be recomputed any time view.scale changes.
function updateViewOffsets() {
  const renderedW = full.width * view.scale;
  const renderedH = full.height * view.scale;
  view.offsetX = renderedW <= display.width ? (display.width - renderedW) / 2 : 0;
  view.offsetY = renderedH <= display.height ? (display.height - renderedH) / 2 : 0;
}

function resetView({ preserveDetections = false } = {}) {
  full = rotatedCanvas(img, rotation);
  display.width = Math.min(MAX_VIEWPORT_W, window.innerWidth - 48);
  display.height = Math.min(MAX_VIEWPORT_H, Math.round(window.innerHeight * 0.6));
  minScale = Math.min(1, display.width / full.width, display.height / full.height);
  view = { scale: minScale, x: 0, y: 0 };
  updateViewOffsets();
  if (!preserveDetections) {
    detections = [];
    selectedId = null;
  }
  draftBox = null;
  hoverDeleteId = null;
  updateMeta();
  redraw();
}

// Info-line text: filename (if known), resolution, rotation, zoom. Shared by
// updateMeta() and setStatusMessage(), which prepends it to a message.
function metaLine() {
  if (!full) return "";
  const name = fileName ? `${fileName} · ` : "";
  return `${name}${full.width}×${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`;
}

// Refreshes the meta portion of the status line, called on every
// pan/zoom/rotate. Re-renders through setStatusMessage() while a message is
// active, so the refresh doesn't overwrite it; falls back to the bare meta
// line when idle.
function updateMeta() {
  if (lastStatusMessage != null) {
    setStatusMessage(lastStatusMessage);
  } else {
    statusEl.textContent = metaLine();
  }
}

function clampView() {
  const visW = display.width / view.scale;
  const visH = display.height / view.scale;
  view.x = Math.min(Math.max(view.x, 0), Math.max(0, full.width - visW));
  view.y = Math.min(Math.max(view.y, 0), Math.max(0, full.height - visH));
}

function zoomTo(newScale, anchorDisplayPt) {
  newScale = Math.min(MAX_SCALE, Math.max(minScale, newScale));
  if (newScale === view.scale) return;
  const anchorSource = toSource(anchorDisplayPt, view);
  view.scale = newScale;
  updateViewOffsets(); // offsets depend on scale — recompute before inverting below
  view.x = anchorSource.x - (anchorDisplayPt.x - view.offsetX) / view.scale;
  view.y = anchorSource.y - (anchorDisplayPt.y - view.offsetY) / view.scale;
  clampView();
  updateMeta();
  redrawCanvas(); // view-only: no list content changed, nothing to persist
}

function strokeBoxPath(box) {
  ctx.beginPath();
  box.forEach((pt, i) => {
    const d = toDisplay({ x: pt[0], y: pt[1] }, view);
    if (i === 0) ctx.moveTo(d.x, d.y);
    else ctx.lineTo(d.x, d.y);
  });
  ctx.closePath();
}

function drawLabelText(text, color, topLeft) {
  ctx.font = "14px sans-serif";
  const metrics = ctx.measureText(text);
  const labelHeight = 16;
  const spaceAbove = topLeft.y - 6;
  // No room above: place the label below the box, still anchored to it so it
  // pans and scrolls off-screen with it.
  const labelY = spaceAbove >= labelHeight ? spaceAbove : topLeft.y + labelHeight + 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(topLeft.x - 2, labelY - 13, metrics.width + 4, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, topLeft.x, labelY);
}

// Colored outline plus a numbered badge. Full text+score shows only for the
// hovered or selected box; the results list always shows everything.
function drawDetection(detection, index) {
  const color = colorFor(detection);
  const isSelected = detection.id === selectedId;
  const isHovered = detection.id === hoverBoxId;
  const isPending = detection.score == null;
  const showFullLabel = isSelected || isHovered;

  strokeBoxPath(detection.box);
  ctx.setLineDash(isPending ? [6, 4] : []);
  ctx.lineWidth = isSelected ? 4 : 2;
  ctx.strokeStyle = isSelected ? "#3498db" : color;
  ctx.stroke();
  ctx.setLineDash([]);

  const topLeft = toDisplay({ x: detection.box[0][0], y: detection.box[0][1] }, view);
  if (showFullLabel) {
    drawLabelText(canvasLabelFor(detection), isSelected ? "#3498db" : color, topLeft);
  } else {
    drawLabelText(String(index + 1), color, topLeft);
  }
}

// Delete-X floats just above the box's top-center, in display space so it
// tracks pan/zoom — clear of the corners, which are resize handles.
function deleteHotspotDisplayPos(detection) {
  const b = boundsOf(detection.box);
  const topCenter = toDisplay({ x: (b.minX + b.maxX) / 2, y: b.minY }, view);
  return { x: topCenter.x, y: topCenter.y - 14 };
}

// A box's delete-X shows when it's hovered near or selected.
function visibleDeleteHotspotIds() {
  const ids = new Set();
  if (selectedId != null) ids.add(selectedId);
  if (hoverDeleteId != null) ids.add(hoverDeleteId);
  return ids;
}

function selectedDetection() {
  return selectedId == null ? null : detections.find((d) => d.id === selectedId);
}

function drawResizeHandles() {
  const detection = selectedDetection();
  if (!detection) return;
  const bounds = boundsOf(detection.box);
  for (const corner of cornersOf(bounds)) {
    const p = toDisplay(corner, view);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#3498db";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(
      p.x - RESIZE_HANDLE_RADIUS, p.y - RESIZE_HANDLE_RADIUS,
      RESIZE_HANDLE_RADIUS * 2, RESIZE_HANDLE_RADIUS * 2,
    );
    ctx.fill();
    ctx.stroke();
  }
}

// Editing a box invalidates its recognition (the region it covers changed),
// so it goes back to pending and is marked "manual".
function applyEditedBox(detection, newBox) {
  detection.box = newBox;
  detection.text = null;
  detection.score = null;
  detection.attempted = false;
  detection.source = "manual";
}

function drawDeleteHotspot() {
  for (const id of visibleDeleteHotspotIds()) {
    const detection = detections.find((d) => d.id === id);
    if (!detection) continue;
    const pos = deleteHotspotDisplayPos(detection);

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, DELETE_HOTSPOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#e74c3c";
    ctx.fill();

    const r = DELETE_HOTSPOT_RADIUS * 0.5;
    ctx.beginPath();
    ctx.moveTo(pos.x - r, pos.y - r);
    ctx.lineTo(pos.x + r, pos.y + r);
    ctx.moveTo(pos.x + r, pos.y - r);
    ctx.lineTo(pos.x - r, pos.y + r);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// Tile grid for the current queue drain (see ensureWorkerRunning) — dashed
// while a tile is queued/in-flight, solid once its result is back. A plain
// outline, so it reads differently from the detection boxes drawn over it.
function drawTileOverlay() {
  for (const t of tileOverlay) {
    const p0 = toDisplay({ x: t.box[0], y: t.box[1] }, view);
    const p1 = toDisplay({ x: t.box[2], y: t.box[3] }, view);
    ctx.setLineDash(t.done ? [] : [5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 188, 212, 0.85)";
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  }
  ctx.setLineDash([]);
}

// Canvas-only repaint. Hover updates use this rather than redraw(), which
// would rebuild the list DOM under the cursor and misfire its hover events.
function redrawCanvas() {
  if (!full) return;
  ctx.clearRect(0, 0, display.width, display.height);
  // Clip the sampled source rect to the image's bounds; the destination rect
  // is drawn at view.offsetX/offsetY, centering the image in the leftover
  // space on whichever axis it doesn't fill.
  const visW = Math.min(full.width, display.width / view.scale);
  const visH = Math.min(full.height, display.height / view.scale);
  ctx.drawImage(full, view.x, view.y, visW, visH, view.offsetX, view.offsetY, visW * view.scale, visH * view.scale);

  if (tileOverlay.length > 0) drawTileOverlay();
  detections.forEach((d, i) => drawDetection(d, i));

  if (draftBox) {
    const p0 = toDisplay({ x: draftBox.x0, y: draftBox.y0 }, view);
    const p1 = toDisplay({ x: draftBox.x1, y: draftBox.y1 }, view);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#3498db";
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.setLineDash([]);
  }

  drawDeleteHotspot();
  drawResizeHandles();
}

function redraw() {
  redrawCanvas();
  renderResultsList();
  persistState({ rotation, detections });
}

// Detections whose bounding rects intersect — likely duplicate reads of the
// same physical label. Keyed by detection id -> the other overlapping boxes'
// display numbers (1-based), for the list warning.
function computeOverlapWarnings() {
  const warnings = new Map();
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

// Shared cleanup for any bulk removal: drop the ids from `detections` and
// clear any selection/hover state that would otherwise dangle on a removed id.
function removeDetections(idsToRemove) {
  if (idsToRemove.size === 0) return 0;
  detections = detections.filter((d) => !idsToRemove.has(d.id));
  if (selectedId != null && idsToRemove.has(selectedId)) selectedId = null;
  if (hoverDeleteId != null && idsToRemove.has(hoverDeleteId)) hoverDeleteId = null;
  if (hoverBoxId != null && idsToRemove.has(hoverBoxId)) hoverBoxId = null;
  return idsToRemove.size;
}

function pruneOverlapping() {
  const keptIds = new Set(selectNonOverlapping(detections).map((d) => d.id));
  const removedIds = new Set(detections.filter((d) => !keptIds.has(d.id)).map((d) => d.id));
  return removeDetections(removedIds);
}

// "Empty" = recognition was tried and found nothing (dark-red dashed).
// Never-tried boxes (gray dashed) are left alone.
function pruneEmpty() {
  const emptyIds = new Set(
    detections.filter((d) => d.score == null && d.attempted).map((d) => d.id),
  );
  return removeDetections(emptyIds);
}

function updateButtons() {
  const hasImage = !!img;
  for (const b of [rotateLeftBtn, rotateRightBtn]) b.disabled = !hasImage || !!scanAbortController;
  // Both scan buttons just push onto scanQueue and (re)start the worker (see
  // ensureWorkerRunning()), so clicking either mid-scan adds to the same
  // queue rather than being blocked.
  runOcrBtn.disabled = !hasImage;
  cancelScanBtn.disabled = !scanAbortController;
  deleteBtn.disabled = selectedId == null;
  recognizePendingBtn.disabled = !detections.some((d) => d.score == null && !d.attempted);
  pruneOverlappingBtn.disabled = computeOverlapWarnings().size === 0;
  pruneEmptyBtn.disabled = !detections.some((d) => d.score == null && d.attempted);
  goToGuideBtn.disabled = !detections.some((d) => d.score != null);
  clearBtn.disabled = !hasImage && detections.length === 0;
  clearBoxesBtn.disabled = detections.length === 0;
}

// The canvas's rendered CSS size can differ from its internal pixel buffer
// (e.g. the flex layout shrinking it on a narrow window). Scales into
// internal-pixel space, which hit-testing and view math assume.
function pointerDisplayPos(e) {
  const r = display.getBoundingClientRect();
  const scaleX = display.width / r.width;
  const scaleY = display.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

function tryDeleteAtClick(p) {
  const ids = [...visibleDeleteHotspotIds()];
  if (ids.length === 0) return false;
  const hotspots = ids.map((id) => deleteHotspotDisplayPos(detections.find((d) => d.id === id)));
  const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
  if (idx < 0) return false;

  const hitId = ids[idx];
  detections = detections.filter((d) => d.id !== hitId);
  if (selectedId === hitId) selectedId = null;
  if (hoverDeleteId === hitId) hoverDeleteId = null;
  updateButtons();
  redraw();
  return true;
}

display.addEventListener("pointerdown", (e) => {
  if (!img) return;
  const p = pointerDisplayPos(e);
  if (tryDeleteAtClick(p)) return; // clicking a delete-X always wins

  display.setPointerCapture(e.pointerId);
  pointerDownDisplayPos = p;

  if (e.ctrlKey && e.button === 0) {
    dragging = "pan";
    panStart = { px: p.x, py: p.y, vx: view.x, vy: view.y };
    return;
  }

  const sp = toSource(p, view);

  if (selectedId != null) {
    const current = selectedDetection();
    if (current) {
      const bounds = boundsOf(current.box);
      const handlePositions = cornersOf(bounds).map((c) => toDisplay(c, view));
      const handleIdx = nearestWithinRadius(p, handlePositions, RESIZE_HANDLE_HIT_RADIUS);
      if (handleIdx >= 0) {
        dragging = "resize";
        resizeHandleIndex = handleIdx;
        editStartBounds = bounds;
        return;
      }
      if (pointInPolygon(sp, current.box)) {
        dragging = "move";
        editStartBounds = bounds;
        editStartSource = sp;
        return;
      }
    }
  }

  const hitIndex = hitTestBoxes(sp, detections);
  if (hitIndex >= 0) {
    dragging = "select-candidate";
    selectCandidateId = detections[hitIndex].id;
  } else {
    dragging = "draw";
    draftBox = { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
  }
});

function updateHoverDelete(p) {
  const hotspots = detections.map(deleteHotspotDisplayPos);
  const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
  const newHoverId = idx >= 0 ? detections[idx].id : null;
  if (newHoverId !== hoverDeleteId) {
    hoverDeleteId = newHoverId;
    return true;
  }
  return false;
}

function updateHoverBox(p) {
  const sp = toSource(p, view);
  const idx = hitTestBoxes(sp, detections);
  const newHoverId = idx >= 0 ? detections[idx].id : null;
  if (newHoverId !== hoverBoxId) {
    hoverBoxId = newHoverId;
    return true;
  }
  return false;
}

display.addEventListener("pointermove", (e) => {
  const p = pointerDisplayPos(e);

  if (!dragging) {
    const changedDelete = updateHoverDelete(p);
    const changedBox = updateHoverBox(p);
    if (changedDelete || changedBox) redrawCanvas();
    return;
  }

  if (dragging === "pan") {
    view.x = panStart.vx - (p.x - panStart.px) / view.scale;
    view.y = panStart.vy - (p.y - panStart.py) / view.scale;
    clampView();
    updateMeta();
    redrawCanvas(); // view-only: no list content changed, nothing to persist
  } else if (dragging === "draw") {
    const sp = toSource(p, view);
    draftBox.x1 = sp.x;
    draftBox.y1 = sp.y;
    redrawCanvas();
  } else if (dragging === "move") {
    const sp = toSource(p, view);
    const dx = sp.x - editStartSource.x;
    const dy = sp.y - editStartSource.y;
    const b = editStartBounds;
    selectedDetection().box = normalizedRectBox({
      x0: b.minX + dx, y0: b.minY + dy, x1: b.maxX + dx, y1: b.maxY + dy,
    });
    redrawCanvas();
  } else if (dragging === "resize") {
    const sp = toSource(p, view);
    const bounds = resizedBounds(resizeHandleIndex, sp, editStartBounds);
    selectedDetection().box = normalizedRectBox(bounds);
    redrawCanvas();
  }
  // "select-candidate": no visual feedback until pointerup — a click selects
  // the box before its handles/body become draggable.
});

display.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  const p = pointerDisplayPos(e);
  const moved = distance(p, pointerDownDisplayPos);

  if (dragging === "draw") {
    if (moved >= CLICK_THRESHOLD_PX) {
      detections.push({
        id: nextId++,
        box: normalizedRectBox(draftBox),
        text: null,
        score: null,
        source: "manual",
      });
      selectedId = detections[detections.length - 1].id;
    } else {
      selectedId = null; // click on empty canvas: deselect
    }
    draftBox = null;
  } else if (dragging === "select-candidate") {
    selectedId = selectedId === selectCandidateId ? null : selectCandidateId;
    selectCandidateId = null;
  } else if (dragging === "move" || dragging === "resize") {
    const detection = selectedDetection();
    if (moved >= CLICK_THRESHOLD_PX) {
      if (detection) applyEditedBox(detection, detection.box);
    } else if (dragging === "move") {
      selectedId = null; // click (no real drag) on the selected box's body: deselect
    }
    editStartBounds = null;
    editStartSource = null;
    resizeHandleIndex = null;
  }

  dragging = null;
  updateButtons();
  redraw();
});

display.addEventListener("pointerleave", () => {
  if (hoverDeleteId != null || hoverBoxId != null) {
    hoverDeleteId = null;
    hoverBoxId = null;
    redrawCanvas();
  }
});

display.addEventListener("wheel", (e) => {
  if (!img) return;
  e.preventDefault();
  const anchor = pointerDisplayPos(e);
  if (e.ctrlKey) {
    // Per-event factor scales with the gesture's own magnitude (deltaY), so a
    // trackpad's sparse early pinch events zoom less than a later fast burst.
    // Clamped so a large deltaY spike can't jump more than ~1.4x in one event.
    const factor = Math.max(0.7, Math.min(1.4, Math.exp(-e.deltaY * ZOOM_SENSITIVITY)));
    zoomTo(view.scale * factor, anchor);
  } else {
    view.x += e.deltaX / view.scale;
    view.y += e.deltaY / view.scale;
    clampView();
    updateMeta();
    redrawCanvas(); // view-only: no list content changed, nothing to persist
  }
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId != null) {
    e.preventDefault();
    deleteSelected();
  }
});

function deleteSelected() {
  if (selectedId == null) return;
  detections = detections.filter((d) => d.id !== selectedId);
  selectedId = null;
  updateButtons();
  redraw();
}
deleteBtn.addEventListener("click", deleteSelected);

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

// Maps one box corner through a 90-degree canvas rotation. oldW/oldH are the
// pre-rotation `full` canvas dimensions.
function rotatePoint([x, y], delta, oldW, oldH) {
  return delta > 0 ? [oldH - y, x] : [y, oldW - x];
}

function rotate(delta) {
  if (!img || scanAbortController) return;
  const oldW = full.width;
  const oldH = full.height;
  detections = detections.map((d) => ({
    ...d,
    box: d.box.map((pt) => rotatePoint(pt, delta, oldW, oldH)),
  }));
  rotation = (rotation + delta + 360) % 360;
  clearThumbnailCache(); // `full` is re-rendered, so every cached crop is stale
  resetView({ preserveDetections: true });
  updateButtons();
}
rotateLeftBtn.addEventListener("click", () => rotate(-90));
rotateRightBtn.addEventListener("click", () => rotate(90));

// Crops [x0,y0,x1,y1] (full-image coordinates) from `full` and posts it to
// /ocr, returning results translated back into full-image space.
async function recognizeTile([x0, y0, x1, y1], signal) {
  const tw = x1 - x0;
  const th = y1 - y0;
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = tw;
  cropCanvas.height = th;
  cropCanvas.getContext("2d").drawImage(full, x0, y0, tw, th, 0, 0, tw, th);
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
  scanQueue.push({
    ...item,
    overlay,
    enqueuedAfterAbort: scanAbortController?.signal.aborted === true,
  });
  tileOverlay.push(overlay);
}

runOcrBtn.addEventListener("click", () => {
  if (!full) return;
  for (const box of tileBoxesFor(0, 0, full.width, full.height)) {
    enqueueTile({ box, kind: "auto" });
  }
  redrawCanvas();
  ensureWorkerRunning();
});

cancelScanBtn.addEventListener("click", () => {
  if (scanAbortController) scanAbortController.abort();
});

// Margin around the user's rough box, giving the detector room to find the
// tight text region itself.
function marginFor(bounds) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return Math.max(6, 0.15 * Math.min(w, h));
}

// A drawn box is a region to scan — it may hold one label or several, so
// it's tiled the same way the whole photo is. Each pending box gets a
// placeholder entry so its tiles can be reassembled once all report back.
function recognizePendingBoxes() {
  // Skips boxes already queued: one placeholder entry per box, so a second
  // click can't overwrite bookkeeping the first click's tiles still refer to.
  const pending = detections.filter(
    (d) => d.score == null && !d.attempted && !pendingPlaceholders.has(d.id),
  );
  if (pending.length === 0) return;

  for (const placeholder of pending) {
    const bounds = boundsOf(placeholder.box);
    const margin = marginFor(bounds);
    const x0 = Math.max(0, Math.floor(bounds.minX - margin));
    const y0 = Math.max(0, Math.floor(bounds.minY - margin));
    const x1 = Math.min(full.width, Math.ceil(bounds.maxX + margin));
    const y1 = Math.min(full.height, Math.ceil(bounds.maxY + margin));
    const w = x1 - x0;
    const h = y1 - y0;
    const gotUpscaleBoost = Math.min(w, h) < RAPIDOCR_UPSCALE_SHORT_SIDE;

    const boxes = tileBoxesFor(x0, y0, w, h);
    if (boxes.length === 0) continue; // degenerate (zero-area) region -- nothing to scan
    pendingPlaceholders.set(placeholder.id, { placeholder, remaining: boxes.length, found: [], gotUpscaleBoost });
    for (const box of boxes) {
      enqueueTile({ box, kind: "manual", placeholderId: placeholder.id });
    }
  }
  redrawCanvas();
  ensureWorkerRunning();
}
recognizePendingBtn.addEventListener("click", recognizePendingBoxes);

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
  if (scanAbortController) return;
  scanAbortController = new AbortController();
  const signal = scanAbortController.signal;
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
    while (scanQueue.length > 0) {
      if (signal.aborted) break;
      const item = scanQueue.shift();
      setStatusMessage(`Scanning… ${scanQueue.length} tile(s) queued`);

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
      }
      if (signal.aborted) break; // discard a result that arrived the instant abort() landed

      item.overlay.done = true;
      redrawCanvas();

      if (item.kind === "auto") {
        const newDetections = found.map((d) => ({ id: nextId++, ...d, source: "auto" }));
        autoFoundCount += newDetections.length;
        detections = [...detections, ...newDetections];
        redraw();
        continue;
      }

      // manual: accumulate until every tile this placeholder produced has
      // reported back, then splice its results in (or mark it "no text
      // found" if none of them found anything).
      const entry = pendingPlaceholders.get(item.placeholderId);
      entry.found.push(...found);
      entry.remaining--;
      if (entry.remaining > 0) continue;
      pendingPlaceholders.delete(item.placeholderId);
      manualRegionCount++;
      if (!entry.gotUpscaleBoost) manualNoBoostCount++;
      if (entry.found.length === 0) {
        entry.placeholder.attempted = true; // stays visible, marked "no text found"
        manualEmptyCount++;
      } else {
        const newDetections = entry.found.map((d) => ({ id: nextId++, ...d, source: "manual" }));
        manualFoundCount += newDetections.length;
        const idx = detections.indexOf(entry.placeholder);
        if (idx >= 0) detections.splice(idx, 1, ...newDetections);
        if (selectedId != null && !detections.some((d) => d.id === selectedId)) selectedId = null;
      }
      redraw();
    }
  } finally {
    const cancelled = signal.aborted;
    // Tiles enqueued after the abort landed belong to the next drain, so only
    // this drain's own leftovers are discarded.
    const carried = scanQueue.filter((t) => t.enqueuedAfterAbort);
    const leftoverCount = scanQueue.length - carried.length;
    const carriedPlaceholderIds = new Set(
      carried.filter((t) => t.placeholderId != null).map((t) => t.placeholderId),
    );
    scanQueue = carried.map((t) => ({ ...t, enqueuedAfterAbort: false }));
    // Carried tiles were never drained, so their overlay entries are still
    // undone and can be reused as-is.
    tileOverlay = carried.map((t) => t.overlay);

    // A cancelled region keeps whatever tiles came back before the cancel
    // landed, matching the auto layer's partial-keep above. A placeholder
    // whose tiles carried over is left intact for the next drain to finish,
    // rather than being resolved here and orphaning those tiles.
    for (const [placeholderId, entry] of pendingPlaceholders) {
      if (carriedPlaceholderIds.has(placeholderId)) continue;
      if (entry.found.length > 0) {
        const newDetections = entry.found.map((d) => ({ id: nextId++, ...d, source: "manual" }));
        const idx = detections.indexOf(entry.placeholder);
        if (idx >= 0) detections.splice(idx, 1, ...newDetections);
      }
      pendingPlaceholders.delete(placeholderId);
    }
    scanAbortController = null;

    // Clear ran mid-scan (img null), or Clear boxes did (suppressScanSummary,
    // since img stays set there) -- either way, don't post a stale summary
    // over the clean state it just left behind.
    if (img && !suppressScanSummary) {
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
    suppressScanSummary = false;
    updateButtons();
    redraw();

    // Work arrived while this drain was tearing down -- pick it up, rather
    // than leaving it queued with nothing running to consume it.
    if (scanQueue.length > 0) ensureWorkerRunning();
  }
}

const MAX_THUMB_HEIGHT = 36; // display px

// detection id -> { key, url }, key being the box coordinates, so editing a
// box re-crops it. Held here rather than on the detection objects themselves:
// persistState() serialises `detections` wholesale, so a data URL per box
// would be written to IndexedDB on every save.
const thumbnailCache = new Map();

// Ids restart at 1 after a clear, and `full`'s contents change on rotate or a
// new photo -- either way the cached crops no longer describe their ids.
function clearThumbnailCache() {
  thumbnailCache.clear();
}

function thumbnailDataUrl(detection) {
  const key = JSON.stringify(detection.box);
  const cached = thumbnailCache.get(detection.id);
  if (cached && cached.key === key) return cached.url;

  const b = boundsOf(detection.box);
  const w = Math.max(1, Math.round(b.maxX - b.minX));
  const h = Math.max(1, Math.round(b.maxY - b.minY));
  const scale = Math.min(1, MAX_THUMB_HEIGHT / h);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const c = document.createElement("canvas");
  c.width = outW;
  c.height = outH;
  c.getContext("2d").drawImage(full, b.minX, b.minY, w, h, 0, 0, outW, outH);

  const url = c.toDataURL("image/png");
  thumbnailCache.set(detection.id, { key, url });
  return url;
}

// Frames the box with 3x its own width/height as margin on each side, so the
// visible region is 7x the box's size along each axis.
function zoomToBox(detection) {
  if (!full) return;
  const b = boundsOf(detection.box);
  const boxW = b.maxX - b.minX;
  const boxH = b.maxY - b.minY;
  const targetW = boxW * 7;
  const targetH = boxH * 7;
  const centerX = (b.minX + b.maxX) / 2;
  const centerY = (b.minY + b.maxY) / 2;

  const scaleToFit = Math.min(display.width / targetW, display.height / targetH);
  view.scale = Math.min(MAX_SCALE, Math.max(minScale, scaleToFit));
  updateViewOffsets(); // offsets depend on scale — recompute before using below
  view.x = centerX - (display.width / 2 - view.offsetX) / view.scale;
  view.y = centerY - (display.height / 2 - view.offsetY) / view.scale;
  clampView();
  updateMeta();
}

function renderResultsList() {
  resultsEl.innerHTML = "";
  const overlapWarnings = computeOverlapWarnings();
  detections.forEach((d, i) => {
    const li = document.createElement("li");
    li.className = "result-row";
    li.style.cursor = "pointer";
    li.style.fontWeight = d.id === selectedId ? "bold" : "normal";

    const thumb = document.createElement("img");
    thumb.className = "result-thumb";
    thumb.src = thumbnailDataUrl(d);
    thumb.alt = "";

    const info = document.createElement("div");
    info.className = "result-info";

    const label = document.createElement("span");
    label.className = "result-label";
    label.textContent = `#${i + 1}  ${listLabelFor(d)}`;
    label.style.color = colorFor(d);
    info.append(label);

    const overlapsWith = overlapWarnings.get(d.id);
    if (overlapsWith) {
      const warn = document.createElement("span");
      warn.className = "overlap-warning";
      warn.textContent = `⚠ overlaps #${overlapsWith.join(", #")}`;
      warn.title = "This box's region overlaps another — likely a duplicate of the same label";
      info.append(warn);
    }

    const icons = document.createElement("span");
    icons.className = "result-icons";

    const findBtn = document.createElement("button");
    findBtn.type = "button";
    findBtn.className = "icon-btn";
    findBtn.title = "Pan/zoom to this box";
    findBtn.textContent = "\u{1F50D}"; // 🔍
    findBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedId = d.id;
      zoomToBox(d);
      updateButtons();
      redraw();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.title = "Delete this box";
    delBtn.textContent = "✕"; // ✕
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      detections = detections.filter((x) => x.id !== d.id);
      if (selectedId === d.id) selectedId = null;
      if (hoverDeleteId === d.id) hoverDeleteId = null;
      if (hoverBoxId === d.id) hoverBoxId = null;
      updateButtons();
      redraw();
    });

    icons.append(findBtn, delBtn);
    li.append(thumb, info, icons);
    li.addEventListener("click", () => {
      selectedId = selectedId === d.id ? null : d.id;
      updateButtons();
      redraw();
    });
    // Hovering a row reveals that box's full label on the image, mirroring
    // canvas hover. redrawCanvas(), not redraw(): see redrawCanvas().
    li.addEventListener("mouseenter", () => {
      hoverBoxId = d.id;
      redrawCanvas();
    });
    li.addEventListener("mouseleave", () => {
      if (hoverBoxId === d.id) {
        hoverBoxId = null;
        redrawCanvas();
      }
    });
    resultsEl.appendChild(li);
  });
}

// The meta line stays regular text; the message half is wrapped in a
// monospace span so it reads as a distinct system message.
function setStatusMessage(msg) {
  lastStatusMessage = msg;
  const meta = metaLine();
  statusEl.textContent = "";
  if (meta) statusEl.append(`${meta} — `);
  const span = document.createElement("span");
  span.className = "status-msg";
  span.textContent = msg;
  statusEl.append(span);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  // Stop any in-flight scan against the photo being replaced.
  if (scanAbortController) scanAbortController.abort();
  const url = URL.createObjectURL(file);
  const nextImg = new Image();
  nextImg.onload = () => {
    img = nextImg;
    fileName = file.name; // set before resetView() so its info-line update includes it
    rotation = 0;
    detections = [];
    selectedId = null;
    clearThumbnailCache();
    lastStatusMessage = null; // new photo: don't carry over the previous one's status
    resetView();
    updateButtons();
    URL.revokeObjectURL(url);
    persistImage(file); // new photo: overwrite whatever session was remembered before
  };
  nextImg.src = url;
});

// On boot, restore a previously-remembered image + boxes, if any. Runs
// unawaited; nothing else on the page depends on it finishing.
async function restoreSession() {
  const stored = await loadSession();
  if (!stored) return; // storage unreadable; session-store.js has logged it
  const { blob, state } = stored;
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

  img = nextImg;
  fileName = blob.name || ""; // set before resetView() so its info-line update includes it
  rotation = state?.rotation || 0;
  // Sessions saved before thumbnails moved into thumbnailCache carry a data
  // URL per box; drop those fields rather than persisting them onward.
  detections = (state?.detections || []).map(({ _thumbKey, _thumbUrl, ...d }) => d);
  nextId = detections.reduce((max, d) => Math.max(max, d.id), 0) + 1;
  resetView({ preserveDetections: true });
  updateButtons();
  const label = fileName ? `"${fileName}"` : "previous scan";
  setStatusMessage(`Restored ${label} (${detections.length} box(es))`);
}
restoreSession();

// Hands every recognized detection's text to guide.js via sessionStorage.
// Not deduped: a real board pile can hold several copies of the same board,
// and guide.js counts quantities to allocate complete sets. Use "Prune
// overlapping" first if a region got detected more than once by mistake;
// every box left after that counts as one real board.
goToGuideBtn.addEventListener("click", () => {
  const numbers = detections
    .filter((d) => d.score != null && d.text && d.text.trim())
    .map((d) => d.text.trim());
  if (numbers.length === 0) return;
  sessionStorage.setItem(SCAN_HANDOFF_KEY, numbers.join("\n"));
  location.href = "guide.html";
});
