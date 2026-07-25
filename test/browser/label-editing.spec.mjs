// Spec for hand-entered labels: typing/correcting a box's text from the results
// list. A manual label is authoritative and sticky -- it survives a geometry
// edit or any later rescan, because once labelled the box is only an
// approximate location, not a region to re-read. Board-label OCR is imperfect,
// so this is how the hasso/ set gets turned into ground truth (groundtruth.md).
//
// Detection fields are only observable through the persisted session
// (fixtures.mjs's readState) or the rendered DOM, as elsewhere in this suite.
//
// Run: `npm run test:browser`

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, findChrome } from "./harness.mjs";
import { bootApp, loadSyntheticPhoto, stageRect, dragFrac, readState } from "./fixtures.mjs";

const chromePath = await findChrome();

describe("hand-entered labels", { skip: chromePath ? false : "no Chrome found" }, () => {
  let browser;
  let page;
  let origin;
  let rect;

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
    await loadSyntheticPhoto(page);
    rect = await stageRect(page);
  });

  async function drawBox() {
    await dragFrac(page, rect, 0.15, 0.15, 0.45, 0.35);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "box drawn");
  }

  // Opens the row's editor (clicking the label) and commits `value` with Enter.
  // The dispatched keydown drives the same commit path a real Enter would.
  async function editLabel(value) {
    // Wrapped in an IIFE so its declarations don't leak into the execution
    // context's global scope -- a test may call this twice without a reload.
    await page.evaluate(`(() => {
      document.querySelector("#results .result-label").click();
      const input = document.querySelector("#results input.label-edit");
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
  }

  const labelText = () => page.evaluate(`document.querySelector("#results .result-label").textContent`);
  const statusGlyph = () => page.evaluate(`document.querySelector("#results .result-status").textContent`);
  const disabled = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`);

  test("typing a label marks the box manual, sets its text, and takes it out of pending", async () => {
    await drawBox();
    await editLabel("M8295");

    const d = (await readState(page)).detections[0];
    assert.equal(d.manual, true);
    assert.equal(d.text, "M8295");
    assert.equal(d.score, null);
    assert.match(await labelText(), /M8295/);
    assert.equal(await statusGlyph(), "✎", "a hand-entered label shows the pencil glyph");
    assert.equal(await disabled("recognizePending"), true,
      "a hand-labelled box is not pending recognition");
    assert.equal(await disabled("goToGuide"), false,
      "a hand-labelled box carries usable text, so it is exportable to the guide");
  });

  test("a manual label survives a move -- the box is only an approximate location", async () => {
    await drawBox();
    await editLabel("M8295"); // box stays selected through the list edit
    await dragFrac(page, rect, 0.30, 0.25, 0.55, 0.55); // drag its body = move

    const d = (await readState(page)).detections[0];
    assert.equal(d.text, "M8295", "moving a manual box must not clear its hand-entered label");
    assert.equal(d.manual, true);
  });

  test("Backspace while editing edits the text; it must not delete the selected box", async () => {
    await drawBox(); // leaves the box selected
    // Open the editor and focus its input, then send a real Backspace. It must
    // reach the input, not interaction.js's window keydown handler (which
    // deletes the selected box and has no input-focus guard).
    await page.evaluate(`(() => {
      document.querySelector("#results .result-label").click();
      const input = document.querySelector("#results input.label-edit");
      input.value = "M829X";
      return true;
    })()`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });

    assert.equal(await page.evaluate(`document.querySelectorAll("#results li").length`), 1,
      "the box must survive -- Backspace was consumed by the input, not the delete handler");
  });

  // Puts an OCR result on the drawn box by writing the persisted session and
  // reloading, since the scan path isn't exercised here.
  async function seedRecognized(text, score) {
    await page.evaluate(`(async () => {
      const req = indexedDB.open("field-guide-scan", 1);
      await new Promise((r) => { req.onsuccess = r; });
      const tx = req.result.transaction("session", "readwrite");
      const store = tx.objectStore("session");
      const g = store.get("state");
      await new Promise((r) => { g.onsuccess = r; });
      const state = g.result;
      state.detections[0].text = ${JSON.stringify(text)};
      state.detections[0].score = ${score};
      store.put(state, "state");
      await new Promise((r) => { tx.oncomplete = r; });
    })()`);
    await page.goto(`${origin}/ocr.html`);
    await page.waitFor(`document.querySelectorAll("#results li").length === 1`, "recognized box restored");
  }

  test("re-entering the detected text verbatim keeps the OCR result; a real change flips to manual",
    async () => {
      await drawBox();
      await seedRecognized("M8295", 0.9);

      await editLabel("M8295"); // same as detected -- must be a no-op
      let d = (await readState(page)).detections[0];
      assert.equal(d.score, 0.9, "confirming an OCR read verbatim must keep its score");
      assert.notEqual(d.manual, true);

      await editLabel("M8290"); // a genuine correction -- now manual
      d = (await readState(page)).detections[0];
      assert.equal(d.manual, true);
      assert.equal(d.text, "M8290");
      assert.equal(d.score, null);
    });

  test("an empty commit records a negative box (no label), which is not exportable", async () => {
    await drawBox();
    await editLabel("");

    const d = (await readState(page)).detections[0];
    assert.equal(d.manual, true);
    assert.equal(d.text, "");
    assert.match(await labelText(), /\(no label\)/);
    assert.equal(await disabled("goToGuide"), true,
      "a blank manual box carries no text, so there is nothing to export");
  });

  test("no page errors were logged across any of the above", () => {
    assert.deepEqual(page.consoleErrors, []);
  });
});
