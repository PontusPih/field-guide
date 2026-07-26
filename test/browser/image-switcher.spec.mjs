// Spec for the image-switcher UI (image-switcher.js, PLAN.md "Multi-image
// workflow"): lists every image in the current batch as a row of chips,
// highlights the active one, switches on click, disables switching while a
// scan is in flight (v1 keeps scanning exclusive to the active image -- see
// scan.js), and shows a running "N board(s) across M image(s)" summary.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import {
  bootApp, loadSyntheticPhoto, loadSyntheticPhotos, stageRect, dragFrac, scanIdle,
} from "./fixtures.mjs";

const chromePath = await findChrome();

// Delays every stubbed /ocr response, matching scan-lifecycle.spec.mjs's own
// helper -- long enough that a scan is reliably still in flight when the
// test tries (and must fail) to switch images mid-scan.
async function stubOcrDelayed(page, delayMs = 300) {
  await page.evaluate(`
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (!String(url).includes("/ocr")) return realFetch(url, opts);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify([]), {
            status: 200, headers: { "content-type": "application/json" },
          }));
        }, ${delayMs});
      });
    };
    true
  `);
}

const chipNames = (page) => page.evaluate(`
  JSON.stringify([...document.querySelectorAll(".switcher-chip .switcher-name")].map((el) => el.textContent))
`).then(JSON.parse);

const activeChipName = (page) => page.evaluate(
  `document.querySelector(".switcher-chip.active .switcher-name")?.textContent ?? null`);

const summaryText = (page) => page.evaluate(`document.getElementById("imageSwitcherSummary").textContent`);

describe("image switcher", { skip: chromePath ? false : "no Chrome found" }, () => {
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

  test("lists every image in the batch as a chip, with the active one highlighted", async () => {
    await loadSyntheticPhotos(page, [
      { name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }, { name: "c.png", text: "CCC" },
    ]);

    assert.deepEqual(await chipNames(page), ["a.png", "b.png", "c.png"]);
    assert.equal(await activeChipName(page), "a.png", "the first selected image should be active");
  });

  test("clicking a chip switches the active image", async () => {
    await loadSyntheticPhotos(page, [{ name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }]);
    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35); // a box on a.png, the active image
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn on a.png");

    await page.evaluate(`
      [...document.querySelectorAll(".switcher-chip")]
        .find((li) => li.querySelector(".switcher-name").textContent === "b.png")
        .click();
      true
    `);

    assert.equal(await activeChipName(page), "b.png");
    assert.equal(await page.evaluate(`document.querySelectorAll("#results li").length`), 0,
      "the results list should now show b.png's (empty) boxes, not a.png's");

    // The switch is persisted, not just an in-memory view change --
    // switchActiveImage()'s own persistBatchMeta() isn't awaited by the
    // click handler (fire-and-forget, like every other persist here), so
    // poll for it rather than checking immediately.
    await page.waitFor(`
      new Promise((resolve, reject) => {
        const req = indexedDB.open("field-guide-scan", 2);
        req.onsuccess = () => {
          const g = req.result.transaction("batch", "readonly").objectStore("batch").get("current");
          g.onsuccess = () => {
            const active = g.result?.active;
            if (!active) { resolve(false); return; }
            const ig = req.result.transaction("images", "readonly").objectStore("images").get(active);
            ig.onsuccess = () => resolve(ig.result?.name === "b.png");
            ig.onerror = () => reject(ig.error);
          };
          g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
      })
    `, "batch to persist b.png as active");
  });

  test("switching to a never-before-viewed image renders it correctly -- rotate and scan both work",
    async () => {
      // Loading a.png + b.png in one selection only computes a.png's
      // offscreen `full` canvas (renderActiveView() runs for whichever image
      // is active *at that instant* -- only the first-selected one). b.png
      // starts with full: null and, before the fix, stayed that way forever:
      // a blank canvas, a silent no-op "OCR full photo", and an uncaught
      // TypeError ("active.full is null") from rotate().
      await loadSyntheticPhotos(page, [{ name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }]);
      await page.evaluate(`
        [...document.querySelectorAll(".switcher-chip")]
          .find((li) => li.querySelector(".switcher-name").textContent === "b.png")
          .click();
        true
      `);
      assert.equal(await activeChipName(page), "b.png");

      const errorsBeforeRotate = page.consoleErrors.length;
      await page.evaluate(`document.getElementById("rotateLeft").click(); true`);
      assert.equal(page.consoleErrors.length, errorsBeforeRotate,
        "rotating the newly-switched-to image must not throw");

      await page.evaluate(`
        window.__ocrCalls = 0;
        const realFetch = window.fetch.bind(window);
        window.fetch = (url, opts) => {
          if (!String(url).includes("/ocr")) return realFetch(url, opts);
          window.__ocrCalls++;
          return Promise.resolve(new Response(JSON.stringify([]), {
            status: 200, headers: { "content-type": "application/json" },
          }));
        };
        document.getElementById("runOcr").click();
        true
      `);
      await scanIdle(page);
      assert.equal(await page.evaluate("window.__ocrCalls"), 1,
        "OCR full photo must actually scan the newly-active image, not silently no-op");
    });

  test("switching is disabled while a scan is in flight, and re-enabled once it finishes", async () => {
    await loadSyntheticPhotos(page, [{ name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }]);
    await stubOcrDelayed(page);

    await page.evaluate(`document.getElementById("runOcr").click(); true`);
    await page.waitFor(`document.getElementById("cancelScan").disabled === false`, "scan to start");

    await page.evaluate(`
      [...document.querySelectorAll(".switcher-chip")]
        .find((li) => li.querySelector(".switcher-name").textContent === "b.png")
        .click();
      true
    `);
    assert.equal(await activeChipName(page), "a.png",
      "clicking another chip mid-scan must not switch the active image");

    await scanIdle(page);
    await page.evaluate(`
      [...document.querySelectorAll(".switcher-chip")]
        .find((li) => li.querySelector(".switcher-name").textContent === "b.png")
        .click();
      true
    `);
    assert.equal(await activeChipName(page), "b.png", "switching should work again once the scan finishes");
  });

  test("the summary counts boards across the whole batch, not just the active image", async () => {
    await loadSyntheticPhoto(page, { name: "a.png", text: "AAA" });
    assert.equal(await summaryText(page), "0 board(s) across 1 image(s)");

    const rect = await stageRect(page);
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
    await page.evaluate(`
      document.querySelector("#results .result-label").click();
      const input = document.querySelector("#results input.label-edit");
      input.value = "M8295";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      true
    `);
    await page.waitFor(`document.querySelector("#results .result-label")?.textContent === "M8295"`, "label committed");
    assert.equal(await summaryText(page), "1 board(s) across 1 image(s)");

    // A second, unlabelled image joins the batch -- the image count grows,
    // the board count doesn't (its own boxes carry no text yet).
    await loadSyntheticPhotos(page, [{ name: "a.png", text: "AAA" }, { name: "b.png", text: "BBB" }]);
    assert.equal(await summaryText(page), "1 board(s) across 2 image(s)",
      "a.png's labelled board should reattach and still count, alongside the newly-added, unlabelled b.png");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
