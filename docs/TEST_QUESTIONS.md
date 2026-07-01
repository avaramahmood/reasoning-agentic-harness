# Test Questions — full capability sweep

A scripted run-through to exercise every part of the system: Reasoning
pipeline, deterministic execution, reward gate, OKF memory (write/recall/filter),
and the other modes. Each item says **what to do** and **what "good" looks like**.

> Setup: control server + `npm run dev` running, 7B loaded, **Reasoning** mode
> selected so the `reward (bge)` chip is green (the 0.5B planner has been removed —
> Reasoning is now direct 7B chain-of-thought).

---

## 1. Counting / enumeration (the strawberry class)

These must be **executed**, never guessed. Watch for an `Execute` card
and an `Execute` card with the real result.

1. `How many r's are in "strawberry"?` → **3**, grounded by code.
2. `How many times does the letter "s" appear in "mississippi"?` → **4**.
3. `How many days of the week start with the letter T?` → **2**.
4. `How many months have exactly 31 days?` → **7**.
5. `Reverse the string "reasoning".` → **gninosaer**.

✅ Good: `Execute` card shows the computed value; final answer matches it; reward
score is high (passes). ❌ Bad: answer differs from the executed value.

## 2. Arithmetic

1. `What is 17 × 23 − 145?` → **246**.
2. `What is 1234 × 5678?` → **7,006,652**.
3. `What is 15% of 1,200?` → **180**.

✅ Good: a `COMPUTE` step runs the math; answer = executed output.

## 3. Math word problems (multi-step reasoning + CoT)

1. `Tobias is buying shoes that cost $95. He saves a $5 allowance each month for 3 months, charges $15 to mow a lawn and $7 to shovel a driveway. After buying the shoes he has $15 left. If he mows 4 lawns, how many driveways did he shovel?` → **5**.
2. `A train travels 60 km in the first hour, 80 km in the second, and 100 km in the third. What is its average speed?` → **80 km/h**.
3. `If a shirt costs $40 after a 20% discount, what was the original price?` → **$50**.

✅ Good: the `Generate` card shows step-by-step CoT in the reasoning area; the
final answer is correct; reward score passes (≥45). This is the case that used to
get wrongly rejected — confirm it now **passes**.

## 4. Code generation (any-length answers)

These verify the `<answer>` is no longer truncated to one line / "Yes".

1. `Write a Python function that counts how many times any given letter appears in any word, with a couple of test cases.`
2. `Write a Python script that reads a CSV of server logs, fixes timestamps formatted as DD/MM/YYYY into YYYY-MM-DD HH:MM:SS, flags any server with more than 45 errors in a rolling 10-minute window, and writes the flagged server IDs to reboot_list.txt.`
3. `Write a bash one-liner to find the 5 largest files under the current directory.`

✅ Good: the `<answer>` contains the **complete code**, multi-line, not "Yes" or a
single line. ❌ Bad: one-word / one-line answer.

## 5. Memory — WRITE then RECALL (the core loop)

Run these **in order**, as separate turns, with "Ground answers" ON.

1. `My name is Avara and I'm building an on-device SLM agent called RIVA.`
2. `I prefer concise, technical answers and I dislike long explanations.`
3. `I'm preparing for a system-design interview next week.`
   - After each: open the **Memory** panel → a new concept should appear
     (Person / Preference / Goal), with a sensible `type` (not `Person|Project|Note`)
     and a non-empty body.
4. Now ask: `What do you know about me?`
   - ✅ Good: the **Recall** card retrieves the stored facts and the answer uses
     them (name Avara, RIVA, concise preference, interview goal).
5. `Based on what you know about me, suggest how I should answer interview questions.`
   - ✅ Good: it tailors to "concise/technical" + "system-design interview".

## 6. Memory — must NOT store task content (the filter)

These should add **nothing** to the store (they're tasks, not user facts).

1. The Tobias problem from §3.1.
2. The CSV log script from §4.2.
3. `What is the capital of France?`

✅ Good: after each, the Memory panel count does **not** increase. ❌ Bad: it
stores "Tobias", "server logs", "France", etc. (the old bug).

## 7. Reward gate (scoring)

1. Ask a §3 word problem and let it answer correctly → score should be **high**,
   "released ✓", and a row appears under **Reward scores** in the Memory panel.
2. To see a **resample**: ask something the 7B is likely to get shaky on, e.g.
   `What is the 12th prime number?` (correct: 37) — if the first answer is off,
   the gate should drop below 45, show "→ resampling", and keep the better of the
   two attempts (never replace a higher-scored answer with a worse one).

✅ Good: scores persist in the panel; `clear` empties them.

## 8. Memory + scores housekeeping

1. Memory panel → **Clear all** → confirm → store empties (count → 0).
2. Reward scores → **clear** → list empties.
3. Re-run a §5 write → store repopulates (proves it's live, not cached).

## 9. Other modes (regression)

- **Knowledge** mode: `Who wrote the play Hamlet?` → fast single-pass answer.
- **Thinking** mode: `How many vowels are in "encyclopedia"?` → ReAct loop writes
  code, returns **5**.

## 10. Edge / robustness

1. `Sort these numbers descending: 42, 7, 13, 99, 1, 56.` → 99, 56, 42, 13, 7, 1.
2. `How many days are between 2026-01-01 and 2026-03-01?` → **59**.
3. Empty / nonsense input → should not crash; graceful answer.
4. Pull the reward GGUF (rename it) and run §3.1 → gate shows "unavailable —
   skipped", pipeline still answers. (Confirms graceful degradation.)

---

## What each pipeline card means

| Card | Source | Healthy sign |
|---|---|---|
| **Recall** | OKF facts + attached doc chunks | retrieves relevant facts/chunks (or "none") |
| **Reasoning / Continue** | 7B chain-of-thought | step-by-step CoT; writes code when needed |
| **Execute** | deterministic Python | real computed output, `exit 0 ✓` |
| **Reward gate** | bge-reranker GGUF | score bar; high = released, low = resample |
