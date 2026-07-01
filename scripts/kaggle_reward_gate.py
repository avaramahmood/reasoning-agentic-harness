# =============================================================================
# SMAE Reward Gate — Kaggle training (2x T4)  →  GGUF reranker
# =============================================================================
# Fine-tunes BAAI/bge-reranker-base (cross-encoder) on your PEAR positive/negative
# traces, then converts to GGUF so the app serves it via `llama-server --reranking`.
#
# Paste these cells into a Kaggle notebook (Accelerator = GPU T4 x2, Internet ON).
# Output: /kaggle/working/reward-gate.gguf  →  drop into the app at
#         models/reward-gate.gguf
#
# WHY a reranker: a reward gate is a cross-encoder "does this ANSWER fit this
# QUESTION" scorer. bge-reranker is exactly that, and llama.cpp converts/serves
# it as GGUF (unlike a DeBERTa classifier head) — so everything stays on llama.cpp.
# =============================================================================


# %% [cell 1] deps -----------------------------------------------------------
# torch is preinstalled on Kaggle.
!pip -q install -U transformers sentencepiece datasets


# %% [cell 2] config + build (query, answer, label) from PEAR traces ---------
import json, glob, os, random, math

BASE      = "BAAI/bge-reranker-base"     # XLM-RoBERTa cross-encoder, llama.cpp-convertible
SAVE_DIR  = "/kaggle/working/reward-gate-hf"
GGUF_OUT  = "/kaggle/working/reward-gate.gguf"
MAX_LEN   = 320
EPOCHS    = 3
BATCH     = 32           # effective batch across the 2 T4s
LR        = 2e-5
SEED      = 0

# PEAR traces: {prompt, trace, gold, source, role: positive|negative}
# Add the dataset as a Kaggle input; this finds it recursively.
PEAR_GLOB = "/kaggle/input/**/pear*final*.jsonl"   # aligned or non-aligned both fine

# --- canonical query/doc format — MUST match the app (src/lib/reward.ts) ---
# query = the question (+ executed VERIFIED result at serve time); doc = the answer.
def make_query(problem, verified=""):
    return f"QUESTION: {problem}\nVERIFIED: {verified or '(none)'}"

def extract_question(prompt: str) -> str:
    # PEAR prompts are few-shot; the real question is after the LAST "Question:".
    tail = prompt.rsplit("Question:", 1)[-1].strip()
    for marker in ("\nAnswer", "\n<think>", "\nLet's", "\nThink", "\n\n"):
        i = tail.find(marker)
        if i != -1:
            tail = tail[:i].strip()
    return tail or prompt.strip()

random.seed(SEED)
paths = glob.glob(PEAR_GLOB, recursive=True)
assert paths, f"No PEAR traces found under {PEAR_GLOB} — add the dataset as a Kaggle input."
print("PEAR files:", paths)

rows = []           # (query, doc, label)
pos = neg = 0
for p in paths:
    for line in open(p):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        role = r.get("role")
        if role not in ("positive", "negative"):
            continue
        q = extract_question(r.get("prompt", ""))
        doc = (r.get("trace", "") or "").strip()
        if not q or not doc:
            continue
        label = 1.0 if role == "positive" else 0.0
        rows.append((make_query(q), doc, label))
        pos += role == "positive"; neg += role == "negative"

random.shuffle(rows)
assert rows, "No usable rows (need records with role + prompt + trace)."
n_val      = max(1, int(0.1 * len(rows)))
val_rows   = rows[:n_val]
train_rows = rows[n_val:]
n_pos = sum(1 for *_, y in train_rows if y == 1.0)
n_neg = len(train_rows) - n_pos
print(f"examples: {len(rows)} (pos={pos}, neg={neg})  |  train={len(train_rows)} val={len(val_rows)}")
print(f"train balance: pos={n_pos} neg={n_neg}")


