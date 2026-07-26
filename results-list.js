// The results list: one row per detection *of the active image* (see PLAN.md,
// "Multi-image workflow" -- state.active is whichever image in the batch is
// currently being viewed/edited). A row is a thumbnail, a compact status
// glyph + label, an optional overlap warning, and a delete button. Actions are
// overloaded onto the row's own elements to keep it uncluttered: clicking the
// thumbnail zooms to the box, clicking the label edits it by hand, clicking
// elsewhere on the row selects it. Rebuilt wholesale from state.active on
// every redraw() -- the DOM is cheap at these counts, and a full rebuild keeps
// the list a pure function of state.
//
// DOM-imperative: builds rows and wires their events; thumbnail image work
// lives in thumbnails.js. createResultsList() binds it to the shared state,
// the <ul> element, and the callbacks its rows trigger (select/zoom/delete all
// re-render), and returns { renderResultsList }; ocr.js's redraw() and the
// Clear-family operations call it by name.

import { colorFor, glyphFor, listLabelFor } from "./detections.js";

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
  // Swap a row's label for a text input to hand-enter/correct its label. The
  // list is rebuilt wholesale on the next redraw(), so this mutates the DOM in
  // place until commit/cancel and lets that rebuild restore the row. Committing
  // marks the box `manual` (authoritative, sticky through edits/rescans) and
  // clears any OCR state; an empty commit records "no label here" (a negative).
  function startEdit(label, d) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "label-edit";
    input.value = d.text || "";
    label.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length); // caret at the end, nothing selected

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const text = input.value.trim();
      // Re-entering the text a box already shows -- confirming an OCR read
      // verbatim, or re-committing an existing manual label -- is not an edit:
      // leave the recognition state (and any OCR score) alone. Only a genuine
      // change marks the box manual.
      if (text !== "" && text === d.text) {
        redraw();
        return;
      }
      d.text = text;
      d.manual = true;
      d.score = null;
      d.attempted = false;
      d.scanFailed = false;
      updateButtons();
      redraw();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      redraw(); // rebuild restores the untouched row
    };
    // Stop keys reaching interaction.js's window handler -- otherwise
    // Backspace/Delete while typing would delete the selected box.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  function renderResultsList() {
    resultsEl.innerHTML = "";
    const active = state.active;
    if (!active) return; // no image loaded: an empty list is correct

    const overlapWarnings = computeOverlapWarnings();
    active.detections.forEach((d, i) => {
      const li = document.createElement("li");
      li.className = "result-row";
      li.style.cursor = "pointer";
      li.style.fontWeight = d.id === active.selectedId ? "bold" : "normal";

      // Row index in its own fixed-width column, left of the thumbnail, so it
      // reads as an index rather than part of the detected text. Sized for two
      // digits (see .result-num); overlap warnings reference these as "#N".
      const num = document.createElement("span");
      num.className = "result-num";
      num.textContent = `${i + 1}`;

      const thumb = document.createElement("img");
      thumb.className = "result-thumb";
      thumb.src = thumbnailDataUrl(d);
      thumb.alt = "";
      thumb.title = "Zoom to this box";
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        active.selectedId = d.id;
        zoomToBox(d);
        updateButtons();
        redraw();
      });

      const info = document.createElement("div");
      info.className = "result-info";

      const headline = document.createElement("span");
      headline.className = "result-headline";

      // Compact status: a coloured glyph carries the confidence/state (filled
      // dot for an OCR read, ✎ for a hand-entered label, hollow for unsettled),
      // replacing the old "(score …)" text; the numeric score moves to the tooltip.
      const status = document.createElement("span");
      status.className = "result-status";
      status.textContent = glyphFor(d);
      status.style.color = colorFor(d);

      const label = document.createElement("span");
      label.className = "result-label";
      label.textContent = listLabelFor(d);
      label.title = d.score != null
        ? `Score ${d.score.toFixed(3)} — click to edit label`
        : "Click to edit label";
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        startEdit(label, d);
      });

      headline.append(status, label);
      info.append(headline);

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

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn";
      delBtn.title = "Delete this box";
      delBtn.textContent = "✕"; // ✕
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        active.detections = active.detections.filter((x) => x.id !== d.id);
        if (active.selectedId === d.id) active.selectedId = null;
        if (active.hoverDeleteId === d.id) active.hoverDeleteId = null;
        if (active.hoverBoxId === d.id) active.hoverBoxId = null;
        updateButtons();
        redraw();
      });

      icons.append(delBtn);
      li.append(num, thumb, info, icons);
      li.addEventListener("click", () => {
        active.selectedId = active.selectedId === d.id ? null : d.id;
        updateButtons();
        redraw();
      });
      // Hovering a row reveals that box's full label on the image, mirroring
      // canvas hover. redrawCanvas(), not redraw(): see redrawCanvas().
      li.addEventListener("mouseenter", () => {
        active.hoverBoxId = d.id;
        redrawCanvas();
      });
      li.addEventListener("mouseleave", () => {
        if (active.hoverBoxId === d.id) {
          active.hoverBoxId = null;
          redrawCanvas();
        }
      });
      resultsEl.appendChild(li);
      // Selecting a box on the canvas should bring its row into view (e.g.
      // clicking a box that's currently scrolled out of the visible list) --
      // but only within #resultsPanel, the list's own scrollable container.
      // Native li.scrollIntoView() would walk *every* scrollable ancestor,
      // including the whole page, dragging the page's own scroll position
      // along too if the row also needed that (a real bug this had -- see
      // PLAN.md, "Known follow-ups"). Computing the delta via
      // getBoundingClientRect() and applying it to scrollTop directly touches
      // only #resultsPanel: a no-op when the row is already fully visible
      // (a click that originated in the list itself, or a redraw that
      // leaves selection unchanged), matching scrollIntoView's "nearest"
      // semantics without its whole-ancestor-chain side effect.
      if (d.id === active.selectedId) {
        const container = resultsEl.parentElement;
        const rowRect = li.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (rowRect.top < containerRect.top) {
          container.scrollTop -= containerRect.top - rowRect.top;
        } else if (rowRect.bottom > containerRect.bottom) {
          container.scrollTop += rowRect.bottom - containerRect.bottom;
        }
      }
    });
  }

  return { renderResultsList };
}
