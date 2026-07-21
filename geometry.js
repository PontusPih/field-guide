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

// Given which corner (see cornersOf) is dragged to source point `sp`, the
// resulting {x0,y0,x1,y1} — the opposite corner stays fixed.
// normalizedRectBox() handles the min/max swap if the drag crosses over it.
function resizedBounds(handleIndex, sp, startBounds) {
  const b = startBounds;
  switch (handleIndex) {
    case 0: return { x0: sp.x, y0: sp.y, x1: b.maxX, y1: b.maxY };
    case 1: return { x0: b.minX, y0: sp.y, x1: sp.x, y1: b.maxY };
    case 2: return { x0: b.minX, y0: b.minY, x1: sp.x, y1: sp.y };
    default: return { x0: sp.x, y0: b.minY, x1: b.maxX, y1: sp.y };
  }
}

// {x0,y0,x1,y1} in any corner order -> a four-corner box wound clockwise from
// the top-left, which is the shape every detection's `box` uses.
function normalizedRectBox(b) {
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export {
  toSource, toDisplay, pointInPolygon, hitTestBoxes, distance, nearestWithinRadius,
  boundsOf, overlapArea, cornersOf, resizedBounds, normalizedRectBox,
};
