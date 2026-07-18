"use strict";

// RapidOCR POC frontend. Load a photo, rotate in 90-degree steps, pan/zoom to
// inspect it, run OCR against the backend, and edit the resulting boxes
// (select + delete; draw new ones). Coordinate transforms and hit-testing
// live in geometry.js as pure functions so they're unit-testable.
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
  boundsOf, overlapArea,
} from "./geometry.js";

const fileInput = document.getElementById("file");
const display = document.getElementById("stage");
const ctx = display.getContext("2d");
const rotateLeftBtn = document.getElementById("rotateLeft");
const rotateRightBtn = document.getElementById("rotateRight");
const runOcrBtn = document.getElementById("runOcr");
const recognizePendingBtn = document.getElementById("recognizePending");
const pruneOverlappingBtn = document.getElementById("pruneOverlapping");
const pruneEmptyBtn = document.getElementById("pruneEmpty");
const deleteBtn = document.getElementById("deleteSelected");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

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

let img = null; // loaded HTMLImageElement, full source resolution
let rotation = 0; // 0 | 90 | 180 | 270, clockwise
let full = null; // offscreen canvas: full-res image at current rotation
let view = { scale: 1, x: 0, y: 0 };
let minScale = 1;

let detections = []; // [{ id, box: [[x,y]x4] in source coords, text, score }]
let nextId = 1;
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
  full = rotatedCanvas(img, rotation);
  display.width = Math.min(MAX_VIEWPORT_W, window.innerWidth - 48);
  display.height = Math.min(MAX_VIEWPORT_H, Math.round(window.innerHeight * 0.6));
  minScale = Math.min(1, display.width / full.width, display.height / full.height);
  view = { scale: minScale, x: 0, y: 0 };
  if (!preserveDetections) {
    detections = [];
    selectedId = null;
  }
  draftBox = null;
  hoverDeleteId = null;
  updateMeta();
  redraw();
}

function updateMeta() {
  statusEl.textContent = full
    ? `${full.width}×${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`
    : "";
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
  view.x = anchorSource.x - anchorDisplayPt.x / view.scale;
  view.y = anchorSource.y - anchorDisplayPt.y / view.scale;
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

// Split from redraw() so hover-only updates (canvas hover, or hovering a row
// in the results list) can repaint the canvas without rebuilding the whole
// list DOM underneath the cursor — which would flicker/misfire hover events
// on the very row being hovered.
function redrawCanvas() {
  if (!full) return;
  ctx.clearRect(0, 0, display.width, display.height);
  const visW = display.width / view.scale;
  const visH = display.height / view.scale;
  ctx.drawImage(full, view.x, view.y, visW, visH, 0, 0, display.width, display.height);

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
  const sorted = [...detections].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const kept = [];
  const removedIds = new Set();
  for (const d of sorted) {
    const dBounds = boundsOf(d.box);
    const overlapsKept = kept.some((k) => overlapArea(dBounds, boundsOf(k.box)) > 0);
    if (overlapsKept) removedIds.add(d.id);
    else kept.push(d);
  }
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
  for (const b of [rotateLeftBtn, rotateRightBtn, runOcrBtn]) b.disabled = !hasImage;
  deleteBtn.disabled = selectedId == null;
  recognizePendingBtn.disabled = !detections.some((d) => d.score == null && !d.attempted);
  pruneOverlappingBtn.disabled = computeOverlapWarnings().size === 0;
  pruneEmptyBtn.disabled = !detections.some((d) => d.score == null && d.attempted);
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
  if (!img) return;
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

runOcrBtn.addEventListener("click", async () => {
  if (!full) return;
  setStatusMessage("Running OCR…");
  runOcrBtn.disabled = true;
  try {
    // PNG, not JPEG: avoids re-compressing an already-JPEG-decoded image a
    // second time before it reaches the OCR backend.
    const blob = await new Promise((resolve) => full.toBlob(resolve, "image/png"));
    const resp = await fetch("/ocr", { method: "POST", body: blob });
    if (!resp.ok) throw new Error(`server returned ${resp.status}`);
    const found = await resp.json();
    // Only the auto-detected layer gets refreshed — boxes you drew or
    // recognized by hand (source "manual") survive a re-scan.
    const autoDetections = found.map((d) => (
      { id: nextId++, box: d.box, text: d.text, score: d.score, source: "auto" }
    ));
    const manualDetections = detections.filter((d) => d.source === "manual");
    detections = [...manualDetections, ...autoDetections];
    selectedId = null;
    redraw();
    setStatusMessage(`Found ${autoDetections.length} box(es) (${manualDetections.length} manual box(es) kept)`);
  } catch (err) {
    setStatusMessage(`OCR failed: ${err.message}`);
  } finally {
    runOcrBtn.disabled = false;
    updateButtons();
  }
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
// label area). Either way: crop it, send the crop through the same /ocr
// full detect+recognize pipeline, and keep every result found — not just
// the best-scoring one — translated back into full-image coordinates.
async function recognizeRegion(placeholder) {
  const bounds = boundsOf(placeholder.box);
  const margin = marginFor(bounds);
  const x0 = Math.max(0, Math.floor(bounds.minX - margin));
  const y0 = Math.max(0, Math.floor(bounds.minY - margin));
  const x1 = Math.min(full.width, Math.ceil(bounds.maxX + margin));
  const y1 = Math.min(full.height, Math.ceil(bounds.maxY + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  const gotUpscaleBoost = Math.min(w, h) < RAPIDOCR_UPSCALE_SHORT_SIDE;

  if (w <= 0 || h <= 0) return { placeholder, found: [], gotUpscaleBoost };

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = w;
  cropCanvas.height = h;
  cropCanvas.getContext("2d").drawImage(full, x0, y0, w, h, 0, 0, w, h);
  const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));

  const resp = await fetch("/ocr", { method: "POST", body: blob });
  const found = resp.ok ? await resp.json() : [];
  // f.box is in crop-local coordinates; translate back to full-image space.
  const newDetections = found.map((f) => ({
    id: nextId++,
    box: f.box.map(([x, y]) => [x + x0, y + y0]),
    text: f.text,
    score: f.score,
    source: "manual",
  }));
  return { placeholder, found: newDetections, gotUpscaleBoost };
}

async function recognizePendingBoxes() {
  const pending = detections.filter((d) => d.score == null && !d.attempted);
  if (pending.length === 0) return;

  setStatusMessage(`Recognizing ${pending.length} region(s)…`);
  recognizePendingBtn.disabled = true;
  try {
    const results = await Promise.all(pending.map(recognizeRegion));

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
  } finally {
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
  view.x = centerX - display.width / view.scale / 2;
  view.y = centerY - display.height / view.scale / 2;
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

function setStatusMessage(msg) {
  const meta = full
    ? `${full.width}×${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`
    : "";
  statusEl.textContent = meta ? `${meta}\n${msg}` : msg;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const nextImg = new Image();
  nextImg.onload = () => {
    img = nextImg;
    rotation = 0;
    detections = [];
    selectedId = null;
    resetView();
    updateButtons();
    URL.revokeObjectURL(url);
  };
  nextImg.src = url;
});
