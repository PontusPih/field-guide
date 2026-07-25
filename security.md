# Field guide — security notes

Scope: the Scan tool and its OCR backend (`backend/server.py`, `ocr.js`, and the
client-side session store). The rest of the field guide is static content served from
GitHub Pages with no backend of its own.

Threat model, as three questions asked of the design:

1. Can a malicious client bring the backend down with bad input — malformed images or
   huge byte streams? Is throttling needed?
2. Can a malicious actor use the backend as a springboard for lateral movement or
   damage to a third party?
3. Can one client see another client's images by mistake?

Severity tags below: **HIGH** (exploitable, real impact), **MEDIUM** (needs conditions or
is defense-in-depth), **LOW/INFO** (minor or informational). Findings marked **[fixed]**
are implemented and tested; **[recommended]** are deployment or hardening steps not yet
applied.

## The backend's shape

`server.py` is a Python stdlib `http.server` service (no web framework). OCR requests are
handed to a small pool of persistent worker threads over a bounded queue; everything else
(health checks) is served inline. It is deployed on Render's free tier (512 MB RAM), which
is the memory ceiling every limit here is sized against. The service is stateless: it
stores nothing to disk and holds no per-client data between requests.

## 1. Denial of service from bad input

### HIGH — unbounded request body read → out-of-memory [fixed]

`do_POST` previously read the entire request body into memory from the client-declared
`Content-Length` before any check ran. `check_dimensions()` inspects only *pixel*
dimensions, and only *after* the read, so it offered no protection here: a client could
declare a multi-gigabyte `Content-Length`, stream the body slowly, and force the process
to allocate all of it — an immediate out-of-memory kill on a 512 MB instance. The pixel
gate never saw the bytes.

**Fix.** A byte ceiling, `MAX_UPLOAD_BYTES` (env `OCR_MAX_UPLOAD_BYTES`, default 10 MB),
is enforced from `Content-Length` *before* a single byte is read; an oversized body is
rejected with `413` and never buffered. Sized well above a legitimate ~`MAX_DIMENSION`
tile (a few hundred KB) and far below anything that threatens the heap. Set to `0` to
disable, the same explicit opt-out as `OCR_MAX_DIMENSION` — a dev machine sending large
untiled images raises or disables both. Covered by
`test_post_body_over_upload_cap_returns_413`.

**Why gating the declared length is sufficient.** The cap reads the *client-declared*
`Content-Length`, but that is safe because `do_POST` then reads exactly that many bytes and
no more — `self.rfile.read(length)` is the only body read — so the cap and the read bound
the same quantity. A client that lies is covered in both directions:

- Declares little, sends much (understating the header): the server reads only `length`
  bytes; the excess is never pulled into the process. It stays in the fixed-size kernel
  socket buffer, and TCP flow control stalls the sender once that fills and we stop
  reading. The leftover can only desync HTTP keep-alive framing on that one connection,
  which errors its next request — not a memory or availability problem.
- Declares much, sends little (overstating, then stalling): the cap rejects an over-limit
  declaration with `413` before any read, so `read()` is only ever called with
  `length <= MAX_UPLOAD_BYTES`; a client that declares *under* the cap but then withholds
  the rest is dropped by the socket timeout (next finding), not left to pin a thread.

So at most ~`MAX_UPLOAD_BYTES` is ever buffered, regardless of what the client actually
transmits. Chunked transfer encoding is not a bypass: `http.server` does not decode chunked
bodies and this code does not read chunk framing, so a request with no `Content-Length` has
`length == 0` and is rejected as an empty body.

### MEDIUM — no socket timeout → slowloris [fixed]

`http.server` leaves the per-connection socket timeout at `None` (never times out).
`ThreadingHTTPServer` caps neither the thread count nor a connection's lifetime, so a
client could hold a thread open indefinitely by dribbling headers or body one byte at a
time; a handful of such connections exhaust the thread pool at near-zero cost.

**Fix.** `Handler.timeout` is set to `SOCKET_TIMEOUT` (env `OCR_SOCKET_TIMEOUT`, default
30 s), applied to the connection socket by `socketserver`, so a connection that goes idle
mid-request is dropped rather than pinning a thread. This also bounds the "body shorter
than the declared `Content-Length`" case, where `rfile.read(length)` would otherwise wait
on bytes that never arrive. Covered by `test_handler_has_a_socket_timeout`.

### LOW — malformed `Content-Length` → 500 [fixed]

A non-numeric `Content-Length` made `int(...)` raise `ValueError`, uncaught (a per-request
500, not a whole-server crash). Now parsed defensively and answered with a `400`. Covered
by `test_post_invalid_content_length_returns_400`.

### What was already sound

