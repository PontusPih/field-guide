// Spec for the multi-file batch-load flow (PLAN.md, "Multi-image workflow"):
// selecting several files at once loads them into one batch: hash every
// file, reattach ground truth for one the ledger already knows about, purge
// the outgoing batch's pixels (bounding storage to one batch's worth), and
// leave the ledger itself untouched across the swap. Also covers the guide
// handoff's union across the whole batch, the payoff of the feature -- the
// image-switcher (image-switcher.spec.mjs) is what makes a loaded-but-not-
// active image reachable through the UI; this file also reads it directly
// through IndexedDB (readAllLabels()/readImageStoreKeys()) where that's
// simpler than driving the switcher.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import {
  bootApp, loadSyntheticPhoto, loadSyntheticPhotos, stageRect, dragFrac,
  readState, readImageName, readAllLabels, readImageStoreKeys,
} from "./fixtures.mjs";

const chromePath = await findChrome();

describe("multi-image batch loading", { skip: chromePath ? false : "no Chrome found" }, () => {
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

  beforeEach(async () => {
    await bootApp(page, origin, {});
  });

  test("selecting several files at once loads them all into one batch, with the first active", async () => {
    await loadSyntheticPhotos(page, [
      { name: "a.png", text: "AAA" },
      { name: "b.png", text: "BBB" },
      { name: "c.png", text: "CCC" },
    ]);

    const labels = await readAllLabels(page);
    assert.equal(labels.length, 3, "all three images should be in the batch");
    assert.deepEqual(labels.map((l) => l.filename), ["a.png", "b.png", "c.png"],
      "batch order should match selection order");

    assert.equal(await readImageName(page), "a.png",
      "the first selected image should be the active one");
  });

  test("re-selecting a previously-loaded image reattaches its ground truth from the ledger",
    async () => {
      // Load image A alone and label a box on it.
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });
      const rect = await stageRect(page);
      await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
      const boxBeforeSwitch = (await readState(page)).detections[0].box;

      // Switch entirely to a different batch -- A is no longer loaded at all.
      await loadSyntheticPhoto(page, { name: "B.png", text: "B-TEXT" });
      assert.equal(await readImageName(page), "B.png", "test setup: A should no longer be active");

      // Re-select A. Same name/text -> canvas renders byte-identical PNGs ->
      // the same sha256 -> the same ledger entry.
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });

      assert.equal(await readImageName(page), "A.png");
      const restored = await readState(page);
      assert.equal(restored.detections.length, 1,
        "the box drawn on A before switching away should have reattached");
      assert.deepEqual(restored.detections[0].box, boxBeforeSwitch);
    });

  test("loading a new batch purges the outgoing batch's image bytes, but not its ledger entry",
    async () => {
      await loadSyntheticPhoto(page, { name: "A.png", text: "A-TEXT" });
      const rect = await stageRect(page);
      await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
      await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
      const labelsWithA = await readAllLabels(page);
      assert.equal(labelsWithA.length, 1);
      const shaOfA = labelsWithA[0].sha256;
      const keysWithA = await readImageStoreKeys(page);
      assert.ok(keysWithA.includes(shaOfA), "test setup: A's bytes should be in the images store");

      await loadSyntheticPhoto(page, { name: "B.png", text: "B-TEXT" });

      const keysAfterB = await readImageStoreKeys(page);
      assert.ok(!keysAfterB.includes(shaOfA),
        "A's bytes should be purged once it's no longer part of the loaded batch");

      // A's ground truth is still in the permanent ledger, findable by its
      // content hash, even though its pixels are gone.
      const stillLabeled = await page.evaluate(`
        new Promise((resolve, reject) => {
          const req = indexedDB.open("field-guide-scan", 2);
          req.onsuccess = () => {
            const g = req.result.transaction("labels", "readonly").objectStore("labels")
              .get(${JSON.stringify(shaOfA)});
            g.onsuccess = () => resolve(g.result?.detections?.length ?? 0);
            g.onerror = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        })
      `);
      assert.equal(stillLabeled, 1, "A's labels ledger entry should survive the batch change");
    });

  test("the guide handoff unions labelled text across every image in the batch, not just the active one",
    async () => {
      await loadSyntheticPhotos(page, [{ name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }]);
      const [aEntry, bEntry] = await readAllLabels(page);

      // Seeds each image's ledger entry directly -- drawing/labeling through
      // the UI is covered elsewhere; this test is specifically about the
      // handoff's union, not how the labels got there.
      await page.evaluate(`
        (async () => {
          const req = indexedDB.open("field-guide-scan", 2);
          await new Promise((r) => { req.onsuccess = r; });
          const tx = req.result.transaction("labels", "readwrite");
          const store = tx.objectStore("labels");
          store.put({ filename: "a.png", rotation: 0, detections: [
            { id: 1, box: [[0, 0], [10, 0], [10, 10], [0, 10]], text: "M8295", score: 0.9, source: "auto" },
          ] }, ${JSON.stringify(aEntry.sha256)});
          store.put({ filename: "b.png", rotation: 0, detections: [
            { id: 1, box: [[0, 0], [10, 0], [10, 10], [0, 10]], text: "L0002", score: 0.85, source: "auto" },
          ] }, ${JSON.stringify(bEntry.sha256)});
          await new Promise((r) => { tx.oncomplete = r; });
        })()
      `);
      // Reload so ocr.js's in-memory state.images picks up both seeded labels.
      await page.goto(`${origin}/ocr.html`);
      await page.waitFor(`!!document.getElementById("runOcr")`, "app boot");
      await page.waitFor(`!document.getElementById("goToGuide").disabled`, "handoff enabled");

      // goToGuideBtn's handler writes sessionStorage then navigates to
      // guide.html, which consumes (removes) that key on its own boot -- so
      // reading it *after* navigation would race guide.js and likely see it
      // already gone. click() runs the whole handler synchronously before the
      // browser acts on the location.href assignment, so reading
      // sessionStorage in the same script, right after the click, reliably
      // sees the value this click just wrote.
      const handoff = await page.evaluate(`
        (() => {
          document.getElementById("goToGuide").click();
          return sessionStorage.getItem("fieldGuideScan");
        })()
      `);
      assert.equal(handoff, "M8295\nL0002",
        "the handoff should include b.png's label even though a.png is the active image");
    });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
