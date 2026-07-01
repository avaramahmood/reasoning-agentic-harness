// Client for the local OKF knowledge store (served by the control server).
// Fully on-device: these calls hit 127.0.0.1 only — no cloud, ever.

const API = import.meta.env.DEV ? "" : "http://127.0.0.1:8081";

export interface OkfConcept {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  meta: Record<string, unknown>;
  body?: string;
  bodyChars?: number;
}

export interface OkfHit {
  id: string;
  score: number;
  type: string;
  title: string;
  description: string;
  snippet: string;
  meta: Record<string, unknown>;
}

export interface OkfPut {
  id?: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  resource?: string;
  body?: string;
  extra?: Record<string, unknown>;
}

export async function listConcepts(): Promise<{ concepts: OkfConcept[]; storeDir: string }> {
  const r = await fetch(`${API}/api/okf/list`);
  if (!r.ok) throw new Error(`okf list ${r.status}`);
  return r.json();
}

export async function searchConcepts(query: string, k = 4): Promise<OkfHit[]> {
  const r = await fetch(`${API}/api/okf/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, k }),
  });
  if (!r.ok) return [];
  return (await r.json()).hits ?? [];
}

// recall = the grounding the model gets: whole profile if the store is small,
// else search + always-identity. Returns a ready context block + the facts used.
export async function recall(query: string): Promise<{ context: string; hits: OkfHit[] }> {
  try {
    const r = await fetch(`${API}/api/okf/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) return { context: "", hits: [] };
    return await r.json();
  } catch {
    return { context: "", hits: [] };
  }
}

export async function putConcept(c: OkfPut): Promise<{ id: string }> {
  const r = await fetch(`${API}/api/okf/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `okf put ${r.status}`);
  return j;
}

export async function deleteConcept(id: string): Promise<void> {
  const r = await fetch(`${API}/api/okf/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`okf delete ${r.status}`);
}

export async function clearConcepts(): Promise<number> {
  const r = await fetch(`${API}/api/okf/clear`, { method: "POST" });
  if (!r.ok) throw new Error(`okf clear ${r.status}`);
  return (await r.json()).removed ?? 0;
}

// existing concept titles — used by capture to dedupe before writing
export async function existingTitles(): Promise<string[]> {
  try {
    const { concepts } = await listConcepts();
    return concepts.map((c) => c.title.toLowerCase().trim());
  } catch {
    return [];
  }
}

// existing concepts' full text (title + body) — used by capture to dedupe. Body
// matters: "prefers concise, technical answers" lives in the body, not the title,
// so title-only dedup would re-add a paraphrase of an existing fact.
export async function existingTexts(): Promise<string[]> {
  try {
    const { concepts } = await listConcepts();
    return concepts.map((c) => `${c.title} ${c.body ?? ""}`.toLowerCase().trim());
  } catch {
    return [];
  }
}

// Render hits into a grounding block injected into the model prompt.
export function hitsToContext(hits: OkfHit[]): string {
  if (!hits.length) return "";
  return hits
    .map((h) => {
      const facts = factLine(h.meta);
      return `- [${h.id}] ${h.title}${h.type ? ` (${h.type})` : ""}${facts ? ` — ${facts}` : ""}${
        h.snippet ? `\n    ${h.snippet}` : ""
      }`;
    })
    .join("\n");
}

function factLine(meta: Record<string, unknown>): string {
  const skip = new Set(["type", "title", "description", "resource", "tags", "timestamp"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta || {})) {
    if (skip.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parts.push(`${k}: ${Object.entries(v as Record<string, unknown>).map(([kk, vv]) => `${kk} ${vv}`).join(", ")}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}: ${(v as unknown[]).join(", ")}`);
    } else if (v !== "" && v != null) {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join("; ");
}
