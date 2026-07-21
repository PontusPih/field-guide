// Splits a large OCR region into backend-sized tiles.
//
// Kept apart from geometry.js because this encodes the OCR backend's
// constraints -- how big a tile may be, how much neighbours must overlap so a
// label isn't lost at a seam -- and nothing about the canvas or how it is
// drawn. Pure and DOM-free, so it is testable with `node --test`.

const TILE_SIZE_STORAGE_KEY = "fieldGuideTileSize";
const DEFAULT_PROD_TILE_SIZE = 736;
// Infinity keeps every region a single cell (see axisTiles), so a dev scan
// sends one request covering the whole region -- pair with OCR_MAX_DIMENSION=0
// server-side.
const DEFAULT_DEV_TILE_SIZE = Infinity;

// Tile size in source px: a localStorage override wins, otherwise the dev or
// prod default. Takes `isLocalDev` rather than a hostname so this module needs
// no opinion on which hostnames count as local -- backend-config.js owns that
// list, and ocr.js passes the same answer to both.
//
// The override is what makes the tiled path reachable in dev, where it is
// otherwise unreachable at any region size:
//   `localStorage.setItem("fieldGuideTileSize", "300")`
// A non-numeric or non-positive override is ignored rather than trusted, since
// a bad value would otherwise disable tiling silently.
// `storedOverride` is null/undefined when absent (matches Storage.getItem()).
function resolveTileSize({ isLocalDev, storedOverride }) {
  const parsed = Number(storedOverride);
  if (storedOverride != null && storedOverride !== "" && parsed > 0) return parsed;
  return isLocalDev ? DEFAULT_DEV_TILE_SIZE : DEFAULT_PROD_TILE_SIZE;
}

// Start positions covering [0, total) with cells of size `tile`, splitting
// one axis of a large OCR region into tile-sized pieces (see PLAN.md, "Tiled
// scanning for large images").
//
// A `total` within `tile * singleCellFactor` returns one cell spanning the
// whole axis rather than splitting. Otherwise cells step by
// `tile * (1 - overlapFrac)`, and the last cell is snapped to end exactly at
// `total` -- so no axis produces a sliver smaller than `tile`, the larger
// final overlap absorbing the remainder instead.
function axisTiles(total, tile, { overlapFrac = 0.15, singleCellFactor = 1.4 } = {}) {
  if (total <= tile * singleCellFactor) {
    return [{ start: 0, length: total }];
  }
  const step = Math.max(1, Math.floor(tile * (1 - overlapFrac)));
  const starts = [];
  for (let s = 0; s <= total - tile; s += step) starts.push(s);
  if (starts[starts.length - 1] !== total - tile) starts.push(total - tile);
  return starts.map((start) => ({ start, length: tile }));
}

// Full 2D tile grid over a width x height region, each tile as
// [x0, y0, x1, y1] in the region's own local coordinates. Rows and columns
// are computed independently via axisTiles, so elongated regions (very wide
// or very tall) naturally get an asymmetric grid without special-casing.
function tileGrid(width, height, tile, opts = {}) {
  const xs = axisTiles(width, tile, opts);
  const ys = axisTiles(height, tile, opts);
  const boxes = [];
  for (const y of ys) {
    for (const x of xs) {
      boxes.push([x.start, y.start, x.start + x.length, y.start + y.length]);
    }
  }
  return boxes;
}

export {
  axisTiles, tileGrid, resolveTileSize,
  TILE_SIZE_STORAGE_KEY, DEFAULT_DEV_TILE_SIZE, DEFAULT_PROD_TILE_SIZE,
};
