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

import { toSource, toDisplay, hitTestBoxes, distance, nearestWithinRadius } from "./geometry.js";

const fileInput = document.getElementById("file");
const display = document.getElementById("stage");
const ctx = display.getContext("2d");
const rotateLeftBtn = document.getElementById("rotateLeft");
const rotateRightBtn = document.getElementById("rotateRight");
const runOcrBtn = document.getElementById("runOcr");
const recognizePendingBtn = document.getElementById("recognizePending");
const deleteBtn = document.getElementById("deleteSelected");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

const MAX_VIEWPORT_W = 900;
const MAX_VIEWPORT_H = 650;
const MAX_SCALE = 8;
const CLICK_THRESHOLD_PX = 4; // display px; below this, pointerup is a "click" not a drag
const DELETE_HOTSPOT_RADIUS = 8; // display px, drawn size of the delete-X
const DELETE_HOVER_RADIUS = 16; // display px, how close the cursor must get to reveal it

let img = null; // loaded HTMLImageElement, full source resolution
let rotation = 0; // 0 | 90 | 180 | 270, clockwise
let full = null; // offscreen canvas: full-res image at current rotation
let view = { scale: 1, x: 0, y: 0 };
let minScale = 1;

let detections = []; // [{ id, box: [[x,y]x4] in source coords, text, score }]
let nextId = 1;
let selectedId = null;
let draftBox = null; // { x0, y0, x1, y1 } in source coords, while drawing a new box

let dragging = null; // null | "pan" | "draw" | "select-candidate"
let panStart = null; // { px, py, vx, vy }
let selectCandidateId = null;
let pointerDownDisplayPos = null;
let hoverDeleteId = null; // id of the box whose delete-X is currently shown

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

function drawDetection(detection) {
  const color = colorFor(detection);
  const isSelected = detection.id === selectedId;
  const isPending = detection.score == null;

  strokeBoxPath(detection.box);
  ctx.setLineDash(isPending ? [6, 4] : []);
  ctx.lineWidth = isSelected ? 4 : 2;
  ctx.strokeStyle = isSelected ? "#3498db" : color;
  ctx.stroke();
  ctx.setLineDash([]);

  const label = detection.score != null
    ? `${detection.text} (${detection.score.toFixed(2)})`
    : detection.attempted ? "no text found" : "?";
  const topLeft = toDisplay({ x: detection.box[0][0], y: detection.box[0][1] }, view);
  ctx.font = "14px sans-serif";
  const metrics = ctx.measureText(label);
  const labelHeight = 16;
  const spaceAbove = topLeft.y - 6;
  // Fallback stays anchored to the box's own position (not a fixed canvas
  // y) so the label scrolls off-screen together with its box when panning,
  // instead of appearing pinned to the top edge.
  const labelY = spaceAbove >= labelHeight ? spaceAbove : topLeft.y + labelHeight + 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(topLeft.x - 2, labelY - 13, metrics.width + 4, 16);
  ctx.fillStyle = isSelected ? "#3498db" : color;
  ctx.fillText(label, topLeft.x, labelY);
}

function boxBoundsSource(box) {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  return {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
}

// Delete-X sits at the box's top-right corner, in display space (view-
// dependent) so it tracks pan/zoom correctly.
function deleteHotspotDisplayPos(detection) {
  const b = boxBoundsSource(detection.box);
  return toDisplay({ x: b.maxX, y: b.minY }, view);
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

function redraw() {
  if (!full) return;
  ctx.clearRect(0, 0, display.width, display.height);
  const visW = display.width / view.scale;
  const visH = display.height / view.scale;
  ctx.drawImage(full, view.x, view.y, visW, visH, 0, 0, display.width, display.height);

  for (const d of detections) drawDetection(d);

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
  renderResultsList();
}

function normalizedRectBox(b) {
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function updateButtons() {
  const hasImage = !!img;
  for (const b of [rotateLeftBtn, rotateRightBtn, runOcrBtn]) b.disabled = !hasImage;
  deleteBtn.disabled = selectedId == null;
  recognizePendingBtn.disabled = !detections.some((d) => d.score == null && !d.attempted);
}

function pointerDisplayPos(e) {
  const r = display.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
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
    redraw();
  }
}

display.addEventListener("pointermove", (e) => {
  const p = pointerDisplayPos(e);

  if (!dragging) {
    updateHoverDelete(p);
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
    redraw();
  }
  // "select-candidate": no visual feedback until pointerup, by design —
  // avoids half-built move/resize behavior before that's actually wired up.
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
      });
      selectedId = detections[detections.length - 1].id;
    } else {
      selectedId = null; // click on empty canvas: deselect
    }
    draftBox = null;
  } else if (dragging === "select-candidate") {
    selectedId = selectedId === selectCandidateId ? null : selectCandidateId;
    selectCandidateId = null;
  }

  dragging = null;
  updateButtons();
  redraw();
});

