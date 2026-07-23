// Pointer, keyboard, and wheel interaction: turns input on the canvas into
// state changes and repaints.
//
// Gesture model:
//   - plain left-drag on empty canvas  -> draw a new box
//   - click (no real drag) on a box    -> select it (again to deselect)
//   - Ctrl+left-drag, or two-finger
//     scroll (wheel without ctrlKey)   -> pan
//   - pinch (wheel WITH ctrlKey)       -> zoom, anchored at the cursor
//   - Delete/Backspace                 -> remove the selected box
//
// createInteraction() attaches its own listeners (pointer/wheel on the canvas,
// keydown on window) and owns the drag-transient state as closure privates --
// nothing outside these handlers reads it. Everything else -- the shared
// state, the view operations, the flush callbacks -- arrives through the
// params.

import {
  toSource, toDisplay, hitTestBoxes, distance, nearestWithinRadius, pointInPolygon,
  boundsOf, cornersOf, resizedBounds, normalizedRectBox,
} from "./geometry.js";

export function createInteraction({
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
  updateMeta,
  applyEditedBox,
  deleteSelected,
}) {
  // Interaction-transient state, private to these handlers.
  let dragging = null; // null | "pan" | "draw" | "select-candidate" | "move" | "resize"
  let panStart = null; // { px, py, vx, vy }
  let selectCandidateId = null;
  let pointerDownDisplayPos = null;
  let editStartBounds = null; // { minX, minY, maxX, maxY }, source coords, at drag start
  let editStartSource = null; // pointer's source-space position at drag start (for "move")
  let resizeHandleIndex = null; // which corner (see cornersOf), for "resize"

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
    const hotspots = ids.map((id) => deleteHotspotDisplayPos(state.detections.find((d) => d.id === id)));
    const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
    if (idx < 0) return false;

    const hitId = ids[idx];
    state.detections = state.detections.filter((d) => d.id !== hitId);
    if (state.selectedId === hitId) state.selectedId = null;
    if (state.hoverDeleteId === hitId) state.hoverDeleteId = null;
    updateButtons();
    redraw();
    return true;
  }

  display.addEventListener("pointerdown", (e) => {
    if (!state.img) return;
    const p = pointerDisplayPos(e);
    if (tryDeleteAtClick(p)) return; // clicking a delete-X always wins

    display.setPointerCapture(e.pointerId);
    pointerDownDisplayPos = p;

    if (e.ctrlKey && e.button === 0) {
      dragging = "pan";
      panStart = { px: p.x, py: p.y, vx: state.view.x, vy: state.view.y };
      return;
    }

    const sp = toSource(p, state.view);

    if (state.selectedId != null) {
      const current = selectedDetection();
      if (current) {
        const bounds = boundsOf(current.box);
        const handlePositions = cornersOf(bounds).map((c) => toDisplay(c, state.view));
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

    const hitIndex = hitTestBoxes(sp, state.detections);
    if (hitIndex >= 0) {
      dragging = "select-candidate";
      selectCandidateId = state.detections[hitIndex].id;
    } else {
      dragging = "draw";
      state.draftBox = { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
    }
  });

  function updateHoverDelete(p) {
    const hotspots = state.detections.map(deleteHotspotDisplayPos);
    const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
    const newHoverId = idx >= 0 ? state.detections[idx].id : null;
    if (newHoverId !== state.hoverDeleteId) {
      state.hoverDeleteId = newHoverId;
      return true;
    }
    return false;
  }

  function updateHoverBox(p) {
    const sp = toSource(p, state.view);
    const idx = hitTestBoxes(sp, state.detections);
    const newHoverId = idx >= 0 ? state.detections[idx].id : null;
    if (newHoverId !== state.hoverBoxId) {
      state.hoverBoxId = newHoverId;
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
      state.view.x = panStart.vx - (p.x - panStart.px) / state.view.scale;
      state.view.y = panStart.vy - (p.y - panStart.py) / state.view.scale;
      clampView();
      updateMeta();
      redrawCanvas(); // view-only: no list content changed, nothing to persist
    } else if (dragging === "draw") {
      const sp = toSource(p, state.view);
      state.draftBox.x1 = sp.x;
      state.draftBox.y1 = sp.y;
      redrawCanvas();
    } else if (dragging === "move") {
      const sp = toSource(p, state.view);
      const dx = sp.x - editStartSource.x;
      const dy = sp.y - editStartSource.y;
      const b = editStartBounds;
      selectedDetection().box = normalizedRectBox({
        x0: b.minX + dx, y0: b.minY + dy, x1: b.maxX + dx, y1: b.maxY + dy,
      });
      redrawCanvas();
    } else if (dragging === "resize") {
      const sp = toSource(p, state.view);
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
        state.detections.push({
          id: state.nextId++,
          box: normalizedRectBox(state.draftBox),
          text: null,
          score: null,
          source: "manual",
        });
        state.selectedId = state.detections[state.detections.length - 1].id;
      } else {
        state.selectedId = null; // click on empty canvas: deselect
      }
      state.draftBox = null;
    } else if (dragging === "select-candidate") {
      state.selectedId = state.selectedId === selectCandidateId ? null : selectCandidateId;
      selectCandidateId = null;
    } else if (dragging === "move" || dragging === "resize") {
      const detection = selectedDetection();
      if (moved >= CLICK_THRESHOLD_PX) {
        if (detection) applyEditedBox(detection, detection.box);
      } else if (dragging === "move") {
        state.selectedId = null; // click (no real drag) on the selected box's body: deselect
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
    if (state.hoverDeleteId != null || state.hoverBoxId != null) {
      state.hoverDeleteId = null;
      state.hoverBoxId = null;
      redrawCanvas();
    }
  });

  display.addEventListener("wheel", (e) => {
    if (!state.img) return;
    e.preventDefault();
    const anchor = pointerDisplayPos(e);
    if (e.ctrlKey) {
      // Per-event factor scales with the gesture's own magnitude (deltaY), so a
      // trackpad's sparse early pinch events zoom less than a later fast burst.
      // Clamped so a large deltaY spike can't jump more than ~1.4x in one event.
      const factor = Math.max(0.7, Math.min(1.4, Math.exp(-e.deltaY * ZOOM_SENSITIVITY)));
      zoomTo(state.view.scale * factor, anchor);
    } else {
      state.view.x += e.deltaX / state.view.scale;
      state.view.y += e.deltaY / state.view.scale;
      clampView();
      updateMeta();
      redrawCanvas(); // view-only: no list content changed, nothing to persist
    }
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId != null) {
      e.preventDefault();
      deleteSelected();
    }
  });
}
