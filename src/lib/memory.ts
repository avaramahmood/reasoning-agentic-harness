// OKF auto-capture — deterministic, rules-only.
//
// The SLM fallback was dropped: it hallucinated facts (e.g. "the user's email is
// unknown"). Everything here is regex rules (src/lib/extract.ts) so capture is
// clean, offline, and never invents anything.
//
// "remember this" / "save it to memory" carry no content of their own, so they
// capture from the PREVIOUS user message instead.

import { extractFactsRules, isBareSaveCommand, sigTokens, subset } from "./extract";
import { putConcept, existingTexts } from "./okf";

// Returns the number of NEW concepts saved (0 if nothing / all dupes).
export async function captureMemory(userMsg: string, prevUserMsg?: string, signal?: AbortSignal): Promise<number> {
  void signal;
  const source = isBareSaveCommand(userMsg) && prevUserMsg ? prevUserMsg : userMsg;
  const facts = extractFactsRules(source);
  if (!facts.length) return 0;

  // Dedupe CONSERVATIVELY. Only skip a new fact when it is FULLY redundant —
  // i.e. every significant token in it is already present in one existing
  // concept (new adds nothing). We deliberately do NOT skip when an existing
  // concept is a subset of the new fact: that direction dropped real data (a
  // one-word "Dosa" concept swallowed a whole "pizza, dosa, sushi, burritos"
  // list because {dosa} ⊆ {pizza,dosa,sushi,burrito}). Losing the user's data
  // is far worse than an occasional near-duplicate, so we bias toward saving.
  const seen = (await existingTexts()).map((t) => sigTokens(t));
  let n = 0;
  for (const f of facts) {
    const ft = sigTokens(f.title + " " + f.body);
    if (seen.some((g) => subset(ft, g))) continue; // new ⊆ existing -> nothing new
    try {
      await putConcept({ type: f.type, title: f.title, body: f.body, tags: f.tags });
      seen.push(ft);
      n++;
    } catch {
      /* skip a malformed fact */
    }
  }
  return n;
}
