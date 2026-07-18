"use strict";

// OCR crop tool — POC. Upload a photo, optionally rotate in 90-degree steps,
// zoom/pan to see small text clearly, then drag a box (in "Draw box" mode) to
// select the module-number region. Confirm extracts a full-resolution crop,
// preprocesses it, and runs Tesseract on it. The raw OCR text is then matched
// against the real ~1400 module numbers from field-guide-02.txt (edit
// distance) — a hard, exact-vocabulary check that catches and corrects
// misreads Tesseract's own confidence score doesn't.
//
// The crop box is stored in source-image coordinates (full-res, post-
// rotation), not display/canvas coordinates — so it stays correctly anchored
// to the same spot on the image if the user pans or zooms after drawing it.

import { parseGuide } from "./core.js";

let fgIndex = null;  // set once field-guide-02.txt is fetched and parsed

let img = null;         // loaded HTMLImageElement, full source resolution
let rotation = 0;       // 0 | 90 | 180 | 270, applied clockwise
let full = null;        // offscreen canvas: full-res image at current rotation
let view = { scale: 1, x: 0, y: 0 };  // scale = display px per source px; x/y = source px at canvas (0,0)
let minScale = 1;
const MAX_SCALE = 8;

let mode = "pan";       // "pan" | "draw"
let dragging = null;    // null | "pan" | "draw"
let panStart = null;    // { px, py, vx, vy }
let box = null;         // { x0, y0, x1, y1 } in source (full-res) coordinates
const crops = [];       // [{ id, canvas, dataURL, preDataURL, width, height, ocr }]

// ocr: null (not yet run) | { status: "pending" } | { status: "done", text, confidence }
// | { status: "error", error }

// A module number is uppercase letters, digits, and an optional -XX revision
// suffix (see core.js baseOf). Restricting Tesseract to that alphabet removes
// a lot of confusions, and SINGLE_LINE tells it not to guess at page layout —
// both matter far more on a tight single-code crop than on a page of prose.
// I and Z are dropped: across all 1464 module numbers in field-guide-02.txt,
// neither letter is ever used (checked directly against the parsed guide),
// and both are easily confused with 1 and 2/7.
const CHAR_WHITELIST = "ABCDEFGHJKLMNOPQRSTUVWXY0123456789-";

let workerPromise = null;  // shared Tesseract worker, created lazily on first crop
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker("eng").then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: CHAR_WHITELIST,
      });
      return worker;
    });
  }
  return workerPromise;
}

// Upscale (text this small needs to be well past the ~20-30px-tall range
// Tesseract's classifier was trained on), convert to grayscale, and stretch
// contrast to the crop's own min/max — a tight crop's local contrast is often
// much lower than the auto-threshold Tesseract would compute over a full page.
function preprocessForOcr(srcCanvas) {
  const TARGET_HEIGHT = 120;
  const scale = Math.max(1, Math.min(6, TARGET_HEIGHT / srcCanvas.height));
  const w = Math.max(1, Math.round(srcCanvas.width * scale));
  const h = Math.max(1, Math.round(srcCanvas.height * scale));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const gray = new Float32Array(n);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);

  // Tesseract is trained on black text on a white background; light text on
  // a dark background measurably hurts accuracy and should be inverted
  // before recognition. Mean brightness after stretching is a cheap proxy
  // for whether the background (the majority of pixels in a tight crop) is
  // currently light or dark.
  const stretched = new Float32Array(n);
  let sum = 0;
  for (let p = 0; p < n; p++) {
    const v = ((gray[p] - min) / range) * 255;
    stretched[p] = v;
    sum += v;
  }
  const invert = sum / n < 127;

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = invert ? 255 - stretched[p] : stretched[p];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

// Plain Levenshtein edit distance — small alphabet, short strings (module
// numbers top out around 10 characters), so an O(n*m) table is instant.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Closest real module number to a raw OCR guess, brute-forced against every
// known module (~1400 entries — cheap at this scale). Returns null if the
// field guide hasn't loaded yet or the OCR text was empty after cleanup.
function bestModuleMatch(index, rawText) {
  const query = rawText.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!index || !query) return null;
  let best = null;
  for (const mod of index.byModule.keys()) {
    const distance = levenshtein(query, mod);
    if (!best || distance < best.distance) best = { module: mod, distance };
  }
  return best;
}

async function runOcr(crop) {
  crop.ocr = { status: "pending" };
  renderCrops();
  try {
    const pre = preprocessForOcr(crop.canvas);
    crop.preDataURL = pre.toDataURL("image/png");
    const worker = await getWorker();
    const { data } = await worker.recognize(pre);
    const text = data.text.trim();
    crop.ocr = {
      status: "done", text, confidence: data.confidence,
      match: bestModuleMatch(fgIndex, text),
    };
  } catch (err) {
    crop.ocr = { status: "error", error: (err && err.message) || String(err) };
  }
  renderCrops();
}

