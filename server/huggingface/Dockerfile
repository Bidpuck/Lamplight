FROM python:3.11-slim

# Hugging Face Spaces runs the container as user 1000.
RUN useradd -m -u 1000 user
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Kokoro v1.0 model and voice pack (about 350 MB), baked into the image so the
# server doesn't download them on every wake-up.
RUN mkdir -p models && python -c "import urllib.request as u; \
base='https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'; \
[u.urlretrieve(base + f, 'models/' + f) for f in ('kokoro-v1.0.onnx', 'voices-v1.0.bin')]"

COPY app.py .
RUN chown -R user /app
USER user

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
