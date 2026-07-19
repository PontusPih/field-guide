FROM python:3.12-slim

# opencv-python-headless still needs libGL/libglib present on the system even
# though it never opens a window (RapidOCR's cv2 calls dlopen it internally).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# rapidocr-onnxruntime declares a dependency on opencv-python (the GUI build),
# which pulls in X11/Qt libs this headless server never uses. Install its
# other real dependencies explicitly, substitute opencv-python-headless, then
# install rapidocr-onnxruntime itself with --no-deps so pip never reaches for
# the GUI build. Versions pinned to match this project's dev .venv.
RUN pip install --no-cache-dir \
        numpy==2.5.1 \
        onnxruntime==1.27.0 \
        opencv-python-headless==5.0.0.93 \
        pillow==12.3.0 \
        pyclipper==1.4.0 \
        PyYAML==6.0.3 \
        shapely==2.1.2 \
        six==1.17.0 \
        tqdm==4.69.0 \
    && pip install --no-cache-dir --no-deps rapidocr-onnxruntime==1.4.4

WORKDIR /app
COPY server.py ./

EXPOSE 8642
CMD ["python", "server.py"]
