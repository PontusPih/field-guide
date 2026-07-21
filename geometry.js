// Pure view-transform, hit-testing, and box math for the pan/zoom/box-edit
// canvas. Kept dependency-free from the DOM so it's testable with
// `node --test`. Region tiling for the OCR backend lives in tiling.js.

// view: { scale, x, y, offsetX?, offsetY? } — scale = display px per source
// px; x/y = source-space px shown at display (offsetX, offsetY). offsetX/Y
// default to 0 (the canvas-filling case) when absent — the letterbox offset
// applied when the rendered image doesn't fill the canvas on that axis
// (e.g. "fit" zoom on an image whose aspect ratio differs from the canvas's).
function toSource(displayPoint, view) {
  const offsetX = view.offsetX || 0;
  const offsetY = view.offsetY || 0;
  return {
    x: view.x + (displayPoint.x - offsetX) / view.scale,
    y: view.y + (displayPoint.y - offsetY) / view.scale,
  };
}

function toDisplay(sourcePoint, view) {
  const offsetX = view.offsetX || 0;
  const offsetY = view.offsetY || 0;
  return {
    x: (sourcePoint.x - view.x) * view.scale + offsetX,
    y: (sourcePoint.y - view.y) * view.scale + offsetY,
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

// Axis-aligned bounding box of a (possibly tilted) box's corner points.
function boundsOf(box) {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  return {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
}

// Overlap area between two axis-aligned bounds; 0 if they don't intersect.
function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return w * h;
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

// Greedy highest-score-first selection: keep an item unless its box's bounds
// overlap one already kept. `items` is any array of `{box, score}` (score may
// be null/undefined, ranked lowest). Backs ocr.js's "Prune overlapping".
function selectNonOverlapping(items) {
  const sorted = [...items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const kept = [];
  for (const item of sorted) {
    const bounds = boundsOf(item.box);
    const overlapsKept = kept.some((k) => overlapArea(bounds, boundsOf(k.box)) > 0);
    if (!overlapsKept) kept.push(item);
  }
  return kept;
}

export {
  toSource, toDisplay, pointInPolygon, hitTestBoxes, distance, nearestWithinRadius,
  boundsOf, overlapArea, selectNonOverlapping,
};
