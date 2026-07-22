// Per-detection thumbnail crops for the results list, memoized.
//
// Not pure: it reads the shared source canvas (state.full) and does canvas image
// work. But self-contained -- a memoizing image-derivation service keyed by box
// coordinates, so editing a box re-crops it while an unchanged box is a cache
// hit. Held here rather than on the detection objects because persistState()
// serialises detections wholesale (session-store.js), and a data URL per box
// would be written to IndexedDB on every save.
//
// Extracted from ocr.js (refactor-plan.md, "The full ocr.js restructure",
// step 13). createThumbnailCache() binds it to the shared state and returns
// { thumbnailDataUrl, clear }; the cache Map is private. clear() is called
// whenever the source pixels or the ids change (new photo, rotate, clear) --
// that lifecycle, driven from outside the results list, is why this is its own
// module rather than a detail of it.

import { boundsOf } from "./geometry.js";

const MAX_THUMB_HEIGHT = 36; // display px

export function createThumbnailCache({ state }) {
  // detection id -> { key, url }, key being the box coordinates, so editing a
  // box re-crops it.
  const cache = new Map();

  // Ids restart at 1 after a clear, and `full`'s contents change on rotate or a
  // new photo -- either way the cached crops no longer describe their ids.
  function clear() {
    cache.clear();
  }

  function thumbnailDataUrl(detection) {
    const key = JSON.stringify(detection.box);
    const cached = cache.get(detection.id);
    if (cached && cached.key === key) return cached.url;

    const b = boundsOf(detection.box);
    const w = Math.max(1, Math.round(b.maxX - b.minX));
    const h = Math.max(1, Math.round(b.maxY - b.minY));
    const scale = Math.min(1, MAX_THUMB_HEIGHT / h);
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    c.getContext("2d").drawImage(state.full, b.minX, b.minY, w, h, 0, 0, outW, outH);

    const url = c.toDataURL("image/png");
    cache.set(detection.id, { key, url });
    return url;
  }

  return { thumbnailDataUrl, clear };
}
