// Tiny dependency-free keyword retrieval (TF overlap), shared by document RAG.
// Same idea as the OKF store's server-side search, but for in-browser chunks.

const STOP = new Set(
  "a an the of to in on for and or is are was were be been being do does did has have had i you he she it we they this that these those with as at by from about what which who how when where why can could should would will not".split(
    " "
  )
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !STOP.has(t));
}

// Cut runaway degeneration: a char repeated 12+ times, or a short token repeated
// many times — the "ئئئئ…" / symbol-spew small quantized models fall into.
export function stripRunaway(s: string): string {
  let out = s;
  const run = out.match(/(.)\1{11,}/);
  if (run && run.index !== undefined) out = out.slice(0, run.index);
  const tokRun = out.match(/(\S{1,4})(?:\s*\1){8,}/);
  if (tokRun && tokRun.index !== undefined) out = out.slice(0, tokRun.index);
  return out.trim();
}

// Full output cleanup for a quantized model: runaway spew + a cluster of non-Latin
// script (Hebrew/Arabic/CJK = degeneration for an English assistant) + whole-line
// repetition loops (the model "finishes" then restarts the same answer). Newline-
// aware so code blocks survive.
export function cleanModelOutput(s: string): string {
  let out = stripRunaway(s);
  // cut at the URL-spam degeneration marker (the "xmlhttp://www..." loops)
  const url = out.search(/xmlhttp|https?:\/\/www\.(?:google|bing|yahoo|facebook|twitter|github|stackoverflow)/i);
  if (url !== -1) out = out.slice(0, url);
  // handle foreign-script noise (Hebrew/Arabic/CJK degeneration) line-by-line:
  // strip it, but DROP the line entirely if only residue (":", numbers) remains —
  // keeps good English lines instead of throwing everything after it away.
  const FT = /[֐-׿؀-ۿ܀-ࣿ぀-ヿ一-鿿]{2,}/;
  const FG = /[֐-׿؀-ۿ܀-ࣿ぀-ヿ一-鿿]{2,}/g;
  out = out
    .split("\n")
    .map((line) => {
      if (!FT.test(line)) return line;
      const cleaned = line.replace(FG, " ").replace(/\s+/g, " ").trim();
      return /[a-zA-Z]{2,}/.test(cleaned) ? cleaned : "";
    })
    .join("\n");
  // cut at a self-generated follow-up "user turn" (the model role-playing the
  // user after it has already answered — the main over-generation cause).
  const ls = out.split("\n");
  for (let i = 1; i < ls.length; i++) {
    if (
      /^\s*(?:can you (?:provide|give|tell|help|write|generate|create|show)|i'?m trying to|i want to|i need (?:you )?to|how (?:do|can) i\b|please (?:write|give|provide)|question:|user:|human:|here'?s another)/i.test(
        ls[i]
      )
    ) {
      out = ls.slice(0, i).join("\n");
      break;
    }
  }
  // stop at a repeated block. Long prose lines are keyed by their first 60 chars
  // so a TRUNCATED repeat (the model restarts the paragraph but gets cut off)
  // still matches; short lines (code) are matched exactly so real code survives.
  const lines = out.split("\n");
  const seenLong = new Set<string>();
  const seenExact = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const norm = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (norm.length >= 40) {
      const key = norm.slice(0, 60);
      if (seenLong.has(key)) break; // repeated paragraph -> stop
      seenLong.add(key);
    } else if (norm.length > 20) {
      if (seenExact.has(norm)) break;
      seenExact.add(norm);
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Scored<T> {
  item: T;
  score: number;
}

// Rank items by query-token overlap against their text (TF-weighted), top k.
export function rankByKeyword<T>(query: string, items: T[], textOf: (t: T) => string, k = 4): Scored<T>[] {
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  const out: Scored<T>[] = [];
  for (const item of items) {
    const counts = new Map<string, number>();
    for (const tok of tokenize(textOf(item))) counts.set(tok, (counts.get(tok) || 0) + 1);
    let score = 0;
    for (const term of q) score += counts.get(term) || 0;
    if (score > 0) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}
