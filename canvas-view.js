// Canvas rendering and the view transform: paints the image, the tile-progress
// overlay, and the detection boxes (outline, numbered badge, hover/selected
// label, resize handles, delete-X) at the current pan/zoom, plus the zoom and
// clamp operations that change the view.
//
// Holds no module state: createCanvasView() binds the render/view functions
// to the shared `state`, the canvas element and its 2D context, the few
// drawing constants, and updateInfoLine() (called after a view change to refresh
// the zoom% in the info line). Returns the entry points the rest of the app
// calls by name; the draw* helpers stay private to the closure. `state.full`
// is the rotated source canvas everything is painted from.

import { toSource, toDisplay, boundsOf, cornersOf } from "./geometry.js";
import { colorFor, canvasLabelFor } from "./detections.js";

const SELECTED_COLOR = "#3498db";

export function createCanvasView({
  state,
  ctx,
  display,
  config: { MAX_SCALE, RESIZE_HANDLE_RADIUS, DELETE_HOTSPOT_RADIUS },
  updateInfoLine,
}) {

  // Letterbox offset centering the rendered image on any axis it doesn't fill
  // (e.g. "fit" zoom on an image whose aspect ratio differs from the
  // canvas's). toSource()/toDisplay() (geometry.js) read view.offsetX/offsetY,
  // so this must be recomputed any time view.scale changes.
  function updateViewOffsets() {
    const renderedW = state.full.width * state.view.scale;
    const renderedH = state.full.height * state.view.scale;
    state.view.offsetX = renderedW <= display.width ? (display.width - renderedW) / 2 : 0;
    state.view.offsetY = renderedH <= display.height ? (display.height - renderedH) / 2 : 0;
  }

  function clampView() {
    const visW = display.width / state.view.scale;
    const visH = display.height / state.view.scale;
    state.view.x = Math.min(Math.max(state.view.x, 0), Math.max(0, state.full.width - visW));
    state.view.y = Math.min(Math.max(state.view.y, 0), Math.max(0, state.full.height - visH));
  }

  function zoomTo(newScale, anchorDisplayPt) {
    newScale = Math.min(MAX_SCALE, Math.max(state.minScale, newScale));
    if (newScale === state.view.scale) return;
    const anchorSource = toSource(anchorDisplayPt, state.view);
    state.view.scale = newScale;
    updateViewOffsets(); // offsets depend on scale — recompute before inverting below
    state.view.x = anchorSource.x - (anchorDisplayPt.x - state.view.offsetX) / state.view.scale;
    state.view.y = anchorSource.y - (anchorDisplayPt.y - state.view.offsetY) / state.view.scale;
    clampView();
    updateInfoLine();
    redrawCanvas(); // view-only: no list content changed, nothing to persist
  }

  // Frames the box with 3x its own width/height as margin on each side, so the
  // visible region is 7x the box's size along each axis.
  function zoomToBox(detection) {
    if (!state.full) return;
    const b = boundsOf(detection.box);
    const boxW = b.maxX - b.minX;
    const boxH = b.maxY - b.minY;
    const targetW = boxW * 7;
    const targetH = boxH * 7;
    const centerX = (b.minX + b.maxX) / 2;
    const centerY = (b.minY + b.maxY) / 2;

    const scaleToFit = Math.min(display.width / targetW, display.height / targetH);
    state.view.scale = Math.min(MAX_SCALE, Math.max(state.minScale, scaleToFit));
    updateViewOffsets(); // offsets depend on scale — recompute before using below
    state.view.x = centerX - (display.width / 2 - state.view.offsetX) / state.view.scale;
    state.view.y = centerY - (display.height / 2 - state.view.offsetY) / state.view.scale;
    clampView();
    updateInfoLine();
  }

  function strokeBoxPath(box) {
    ctx.beginPath();
    box.forEach((pt, i) => {
      const d = toDisplay({ x: pt[0], y: pt[1] }, state.view);
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
    const isSelected = detection.id === state.selectedId;
    const isHovered = detection.id === state.hoverBoxId;
    const isPending = detection.score == null;
    const showFullLabel = isSelected || isHovered;

    strokeBoxPath(detection.box);
    ctx.setLineDash(isPending ? [6, 4] : []);
    ctx.lineWidth = isSelected ? 4 : 2;
    ctx.strokeStyle = isSelected ? SELECTED_COLOR : color;
    ctx.stroke();
    ctx.setLineDash([]);

    const topLeft = toDisplay({ x: detection.box[0][0], y: detection.box[0][1] }, state.view);
    if (showFullLabel) {
      drawLabelText(canvasLabelFor(detection), isSelected ? SELECTED_COLOR : color, topLeft);
    } else {
      drawLabelText(String(index + 1), color, topLeft);
    }
  }

  // Delete-X floats just above the box's top-center, in display space so it
  // tracks pan/zoom — clear of the corners, which are resize handles.
  function deleteHotspotDisplayPos(detection) {
    const b = boundsOf(detection.box);
    const topCenter = toDisplay({ x: (b.minX + b.maxX) / 2, y: b.minY }, state.view);
    return { x: topCenter.x, y: topCenter.y - 14 };
  }

  // A box's delete-X shows when it's hovered near or selected.
  function visibleDeleteHotspotIds() {
    const ids = new Set();
    if (state.selectedId != null) ids.add(state.selectedId);
    if (state.hoverDeleteId != null) ids.add(state.hoverDeleteId);
    return ids;
  }

  function selectedDetection() {
    return state.selectedId == null ? null : state.detections.find((d) => d.id === state.selectedId);
  }

  function drawResizeHandles() {
    const detection = selectedDetection();
    if (!detection) return;
    const bounds = boundsOf(detection.box);
    for (const corner of cornersOf(bounds)) {
      const p = toDisplay(corner, state.view);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = SELECTED_COLOR;
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

  function drawDeleteHotspot() {
    for (const id of visibleDeleteHotspotIds()) {
      const detection = state.detections.find((d) => d.id === id);
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
    for (const t of state.tileOverlay) {
      const p0 = toDisplay({ x: t.box[0], y: t.box[1] }, state.view);
      const p1 = toDisplay({ x: t.box[2], y: t.box[3] }, state.view);
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
    if (!state.full) return;
    ctx.clearRect(0, 0, display.width, display.height);
    // Clip the sampled source rect to the image's bounds; the destination rect
    // is drawn at view.offsetX/offsetY, centering the image in the leftover
    // space on whichever axis it doesn't fill.
    const visW = Math.min(state.full.width, display.width / state.view.scale);
    const visH = Math.min(state.full.height, display.height / state.view.scale);
    ctx.drawImage(state.full, state.view.x, state.view.y, visW, visH, state.view.offsetX, state.view.offsetY, visW * state.view.scale, visH * state.view.scale);

    if (state.tileOverlay.length > 0) drawTileOverlay();
    state.detections.forEach((d, i) => drawDetection(d, i));

    if (state.draftBox) {
      const p0 = toDisplay({ x: state.draftBox.x0, y: state.draftBox.y0 }, state.view);
      const p1 = toDisplay({ x: state.draftBox.x1, y: state.draftBox.y1 }, state.view);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.setLineDash([]);
    }

    drawDeleteHotspot();
    drawResizeHandles();
  }

  return {
    redrawCanvas, zoomTo, zoomToBox, updateViewOffsets, clampView,
    selectedDetection, deleteHotspotDisplayPos, visibleDeleteHotspotIds,
  };
}
