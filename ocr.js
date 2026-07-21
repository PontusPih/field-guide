"use strict";

// Scan tool frontend. Load a photo, rotate in 90-degree steps, pan/zoom to
// inspect it, run OCR against the backend, and edit the resulting boxes
// (select + delete; draw new ones), then hand the recognized module numbers
// off to guide.js. Coordinate transforms and hit-testing live in
// geometry.js as pure functions so they're unit-testable. The loaded image
// and its boxes are remembered in IndexedDB (see "session persistence"
// below) so navigating away and back — or reopening the tab later — picks
// up right where you left off.
//
// Gesture model (chosen after trying a couple of alternatives):
//   - plain left-drag on empty canvas  -> draw a new box
//   - click (no real drag) on a box    -> select it (again to deselect)
//   - Ctrl+left-drag, or two-finger
//     scroll (wheel without ctrlKey)   -> pan
//   - pinch (wheel WITH ctrlKey)       -> zoom, anchored at the cursor
//   - Delete/Backspace                 -> remove the selected box
// Newly-drawn boxes are stored with text/score = null ("pending") until
// "Recognize new boxes" is run: rather than a dedicated recognition-only
// backend call, each pending box is cropped (with a small margin) and sent
// through the same /ocr endpoint used for full images — letting RapidOCR's
// own detector re-find the tight text region inside the crop measurably
// improves accuracy over skipping detection entirely (0.98 vs 0.89 score on
// the same label, tested directly against the backend during development).

import {
  toSource, toDisplay, hitTestBoxes, distance, nearestWithinRadius, pointInPolygon,
  boundsOf, overlapArea, tileGrid, selectNonOverlapping,
} from "./geometry.js";
import { resolveBackendUrl, BACKEND_URL_STORAGE_KEY, LOCALHOST_NAMES } from "./backend-config.js";

// Same dev/prod signal backend-config.js uses for BACKEND_URL: Render's
// 512MB-driven limits (tile size here, OCR_MAX_DIMENSION server-side) don't
// apply to a local dev machine with real memory headroom, so localhost gets
// the fast/permissive defaults automatically -- see IS_LOCAL_DEV below and
// backend/README.md for the matching OCR_MAX_DIMENSION=0 server-side flag.
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
const goToGuideBtn = document.getElementById("goToGuide");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

// The OCR backend only runs in Python (can't stay client-side like the rest
// of the app), so it's a separate origin from this static page. Hosted on
// Render (see PLAN.md, Phase 2b); backend/server.py sends the CORS headers
// this cross-origin fetch needs. Which URL that actually is -- local
// backend during development, production otherwise, or an explicit
// override -- is resolved by backend-config.js; see there for how to point
// this at something else (e.g. a staging deploy).
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
// images"). Production TILE_SIZE defaults to RAPIDOCR_UPSCALE_SHORT_SIDE
// since that's the size det never scales -- going smaller wastes nothing
// extra (det upscales back up to the floor regardless) but doesn't help
// either, and benchmarking a larger tile came out strictly worse on both
// memory *and* wall time (see PLAN.md Benchmarks), not a trade-off. This is
// the knob to raise if this ever runs on a *production* host with real
// memory headroom instead of Render's 512MB free tier -- kept separate from
// RAPIDOCR_UPSCALE_SHORT_SIDE (today numerically identical) since one
// describes the backend's fixed floor and the other is this client's own
// tunable choice.
//
// Locally, none of that applies: Infinity always fails tileGrid's
// single-cell-region check, so every scan sends exactly one request
// covering the whole region -- fastest possible round trip on a dev
// machine, matching a local server.py run with OCR_MAX_DIMENSION=0 (see
// backend/README.md) so that single big request doesn't get 413-rejected.
const TILE_SIZE = IS_LOCAL_DEV ? Infinity : 736;
const TILE_OVERLAP_FRAC = 0.15;
// A region only modestly larger than one tile must not be forced into a
// multi-tile grid -- the overlap needed to avoid missing text at the seam
// approaches 90%+ at that size (a 800x800 region against a 736 tile), which
// multiplies request count for no benefit. Must stay comfortably under the
// backend's own OCR_MAX_DIMENSION gate (default 1200px = 736 * 1.63) or a
// legitimately single-tile region could get 413-rejected.
const TILE_SINGLE_CELL_FACTOR = 1.4;

