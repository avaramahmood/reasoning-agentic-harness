# Preference-Trace Store — LoRA training data

A store **separate from OKF**. OKF holds *what the model knows* (user facts);
this holds *how well the model answered* — positive/negative `(prompt, CoT, answer)`
examples for adjusting the **LoRA personalization layer** later (offline).

- File: `data/traces.jsonl` (gitignored, append-only; feedback rewrites in place)
- Written automatically after every **Reasoning** run
- Browsable + clearable in the **Memory** panel ("Training traces")

## How a trace is labeled

Two signals, exactly as requested:

1. **CoT quality** — the reward-gate score of the reasoning. At log time:
   `reward ≥ 0.45 → positive`, else `negative` (matches `GATE_THRESHOLD`).
2. **User satisfaction** — the 👍/👎 on the answer **overrides** the reward label
   (`up → positive`, `down → negative`). This is the point: align the LoRA to what
   the user actually liked, not just the gate's guess.

## Record schema

```json
{
  "id": "t_mr11x2ee",
  "ts": "2026-07-01T...",
  "mode": "reasoning",
  "problem": "the user's prompt",
  "cot": "the <think> chain-of-thought",
  "answer": "the final answer",
  "reward": 0.30,            // reward-gate score, or null if gate was off
  "feedback": "up",          // "up" | "down" | null
  "label": "positive"        // derived: feedback overrides reward
}
```

## Consuming it for LoRA (offline, on Kaggle)

The format maps directly onto the two standard recipes — and onto your existing
PEAR `role: positive|negative` convention:

- **SFT** (cheapest): train on `positive` traces only — `prompt → "<think>{cot}</think><answer>{answer}</answer>"`. Teaches the model your preferred style/format on answers you approved.
- **DPO / preference** (stronger): pairs of `(prompt, chosen=positive, rejected=negative)` for the same/similar prompt. Use `feedback`-labeled rows first (real human signal), fall back to reward-labeled.

A LoRA training script mirrors `scripts/kaggle_reward_gate.py`: load `traces.jsonl`,
filter by `label`, build SFT or DPO data, fine-tune a rank-16 LoRA on the frozen 7B,
export, and load at inference with llama.cpp's `--lora` flag.

> Quality gate: prefer rows where `feedback` is set (true human signal) and, for
> reward-only rows, keep the clearly-separated ones (high-positive / low-negative)
> — mirrors the reward-gate training advice (avoid the ambiguous middle).
