// Unit tests for the OCR region tiling used by ocr.js.
// Run: `node --test` (or `node --test test/tiling.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisTiles, tileGrid, resolveTileSize,
  DEFAULT_DEV_TILE_SIZE, DEFAULT_PROD_TILE_SIZE,
} from "../tiling.js";

test("axisTiles: region within singleCellFactor of tile size stays one cell", () => {
  // 800 <= 736 * 1.4 (1030.4) -- the near-tile-sized degenerate case that
  // motivated this threshold in the first place (see PLAN.md).
  assert.deepEqual(axisTiles(800, 736), [{ start: 0, length: 800 }]);
});

test("axisTiles: a region smaller than the tile is also a single cell", () => {
  assert.deepEqual(axisTiles(200, 736), [{ start: 0, length: 200 }]);
});

test("axisTiles: last cell snaps to the far edge, never a sliver", () => {
  const cells = axisTiles(1800, 736, { overlapFrac: 0.15 });
  assert.equal(cells.length, 3);
  assert.equal(cells[0].start, 0);
  assert.equal(cells[cells.length - 1].start + cells[cells.length - 1].length, 1800);
  for (const c of cells) assert.equal(c.length, 736); // every cell is full-size
});

test("axisTiles: cells step by tile * (1 - overlapFrac) until the snapped last one", () => {
  const cells = axisTiles(3000, 736, { overlapFrac: 0.15 });
  const step = Math.floor(736 * 0.85);
  for (let i = 0; i < cells.length - 2; i++) {
    assert.equal(cells[i + 1].start - cells[i].start, step);
  }
});

test("tileGrid: small region is a single tile matching its own size", () => {
  assert.deepEqual(tileGrid(400, 300, 736), [[0, 0, 400, 300]]);
});

test("tileGrid: rows and columns computed independently (elongated region)", () => {
  // Wide and short: many columns, one row.
  const wide = tileGrid(3000, 400, 736);
  assert.ok(wide.every(([, y0, , y1]) => y0 === 0 && y1 === 400));
  assert.ok(wide.length > 1);

  // Tall and narrow: one column, many rows.
  const tall = tileGrid(400, 3000, 736);
  assert.ok(tall.every(([x0, , x1]) => x0 === 0 && x1 === 400));
  assert.ok(tall.length > 1);
});

test("tileGrid: large region tiles both axes and covers the full area", () => {
  const boxes = tileGrid(1800, 1800, 736, { overlapFrac: 0.15 });
  assert.equal(boxes.length, 9); // 3x3
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  assert.equal(maxX, 1800);
  assert.equal(maxY, 1800);
});

test("axisTiles: consecutive cells overlap, leaving no gap at any seam", () => {
  // A gap would drop any label straddling it -- the failure the overlap exists
  // to prevent, and one that only shows up as silently missing text.
  const cells = axisTiles(3000, 736, { overlapFrac: 0.15 });
  for (let i = 0; i < cells.length - 1; i++) {
    const endOfThis = cells[i].start + cells[i].length;
    assert.ok(cells[i + 1].start < endOfThis,
      `cell ${i + 1} starts at ${cells[i + 1].start}, at or past ${endOfThis}`);
  }
});

test("axisTiles: the single-cell branch stays under the backend size gate", () => {
  // A single cell is sent as one request, so tile * singleCellFactor must stay
  // below the backend's OCR_MAX_DIMENSION (default 1200) or it is 413-rejected.
  const largestSingleCell = axisTiles(736 * 1.4, 736, { singleCellFactor: 1.4 });
  assert.equal(largestSingleCell.length, 1);
  assert.ok(largestSingleCell[0].length <= 1200,
    `single cell ${largestSingleCell[0].length}px exceeds the 1200px gate`);
});

test("axisTiles: just past the single-cell threshold, the region splits", () => {
  const factor = 1.4;
  assert.equal(axisTiles(736 * factor, 736, { singleCellFactor: factor }).length, 1);
  assert.ok(axisTiles(736 * factor + 1, 736, { singleCellFactor: factor }).length > 1);
});

test("axisTiles: an Infinity tile size never splits, at any region size", () => {
  // This is what the dev default does -- and why the tiled path cannot be
  // reached in dev without the tile-size override.
  assert.deepEqual(axisTiles(100000, Infinity), [{ start: 0, length: 100000 }]);
});

test("resolveTileSize: dev and prod defaults with no override", () => {
  assert.equal(resolveTileSize({ isLocalDev: true, storedOverride: null }), DEFAULT_DEV_TILE_SIZE);
  assert.equal(resolveTileSize({ isLocalDev: false, storedOverride: null }), DEFAULT_PROD_TILE_SIZE);
});

test("resolveTileSize: a numeric override wins over either default", () => {
  assert.equal(resolveTileSize({ isLocalDev: true, storedOverride: "300" }), 300);
  assert.equal(resolveTileSize({ isLocalDev: false, storedOverride: "300" }), 300);
});

test("resolveTileSize: junk and non-positive overrides fall back to the default", () => {
  // Trusting these would disable tiling silently rather than loudly.
  for (const bad of ["", "abc", "0", "-5", null, undefined]) {
    assert.equal(resolveTileSize({ isLocalDev: false, storedOverride: bad }),
      DEFAULT_PROD_TILE_SIZE, `override ${JSON.stringify(bad)} should be ignored`);
  }
});