let img = null; // loaded HTMLImageElement, full source resolution
let fileName = ""; // original filename of the loaded image, shown in the info line
let rotation = 0; // 0 | 90 | 180 | 270, clockwise
let full = null; // offscreen canvas: full-res image at current rotation
let view = { scale: 1, x: 0, y: 0 };
let minScale = 1;

let detections = []; // [{ id, box: [[x,y]x4] in source coords, text, score }]
let nextId = 1;
// [{ box: [x0,y0,x1,y1], done }] in source coords, shown while a multi-tile
// scan is in flight (see recognizeTiled) -- empty otherwise.
let tileOverlay = [];
// Non-null while any recognizeTiled() call is in flight (whole-photo or
// per-region) -- both the "is a scan running" flag and the means to cancel
// it (cancelScanBtn / clearSession() / loading a new photo all call
// .abort() on it). rotate() doesn't remap tileOverlay, so rotating mid-scan
// would leave the live tile-progress outlines in stale pre-rotation
// coordinates -- disable rotation instead (see updateButtons()).
let scanAbortController = null;
// Last message passed to setStatusMessage(), or null when idle (bare meta
// line only). Tracked so updateMeta() -- called on every pan/zoom/rotate to
// refresh the resolution/zoom% text -- can redraw alongside whatever
// message is still active instead of silently wiping it.
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

// --- session persistence -------------------------------------------------
// Remembers the loaded image, its rotation, and every box (drawn or
// recognized) so navigating to guide.html — or closing the tab entirely —
// and coming back to ocr.html restores exactly where you left off. Uses
// IndexedDB rather than sessionStorage/localStorage because the image is
// binary and can be several MB, well past what string-based storage can
// comfortably hold. The image (rarely rewritten, one put per loaded file)
// and the box state (small JSON, rewritten after every edit) are separate
// keys so editing a box doesn't mean re-storing the whole photo.
const DB_NAME = "field-guide-scan";
const STORE = "session";
const IMAGE_KEY = "image";
const STATE_KEY = "state";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Storing the File directly (not just its bytes) means IndexedDB's
// structured clone keeps its .name intact — retrieved later via
// restoreSession() to show what was loaded, since the native file input
// can't be told to display a filename it didn't itself set.
function persistImage(file) {
  dbPut(IMAGE_KEY, file).catch((err) => console.warn("Could not save scan image:", err));
}

function persistState() {
  dbPut(STATE_KEY, { rotation, detections }).catch((err) => console.warn("Could not save scan state:", err));
}

async function clearSession() {
  if (!img && detections.length === 0) return;
  if (!confirm("Clear the loaded photo and all boxes?")) return;

  // Stop any in-flight scan rather than letting it keep running against a
  // session that's about to be wiped out from under it (see scanAbortController).
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

  fileInput.value = "";
  ctx.clearRect(0, 0, display.width, display.height);
  lastStatusMessage = null; // don't let a stale message survive the clear
  updateMeta();
  updateButtons();
  renderResultsList();

  try {
    await Promise.all([dbDelete(IMAGE_KEY), dbDelete(STATE_KEY)]);
  } catch (err) {
    console.warn("Could not clear saved scan session:", err);
  }
}
clearBtn.addEventListener("click", clearSession);

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

// The canvas box is a fixed size regardless of the loaded image's aspect
// ratio. When the rendered image doesn't fill an axis (e.g. "fit" zoom on
// an image whose aspect ratio differs from the canvas's), that axis gets a
// centered letterbox offset instead of the image being pinned to the
// canvas's top-left corner with the excess canvas space left blank.
// toSource()/toDisplay() (geometry.js) read view.offsetX/offsetY, so this
// must be recomputed any time view.scale changes.
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