const fileInput = document.getElementById("file");
const display = document.getElementById("display");
const meta = document.getElementById("meta");
const rotateLeftBtn = document.getElementById("rotate-left");
const rotateRightBtn = document.getElementById("rotate-right");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomFitBtn = document.getElementById("zoom-fit");
const modePanBtn = document.getElementById("mode-pan");
const modeDrawBtn = document.getElementById("mode-draw");
const confirmBtn = document.getElementById("confirm");
const clearBtn = document.getElementById("clear-box");
const cropsEl = document.getElementById("crops");

const MAX_VIEWPORT_W = 900;
const MAX_VIEWPORT_H = 650;

function rotatedCanvas(image, rotationDeg) {
  const c = document.createElement("canvas");
  const swap = rotationDeg % 180 !== 0;
  c.width = swap ? image.naturalHeight : image.naturalWidth;
  c.height = swap ? image.naturalWidth : image.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  return c;
}

function resetView() {
  full = rotatedCanvas(img, rotation);
  display.width = Math.min(MAX_VIEWPORT_W, window.innerWidth - 48);
  display.height = Math.min(MAX_VIEWPORT_H, Math.round(window.innerHeight * 0.6));
  minScale = Math.min(1, display.width / full.width, display.height / full.height);
  view = { scale: minScale, x: 0, y: 0 };
  mode = "pan";
  updateModeButtons();
  updateMeta();
  redraw();
}

function updateMeta() {
  meta.textContent = full
    ? `${full.width} × ${full.height}px · rotation ${rotation}° · zoom ${Math.round(view.scale * 100)}%`
    : "";
}

function toSource(p) {
  return { x: view.x + p.x / view.scale, y: view.y + p.y / view.scale };
}
function toDisplay(p) {
  return { x: (p.x - view.x) * view.scale, y: (p.y - view.y) * view.scale };
}

function clampView() {
  const visW = display.width / view.scale;
  const visH = display.height / view.scale;
  view.x = Math.min(Math.max(view.x, 0), Math.max(0, full.width - visW));
  view.y = Math.min(Math.max(view.y, 0), Math.max(0, full.height - visH));
}

function redraw() {
  const ctx = display.getContext("2d");
  ctx.clearRect(0, 0, display.width, display.height);
  const visW = display.width / view.scale;
  const visH = display.height / view.scale;
  ctx.drawImage(full, view.x, view.y, visW, visH, 0, 0, display.width, display.height);
  if (box) {
    const p0 = toDisplay({ x: box.x0, y: box.y0 });
    const p1 = toDisplay({ x: box.x1, y: box.y1 });
    ctx.strokeStyle = "#e63946";
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  }
}

function normalizedBox(b) {
  return {
    x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1),
    x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1),
  };
}

function zoomTo(newScale, anchorDisplayPt) {
  newScale = Math.min(MAX_SCALE, Math.max(minScale, newScale));
  if (newScale === view.scale) return;
  const anchorSource = toSource(anchorDisplayPt);
  view.scale = newScale;
  view.x = anchorSource.x - anchorDisplayPt.x / view.scale;
  view.y = anchorSource.y - anchorDisplayPt.y / view.scale;
  clampView();
  updateMeta();
  redraw();
}

function updateButtons() {
  const hasImage = !!img;
  for (const b of [rotateLeftBtn, rotateRightBtn, zoomInBtn, zoomOutBtn, zoomFitBtn, modePanBtn, modeDrawBtn]) {
    b.disabled = !hasImage;
  }
  const hasBox = !!box && box.x1 - box.x0 >= 1 && box.y1 - box.y0 >= 1;
  confirmBtn.disabled = !hasBox;
  clearBtn.disabled = !box;
}

function updateModeButtons() {
  modePanBtn.classList.toggle("active", mode === "pan");
  modeDrawBtn.classList.toggle("active", mode === "draw");
  display.classList.toggle("mode-pan", mode === "pan");
}

function setMode(m) {
  mode = m;
  updateModeButtons();
}
modePanBtn.addEventListener("click", () => setMode("pan"));
modeDrawBtn.addEventListener("click", () => setMode("draw"));

function pointerPos(e) {
  const r = display.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

display.addEventListener("pointerdown", (e) => {
  if (!img) return;
  const p = pointerPos(e);
  display.setPointerCapture(e.pointerId);
  if (mode === "pan") {
    dragging = "pan";
    panStart = { px: p.x, py: p.y, vx: view.x, vy: view.y };
  } else {
    dragging = "draw";
    const sp = toSource(p);
    box = { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
    redraw();
  }
  updateButtons();
});

display.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = pointerPos(e);
  if (dragging === "pan") {
    view.x = panStart.vx - (p.x - panStart.px) / view.scale;
    view.y = panStart.vy - (p.y - panStart.py) / view.scale;
    clampView();
    redraw();
  } else {
    const sp = toSource(p);
    box.x1 = sp.x;
    box.y1 = sp.y;
    redraw();
  }
});

