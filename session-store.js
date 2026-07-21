// IndexedDB-backed persistence for the Scan tool's session: the loaded image,
// its rotation, and every box (drawn or recognized), so returning to ocr.html
// restores where the user left off.
//
// IndexedDB rather than sessionStorage/localStorage because the image is
// binary and can be several MB, past what string storage holds comfortably.
// The image and the box state live under separate keys, so editing a box does
// not re-store the whole photo.
//
// Holds no state of its own: callers pass what they want written and receive
// plain data back.

const DB_NAME = "field-guide-scan";
const STORE = "session";
const IMAGE_KEY = "image";
const STATE_KEY = "state";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Stores the File itself, not just its bytes: IndexedDB's structured clone
// keeps .name, which the caller shows on restore (the native file input can't
// be told to display a filename it didn't set).
//
// Fire and forget, like persistState(): persistence is a convenience here, and
// a failed write should not interrupt what the user is doing.
function persistImage(file) {
  dbPut(IMAGE_KEY, file).catch((err) => console.warn("Could not save scan image:", err));
}

// `state` is the caller's `{ rotation, detections }` snapshot.
function persistState(state) {
  dbPut(STATE_KEY, state).catch((err) => console.warn("Could not save scan state:", err));
}

// Returns `{ blob, state }`, either of which may be undefined when nothing was
// stored, or null when the database could not be read at all -- a distinction
// the caller needs, since "no session yet" is normal and "cannot read" is not.
async function loadSession() {
  try {
    const [blob, state] = await Promise.all([dbGet(IMAGE_KEY), dbGet(STATE_KEY)]);
    return { blob, state };
  } catch (err) {
    console.warn("Could not restore previous scan session:", err);
    return null;
  }
}

// Resolves whether or not the delete succeeded; a session that cannot be
// cleared from storage is worth logging but should not block the UI reset the
// caller has already done.
async function clearStoredSession() {
  try {
    await Promise.all([dbDelete(IMAGE_KEY), dbDelete(STATE_KEY)]);
  } catch (err) {
    console.warn("Could not clear saved scan session:", err);
  }
}

export { persistImage, persistState, loadSession, clearStoredSession };
