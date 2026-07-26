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
  // ocr.js's fileInput handler enables the UI synchronously but hashes and
  // persists the batch (images/labels/batch stores) afterward, unawaited --
  // the same fire-and-forget precedent as the old single-slot persistImage().
  // A test that reads IndexedDB directly right after this resolves (e.g. to
  // seed detections by sha256, see list-actions/interaction/label-editing
  // specs) would otherwise race that write, so wait for it to actually land
  // rather than trusting the visual cue alone.
  //
  // Checks the *active* label's filename matches this call's own `name`, not
  // just "batch.active is truthy": a second loadSyntheticPhoto() in the same
  // test would otherwise see the *previous* call's already-truthy `active`
  // and return immediately, before this call's own persistBatchMeta()/
  // persistLabel() writes have actually landed -- a real bug this exact
  // check caught once (see PLAN.md/session notes: readImageName() resolved
  // null for a second-loaded photo because the wait resolved on stale data).
  // ocr.js awaits replaceImages() -> persistBatchMeta() -> persistLabel() in
  // that order, so the label write landing guarantees the other two did too.
  await page.waitFor(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const db = req.result;
        const bg = db.transaction("batch", "readonly").objectStore("batch").get("current");
        bg.onsuccess = () => {
          const active = bg.result?.active;
          if (!active) { resolve(false); return; }
          const lg = db.transaction("labels", "readonly").objectStore("labels").get(active);
          lg.onsuccess = () => resolve(lg.result?.filename === ${JSON.stringify(name)});
          lg.onerror = () => reject(lg.error);
        };
        bg.onerror = () => reject(bg.error);
      };
      req.onerror = () => reject(req.error);
    })
  `, "batch to be persisted");
}

// Selects several photos in one go, as a real multi-file dialog selection
// would (one DataTransfer holding every File, one change event) -- unlike
// calling loadSyntheticPhoto() repeatedly, which is N separate batch loads,
// each replacing the last. `entries` is `[{ text, name, w, h }, …]`; unset
// fields fall back to loadSyntheticPhoto()'s own defaults.
async function loadSyntheticPhotos(page, entries) {
  await page.evaluate(`
    (async () => {
      const entries = ${JSON.stringify(entries)};
      const dt = new DataTransfer();
      for (const e of entries) {
        const c = document.createElement("canvas");
        c.width = e.w ?? ${DEFAULT_PHOTO_W};
        c.height = e.h ?? ${DEFAULT_PHOTO_H};
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "#000";
        g.font = "48px sans-serif";
        g.fillText(e.text ?? "M7270", 40, 90);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        dt.items.add(new File([blob], e.name ?? "synthetic.png", { type: "image/png" }));
      }
      const input = document.getElementById("file");
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    })()
  `);
  await page.waitFor(`!document.getElementById("runOcr").disabled`, "photos to load");
  // See loadSyntheticPhoto()'s comment for why this checks actual filenames,
  // not just order.length: a length match alone could coincidentally be true
  // from a *previous* load already in the DB (e.g. two 3-image batches in the
  // same test), resolving before this call's own writes land. Checking the
  // full, in-order filename list rules that out.
  const expectedNames = JSON.stringify(entries.map((e) => e.name ?? "synthetic.png"));
  await page.waitFor(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const db = req.result;
        const bg = db.transaction("batch", "readonly").objectStore("batch").get("current");
        bg.onsuccess = async () => {
          const order = bg.result?.order ?? [];
          const expected = ${expectedNames};
          if (order.length !== expected.length) { resolve(false); return; }
          const store = db.transaction("labels", "readonly").objectStore("labels");
          try {
            const names = await Promise.all(order.map((sha) => new Promise((res, rej) => {
              const g = store.get(sha);
              g.onsuccess = () => res(g.result?.filename);
              g.onerror = () => rej(g.error);
            })));
            resolve(JSON.stringify(names) === JSON.stringify(expected));
          } catch (err) { reject(err); }
        };
        bg.onerror = () => reject(bg.error);
      };
      req.onerror = () => reject(req.error);
    })
  `, "batch to be persisted with every image");
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