// Info-line text: filename (if known) before the resolution, so it reads as
// "what this is, then its details" — shared by updateMeta() (the idle line)
// and setStatusMessage() (which prepends this same line to a status message).
function metaLine() {
  if (!full) return "";
  const name = fileName ? `${fileName} · ` : "";
  return `${name}${full.width}×${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`;
}

// Refreshes the meta portion (resolution/rotation/zoom%) of the status
// line -- called on every pan/zoom/rotate. Re-renders through
// setStatusMessage() when a message is still active (lastStatusMessage) so
// that message survives the refresh instead of being overwritten by the
// bare meta line; genuinely idle (no message yet, or explicitly cleared —
// see clearSession()) falls back to just the meta line.
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
  redraw();
}

function colorFor(detection) {
  if (detection.score != null) {
    if (detection.score >= 0.9) return "#2ecc71";
    if (detection.score >= 0.5) return "#f1c40f";
    return "#e74c3c";
  }
  return detection.attempted ? "#c0392b" : "#888"; // tried-and-failed vs never-tried
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

// Canvas hover label: text only, no score — the score is still available in
// the results list, which is the place for full detail.
function canvasLabelFor(detection) {
  if (detection.score != null) return detection.text;
  return detection.attempted ? "no text found" : "not yet recognized";
}

function listLabelFor(detection) {
  if (detection.score != null) return `${detection.text}  (score ${detection.score.toFixed(3)})`;
  return detection.attempted ? "no text found" : "not yet recognized";
}

function drawLabelText(text, color, topLeft) {
  ctx.font = "14px sans-serif";
  const metrics = ctx.measureText(text);
  const labelHeight = 16;
  const spaceAbove = topLeft.y - 6;
  // Fallback stays anchored to the box's own position (not a fixed canvas
  // y) so the label scrolls off-screen together with its box when panning,
  // instead of appearing pinned to the top edge.
  const labelY = spaceAbove >= labelHeight ? spaceAbove : topLeft.y + labelHeight + 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(topLeft.x - 2, labelY - 13, metrics.width + 4, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, topLeft.x, labelY);
}

// Default view stays uncluttered — just a colored outline plus a small
// numbered badge. Full text+score only shows for the hovered or selected
// box; everything is always visible in the results list regardless.
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

// Delete-X floats just above the box's top-center, in display space (view-
// dependent, so it tracks pan/zoom correctly) — kept clear of the corners,
// which are now resize handles.
function deleteHotspotDisplayPos(detection) {
  const b = boundsOf(detection.box);
  const topCenter = toDisplay({ x: (b.minX + b.maxX) / 2, y: b.minY }, view);
  return { x: topCenter.x, y: topCenter.y - 14 };
}

// A box's delete-X shows if it's hovered near, OR selected — selecting a
// box (e.g. via the results list) shouldn't require re-hovering it just to
// find the delete affordance.
function visibleDeleteHotspotIds() {
  const ids = new Set();
  if (selectedId != null) ids.add(selectedId);
  if (hoverDeleteId != null) ids.add(hoverDeleteId);
  return ids;
}

// Corner order: 0=top-left, 1=top-right, 2=bottom-right, 3=bottom-left —
// used consistently for both drawing handles and resizing from one.
function cornersOf(bounds) {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
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

// Given which corner (see cornersOf) is being dragged to source point `sp`,
// return the resulting {x0,y0,x1,y1} — the opposite corner stays fixed.
// normalizedRectBox() (already used for drawing new boxes) handles the
// min/max swap if the drag crosses over the opposite corner.
function resizedBounds(handleIndex, sp, startBounds) {
  const b = startBounds;
  switch (handleIndex) {
    case 0: return { x0: sp.x, y0: sp.y, x1: b.maxX, y1: b.maxY };
    case 1: return { x0: b.minX, y0: sp.y, x1: sp.x, y1: b.maxY };
    case 2: return { x0: b.minX, y0: b.minY, x1: sp.x, y1: sp.y };
    default: return { x0: sp.x, y0: b.minY, x1: b.maxX, y1: sp.y };
  }
}

// Editing a box invalidates whatever recognition it had (the region it
// covers just changed), so treat it as pending again and mark it "manual"
// so a later Run OCR won't discard the edit.
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

// Tile grid for an in-flight multi-tile scan (see recognizeTiled) — dashed
// while a tile is still queued/in-flight, solid once its result is back.
// Deliberately a plain outline (no label/color-by-confidence) so it reads
// as a different kind of thing from the detection boxes drawn over it.
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

// Split from redraw() so hover-only updates (canvas hover, or hovering a row
// in the results list) can repaint the canvas without rebuilding the whole
// list DOM underneath the cursor — which would flicker/misfire hover events
// on the very row being hovered.
function redrawCanvas() {
  if (!full) return;
  ctx.clearRect(0, 0, display.width, display.height);
  // Clip the sampled source rect to the image's actual bounds — sampling
  // past them (e.g. at "fit" zoom on an image whose aspect ratio doesn't
  // match the canvas's) previously left drawImage silently drawing only
  // the overlap pinned to the canvas's top-left corner. The now-smaller
  // destination rect is drawn at view.offsetX/offsetY instead, centering
  // the image in the leftover space on whichever axis doesn't fill it.
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
  persistState();
}

function normalizedRectBox(b) {
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// Pairs of detections whose bounding rects intersect — most likely
// duplicate detections of the same physical label from overlapping drawn
// regions. Keyed by detection id -> the other overlapping boxes' display
// numbers (1-based), for the list warning.
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

// Greedy non-max suppression: process boxes highest-score first, drop any
// box that overlaps one already kept. Keeps the more-trustworthy box from
// each overlapping cluster; pending (null-score) boxes rank lowest.
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
// Never-tried boxes ("?", gray dashed) are left alone — they're still
// pending user intent, not a dead end.
function pruneEmpty() {
  const emptyIds = new Set(
    detections.filter((d) => d.score == null && d.attempted).map((d) => d.id),
  );
  return removeDetections(emptyIds);
}

function updateButtons() {
  const hasImage = !!img;
  for (const b of [rotateLeftBtn, rotateRightBtn]) b.disabled = !hasImage || !!scanAbortController;
  // Mutual exclusion: only one scan (whole-photo or per-region) runs at a
  // time -- both share the single scanAbortController slot, so letting a
  // second one start would silently orphan whichever scan started first
  // (Cancel/Clear would only ever be able to reach the newer one).
  runOcrBtn.disabled = !hasImage || !!scanAbortController;
  cancelScanBtn.disabled = !scanAbortController;
  deleteBtn.disabled = selectedId == null;
  recognizePendingBtn.disabled = !detections.some((d) => d.score == null && !d.attempted) || !!scanAbortController;
  pruneOverlappingBtn.disabled = computeOverlapWarnings().size === 0;
  pruneEmptyBtn.disabled = !detections.some((d) => d.score == null && d.attempted);
  goToGuideBtn.disabled = !detections.some((d) => d.score != null);
  clearBtn.disabled = !hasImage && detections.length === 0;
}

// The canvas's rendered CSS size can differ from its internal pixel buffer
// (display.width/height) — e.g. the flex layout shrinking it on a narrow
// window. Scale into internal-pixel space so hit-testing and view math
// (which assume 1 canvas px per unit) stay correct regardless of render size.
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
    redraw();
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
  // "select-candidate": no visual feedback until pointerup, by design —
  // a click should select before its handles/move-body become draggable.
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
    // Scale the per-event factor by the actual gesture magnitude (deltaY)
    // instead of a fixed step — a fixed step means a trackpad's early
    // sparse/small pinch events zoom just as much as a later fast burst,
    // which reads as "nothing, nothing, then a lot." Clamped so a rare
    // large deltaY spike can't jump more than ~1.4x in a single event.
    const factor = Math.max(0.7, Math.min(1.4, Math.exp(-e.deltaY * ZOOM_SENSITIVITY)));
    zoomTo(view.scale * factor, anchor);
  } else {
    view.x += e.deltaX / view.scale;
    view.y += e.deltaY / view.scale;
    clampView();
    updateMeta();
    redraw();
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

// A 90-degree rotation of the canvas is a well-defined coordinate transform,
// so existing boxes can be carried through it rather than discarded.
// oldW/oldH are the pre-rotation `full` canvas dimensions.
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
  resetView({ preserveDetections: true });
  updateButtons();
}
rotateLeftBtn.addEventListener("click", () => rotate(-90));
rotateRightBtn.addEventListener("click", () => rotate(90));

// Crops one tile from `full` at (x0,y0) (region-local origin) sized
// (tx0,ty0)-(tx1,ty1) and posts it to /ocr, returning results translated
// into full-image coordinates. Shared by every caller of recognizeTiled.
async function recognizeTile(x0, y0, [tx0, ty0, tx1, ty1], signal) {
  const tw = tx1 - tx0;
  const th = ty1 - ty0;
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = tw;
  cropCanvas.height = th;
  cropCanvas.getContext("2d").drawImage(full, x0 + tx0, y0 + ty0, tw, th, 0, 0, tw, th);
  const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));

  const resp = await fetch(`${BACKEND_URL}/ocr`, { method: "POST", body: blob, signal });
  const found = resp.ok ? await resp.json() : [];
  // f.box is in tile-local coordinates; translate back to full-image space.
  return found.map((f) => ({
    box: f.box.map(([x, y]) => [x + x0 + tx0, y + y0 + ty0]),
    text: f.text,
    score: f.score,
  }));
}

