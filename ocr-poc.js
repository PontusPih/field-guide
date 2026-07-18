"use strict";

// OCR crop tool — POC. Upload a photo, optionally rotate in 90-degree steps,
// zoom/pan to see small text clearly, then drag a box (in "Draw box" mode) to
// select the module-number region. Confirm extracts a full-resolution crop.
// One box at a time; crops accumulate in a list for later feeding into
// Tesseract (not wired up yet).
//
// The crop box is stored in source-image coordinates (full-res, post-
// rotation), not display/canvas coordinates — so it stays correctly anchored
// to the same spot on the image if the user pans or zooms after drawing it.

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
const crops = [];       // [{ id, dataURL, width, height }]

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
  crops.push({ id, dataURL: out.toDataURL("image/png"), width: out.width, height: out.height });
  renderCrops();

  box = null;
  redraw();
  updateButtons();
}
confirmBtn.addEventListener("click", confirmCrop);

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
    const link = document.createElement("a");
    link.href = c.dataURL;
    link.download = `crop-${c.id}.png`;
    link.textContent = "download";
    card.append(image, label, link);
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