// The persisted batch is the only place box geometry and recognition state
// are observable from outside the module -- ocr.js keeps `state.images` in
// closure scope, never on `window`. Schema is session-store.js's three
// stores (images/labels/batch, see PLAN.md "Multi-image workflow"); every
// spec so far only ever loads one image, so this resolves the *active*
// image's ledger entry -- {filename, rotation, detections}, a superset of the
// old single-session shape, so existing `.detections`/`.rotation` assertions
// are unaffected by the schema change underneath.
async function readState(page) {
  return JSON.parse(await page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const db = req.result;
        const bg = db.transaction("batch", "readonly").objectStore("batch").get("current");
        bg.onsuccess = () => {
          const active = bg.result?.active;
          if (!active) { resolve(JSON.stringify(null)); return; }
          const lg = db.transaction("labels", "readonly").objectStore("labels").get(active);
          lg.onsuccess = () => resolve(JSON.stringify(lg.result ?? null));
          lg.onerror = () => reject(lg.error);
        };
        bg.onerror = () => reject(bg.error);
      };
      req.onerror = () => reject(req.error);
    })
  `));
}

// Reads the active image's stored File's own .name from the `images` store
// (not the `labels` store's plain filename string) -- proves the File object
// itself round-trips through IndexedDB, not just its bytes, since only a File
// (not a bare Blob) carries a name.
async function readImageName(page) {
  return page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const db = req.result;
        const bg = db.transaction("batch", "readonly").objectStore("batch").get("current");
        bg.onsuccess = () => {
          const active = bg.result?.active;
          if (!active) { resolve(null); return; }
          const ig = db.transaction("images", "readonly").objectStore("images").get(active);
          ig.onsuccess = () => resolve(ig.result?.name ?? null);
          ig.onerror = () => reject(ig.error);
        };
        bg.onerror = () => reject(bg.error);
      };
      req.onerror = () => reject(req.error);
    })
  `);
}

// Reads every image currently in the batch, in its saved order --
// `[{ sha256, filename, rotation, detections }, …]`. Unlike readState() (the
// *active* image only), this is for asserting on the whole batch: composition,
// order, and each image's own ground truth.
async function readAllLabels(page) {
  return JSON.parse(await page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const db = req.result;
        const bg = db.transaction("batch", "readonly").objectStore("batch").get("current");
        bg.onsuccess = () => {
          const order = bg.result?.order ?? [];
          const store = db.transaction("labels", "readonly").objectStore("labels");
          const results = new Array(order.length);
          let remaining = order.length;
          if (remaining === 0) { resolve(JSON.stringify([])); return; }
          order.forEach((sha256, i) => {
            const g = store.get(sha256);
            g.onsuccess = () => {
              results[i] = { sha256, ...g.result };
              if (--remaining === 0) resolve(JSON.stringify(results));
            };
            g.onerror = () => reject(g.error);
          });
        };
        bg.onerror = () => reject(bg.error);
      };
      req.onerror = () => reject(req.error);
    })
  `));
}

// The sha256 keys currently holding image bytes in the `images` store --
// bounded to the current batch's images only (replaceImages() replaces this
// store wholesale on every batch change), which is what keeps storage from
// accumulating across batches (see PLAN.md, "Multi-image workflow").
async function readImageStoreKeys(page) {
  return page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open("field-guide-scan", 2);
      req.onsuccess = () => {
        const g = req.result.transaction("images", "readonly").objectStore("images").getAllKeys();
        g.onsuccess = () => resolve(g.result);
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
  bootApp, loadSyntheticPhoto, loadSyntheticPhotos, stageRect, dragFrac, clickFrac, scanIdle,
  readState, readImageName, readAllLabels, readImageStoreKeys, boundsOf,
};
