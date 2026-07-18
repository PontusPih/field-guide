"use strict";

// OCR crop tool — POC. Upload a photo, optionally rotate in 90-degree steps,
// drag a box to select the module-number region, and confirm to extract a
// full-resolution crop. One box at a time; crops accumulate in a list for
// later feeding into Tesseract (not wired up yet).

let img = null;         // loaded HTMLImageElement, full source resolution
let rotation = 0;       // 0 | 90 | 180 | 270, applied clockwise
let full = null;        // offscreen canvas: full-res image at current rotation
let scale = 1;          // display px per full-res px
let box = null;         // current (uncommitted) crop box, in display coords
let dragging = false;
const crops = [];       // [{ id, dataURL, width, height }]

const fileInput = document.getElementById("file");
const display = document.getElementById("display");
const meta = document.getElementById("meta");
const rotateLeftBtn = document.getElementById("rotate-left");
const rotateRightBtn = document.getElementById("rotate-right");
const confirmBtn = document.getElementById("confirm");
const clearBtn = document.getElementById("clear-box");
const cropsEl = document.getElementById("crops");

const MAX_DISPLAY_WIDTH = 900;

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

function updateDisplay() {
  full = rotatedCanvas(img, rotation);
  const maxW = Math.min(MAX_DISPLAY_WIDTH, window.innerWidth - 48);
  scale = Math.min(1, maxW / full.width);
  display.width = Math.round(full.width * scale);
  display.height = Math.round(full.height * scale);
  meta.textContent = `${full.width} × ${full.height} px (rotation ${rotation}°)`;
  redraw();
}

function redraw() {
  const ctx = display.getContext("2d");
  ctx.clearRect(0, 0, display.width, display.height);
  ctx.drawImage(full, 0, 0, display.width, display.height);
  if (box) {
    ctx.strokeStyle = "#e63946";
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  }
}

function normalizedBox(b) {
  return {
    x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1),
    x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1),
  };
}

function updateButtons() {
  const hasImage = !!img;
  rotateLeftBtn.disabled = !hasImage;
  rotateRightBtn.disabled = !hasImage;
  const hasBox = !!box && box.x1 - box.x0 >= 4 && box.y1 - box.y0 >= 4;
  confirmBtn.disabled = !hasBox;
  clearBtn.disabled = !box;
}

function pointerPos(e) {
  const r = display.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

display.addEventListener("pointerdown", (e) => {
  if (!img) return;
  const p = pointerPos(e);
  dragging = true;
  box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  display.setPointerCapture(e.pointerId);
  redraw();
  updateButtons();
});

display.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = pointerPos(e);
  box.x1 = p.x;
  box.y1 = p.y;
  redraw();
});

display.addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = false;
  box = normalizedBox(box);
  redraw();
  updateButtons();
});

function rotate(delta) {
  if (!img) return;
  rotation = (rotation + delta + 360) % 360;
  box = null;
  updateDisplay();
  updateButtons();
}
rotateLeftBtn.addEventListener("click", () => rotate(-90));
rotateRightBtn.addEventListener("click", () => rotate(90));
clearBtn.addEventListener("click", () => { box = null; redraw(); updateButtons(); });

function confirmCrop() {
  if (!box) return;
  const sx = box.x0 / scale, sy = box.y0 / scale;
  const sw = (box.x1 - box.x0) / scale, sh = (box.y1 - box.y0) / scale;
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
    updateDisplay();
    updateButtons();
    URL.revokeObjectURL(url);
  };
  nextImg.src = url;
});
