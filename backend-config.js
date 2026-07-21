// Resolves which OCR backend ocr.js talks to, with no build step or
// per-environment file. Two mechanisms, checked in order:
//
//   1. A saved override in localStorage (key: BACKEND_URL_STORAGE_KEY), set
//      from the browser console to point at any backend without editing
//      source:
//      `localStorage.setItem("fieldGuideBackendUrl", "https://staging.example.com")`.
//      Remove the key to fall back to auto-detection.
//   2. Hostname-based auto-detect: a localhost name gets the dev backend,
//      anything else gets prod.
//
// Pure and DOM-free -- localStorage/location are read by the caller and
// passed in -- so the resolution logic is unit-testable, as in geometry.js.

const LOCALHOST_NAMES = ["localhost", "127.0.0.1"];
const DEFAULT_DEV_BACKEND_URL = "http://localhost:8642";
const DEFAULT_PROD_BACKEND_URL = "https://field-guide.onrender.com";
const BACKEND_URL_STORAGE_KEY = "fieldGuideBackendUrl";

// `storedOverride` is `null`/`undefined` when absent (matches
// Storage.getItem()).
function resolveBackendUrl({ hostname, storedOverride }) {
  if (storedOverride) return storedOverride;
  return LOCALHOST_NAMES.includes(hostname) ? DEFAULT_DEV_BACKEND_URL : DEFAULT_PROD_BACKEND_URL;
}

export {
  resolveBackendUrl,
  LOCALHOST_NAMES,
  DEFAULT_DEV_BACKEND_URL,
  DEFAULT_PROD_BACKEND_URL,
  BACKEND_URL_STORAGE_KEY,
};
