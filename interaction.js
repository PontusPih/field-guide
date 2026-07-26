// Pointer, keyboard, and wheel interaction: turns input on the canvas into
// state changes and repaints. Everything here operates on `state.active` --
// the currently-viewed image in the batch (see PLAN.md, "Multi-image
// workflow") -- never on any other image in `state.images`.
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
// params. `state.active` can be null (nothing loaded yet); every handler that
// can fire with no image loaded (pointermove/pointerleave/wheel/keydown) is
// guarded accordingly, since unlike `state` itself, `state.active` isn't
// always present.

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
  updateInfoLine,
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

  // Called only from pointerdown, after its own state.active?.img guard has
  // passed -- state.active is guaranteed non-null here.
  function tryDeleteAtClick(p) {
    const active = state.active;
    const ids = [...visibleDeleteHotspotIds()];
    if (ids.length === 0) return false;
    const hotspots = ids.map((id) => deleteHotspotDisplayPos(active.detections.find((d) => d.id === id)));
    const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
    if (idx < 0) return false;

    const hitId = ids[idx];
    active.detections = active.detections.filter((d) => d.id !== hitId);
    if (active.selectedId === hitId) active.selectedId = null;
    if (active.hoverDeleteId === hitId) active.hoverDeleteId = null;
    updateButtons();
    redraw();
    return true;
  }

  display.addEventListener("pointerdown", (e) => {
    if (!state.active?.img) return;
    const active = state.active;
    const p = pointerDisplayPos(e);
    if (tryDeleteAtClick(p)) return; // clicking a delete-X always wins

    display.setPointerCapture(e.pointerId);
    pointerDownDisplayPos = p;

    if (e.ctrlKey && e.button === 0) {
      dragging = "pan";
      panStart = { px: p.x, py: p.y, vx: active.view.x, vy: active.view.y };
      return;
    }

    const sp = toSource(p, active.view);

    if (active.selectedId != null) {
      const current = selectedDetection();
      if (current) {
        const bounds = boundsOf(current.box);
        const handlePositions = cornersOf(bounds).map((c) => toDisplay(c, active.view));
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

    const hitIndex = hitTestBoxes(sp, active.detections);
    if (hitIndex >= 0) {
      dragging = "select-candidate";
      selectCandidateId = active.detections[hitIndex].id;
    } else {
      dragging = "draw";
      active.draftBox = { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
    }
  });

  // Both hover helpers can run with no image loaded (mouse moving over an
  // empty canvas) -- the caller (pointermove) guards on state.active first.
  function updateHoverDelete(active, p) {
    const hotspots = active.detections.map(deleteHotspotDisplayPos);
    const idx = nearestWithinRadius(p, hotspots, DELETE_HOVER_RADIUS);
    const newHoverId = idx >= 0 ? active.detections[idx].id : null;
    if (newHoverId !== active.hoverDeleteId) {
      active.hoverDeleteId = newHoverId;
      return true;
    }
    return false;
  }

  function updateHoverBox(active, p) {
    const sp = toSource(p, active.view);
    const idx = hitTestBoxes(sp, active.detections);
    const newHoverId = idx >= 0 ? active.detections[idx].id : null;
    if (newHoverId !== active.hoverBoxId) {
      active.hoverBoxId = newHoverId;
      return true;
    }
    return false;
  }

  display.addEventListener("pointermove", (e) => {
    const p = pointerDisplayPos(e);

    if (!dragging) {
      const active = state.active;
      if (!active) return; // nothing loaded yet: no hover state to update
      const changedDelete = updateHoverDelete(active, p);
      const changedBox = updateHoverBox(active, p);
      if (changedDelete || changedBox) redrawCanvas();
      return;
    }

    // Every branch below only runs while dragging, which is only ever set
    // from pointerdown after its state.active?.img guard passed, so
    // state.active is guaranteed non-null here.
    const active = state.active;

    if (dragging === "pan") {
      active.view.x = panStart.vx - (p.x - panStart.px) / active.view.scale;
      active.view.y = panStart.vy - (p.y - panStart.py) / active.view.scale;
      clampView();
      updateInfoLine();
      redrawCanvas(); // view-only: no list content changed, nothing to persist
    } else if (dragging === "draw") {
      const sp = toSource(p, active.view);
      active.draftBox.x1 = sp.x;
      active.draftBox.y1 = sp.y;
      redrawCanvas();
    } else if (dragging === "move") {
      const sp = toSource(p, active.view);
      const dx = sp.x - editStartSource.x;
      const dy = sp.y - editStartSource.y;
      const b = editStartBounds;
      selectedDetection().box = normalizedRectBox({
        x0: b.minX + dx, y0: b.minY + dy, x1: b.maxX + dx, y1: b.maxY + dy,
      });
      redrawCanvas();
    } else if (dragging === "resize") {
      const sp = toSource(p, active.view);
      const bounds = resizedBounds(resizeHandleIndex, sp, editStartBounds);
      selectedDetection().box = normalizedRectBox(bounds);
      redrawCanvas();
    }
    // "select-candidate": no visual feedback until pointerup — a click selects
    // the box before its handles/body become draggable.
  });

  display.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    // dragging is only ever set from pointerdown after its own guard passed,
    // so state.active is guaranteed non-null throughout a drag.
    const active = state.active;
    const p = pointerDisplayPos(e);
    const moved = distance(p, pointerDownDisplayPos);

    if (dragging === "draw") {
      if (moved >= CLICK_THRESHOLD_PX) {
        active.detections.push({
          id: active.nextId++,
          box: normalizedRectBox(active.draftBox),
          text: null,
          score: null,
          source: "manual",
        });
        active.selectedId = active.detections[active.detections.length - 1].id;
      } else {
        active.selectedId = null; // click on empty canvas: deselect
      }
      active.draftBox = null;
    } else if (dragging === "select-candidate") {
      active.selectedId = active.selectedId === selectCandidateId ? null : selectCandidateId;
      selectCandidateId = null;
    } else if (dragging === "move" || dragging === "resize") {
      const detection = selectedDetection();
      if (moved >= CLICK_THRESHOLD_PX) {
        if (detection) applyEditedBox(detection, detection.box);
      } else if (dragging === "move") {
        active.selectedId = null; // click (no real drag) on the selected box's body: deselect
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
    const active = state.active;
    if (!active) return; // nothing loaded yet: no hover state to clear
    if (active.hoverDeleteId != null || active.hoverBoxId != null) {
      active.hoverDeleteId = null;
      active.hoverBoxId = null;
      redrawCanvas();
    }
  });

  display.addEventListener("wheel", (e) => {
    if (!state.active?.img) return;
    const active = state.active;
    e.preventDefault();
    const anchor = pointerDisplayPos(e);
    if (e.ctrlKey) {
      // Per-event factor scales with the gesture's own magnitude (deltaY), so a
      // trackpad's sparse early pinch events zoom less than a later fast burst.
      // Clamped so a large deltaY spike can't jump more than ~1.4x in one event.
      const factor = Math.max(0.7, Math.min(1.4, Math.exp(-e.deltaY * ZOOM_SENSITIVITY)));
      zoomTo(active.view.scale * factor, anchor);
    } else {
      active.view.x += e.deltaX / active.view.scale;
      active.view.y += e.deltaY / active.view.scale;
      clampView();
      updateInfoLine();
      redrawCanvas(); // view-only: no list content changed, nothing to persist
    }
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.active?.selectedId != null) {
      e.preventDefault();
      deleteSelected();
    }
  });
}
