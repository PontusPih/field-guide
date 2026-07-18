const fileInput = document.getElementById('file');
const stage = document.getElementById('stage');
const ctx = stage.getContext('2d');
const rotateLeftBtn = document.getElementById('rotateLeft');
const rotateRightBtn = document.getElementById('rotateRight');
const runOcrBtn = document.getElementById('runOcr');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

let sourceCanvas = null; // pristine loaded image, never mutated by rotation
let rotation = 0; // degrees clockwise: 0, 90, 180, 270
let lastDetections = [];

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const bitmap = await createImageBitmap(file);
  sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = bitmap.width;
  sourceCanvas.height = bitmap.height;
  sourceCanvas.getContext('2d').drawImage(bitmap, 0, 0);

  rotation = 0;
  lastDetections = [];
  redraw();
  setControlsEnabled(true);
  setStatus(`Loaded ${file.name} (${bitmap.width}x${bitmap.height})`);
});

rotateLeftBtn.addEventListener('click', () => {
  rotation = (rotation + 270) % 360;
  lastDetections = [];
  redraw();
});

rotateRightBtn.addEventListener('click', () => {
  rotation = (rotation + 90) % 360;
  lastDetections = [];
  redraw();
});

runOcrBtn.addEventListener('click', async () => {
  if (!sourceCanvas) return;

  setStatus('Running OCR…');
  runOcrBtn.disabled = true;
  try {
    // PNG, not JPEG: avoids re-compressing an already-JPEG-decoded image a
    // second time before it reaches the OCR backend.
    const blob = await new Promise((resolve) => stage.toBlob(resolve, 'image/png'));
    const resp = await fetch('/ocr', { method: 'POST', body: blob });
    if (!resp.ok) {
      throw new Error(`server returned ${resp.status}`);
    }
    lastDetections = await resp.json();
    redraw();
    renderResultsList(lastDetections);
    setStatus(`Found ${lastDetections.length} box(es)`);
  } catch (err) {
    setStatus(`OCR failed: ${err.message}`);
  } finally {
    runOcrBtn.disabled = false;
  }
});

function redraw() {
  if (!sourceCanvas) return;

  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const swapped = rotation === 90 || rotation === 270;
  stage.width = swapped ? sh : sw;
  stage.height = swapped ? sw : sh;

  ctx.save();
  ctx.translate(stage.width / 2, stage.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(sourceCanvas, -sw / 2, -sh / 2);
  ctx.restore();

  drawBoxes(lastDetections);
}

function drawBoxes(detections) {
  for (const d of detections) {
    const [p0, p1, p2, p3] = d.box;
    const color = colorForScore(d.score);

    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();

    const label = `${d.text} (${d.score.toFixed(2)})`;
    ctx.font = '20px sans-serif';
    const labelY = Math.min(p0[1], p1[1]) - 6;
    ctx.fillStyle = color;
    ctx.fillText(label, p0[0], labelY > 12 ? labelY : p2[1] + 20);
  }
}

function renderResultsList(detections) {
  resultsEl.innerHTML = '';
  for (const d of detections) {
    const li = document.createElement('li');
    li.textContent = `${d.text}  (score ${d.score.toFixed(3)})`;
    li.style.color = colorForScore(d.score);
    resultsEl.appendChild(li);
  }
}

function colorForScore(score) {
  if (score >= 0.9) return '#2ecc71';
  if (score >= 0.5) return '#f1c40f';
  return '#e74c3c';
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setControlsEnabled(enabled) {
  rotateLeftBtn.disabled = !enabled;
  rotateRightBtn.disabled = !enabled;
  runOcrBtn.disabled = !enabled;
}