// Runs the (x0,y0)-(x0+w,y0+h) region of `full` through OCR, auto-tiling
// into RapidOCR-sized pieces if the region is large (see PLAN.md, "Tiled
// scanning for large images") and deduping tile-boundary duplicates.
// Shared by the whole-photo "Run OCR" button and per-drawn-box recognition
// below -- every /ocr upload goes through here, which is also what keeps
// every upload under the backend's hard size limit (OCR_MAX_DIMENSION):
// posting `full` directly (the pre-tiling behavior) would exceed it for any
// realistically-sized photo. Options (both optional):
//   - onProgress(done, total) fires after each tile completes -- a
//     multi-tile scan is sequential (see below) and each tile takes real
//     time, so callers with many tiles can show "tile N/X" instead of
//     leaving the status line static for several seconds.
//   - onTileFound(tileResults) fires with each tile's own (not yet deduped)
//     results as they arrive, letting a caller render boxes live instead of
//     waiting for the whole scan (all tiles + final dedup) to finish. The
//     eventual return value is the authoritative, deduped set -- a caller
//     using onTileFound should treat it as provisional and reconcile
//     against the final return value once the scan completes (a box shown
//     live from one tile can still get dropped by dedup once a later,
//     higher-confidence tile finds the same box again).
//   - signal: an AbortSignal that stops the scan between tiles (see
//     cancelScanBtn / clearSession()). Passed through to each tile's fetch
//     so an already-in-flight request is actually cancelled too, freeing
//     the backend's job queue rather than letting it run to completion for
//     a result nobody wants. Checked again right after each tile's await
//     resolves, in case that tile's response had already fully arrived the
//     instant abort() was called -- fetch alone can't reject a promise
//     that's already settled, so that result must be discarded explicitly
//     instead of reaching onTileFound.
async function recognizeTiled(x0, y0, w, h, { onProgress, onTileFound, signal } = {}) {
  if (w <= 0 || h <= 0) return [];

  const tiles = tileGrid(w, h, TILE_SIZE, {
    overlapFrac: TILE_OVERLAP_FRAC,
    singleCellFactor: TILE_SINGLE_CELL_FACTOR,
  });
  // Only worth drawing when there's an actual grid to see -- a single-tile
  // region matches its own bounds exactly, nothing to visualize.
  const showOverlay = tiles.length > 1;

  if (showOverlay) {
    tileOverlay = tiles.map(([tx0, ty0, tx1, ty1]) => ({
      box: [x0 + tx0, y0 + ty0, x0 + tx1, y0 + ty1],
      done: false,
    }));
    redrawCanvas();
  }

  // Sequential, not Promise.all across tiles: a large region can produce
  // many tiles, and the backend's job queue is bounded (OCR_QUEUE_MAXSIZE)
  // -- firing them all at once would just 503 most of them instead of
  // letting the single worker queue work through them.
  let allFound = [];
  try {
    for (let i = 0; i < tiles.length; i++) {
      const tileFound = await recognizeTile(x0, y0, tiles[i], signal);
      if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
      allFound = allFound.concat(tileFound);
      if (onTileFound) onTileFound(tileFound);
      if (showOverlay) {
        tileOverlay[i].done = true;
        redrawCanvas();
      }
      if (onProgress) onProgress(i + 1, tiles.length);
    }
  } finally {
    // Clear even on failure -- an error partway through a scan shouldn't
    // leave a stale tile grid drawn over the photo indefinitely.
    if (showOverlay) {
      tileOverlay = [];
      redrawCanvas();
    }
  }

  // Overlapping tiles often detect the same complete box twice; a region
  // that wasn't split has nothing to dedupe against itself.
  return tiles.length > 1 ? selectNonOverlapping(allFound) : allFound;
}

