"use strict";

// Pure view-transform and hit-testing math for the pan/zoom/box-edit canvas.
// Kept dependency-free from the DOM so it's testable with `node --test`.

// view: { scale, x, y } — scale = display px per source px;
// x/y = source-space px shown at display (0,0).
function toSource(displayPoint, view) {
  return {
    x: view.x + displayPoint.x / view.scale,
    y: view.y + displayPoint.y / view.scale,
  };
}

function toDisplay(sourcePoint, view) {
  return {
    x: (sourcePoint.x - view.x) * view.scale,
    y: (sourcePoint.y - view.y) * view.scale,
  };
}

// Standard ray-casting point-in-polygon test. `polygon` is an array of
// [x, y] pairs (closed implicitly — no need to repeat the first point).
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Topmost (last-drawn) box whose polygon contains the point, or -1.
function hitTestBoxes(sourcePoint, boxes) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (pointInPolygon(sourcePoint, boxes[i].box)) return i;
  }
  return -1;
}

// Euclidean distance — used to tell a "click" (no meaningful movement) from
// a completed drag on pointerup.
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Index of the candidate closest to `point` within `radius`, or -1 if none
// qualify. Used to decide which box's delete-X (if any) should light up.
function nearestWithinRadius(point, candidates, radius) {
  let bestIndex = -1;
  let bestDist = radius;
  candidates.forEach((c, i) => {
    const d = distance(point, c);
    if (d <= bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  });
  return bestIndex;
}

export { toSource, toDisplay, pointInPolygon, hitTestBoxes, distance, nearestWithinRadius };
