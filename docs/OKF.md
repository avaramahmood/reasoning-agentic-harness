# OKF — local memory for offline SLM (how it works & how to use it)

OKF (Open Knowledge Format) is "a directory of markdown files with YAML
frontmatter." This app uses it as the model's **long-term memory about you**:
plain files you can read/edit, no database, no cloud. Two halves — **remember**
and **fetch** — designed so a weak offline model can't break them.

```
okf-store/
├── index.md            (auto: a listing of everything)
├── log.md              (auto: change history)
├── people/avara.md     (one concept = one .md file)
└── projects/riva.md
```

A concept file:

```markdown
---
type: Person                 # the only REQUIRED field (OKF conformance)
title: Avara
tags: [identity, name]
timestamp: 2026-07-01T...
---
The user's name is Avara.
```

## Remember (write) — rules first, SLM second

The hard part for an SLM is *deciding what to store and emitting clean data*.
So capture does **not** depend on the model for the common cases:

1. **Deterministic rules** (`src/lib/extract.ts`) match high-precision patterns
   in your message and produce clean concepts with **no model call**:
   - "my name is X" / "call me X" / "I'm X" → `Person`
   - "I work at X" → employer · "I'm a <role>" → `Person`
   - "I live in X" → location
   - "I'm building/working on X" → `Project`
   - "I'm preparing for / planning to X" → `Goal`
   - "I prefer/like/dislike X", "always answer concisely" → `Preference`
   - "remember that X" → `Note`
2. **SLM fallback** — only if the rules find nothing, the 7B is asked to extract
   facts (for unusual phrasings). Task content (math/coding problems, pasted
   docs) is filtered out so it never pollutes memory.
3. **Dedupe** — a fact whose title already exists is skipped (no duplicates).

Capture runs automatically after each turn. It writes plain `.md` files; the
Memory panel lets you view/add/edit/delete/clear them by hand too.

## Fetch (retrieve) — whole-profile injection

Keyword search is the wrong tool for a *personal* store: "what is my name" shares
no words with a concept about "Avara". So:

- **Small store (≤30 facts) → inject the ENTIRE profile** as ground truth before
  every answer. 100% recall, phrasing-proof, offline. This is the normal case.
- **Large store (>30) → keyword search + ALWAYS include identity facts**
  (Person/Preference/Goal/…), so personal questions still never miss.

The injected block is shown in the **Recall** card each turn, and the system
prompt tells the model: *"answer questions about the user directly from this."*

## How to use it

Just talk naturally — no commands needed:

| You say | What gets stored |
|---|---|
| `My name is Avara` | Person: "The user's name is Avara." |
| `I work at RIVA Labs` | Fact: "The user works at RIVA Labs." |
| `I'm a software engineer` | Person: "The user is a software engineer." |
| `I'm building an on-device agent` | Project |
| `I'm preparing for a system-design interview` | Goal |
| `I prefer concise answers` | Preference |
| `Remember that my deadline is Friday` | Note |

Then ask, in any phrasing: `what is my name?` · `where do I work?` ·
`what am I preparing for?` · `tell me about myself` — all fetch from OKF.

Manage it in the **Memory** panel (Settings): add/edit/delete a fact, or **Clear
all**. Files live in `okf-store/` — open them in any editor.

## Guarantees / limits

- ✅ The common personal statements are captured **deterministically** (no model
  needed) and recalled **regardless of question wording**.
- ✅ All of it is offline, human-readable markdown you fully control.
- ⚠️ Very unusual phrasings rely on the SLM fallback (best-effort).
- ⚠️ Retrieval is whole-profile (small store), not vector search — perfect for
  personal facts; for a huge knowledge base you'd add an embedder behind the same
  `recall()` contract.

Everything here is covered by `npm test` (extraction across many phrasings +
the full remember→store→fetch loop + endpoints + load).