runOcrBtn.addEventListener("click", async () => {
  if (!full) return;
  setStatusMessage("Running OCR…");
  runOcrBtn.disabled = true;
  scanAbortController = new AbortController();
  updateButtons(); // picks up scanAbortController -- disables rotation, enables Cancel scan
  // Only the auto-detected layer gets refreshed — boxes you drew or
  // recognized by hand (source "manual") survive a re-scan. Cleared up
  // front (rather than only at the end) so the live per-tile updates below
  // start from an empty auto layer instead of briefly showing stale boxes
  // alongside newly-arriving ones.
  const manualDetections = detections.filter((d) => d.source === "manual");
  detections = [...manualDetections];
  redraw();
  let foundSoFar = 0; // tracked separately from `detections` -- Clear can reset that out from under a cancelled scan
  try {
    const found = await recognizeTiled(0, 0, full.width, full.height, {
      signal: scanAbortController.signal,
      onProgress: (done, total) => {
        if (total > 1) setStatusMessage(`Scanning tile ${done}/${total}…`);
      },
      // Show each tile's boxes as soon as they arrive rather than waiting
      // for the whole scan to finish -- provisional, reconciled below once
      // recognizeTiled resolves with the final deduped set.
      onTileFound: (tileFound) => {
        const newDetections = tileFound.map((d) => ({ id: nextId++, ...d, source: "auto" }));
        foundSoFar += newDetections.length;
        detections = [...detections, ...newDetections];
        redraw();
      },
    });
    // Reconcile: replace the provisional auto layer with the final,
    // deduped set (some boxes shown live above may have been superseded).
    const autoDetections = found.map((d) => ({ id: nextId++, ...d, source: "auto" }));
    detections = [...manualDetections, ...autoDetections];
    selectedId = null;
    redraw();
    setStatusMessage(`Found ${autoDetections.length} box(es) (${manualDetections.length} manual box(es) kept)`);
  } catch (err) {
    // img null means Clear ran mid-scan and already replaced this status
    // with its own clean state -- don't resurrect a stale scan message
    // over it. Boxes found before cancelling are left in place either way
    // (kept on a plain Cancel, discarded along with everything else by
    // Clear's own reset).
    if (img) {
      setStatusMessage(
        err.name === "AbortError"
          ? `Scan cancelled (kept ${foundSoFar} box(es) found before cancelling)`
          : `OCR failed: ${err.message}`,
      );
    }
  } finally {
    runOcrBtn.disabled = false;
    scanAbortController = null;
    updateButtons();
  }
});