display.addEventListener("pointerleave", () => {
  if (hoverDeleteId != null) {
    hoverDeleteId = null;
    redraw();
  }
});

display.addEventListener("wheel", (e) => {
  if (!img) return;
  e.preventDefault();
  const anchor = pointerDisplayPos(e);
  if (e.ctrlKey) {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
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
    detections = found.map((d) => ({ id: nextId++, box: d.box, text: d.text, score: d.score }));
    selectedId = null;
    redraw();
    setStatusMessage(`Found ${detections.length} box(es)`);
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

async function recognizeOneBox(detection) {
  const bounds = boxBoundsSource(detection.box);
  const margin = marginFor(bounds);
  const x0 = Math.max(0, Math.floor(bounds.minX - margin));
  const y0 = Math.max(0, Math.floor(bounds.minY - margin));
  const x1 = Math.min(full.width, Math.ceil(bounds.maxX + margin));
  const y1 = Math.min(full.height, Math.ceil(bounds.maxY + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  detection.attempted = true;
  if (w <= 0 || h <= 0) return;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = w;
  cropCanvas.height = h;
  cropCanvas.getContext("2d").drawImage(full, x0, y0, w, h, 0, 0, w, h);
  const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));

  const resp = await fetch("/ocr", { method: "POST", body: blob });
  if (!resp.ok) return;
  const found = await resp.json();
  if (found.length === 0) return;

  const best = found.reduce((a, b) => (b.score > a.score ? b : a));
  detection.text = best.text;
  detection.score = best.score;
  // best.box is in crop-local coordinates; translate back to full-image space.
  detection.box = best.box.map(([x, y]) => [x + x0, y + y0]);
}

async function recognizePendingBoxes() {
  const pending = detections.filter((d) => d.score == null && !d.attempted);
  if (pending.length === 0) return;

  setStatusMessage(`Recognizing ${pending.length} box(es)…`);
  recognizePendingBtn.disabled = true;
  try {
    await Promise.all(pending.map(recognizeOneBox));
    const stillPending = pending.filter((d) => d.score == null).length;
    setStatusMessage(
      stillPending > 0
        ? `Recognized ${pending.length - stillPending} of ${pending.length}; ${stillPending} found no text`
        : `Recognized all ${pending.length} box(es)`,
    );
  } finally {
    updateButtons();
    redraw();
  }
}
recognizePendingBtn.addEventListener("click", recognizePendingBoxes);

function renderResultsList() {
  resultsEl.innerHTML = "";
  for (const d of detections) {
    const li = document.createElement("li");
    const label = d.score != null
      ? `${d.text}  (score ${d.score.toFixed(3)})`
      : d.attempted ? "(no text found in that box)" : "(unrecognized — not yet run through OCR)";
    li.textContent = label;
    li.style.color = colorFor(d);
    li.style.cursor = "pointer";
    li.style.fontWeight = d.id === selectedId ? "bold" : "normal";
    li.addEventListener("click", () => {
      selectedId = selectedId === d.id ? null : d.id;
      updateButtons();
      redraw();
    });
    resultsEl.appendChild(li);
  }
}

function setStatusMessage(msg) {
  const meta = full
    ? `${full.width}×${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`
    : "";
  statusEl.textContent = meta ? `${meta} — ${msg}` : msg;
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
