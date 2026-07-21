// Shared boot and gesture helpers for browser specs, factored out once a
// second spec needed the same setup tiling.spec.mjs already had. Each spec
// still writes its own /ocr stub inline where it needs one: what a stub
// should return differs enough between specs (success vs failure, per-tile
// text) that a shared, parameterized version would hide more than it saves.

const DEFAULT_PHOTO_W = 900;
const DEFAULT_PHOTO_H = 650;

// Boots ocr.html with a clean IndexedDB session and known localStorage.
// Always reloads after clearing storage: ocr.js resolves TILE_SIZE once at
// module load, so a tile-size override must be in place before that happens.
async function bootApp(page, origin, { tileSize } = {}) {
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
}

// Builds a photo in the page rather than shipping a fixture file: the canvas
// encodes the PNG, so the repo needs no binary test asset.
async function loadSyntheticPhoto(
  page, { w = DEFAULT_PHOTO_W, h = DEFAULT_PHOTO_H, text = "M7270", name = "synthetic.png" } = {},
) {
  await page.evaluate(`
    (async () => {
      const c = document.createElement("canvas");
      c.width = ${w};
      c.height = ${h};
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#000";
      g.font = "48px sans-serif";
      g.fillText(${JSON.stringify(text)}, 40, 90);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: "image/png" }));
      const input = document.getElementById("file");
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    })()
  `);
  await page.waitFor(`!document.getElementById("runOcr").disabled`, "photo to load");
}

async function stageRect(page) {
  return JSON.parse(await page.evaluate(`
    (() => {
      const r = document.getElementById("stage").getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    })()
  `));
}

// Drag in fractions of the stage, so a gesture is independent of layout.
// >= CLICK_THRESHOLD_PX of movement, so this always reads as a drag, never a
// click -- use clickFrac() for the latter.
async function dragFrac(page, rect, fx0, fy0, fx1, fy1) {
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

// A press-release at the same point, with no movement in between -- what the
// app's own CLICK_THRESHOLD_PX distinguishes from a drag (select/deselect,
// rather than draw/move/resize).
async function clickFrac(page, rect, fx, fy) {
  const x = rect.x + rect.w * fx;
  const y = rect.y + rect.h * fy;
  const opts = { x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...opts });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...opts });
}

const scanIdle = (page) => page.waitFor(
  `document.getElementById("cancelScan").disabled`, "scan to finish");

// The persisted session is the only place box geometry and recognition state
// are observable from outside the module -- ocr.js keeps `detections` in
// closure scope, never on `window`.
async function readState(page) {
  return JSON.parse(await page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 1);
      req.onsuccess = () => {
        const g = req.result.transaction("session", "readonly").objectStore("session").get("state");
        g.onsuccess = () => resolve(JSON.stringify(g.result ?? null));
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    })
  `));
}

async function readImageName(page) {
  return page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 1);
      req.onsuccess = () => {
        const g = req.result.transaction("session", "readonly").objectStore("session").get("image");
        g.onsuccess = () => resolve(g.result?.name ?? null);
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    })
  `);
}

function boundsOf(box) {
  return {
    minX: Math.min(...box.map((p) => p[0])), maxX: Math.max(...box.map((p) => p[0])),
    minY: Math.min(...box.map((p) => p[1])), maxY: Math.max(...box.map((p) => p[1])),
  };
}

export {
  bootApp, loadSyntheticPhoto, stageRect, dragFrac, clickFrac, scanIdle,
  readState, readImageName, boundsOf,
};
