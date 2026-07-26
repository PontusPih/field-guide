// Spec for the multi-file batch-load flow (PLAN.md, "Multi-image workflow"):
// selecting several files at once loads them into one batch: hash every
// file, reattach ground truth for one the ledger already knows about, purge
// the outgoing batch's pixels (bounding storage to one batch's worth), and
// leave the ledger itself untouched across the swap.
//
// No image-switcher UI exists yet (a follow-up step), so a loaded-but-not-
// active image is only observable through IndexedDB directly -- see
// fixtures.mjs's readAllLabels()/readImageStoreKeys().
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

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
