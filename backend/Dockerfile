FROM python:3.12-slim

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

EXPOSE 8642
CMD ["python", "server.py"]