cancelScanBtn.addEventListener("click", () => {
  if (scanAbortController) scanAbortController.abort();
});

// Margin around the user's rough box, giving the detector room to find the
// tight text region itself rather than relying on the recognizer to cope
// with an imprecise crop.
function marginFor(bounds) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return Math.max(6, 0.15 * Math.min(w, h));
}

// A drawn box is really just "a region to scan" — it may hold one label
// (the common case) or several (a looser region covering a cluttered/tiny-
// label area). Crop it (with a small margin, letting the detector find the
// tight text region itself) and run it through recognizeTiled.
async function recognizeRegion(placeholder, signal) {
  const bounds = boundsOf(placeholder.box);
  const margin = marginFor(bounds);
  const x0 = Math.max(0, Math.floor(bounds.minX - margin));
  const y0 = Math.max(0, Math.floor(bounds.minY - margin));
  const x1 = Math.min(full.width, Math.ceil(bounds.maxX + margin));
  const y1 = Math.min(full.height, Math.ceil(bounds.maxY + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  const gotUpscaleBoost = Math.min(w, h) < RAPIDOCR_UPSCALE_SHORT_SIDE;

  const found = await recognizeTiled(x0, y0, w, h, { signal });
  const newDetections = found.map((d) => ({ id: nextId++, ...d, source: "manual" }));
  return { placeholder, found: newDetections, gotUpscaleBoost };
}

async function recognizePendingBoxes() {
  const pending = detections.filter((d) => d.score == null && !d.attempted);
  if (pending.length === 0) return;

  setStatusMessage(`Recognizing ${pending.length} region(s)…`);
  recognizePendingBtn.disabled = true;
  scanAbortController = new AbortController();
  updateButtons(); // picks up scanAbortController -- disables rotation, enables Cancel scan
  try {
    const signal = scanAbortController.signal;
    const results = await Promise.all(pending.map((p) => recognizeRegion(p, signal)));

    let foundCount = 0;
    let emptyCount = 0;
    let noBoostCount = 0;
    for (const { placeholder, found, gotUpscaleBoost } of results) {
      if (!gotUpscaleBoost) noBoostCount++;
      if (found.length === 0) {
        placeholder.attempted = true; // stays visible, marked "no text found"
        emptyCount++;
        continue;
      }
      foundCount += found.length;
      const idx = detections.indexOf(placeholder);
      if (idx >= 0) detections.splice(idx, 1, ...found);
    }
    // A replaced placeholder's id no longer exists — drop a now-dangling selection.
    if (selectedId != null && !detections.some((d) => d.id === selectedId)) selectedId = null;

    const parts = [];
    if (foundCount > 0) parts.push(`found ${foundCount} box(es) from ${pending.length} region(s)`);
    if (emptyCount > 0) parts.push(`${emptyCount} region(s) found no text`);
    if (noBoostCount > 0) {
      parts.push(
        `${noBoostCount} region(s) shortest side ≥${RAPIDOCR_UPSCALE_SHORT_SIDE}px `
        + "(no scale boost, same as full image scan)",
      );
    }
    setStatusMessage(parts.join("\n"));
  } catch (err) {
    // Promise.all rejects as soon as any one region's request does, so a
    // cancel (or a genuine failure) here drops the whole batch -- placeholders
    // stay pending ("?"), unlike the whole-photo scan's per-tile partial keep.
    // img null means Clear ran mid-scan and already replaced this status with
    // its own clean state -- don't resurrect a stale one over it.
    if (img) {
      setStatusMessage(err.name === "AbortError" ? "Recognition cancelled" : `Recognition failed: ${err.message}`);
    }
  } finally {
    scanAbortController = null;
    updateButtons();
    redraw();
  }
}
recognizePendingBtn.addEventListener("click", recognizePendingBoxes);

const MAX_THUMB_HEIGHT = 36; // display px

// Cached on the detection itself, keyed by its box — redraw()s triggered by
// hover alone (no box change) reuse the cached data URL instead of
// re-cropping and re-encoding a PNG on every mouse move.
function thumbnailDataUrl(detection) {
  const key = JSON.stringify(detection.box);
  if (detection._thumbKey === key && detection._thumbUrl) return detection._thumbUrl;

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

  detection._thumbKey = key;
  detection._thumbUrl = c.toDataURL("image/png");
  return detection._thumbUrl;
}

// Frames the box with 3x its own width/height as margin on each side (so
// the visible region is 7x the box's size along each axis) — enough context
// to see where the box sits without zooming in so tight it's disorienting.
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
    // Mirrors canvas hover: hovering a row reveals that box's full label on
    // the image. Uses redrawCanvas(), not redraw() — rebuilding the list
    // DOM while the mouse sits on one of its rows would flicker/misfire.
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

// The meta line (filename/resolution/rotation/zoom) stays regular text; the
// message half is wrapped in its own monospace span so it visually reads as
// a distinct "system message" rather than blending into the description.
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
  // Stop any in-flight scan against the photo being replaced -- same
  // reasoning as clearSession() (see scanAbortController).
  if (scanAbortController) scanAbortController.abort();
  const url = URL.createObjectURL(file);
  const nextImg = new Image();
  nextImg.onload = () => {
    img = nextImg;
    fileName = file.name; // set before resetView() so its info-line update includes it
    rotation = 0;
    detections = [];
    selectedId = null;
    lastStatusMessage = null; // new photo: don't carry over the previous one's status
    resetView();
    updateButtons();
    URL.revokeObjectURL(url);
    persistImage(file); // new photo: overwrite whatever session was remembered before
  };
  nextImg.src = url;
});

