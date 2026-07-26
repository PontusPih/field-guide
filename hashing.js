// SHA-256 content hashing. Images and their ground-truth labels are keyed by
// the hash of their bytes, not their filename (see PLAN.md, "Multi-image
// workflow") -- so the same physical photo is recognized across batches
// regardless of what it's named, and re-selecting a folder that's grown since
// last time reattaches every previously-labeled image automatically.
//
// Native crypto.subtle.digest, no library. MD5 isn't available in that API
// and isn't needed here -- this identifies content, it isn't a security
// boundary. Available identically in the browser and in Node (crypto.subtle
// is a global in both), so this is unit-testable with `node --test`.

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { sha256Hex };
