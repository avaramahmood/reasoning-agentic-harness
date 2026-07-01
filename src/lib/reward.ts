// Client for the on-device reward gate — a bge-reranker cross-encoder served as
// GGUF by `llama-server --reranking` (control server spawns it on :8084).
//
// We score the candidate answer as a (query, document) rerank pair:
//   query = "QUESTION: <problem>\nVERIFIED: <executed result>"   (matches training)
//   doc   = the candidate answer
// llama.cpp returns a relevance_score; we squash it to [0,1] with a sigmoid.
// Returns null if the gate is unavailable so the pipeline can skip it.

const REWARD_BASE = import.meta.env.DEV ? "/reward" : "http://127.0.0.1:8084";

// KEEP IN SYNC with scripts/kaggle_reward_gate.py -> make_query()
function makeQuery(problem: string, verified: string): string {
  return `QUESTION: ${problem}\nVERIFIED: ${verified || "(none)"}`;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export async function scoreReward(
  problem: string,
  verified: string,
  answer: string,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const r = await fetch(`${REWARD_BASE}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ query: makeQuery(problem, verified), documents: [answer] }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = j.results?.[0]?.relevance_score;
    return typeof raw === "number" ? sigmoid(raw) : null;
  } catch {
    return null; // reranker not running / not trained yet -> gate skipped
  }
}
