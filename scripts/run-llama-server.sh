#!/usr/bin/env bash
# Launch llama.cpp's OpenAI-compatible server for the on-device reasoning agent.
# Tuned for: i7 8th gen + GTX 1050 Ti (4 GB VRAM) + 24 GB RAM, 7B Q4_K_XL GGUF.
#
# The 1050 Ti can hold ~14-16 of the 28 layers in 4 GB; the rest run on the CPU.
# 24 GB RAM means the full model is comfortably resident — it will not OOM.
set -euo pipefail

# ---- config (override via env) ----
MODEL="${MODEL:-./models/concise-Q4_K_XL.gguf}"   # drop your GGUF here
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"        # path to the llama-server binary
NGL="${NGL:-15}"          # GPU layers — lower to 10 if you hit CUDA OOM, raise if VRAM is free
CTX="${CTX:-4096}"        # context window
THREADS="${THREADS:-$(nproc)}"
PORT="${PORT:-8080}"

if [[ ! -f "$MODEL" ]]; then
  echo "!! model not found: $MODEL"
  echo "   put your Q4_K_XL gguf at ./models/ or set MODEL=/path/to/model.gguf"
  exit 1
fi

echo ">> serving $MODEL"
echo ">> ngl=$NGL ctx=$CTX threads=$THREADS port=$PORT"

exec "$LLAMA_SERVER" \
  -m "$MODEL" \
  -ngl "$NGL" \
  -c "$CTX" \
  -t "$THREADS" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --no-warmup
