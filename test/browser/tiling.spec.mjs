// Browser spec: does a scan actually tile the region it is given?
//
// tiling.test.js covers the grid math. This covers the wiring the math cannot
// reach -- that ocr.js passes the right region and the resolved TILE_SIZE into
// tileBoxesFor, issues one request per tile, and reassembles a manual region's
// tiles into a single result. All of that is only reachable through a real
// canvas and real pointer events.
//
// /ocr is stubbed in the page. The backend is not under test here: what is
// under test is how many requests the client makes and what it does with the
// answers, which a real backend would only make nondeterministic.
//
// Run: `npm run test:browser`

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import { tileGrid } from "../../tiling.js";

// Same aspect ratio as the canvas viewport (MAX_VIEWPORT_W/H in ocr.js), so
// the image fills the canvas and no letterboxing shifts pointer coordinates.
const PHOTO_W = 1800;
const PHOTO_H = 1300;
const TILE_OVERRIDE = 300;

const chromePath = await findChrome();

describe("scan tiling", { skip: chromePath ? false : "no Chrome found" }, () => {
  let browser;
  let page;
  let origin;

  before(async () => {
    browser = await launch();
    page = browser.page;
    origin = browser.origin;
  });

  after(async () => {
    await browser?.close();
  });

  // Boots the app with a known tile size, a clean session, and a stubbed /ocr.
  // The tile size must be in localStorage before the reload, since ocr.js
  // resolves TILE_SIZE once at module load.
  async function boot({ tileSize }) {
    await page.goto(`${origin}/ocr.html`);
    await page.evaluate(`
      (async () => {
        localStorage.clear();
        ${tileSize == null ? "" : `localStorage.setItem("fieldGuideTileSize", "${tileSize}");`}
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase("field-guide-scan");
          req.onsuccess = req.onerror = req.onblocked = resolve;
        });
      })()
    `);
    await page.goto(`${origin}/ocr.html`);
    await page.waitFor(`!!document.getElementById("runOcr")`, "app boot");

    // Every tile returns exactly one detection, numbered by request order. A
    // region's detection count must then equal its request count -- which is
    // what makes "waited for every tile before splicing" observable. Returning
    // text from only the first tile does not: a region that resolves early
    // still shows one result, so the bug reads as success.
    await page.evaluate(`
      window.__ocrCalls = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (!String(url).includes("/ocr")) return realFetch(url, opts);
        const n = ++window.__ocrCalls;
        const found = [{
          box: [[10, 10], [60, 10], [60, 30], [10, 30]],
          text: "M7270-" + n,
          score: 0.95,
        }];
        return Promise.resolve(new Response(JSON.stringify(found), {
          status: 200, headers: { "content-type": "application/json" },
        }));
      };
      true
    `);

    await loadSyntheticPhoto();
  }

  // Builds the photo in the page rather than shipping a fixture: the canvas
  // encodes the PNG, so the repo needs no binary test asset.
  async function loadSyntheticPhoto() {
    await page.evaluate(`
      (async () => {
        const c = document.createElement("canvas");
        c.width = ${PHOTO_W};
        c.height = ${PHOTO_H};
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "#000";
        g.font = "64px sans-serif";
        g.fillText("M7270", 120, 240);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "synthetic.png", { type: "image/png" }));
        const input = document.getElementById("file");
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      })()
    `);
    await page.waitFor(`!document.getElementById("runOcr").disabled`, "photo to load");
  }

  const scanIdle = () => page.waitFor(
    `document.getElementById("cancelScan").disabled`, "scan to finish");

  async function stageRect() {
    return JSON.parse(await page.evaluate(`
      (() => {
        const r = document.getElementById("stage").getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
      })()
    `));
  }

  // Drag in fractions of the stage, so the gesture is independent of layout.
  async function dragFrac(rect, fx0, fy0, fx1, fy1) {
    const px = (f) => rect.x + rect.w * f;
    const py = (f) => rect.y + rect.h * f;
    const at = (type, x, y) => page.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
    });
    await at("mousePressed", px(fx0), py(fy0));
    await at("mouseMoved", px((fx0 + fx1) / 2), py((fy0 + fy1) / 2));
    await at("mouseMoved", px(fx1), py(fy1));
    await at("mouseReleased", px(fx1), py(fy1));
  }

  test("dev default sends one request for the whole photo, however large", async () => {
    await boot({ tileSize: null }); // 127.0.0.1 -> the Infinity dev default
    await page.evaluate(`document.getElementById("runOcr").click(); true`);
    await scanIdle();
    assert.equal(await page.evaluate("window.__ocrCalls"), 1,
      "the Infinity dev default should keep any region a single cell");
  });

  test("a tile-size override splits the whole photo into one request per tile",
    async () => {
      await boot({ tileSize: TILE_OVERRIDE });
      const expected = tileGrid(PHOTO_W, PHOTO_H, TILE_OVERRIDE, {
        overlapFrac: 0.15, singleCellFactor: 1.4,
      }).length;
      assert.ok(expected > 1, "test setup: the override must actually cause tiling");

      await page.evaluate(`document.getElementById("runOcr").click(); true`);
      await scanIdle();

      assert.equal(await page.evaluate("window.__ocrCalls"), expected,
        `whole-photo scan should issue one request per tile of ${PHOTO_W}x${PHOTO_H}`);
    });

  test("a manual box larger than a tile is split, and every tile's result is kept",
    async () => {
      await boot({ tileSize: TILE_OVERRIDE });
      const rect = await stageRect();

      await dragFrac(rect, 0.15, 0.15, 0.85, 0.85);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`,
        "the drawn box to appear");

      await page.evaluate(`document.getElementById("recognizePending").click(); true`);
      await scanIdle();

      const calls = await page.evaluate("window.__ocrCalls");
      assert.ok(calls > 1, `a box spanning most of the photo should tile, got ${calls} request(s)`);

      const labels = JSON.parse(await page.evaluate(`
        JSON.stringify([...document.querySelectorAll("#results .result-label")]
          .map((el) => el.textContent.trim()))
      `));

      // One detection per tile, and the placeholder gone: a region that
      // resolved before its last tile reported would land short of `calls`.
      assert.equal(labels.length, calls,
        `expected one result per tile (${calls}), got ${labels.length}`);
      assert.ok(labels.every((l) => /M7270-\d+/.test(l)),
        `every result should carry recognized text, got ${JSON.stringify(labels)}`);
      assert.ok(!labels.some((l) => /not yet recognized/.test(l)),
        "the placeholder should have been replaced, not left pending");
    });

  test("no page errors were logged during any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
