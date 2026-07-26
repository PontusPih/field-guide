// The image switcher: lists every image in the current batch as a row of
// chips, highlights the active one, and lets you pick which to view/edit.
// Also renders the running "N board(s) across M image(s)" summary. See
// PLAN.md, "Multi-image workflow".
//
// Rebuilt wholesale on every render, mirroring results-list.js's own
// approach -- the DOM is cheap at these counts, and a full rebuild keeps it a
// pure function of state. Switching is disabled while a scan is in flight
// (state.scanAbortController): v1 keeps scanning exclusive to the active
// image (see scan.js), so the batch it's scanning must not change underneath
// it.
//
// createImageSwitcher() binds it to the shared state, the list/summary
// elements, and the callback a row click triggers, and returns
// { renderImageSwitcher }.

function boardCountFor(image) {
  return image.detections.filter((d) => d.text && d.text.trim()).length;
}

export function createImageSwitcher({ state, listEl, summaryEl, switchTo }) {
  function renderImageSwitcher() {
    listEl.innerHTML = "";
    const scanning = !!state.scanAbortController;

    for (const image of state.images) {
      const li = document.createElement("li");
      li.className = "switcher-chip";
      const isActive = image.id === state.activeId;
      if (isActive) li.classList.add("active");

      const name = document.createElement("span");
      name.className = "switcher-name";
      name.textContent = image.fileName || `image ${image.id}`;
      li.append(name);

      const count = boardCountFor(image);
      const badge = document.createElement("span");
      badge.className = "switcher-count";
      badge.textContent = String(count);
      badge.title = `${count} board(s) found`;
      li.append(badge);

      if (!isActive && !scanning) {
        li.addEventListener("click", () => switchTo(image.id));
      } else if (!isActive) {
        li.classList.add("disabled");
        li.title = "Switching images is disabled while a scan is in flight";
      }
      listEl.appendChild(li);
    }

    const totalBoards = state.images.reduce((sum, img) => sum + boardCountFor(img), 0);
    summaryEl.textContent = state.images.length > 0
      ? `${totalBoards} board(s) across ${state.images.length} image(s)`
      : "";
  }

  return { renderImageSwitcher };
}
