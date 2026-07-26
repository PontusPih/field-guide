// IndexedDB-backed persistence for the Scan tool's multi-image batch: the
// currently loaded images (pixels), their working state, and a permanent
// per-image label ledger that survives across batches. See PLAN.md,
// "Multi-image workflow", for the design this schema implements.
//
// Three stores:
//   - images  (keyed by sha256) -- blobs for the CURRENT batch only. Replaced
//     wholesale on every batch change (replaceImages()). This is what bounds
//     storage growth to "at most one batch's worth of image bytes", not a
//     cumulative archive of everything ever loaded.
//   - labels  (keyed by sha256) -- { filename, rotation, detections },
//     permanent. Upserted on every edit to whichever image is active. Never
//     purged except by deleteLabels()/clearAllLabels(), which back two of the
//     app's five "Clear" operations (see ocr.js) -- the other three touch
//     only the batch, never the ledger.
//   - batch   (single record, key "current") -- { order: [sha256, ...],
//     active } describing the current batch's composition and order, so a
//     reload can reconstruct state.images[] without re-selecting files.
//
// Holds no state of its own: callers pass what they want written and receive
// plain data back. Writes that fail are logged here (so a failure is never
// silently invisible in devtools) and rethrown, so a caller that wants the
// user to see it (e.g. ocr.js's status line) can catch it; a caller that
// doesn't care can let the rejection surface as a console warning by default.

const DB_NAME = "field-guide-scan";
const DB_VERSION = 2;
const IMAGES_STORE = "images";
const LABELS_STORE = "labels";
const BATCH_STORE = "batch";
const BATCH_KEY = "current";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1's single "session" store (one image + its state under fixed keys)
      // is retired outright, not migrated -- a dev tool with no external
      // users to preserve continuity for, and the new schema's shape (three
      // stores, keyed by content hash) has no meaningful mapping from the old
      // one anyway.
      if (db.objectStoreNames.contains("session")) db.deleteObjectStore("session");
      if (!db.objectStoreNames.contains(IMAGES_STORE)) db.createObjectStore(IMAGES_STORE);
      if (!db.objectStoreNames.contains(LABELS_STORE)) db.createObjectStore(LABELS_STORE);
      if (!db.objectStoreNames.contains(BATCH_STORE)) db.createObjectStore(BATCH_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, key, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dbGet(storeName, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbDelete(storeName, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dbClear(storeName) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Reads many keys from one store in a single transaction. Results align
// index-for-index with `keys`; a missing key resolves to undefined in its
// slot rather than shortening the array, so callers can zip it against the
// input list.
function dbGetMany(storeName, keys) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const results = new Array(keys.length);
    keys.forEach((key, i) => {
      const req = store.get(key);
      req.onsuccess = () => { results[i] = req.result; };
    });
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
  }));
}

function dbDeleteMany(storeName, keys) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const key of keys) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Logs, then rethrows -- used by every write that a caller might reasonably
// want to surface to the user (a failed save should never be silently
// invisible). label describes what was being saved, for the console message.
function warnAndRethrow(label) {
  return (err) => {
    console.warn(`Could not save ${label}:`, err);
    throw err;
  };
}

// Returns `{ active, images }`, where `images` is `[{ sha256, blob, filename,
// rotation, detections }, …]` in the batch's saved order. `blob` is undefined
// for an image whose bytes are no longer in the `images` store (should not
// happen in normal use -- replaceImages() is the only thing that touches that
// store -- but storage can be evicted under pressure); callers must treat
// that as "known and labeled, but needs its file re-selected to view."
// Returns `{ active: null, images: [] }` when nothing has been saved yet, or
// null when storage could not be read at all -- the caller needs that
// distinction, since "no batch yet" is normal and "cannot read" is not.
async function loadBatch() {
  try {
    const meta = await dbGet(BATCH_STORE, BATCH_KEY);
    const order = meta?.order ?? [];
    if (order.length === 0) return { active: null, images: [] };
    const [blobs, labels] = await Promise.all([
      dbGetMany(IMAGES_STORE, order),
      dbGetMany(LABELS_STORE, order),
    ]);
    const images = order.map((sha256, i) => ({
      sha256,
      blob: blobs[i],
      filename: labels[i]?.filename ?? "",
      rotation: labels[i]?.rotation ?? 0,
      detections: labels[i]?.detections ?? [],
    }));
    return { active: meta.active ?? order[0], images };
  } catch (err) {
    console.warn("Could not restore previous batch:", err);
    return null;
  }
}

