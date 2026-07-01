# SMAE Reward Gate — bge-reranker, trained on PEAR traces, served as GGUF

The reward gate scores each candidate answer in **Reasoning** mode *before* it
reaches the user. It's a **cross-encoder reranker** (`bge-reranker-base`,
fine-tuned on your RIVA PEAR traces): given the question and a candidate answer
it returns a relevance score; the pipeline squashes it to `[0,1]` and resamples
the generate step once if it's below threshold (0.6).

It's a **GGUF served by llama.cpp** — the same runtime as the draft/verify models
(no Python sidecar, no ONNX). The control server runs it on `:8084` with
`llama-server --reranking`, and the app calls `/v1/rerank`.

```
draft 0.5B (plan) ─▶ deterministic exec (ground truth) ─▶ 7B (generate)
                                                              │
                       reward gate (bge GGUF, --reranking) ◀──┘  score < 0.6 → resample once
```

## Why a reranker (not a classifier)

A reward gate is exactly a cross-encoder "does this ANSWER fit this QUESTION"
scorer. `bge-reranker` is that, and llama.cpp converts/serves it as GGUF. A
DeBERTa classification head does **not** convert to a GGUF that llama.cpp can
serve — hence the reranker.

## Training data — your PEAR traces

Source: `pear_sft_final.jsonl` (records `{prompt, trace, gold, source, role}`).
The Kaggle script maps:

- `role == "positive"` (verified-correct trace) → **label 1**
- `role == "negative"` (wrong trace)            → **label 0**

Each becomes a `(query, document, label)` example where:

```
query    = "QUESTION: <question extracted from prompt>\nVERIFIED: (none)"
document = <the reasoning trace / answer>
```

> Negatives are only mined for math/commonsense in the PEAR builder, so the set
> is positive-heavy on sqa/mmlu. If the gate ends up too lenient, add hard
> negatives (e.g. mismatched answers) or regenerate with on-policy sampling.

## The query/document contract (keep in sync)

`make_query()` in `scripts/kaggle_reward_gate.py` and `makeQuery()` in
`src/lib/reward.ts` must produce the **same** query string. At serve time the
app fills `VERIFIED` with the executed ground-truth result; in training it's
`(none)`. If you change the format, change both.

## Train on Kaggle (2× T4)

1. Add your PEAR traces dataset as a Kaggle input (the script finds
   `**/pear*final*.jsonl`).
2. New notebook, **Accelerator = GPU T4 ×2, Internet = ON**.
3. Paste the cells from `scripts/kaggle_reward_gate.py` and run.
   - imports `BAAI/bge-reranker-base` from HF, fine-tunes (DataParallel over both T4s),
   - prints a sanity check (good answer should score higher than bad),
   - clones llama.cpp and runs `convert_hf_to_gguf.py` → `reward-gate.gguf`.
4. Download `/kaggle/working/reward-gate.gguf`.

## Deploy on-device

Drop it at `models/reward-gate.gguf`. Switch to **Reasoning** mode (the control
server auto-spawns `llama-server --reranking` on `:8084`); the "reward (bge)"
chip turns ready and the gate's score bar appears on each answer.

> Needs a `llama-server` build that supports `--reranking` (current llama.cpp
> does). It's the same binary as `LLAMA_SERVER`.

## Tuning

- **Threshold:** `GATE_THRESHOLD = 0.6` in `src/lib/agent.ts`.
- **Quantize** (optional): the script emits f16; shrink with your existing
  `quantize.sh`/`llama-quantize` to Q8_0 if you want a smaller file.
- **Filename/port:** override with `REWARD_MODEL` / `REWARD_PORT` on the control
  server.
