# Reasoning Agent — on-device SLM (Tool-Integrated Reasoning)

A desktop app that runs **your 7B Q4_K_XL GGUF fully on-device** via llama.cpp,
with **three modes** so easy questions stay fast:

| Mode | Pipeline | For |
|---|---|---|
| **Knowledge** | 1 model pass | facts / recall — fast, no tools |
| **Thinking** | Planner → Solver → Execute → Verifier | math, puzzles, counting — tool-grounded |

The **Execute** stage is a real Python tool, not another model pass. A
**deterministic router** forces counting/arithmetic down the code path (with a
regex fallback that writes the code itself), so mechanical questions are correct
**for sure**. When the tool already gives ground truth, later model passes are
**skipped** — faster, and no redundant re-statements.

Loads `.gguf` files directly (pick from the folder or paste any path).

### Why this design (the research)

| Idea | Paper |
|---|---|
| LLM writes a program, interpreter runs it | PAL — Gao et al. [2211.10435](https://arxiv.org/abs/2211.10435) |
| Disentangle reasoning from computation (+12%) | PoT — Chen et al. [2211.12588](https://arxiv.org/abs/2211.12588) |
| Thought → Act(tool) → Observe | ReAct — Yao et al. [2210.03629](https://arxiv.org/abs/2210.03629) |
| Sample + majority vote (+17.9% GSM8K) | Self-Consistency — Wang et al. [2203.11171](https://arxiv.org/abs/2203.11171) |
| Small models are weak self-critics | Han et al. [2404.17140](https://arxiv.org/pdf/2404.17140) |
| "Strawberry" is **tokenization**, not reasoning | [2412.18626](https://arxiv.org/abs/2412.18626), [2410.19730](https://arxiv.org/pdf/2410.19730) |

> The key insight: a small model can neither count reliably **nor** reliably
> choose to use a tool. So the guarantee comes from the **router + code
> execution**, not from the model. Verified on this exact model: asked "how many
> r in strawberry" it answers **2** (wrong) in its head — the tool returns **3**.

## Architecture

```
Browser / Tauri (One UI theme, light/dark)
   React + Vite UI: model picker, live role cards, token streaming
     │  /api  (model discovery + load)        │  /v1  (inference, streaming)
     ▼                                         ▼
   control server (Node, :8081) ──spawns──►  llama-server (llama.cpp, :8080)
     • lists .gguf / .tar.gz                          ▼
     • extracts archives                       chosen model.gguf
     • (re)launches llama-server on select
```

You pick **any `.gguf` or `.tar.gz`** in the UI; the control server extracts it
(if needed) and (re)launches llama-server pointed at it. No rebuild to switch models.

## Setup (Linux)

> Prerequisites: Node 18+, and **`python3`** on PATH (the Execute stage runs
> model-written Python). Both are already present on most Linux setups.

### 1. Get `llama-server` with CUDA

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
# binary: build/bin/llama-server  (put it on PATH or pass LLAMA_SERVER=...)
```

(No NVIDIA toolkit? Build CPU-only by dropping `-DGGML_CUDA=ON`; it still runs,
just slower.)

### 2. Drop your model(s) in

Put any `.gguf` **or** `.tar.gz` (containing a `.gguf`) under `./models/`.
You can also paste a full path in the UI later — they don't have to live here.

### 3. Start the control server

It owns the model lifecycle and launches llama-server when you pick a model:

```bash
LLAMA_SERVER=/path/to/llama.cpp/build/bin/llama-server npm run control
# tune: NGL=10 LLAMA_SERVER=... npm run control   (if CUDA OOM on the 1050 Ti)
```

### 4. Start the UI

```bash
npm install      # REQUIRED after pulling — deps changed to Tailwind v4
npm run dev      # http://localhost:5173
```

In the UI: pick a model in the **Model** card (or paste a path) → **Load**.
The badge goes **online** once it's loaded; then type a question (or hit a Demo
button) and watch the three roles reason live. Toggle ☀️/🌙 for light/dark.

> Single-model alternative (no picker): `LLAMA_SERVER=... npm run server` runs
> `scripts/run-llama-server.sh` against one fixed GGUF.

## Performance notes (1050 Ti / i7 8th gen)

- ~4–7 tok/s with partial GPU offload. A full Plan→Solve→Verify question is
  ~60–120 s — the streaming role cards are designed to make that the *show*.
- Per-role token budgets are capped in `src/lib/prompts.ts` to keep it snappy.
- `cache_prompt: true` reuses KV for the shared role prefixes across passes.

## Windows

Same UI; swap the server step for the Windows CUDA `llama-server.exe`
(`run-llama-server.ps1` to follow). Then optionally wrap in **Tauri** for a
single double-click `.exe`.

## Files

- `src/lib/prompts.ts` — the three role specs + `<think>/<answer>` parsing
- `src/lib/agent.ts` — the sequential orchestration
- `src/lib/llm.ts` — streaming client for llama-server
- `src/App.tsx` — UI, demo questions, live cards
- `scripts/run-llama-server.sh` — Linux launch tuned for your hardware