# %% [cell 3] fine-tune the cross-encoder (both T4s) -------------------------
import numpy as np, torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.manual_seed(SEED); np.random.seed(SEED)
device = "cuda" if torch.cuda.is_available() else "cpu"

tok   = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForSequenceClassification.from_pretrained(BASE, num_labels=1).to(device)

n_gpu = torch.cuda.device_count()
print(f"GPUs: {n_gpu}")
if n_gpu > 1:
    model = torch.nn.DataParallel(model)   # split each batch across the 2 T4s

class DS(Dataset):
    def __init__(self, rows): self.rows = rows
    def __len__(self): return len(self.rows)
    def __getitem__(self, i): return self.rows[i]

def collate(batch):
    q  = [a for a, _, _ in batch]
    d  = [b for _, b, _ in batch]
    y  = torch.tensor([c for _, _, c in batch], dtype=torch.float)
    enc = tok(q, d, truncation=True, max_length=MAX_LEN, padding=True, return_tensors="pt")
    return enc, y

dl      = DataLoader(DS(train_rows), batch_size=BATCH, shuffle=True, collate_fn=collate)
opt     = torch.optim.AdamW(model.parameters(), lr=LR)
pw      = torch.tensor([n_neg / max(1, n_pos)], device=device)   # down-weights the dominant positives
loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pw)

model.train()
for ep in range(EPOCHS):
    total = 0.0
    for enc, y in dl:
        enc = {k: v.to(device) for k, v in enc.items()}
        y = y.to(device)
        logits = model(**enc).logits.squeeze(-1)
        loss = loss_fn(logits, y)
        opt.zero_grad(); loss.backward(); opt.step()
        total += loss.item()
    print(f"epoch {ep+1}/{EPOCHS}  loss={total/len(dl):.4f}")


# %% [cell 4] sanity check + save HF model -----------------------------------
m = (model.module if isinstance(model, torch.nn.DataParallel) else model).eval()

@torch.no_grad()
def score_pair(query, doc):
    enc = tok(query, doc, truncation=True, max_length=MAX_LEN, return_tensors="pt").to(m.device)
    return torch.sigmoid(m(**enc).logits).item()

pos_scores = [score_pair(q, d) for q, d, y in val_rows if y == 1.0]
neg_scores = [score_pair(q, d) for q, d, y in val_rows if y == 0.0]
import statistics as st
print(f"val positives: mean={st.mean(pos_scores):.3f} n={len(pos_scores)}" if pos_scores else "no val positives")
print(f"val negatives: mean={st.mean(neg_scores):.3f} n={len(neg_scores)}" if neg_scores else "no val negatives")
if pos_scores and neg_scores:
    best_t, best_acc = 0.5, 0.0
    for t in sorted(set(pos_scores + neg_scores)):
        acc = (sum(s >= t for s in pos_scores) + sum(s < t for s in neg_scores)) / (len(pos_scores) + len(neg_scores))
        if acc > best_acc: best_acc, best_t = acc, t
    print(f"suggested GATE_THRESHOLD ~= {best_t:.2f}  (val acc {best_acc:.2f})")

m.to("cpu").save_pretrained(SAVE_DIR)
tok.save_pretrained(SAVE_DIR)
print("saved HF model ->", SAVE_DIR)


# %% [cell 5] convert to GGUF (no build needed — pure-python converter) -------
!git clone --depth 1 https://github.com/ggml-org/llama.cpp /kaggle/working/llama.cpp
!pip -q install -r /kaggle/working/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
!python /kaggle/working/llama.cpp/convert_hf_to_gguf.py {SAVE_DIR} --outfile {GGUF_OUT} --outtype f16

import os
print("\nGGUF:", GGUF_OUT, f"({os.path.getsize(GGUF_OUT)/1e6:.0f} MB)" if os.path.exists(GGUF_OUT) else "MISSING")
print("download it and drop into the app at  models/reward-gate.gguf")
