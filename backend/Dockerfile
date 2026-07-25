FROM python:3.12-slim

# Python block-buffers stdout when it isn't a tty -- true here, since Render
# captures the container's output through a pipe. Without this, print()
# output (including the version line and per-request RSS logging in
# server.py) can sit unflushed and never reach Render's logs, and is lost
# outright if the process is later SIGKILLed (e.g. an OOM kill).
ENV PYTHONUNBUFFERED=1

# rapidocr declares a dependency on opencv-python (the GUI build), which pulls
# in X11/Qt libs this headless server never uses. requirements.txt (shared with
# the venv/global-pip install paths in README.md, so all three stay in sync)
# already substitutes opencv-python-headless and pins rapidocr's other runtime
# deps (omegaconf/requests/colorlog/…); rapidocr itself is installed separately
# with --no-deps so pip never reaches for the GUI build via its own dep list.
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps rapidocr==3.9.2

COPY server.py ./

# Bake the OCR models into the image. rapidocr 3.x downloads models on demand
# rather than bundling them; pre-fetching them here means the running container
# needs no outbound network to fetch models (so egress can be locked down, and
# cold starts don't pay a download). The warm step goes through the server's own
# build_engine(), so it downloads exactly the models the runtime will load --
# whatever the OCR_*_MODEL_TYPE/OCR_*_VERSION env knobs select can't drift from
# what gets baked. MODELSCOPE_CACHE (rapidocr's model host) is redirected under
# /app/models so the download lands in this one owned-and-readable tree rather
# than root's $HOME/.cache. Runs before the USER switch (needs to write
# /app/models), then hands ownership to the runtime user.
#
# To pin a benchmarked combo, add its knobs here as ENV before this RUN, e.g.
#   ENV OCR_DET_MODEL_TYPE=tiny OCR_REC_MODEL_TYPE=tiny
# and both the bake and the running server pick them up.
ENV OCR_MODEL_ROOT_DIR=/app/models \
    MODELSCOPE_CACHE=/app/models/.modelscope
RUN python -c "import numpy as np; from server import build_engine; \
build_engine()(np.full((96, 96, 3), 255, 'uint8'))"

# Render sets RENDER_GIT_COMMIT itself at runtime (no build-arg needed there).
# This build-arg covers everyone else: `docker build --build-arg
# GIT_COMMIT=$(git rev-parse --short HEAD) ...` so a manually built image is
# self-describing too. Placed after the dependency layers above so a
# changing commit id doesn't bust their build cache.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Drop root for the running service. A crafted-image RCE in a native decoder
# (libjpeg / OpenCV / Pillow / onnxruntime) then executes as an unprivileged
# user rather than container root, which removes the usual starting point for
# container-escape chains and blocks in-container privilege operations (apt,
# writing system dirs). The dependency layers above install as root into
# read-only system site-packages; the model tree is chowned to the runtime user
# so it can read (and, if a model were ever missing, refetch) it.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app/models
USER appuser

EXPOSE 8642
CMD ["python", "server.py"]
