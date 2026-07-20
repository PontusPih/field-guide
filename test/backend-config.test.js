"use strict";

// Unit tests for the OCR backend URL resolution logic used by ocr.js.
// Run: `node --test` (or `node --test test/backend-config.test.js`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBackendUrl, DEFAULT_DEV_BACKEND_URL, DEFAULT_PROD_BACKEND_URL,
} from "../backend-config.js";

test("resolveBackendUrl: localhost with no override -> local dev backend", () => {
  const url = resolveBackendUrl({ hostname: "localhost", storedOverride: null });
  assert.equal(url, DEFAULT_DEV_BACKEND_URL);
});

test("resolveBackendUrl: 127.0.0.1 also counts as local dev", () => {
  const url = resolveBackendUrl({ hostname: "127.0.0.1", storedOverride: null });
  assert.equal(url, DEFAULT_DEV_BACKEND_URL);
});

test("resolveBackendUrl: any other hostname -> production backend", () => {
  const url = resolveBackendUrl({ hostname: "pdp8.se", storedOverride: null });
  assert.equal(url, DEFAULT_PROD_BACKEND_URL);
});

test("resolveBackendUrl: a stored override wins regardless of hostname", () => {
  const url = resolveBackendUrl({
    hostname: "pdp8.se",
    storedOverride: "https://staging.example.com",
  });
  assert.equal(url, "https://staging.example.com");
});

test("resolveBackendUrl: stored override also applies on localhost", () => {
  const url = resolveBackendUrl({
    hostname: "localhost",
    storedOverride: "https://staging.example.com",
  });
  assert.equal(url, "https://staging.example.com");
});