// Reads existing ledger entries for a set of images about to be loaded, so a
// previously-labeled image (by content hash) can reattach its ground truth
// even though its pixels are freshly re-selected from disk. Returns a Map
// from sha256 to `{ filename, rotation, detections }` -- only for the sha256s
// that already have an entry; one with no prior ground truth is simply
// absent from the Map, which the caller reads as "start fresh."
async function loadLabelsFor(sha256List) {
  const found = await dbGetMany(LABELS_STORE, sha256List);
  const map = new Map();
  sha256List.forEach((sha256, i) => {
    if (found[i] !== undefined) map.set(sha256, found[i]);
  });
  return map;
}

// Upserts one image's ground truth: `label` is `{ filename, rotation,
// detections }`. Called on every edit to whichever image is active -- only
// the active image can be edited, so every image's entry is always current
// the instant its own edit happens; there is nothing to flush in bulk when
// the batch changes. Permanent: never called by anything that also means to
// delete data (see deleteLabels/clearAllLabels for that).
function persistLabel(sha256, label) {
  return dbPut(LABELS_STORE, sha256, label).catch(warnAndRethrow("label"));
}

// Overwrites the single `{ order, active }` record describing the current
// batch's composition. Called whenever the batch's membership or active
// image changes -- far less often than persistLabel.
function persistBatchMeta(meta) {
  return dbPut(BATCH_STORE, BATCH_KEY, meta).catch(warnAndRethrow("batch state"));
}

// Atomically replaces the entire `images` store with `entries` ([{ sha256,
// blob }, …]) -- the operation that bounds storage growth: whatever was there
// before (the outgoing batch's pixels) is gone the instant the new batch's
// are written, never accumulating across batches.
function replaceImages(entries) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, "readwrite");
    const store = tx.objectStore(IMAGES_STORE);
    store.clear();
    for (const { sha256, blob } of entries) store.put(blob, sha256);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(warnAndRethrow("batch images"));
}

// Removes one image's bytes from the current batch (Drop image). Does not
// touch its `labels` entry, and does not update `batch.order` -- the caller
// persists the new order via persistBatchMeta() right after, keeping this
// function single-purpose.
function deleteImage(sha256) {
  return dbDelete(IMAGES_STORE, sha256).catch(warnAndRethrow("image removal"));
}

// Empties the working batch (images + the order/active record) without
// touching the permanent labels ledger -- backs "Finish batch" (nothing else
// changes) and is the first half of "Clear batch"/"Clear all" (which go on to
// delete labels too, via deleteLabels()/clearAllLabels() below). Swallows its
// own failure rather than rethrowing: a failed clear is harmlessly retryable
// by clicking again, unlike a failed save of new work.
async function clearStoredBatch() {
  try {
    await Promise.all([dbClear(IMAGES_STORE), dbClear(BATCH_STORE)]);
  } catch (err) {
    console.warn("Could not clear stored batch:", err);
  }
}

// Deletes specific images' ground truth from the permanent ledger -- backs
// "Clear batch" (scoped to the images that were in it). Rethrows: unlike
// clearStoredBatch(), the caller here is a deliberate, confirm()-gated
// decision to destroy ground truth, and a silent failure would be misleading
// (the user would believe data was wiped that in fact was not).
function deleteLabels(sha256List) {
  return dbDeleteMany(LABELS_STORE, sha256List).catch(warnAndRethrow("label removal"));
}

// Deletes the entire ledger -- every image ever labeled, not just the current
// batch's. Backs "Clear all". Rethrows, for the same reason as deleteLabels().
function clearAllLabels() {
  return dbClear(LABELS_STORE).catch(warnAndRethrow("label removal"));
}

export {
  loadBatch, loadLabelsFor, persistLabel, persistBatchMeta, replaceImages, deleteImage,
  clearStoredBatch, deleteLabels, clearAllLabels,
};