display.addEventListener("pointerup", () => {
  if (!dragging) return;
  if (dragging === "draw") box = normalizedBox(box);
  dragging = null;
  redraw();
  updateButtons();
});

display.addEventListener("wheel", (e) => {
  if (!img) return;
  e.preventDefault();
  const anchor = pointerPos(e);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomTo(view.scale * factor, anchor);
}, { passive: false });

zoomInBtn.addEventListener("click", () =>
  zoomTo(view.scale * 1.25, { x: display.width / 2, y: display.height / 2 }));
zoomOutBtn.addEventListener("click", () =>
  zoomTo(view.scale / 1.25, { x: display.width / 2, y: display.height / 2 }));
zoomFitBtn.addEventListener("click", () =>
  zoomTo(minScale, { x: display.width / 2, y: display.height / 2 }));

function rotate(delta) {
  if (!img) return;
  rotation = (rotation + delta + 360) % 360;
  box = null;
  resetView();
  updateButtons();
}
rotateLeftBtn.addEventListener("click", () => rotate(-90));
rotateRightBtn.addEventListener("click", () => rotate(90));
clearBtn.addEventListener("click", () => { box = null; redraw(); updateButtons(); });

function confirmCrop() {
  if (!box) return;
  const sx = box.x0, sy = box.y0;
  const sw = box.x1 - box.x0, sh = box.y1 - box.y0;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  out.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);

  const id = String.fromCharCode(65 + crops.length); // A, B, C, ...
  const crop = {
    id, canvas: out, dataURL: out.toDataURL("image/png"),
    width: out.width, height: out.height, ocr: null,
  };
  crops.push(crop);
  renderCrops();
  runOcr(crop);

  box = null;
  redraw();
  updateButtons();
}
confirmBtn.addEventListener("click", confirmCrop);

function ocrText(ocr) {
  if (!ocr) return { text: "", cls: "" };
  if (ocr.status === "pending") return { text: "Recognizing…", cls: "" };
  if (ocr.status === "error") return { text: `OCR failed: ${ocr.error}`, cls: "error" };
  const text = ocr.text || "(no text found)";
  return { text: `“${text}” (${Math.round(ocr.confidence)}%)`, cls: "" };
}

function matchLine(ocr) {
  if (!ocr || ocr.status !== "done") return null;
  if (!ocr.match) return { text: fgIndex ? "no match found" : "field guide still loading…", cls: "far" };
  const { module, distance } = ocr.match;
  const entry = fgIndex.byModule.get(module)[0];
  const optionPart = entry.option ? ` — ${entry.option}` : "";
  const cls = distance === 0 ? "exact" : distance <= 2 ? "close" : "far";
  const distPart = distance === 0 ? "exact" : `edit distance ${distance}`;
  return { text: `→ ${module}${optionPart} (${distPart})`, cls };
}

function renderCrops() {
  cropsEl.innerHTML = "";
  for (const c of crops) {
    const card = document.createElement("div");
    card.className = "crop-card";
    const image = document.createElement("img");
    image.src = c.dataURL;
    image.alt = `Crop ${c.id}`;
    const label = document.createElement("div");
    label.textContent = `${c.id} — ${c.width}×${c.height}px`;

    const preImage = document.createElement("img");
    if (c.preDataURL) {
      preImage.src = c.preDataURL;
      preImage.alt = `Crop ${c.id}, preprocessed for OCR`;
      preImage.className = "pre-img";
    }

    const ocrLine = document.createElement("div");
    const { text, cls } = ocrText(c.ocr);
    ocrLine.className = "ocr-line" + (cls ? " " + cls : "");
    ocrLine.textContent = text;

    const elements = [image, label, preImage, ocrLine];
    const match = matchLine(c.ocr);
    if (match) {
      const matchEl = document.createElement("div");
      matchEl.className = "match-line " + match.cls;
      matchEl.textContent = match.text;
      elements.push(matchEl);
    }

    const link = document.createElement("a");
    link.href = c.dataURL;
    link.download = `crop-${c.id}.png`;
    link.textContent = "download";
    elements.push(link);
    card.append(...elements);
    cropsEl.appendChild(card);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const nextImg = new Image();
  nextImg.onload = () => {
    img = nextImg;
    rotation = 0;
    box = null;
    resetView();
    updateButtons();
    URL.revokeObjectURL(url);
  };
  nextImg.src = url;
});

fetch("field-guide-02.txt")
  .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
  .then((text) => {
    fgIndex = parseGuide(text);
    renderCrops();  // refresh any crops OCR'd before the guide finished loading
  })
  .catch((err) => {
    console.error("field guide fetch failed, matching disabled:", err);
  });
