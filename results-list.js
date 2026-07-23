// The results list: one row per detection, with a thumbnail, its label/score,
// an overlap warning, and find/delete buttons. Rebuilt wholesale from
// state.detections on every redraw() -- the DOM is cheap at these counts, and a
// full rebuild keeps the list a pure function of state.
//
// DOM-imperative: builds rows and wires their events; thumbnail image work
// lives in thumbnails.js. createResultsList() binds it to the shared state,
// the <ul> element, and the callbacks its rows trigger (select/zoom/delete all
// re-render), and returns { renderResultsList }; ocr.js's redraw() and
// clearSession() call it by name.

import { colorFor, listLabelFor } from "./detections.js";

export function createResultsList({
  state,
  resultsEl,
  computeOverlapWarnings,
  thumbnailDataUrl,
  zoomToBox,
  updateButtons,
  redraw,
  redrawCanvas,
}) {
  function renderResultsList() {
    resultsEl.innerHTML = "";
    const overlapWarnings = computeOverlapWarnings();
    state.detections.forEach((d, i) => {
      const li = document.createElement("li");
      li.className = "result-row";
      li.style.cursor = "pointer";
      li.style.fontWeight = d.id === state.selectedId ? "bold" : "normal";

      const thumb = document.createElement("img");
      thumb.className = "result-thumb";
      thumb.src = thumbnailDataUrl(d);
      thumb.alt = "";

      const info = document.createElement("div");
      info.className = "result-info";

      const label = document.createElement("span");
      label.className = "result-label";
      label.textContent = `#${i + 1}  ${listLabelFor(d)}`;
      label.style.color = colorFor(d);
      info.append(label);

      const overlapsWith = overlapWarnings.get(d.id);
      if (overlapsWith) {
        const warn = document.createElement("span");
        warn.className = "overlap-warning";
        warn.textContent = `⚠ overlaps #${overlapsWith.join(", #")}`;
        warn.title = "This box's region overlaps another — likely a duplicate of the same label";
        info.append(warn);
      }

      const icons = document.createElement("span");
      icons.className = "result-icons";

      const findBtn = document.createElement("button");
      findBtn.type = "button";
      findBtn.className = "icon-btn";
      findBtn.title = "Pan/zoom to this box";
      findBtn.textContent = "\u{1F50D}"; // 🔍
      findBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectedId = d.id;
        zoomToBox(d);
        updateButtons();
        redraw();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn";
      delBtn.title = "Delete this box";
      delBtn.textContent = "✕"; // ✕
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.detections = state.detections.filter((x) => x.id !== d.id);
        if (state.selectedId === d.id) state.selectedId = null;
        if (state.hoverDeleteId === d.id) state.hoverDeleteId = null;
        if (state.hoverBoxId === d.id) state.hoverBoxId = null;
        updateButtons();
        redraw();
      });

      icons.append(findBtn, delBtn);
      li.append(thumb, info, icons);
      li.addEventListener("click", () => {
        state.selectedId = state.selectedId === d.id ? null : d.id;
        updateButtons();
        redraw();
      });
      // Hovering a row reveals that box's full label on the image, mirroring
      // canvas hover. redrawCanvas(), not redraw(): see redrawCanvas().
      li.addEventListener("mouseenter", () => {
        state.hoverBoxId = d.id;
        redrawCanvas();
      });
      li.addEventListener("mouseleave", () => {
        if (state.hoverBoxId === d.id) {
          state.hoverBoxId = null;
          redrawCanvas();
        }
      });
      resultsEl.appendChild(li);
    });
  }

  return { renderResultsList };
}