// On boot, restore a previously-remembered image + boxes (if any) before
// anything else — lets navigating away from Scan and back, or just closing
// and reopening the tab, pick back up where you left off. Runs unawaited;
// there's nothing else on the page that depends on it finishing.
async function restoreSession() {
  let blob, state;
  try {
    [blob, state] = await Promise.all([dbGet(IMAGE_KEY), dbGet(STATE_KEY)]);
  } catch (err) {
    console.warn("Could not restore previous scan session:", err);
    return;
  }
  if (!blob) return;

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
  detections = state?.detections || [];
  nextId = detections.reduce((max, d) => Math.max(max, d.id), 0) + 1;
  resetView({ preserveDetections: true });
  updateButtons();
  const label = fileName ? `"${fileName}"` : "previous scan";
  setStatusMessage(`Restored ${label} (${detections.length} box(es))`);
}
restoreSession();

// Collate every recognized (non-empty, non-pending) detection's text and hand
// it to guide.js via sessionStorage — the same mechanism a plain page
// navigation can carry state through without a server round-trip.
// Deliberately NOT deduped: a real board pile can hold several copies of the
// same board (e.g. ten of the same RAM card), and guide.js's option grouping
// now counts quantities to strive for complete sets — collapsing duplicates
// here would throw that count away before it ever reaches guide.js. Use
// "Prune overlapping" first if a region got detected more than once by
// mistake; every box left after that is trusted to be one real board.
goToGuideBtn.addEventListener("click", () => {
  const numbers = detections
    .filter((d) => d.score != null && d.text && d.text.trim())
    .map((d) => d.text.trim());
  if (numbers.length === 0) return;
  sessionStorage.setItem(SCAN_HANDOFF_KEY, numbers.join("\n"));
  location.href = "guide.html";
});
