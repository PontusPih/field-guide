// Per-detection thumbnail crops for the results list, memoized.
//
// Not pure: it reads the active image's source canvas (state.active.full) and
// does canvas image work. But self-contained -- a memoizing image-derivation
// service keyed by image + box coordinates, so editing a box re-crops it while
// an unchanged box is a cache hit. Held here rather than on the detection
// objects because persistLabel() (session-store.js) serialises detections
// wholesale, and a data URL per box would be written to IndexedDB on every save.
//
// createThumbnailCache() binds it to the shared state and returns
// { thumbnailDataUrl, clear }; the cache Map is private. clear() is called
// whenever an image's source pixels or detection ids change (rotate, clear
// image) or when it leaves the batch entirely -- that lifecycle, driven from
// outside the results list, is why this is its own module rather than a
// detail of it.

import { boundsOf } from "./geometry.js";

const MAX_THUMB_HEIGHT = 36; // display px

export function createThumbnailCache({ state }) {
  // Keyed by `${imageId}:${detectionId}`, not detection id alone -- each
  // image's own ids restart at 1, so two different images can otherwise
  // collide on the same cache entry and show each other's crop. The stored
  // value's boxKey is the detection's box coordinates, so editing a box within
  // the same image still re-crops it.
  const cache = new Map();

  // Clears one image's cached crops (`imageId` given -- its `full` was
  // re-rendered or its detection ids reset) or the whole cache (no argument --
  // an image left the batch entirely, or everything is being reset).
  function clear(imageId) {
    if (imageId == null) { cache.clear(); return; }
    const prefix = `${imageId}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  function thumbnailDataUrl(detection) {
    const active = state.active;
    const cacheKey = `${active.id}:${detection.id}`;
    const boxKey = JSON.stringify(detection.box);
    const cached = cache.get(cacheKey);
    if (cached && cached.boxKey === boxKey) return cached.url;

    const b = boundsOf(detection.box);
    const w = Math.max(1, Math.round(b.maxX - b.minX));
    const h = Math.max(1, Math.round(b.maxY - b.minY));
    const scale = Math.min(1, MAX_THUMB_HEIGHT / h);
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    c.getContext("2d").drawImage(active.full, b.minX, b.minY, w, h, 0, 0, outW, outH);

    const url = c.toDataURL("image/png");
    cache.set(cacheKey, { boxKey, url });
    return url;
  }

  return { thumbnailDataUrl, clear };
}