The OCR *compute* stage is correctly throttled and needs no change: a bounded `job_queue`
(`OCR_QUEUE_MAXSIZE`, default 2) drained by a fixed worker count (`OCR_WORKERS`, default 1),
with `put_nowait` returning `503 Retry-After` when full. That bounds CPU and memory from
parallel OCR. The fixes above close the *ingest* stage, which previously let the body read
bypass this backpressure entirely.

The pixel-dimension gate (`check_dimensions`, `OCR_MAX_DIMENSION`, default 1200) uses PIL's
lazy header read (no pixel decode) and caps the longer side, which bounds the subsequent
decode's memory. It remains the right control for decode cost, now behind the byte gate
that guards the read itself.

### On throttling

Per-request OCR concurrency is handled by the queue. Per-IP rate limiting — the remaining
throttle worth having, given the open CORS policy below — is deliberately **not** built
into this stdlib server; it belongs at the reverse proxy / platform layer (Render,
Cloudflare, or similar), where it can be applied without adding a framework or shared state
to a process that is otherwise stateless.

## 2. Springboard for lateral movement or third-party damage

### The obvious vectors are absent

`POST /ocr` takes raw image **bytes**, never a URL — there is no server-side request driven
by user input, so no SSRF surface. There is no `subprocess`, `eval`, shell, or
user-controlled filesystem path. No outbound network request is triggered by input.

### MEDIUM — container runs as root, widening any native-decoder exploit [recommended]

The real lateral-movement risk is a memory-corruption bug in the native image path
(libjpeg / OpenCV / Pillow / onnxruntime) reached by a crafted image. The `Dockerfile` sets
no `USER`, so such an exploit would execute as **root inside the container**, with whatever
egress the platform allows.

**Recommended.** Add a non-root `USER` to the `Dockerfile` — a property of the *image*,
portable across Render and any host, and the one lever available here. This is distinct
from *rootless Docker*, which is a property of the *host runtime* (the engine and its
containers run under an unprivileged host account via user namespaces) and is not
selectable on a managed platform like Render. The two are complementary: ship the non-root
`USER` regardless; run the engine rootless as well if the service is ever self-hosted.
Further defense-in-depth: read-only root filesystem, dropped capabilities, and restricted
container egress. Keep the pinned native dependencies patched — pin-and-patch, not
pin-and-forget.

### LOW/INFO — open CORS and no authentication [recommended]

`Access-Control-Allow-Origin: *` with no auth means any web page can drive the backend
using its visitors' browsers — free OCR compute and a way to amplify the DoS surface in
section 1. There is no data-leak impact, since the service is stateless. If the only
legitimate caller is the GitHub Pages origin, reflecting just that origin removes the
amplification. Left open may be a deliberate choice for a public POC; noted so it stays a
choice rather than an oversight.

## 3. Images leaking between clients

**No server-side leak path exists.** Each request creates its own single-slot result queue
and hands `(image_bytes, result_queue)` to a worker, which replies only to that queue;
results cannot cross requests. `image_bytes` is request-local. The service writes no image
to disk, caches nothing, and keeps no cross-request state. The one log line records only
the byte length of an upload, never its content. The shared `RapidOCR` engine is reused
across jobs but exposes no way to read a previous call's input, and each call returns to its
own caller.

**Client side** (`session-store.js`): the loaded image and box state persist in IndexedDB,
which is scoped to the page's origin and the browser profile and is never transmitted
anywhere. The one residual exposure is a *shared physical machine with a shared browser
profile*, where the single-slot session restores the previous user's last image on that
profile. That is a local-device concern, outside the backend's control; a machine used by
multiple people who must not see each other's scans needs separate OS or browser profiles.

## Configuration reference (security-relevant)

| Env var | Default | Purpose |
| --- | --- | --- |
| `OCR_MAX_UPLOAD_BYTES` | `10485760` (10 MB) | Reject a request body larger than this before reading it. `0` disables. |
| `OCR_SOCKET_TIMEOUT` | `30` | Per-connection socket timeout, seconds. Drops stalled (slowloris) connections. |
| `OCR_MAX_DIMENSION` | `1200` | Reject an image whose longer side exceeds this (post-read, pre-OCR). `0` disables. |
| `OCR_QUEUE_MAXSIZE` | `2` | Max requests waiting on a worker; overflow returns `503`. |
| `OCR_WORKERS` | `1` | OCR worker threads; bounds parallel compute. |

`OCR_MAX_UPLOAD_BYTES=0` and `OCR_MAX_DIMENSION=0` are the local-dev opt-outs for sending
large untiled images (see `backend/README.md`); leave both at their defaults anywhere
memory is actually constrained.

## Status

- Section 1: HIGH and MEDIUM findings **fixed** in `server.py` with tests in
  `backend/test/test_server.py`.
- Section 2: **recommended** deployment hardening (non-root `USER`, CORS, egress) — not yet
  applied; no code change lands these, they are `Dockerfile` / platform settings.
- Section 3: no change required; client-side caveat documented.
