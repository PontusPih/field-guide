FROM python:3.12-slim

# Python block-buffers stdout when it isn't a tty -- true here, since Render
# captures the container's output through a pipe. Without this, print()
# output (including the version line and per-request RSS logging in
# server.py) can sit unflushed and never reach Render's logs, and is lost
# outright if the process is later SIGKILLed (e.g. an OOM kill).
ENV PYTHONUNBUFFERED=1

# opencv-python-headless still needs libGL/libglib present on the system even
# though it never opens a window (RapidOCR's cv2 calls dlopen it internally).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# rapidocr-onnxruntime declares a dependency on opencv-python (the GUI build),
# which pulls in X11/Qt libs this headless server never uses. requirements.txt
# (shared with the venv/global-pip install paths in README.md, so all three
# stay in sync) already substitutes opencv-python-headless; rapidocr-
# onnxruntime itself is installed separately with --no-deps so pip never
# reaches for the GUI build via its own dependency list.
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps rapidocr-onnxruntime==1.4.4

COPY server.py ./

# Render sets RENDER_GIT_COMMIT itself at runtime (no build-arg needed there).
# This build-arg covers everyone else: `docker build --build-arg
# GIT_COMMIT=$(git rev-parse --short HEAD) ...` so a manually built image is
# self-describing too. Placed after the dependency layers above so a
# changing commit id doesn't bust their build cache.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 8642
CMD ["python", "server.py"]
