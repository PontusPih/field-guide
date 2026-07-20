"use strict";

// Resolves which OCR backend ocr.js should talk to, without any build step
// or checked-in per-environment file (this repo has neither -- see
// PLAN.md). Two mechanisms, checked in order:
//
//   1. A saved override in localStorage (key: BACKEND_URL_STORAGE_KEY) --
//      set it from the browser console, e.g.
//      `localStorage.setItem("fieldGuideBackendUrl", "https://staging.example.com")`,
//      to point at any backend (a staging deploy, someone else's local
//      instance, ...) without editing source. Clear it to fall back to
//      auto-detection: `localStorage.removeItem("fieldGuideBackendUrl")`.
//   2. Hostname-based auto-detect -- `localhost`/`127.0.0.1` (i.e. running
//      via `python3 -m http.server`, see README.md) default to the local
//      backend; anything else (the real GitHub Pages host) defaults to
//      production. This is the "dev vs prod" switch: no manual edit needed
//      to go either direction.
//
// Kept pure and DOM-free (localStorage/location are read by the caller and
// passed in) so the resolution logic itself is unit-testable, matching
// geometry.js's pattern.

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
