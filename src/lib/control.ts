// Client for the local control server (model discovery + load).

// dev: Vite proxies /api -> 8081. packaged app: call the control server directly.
const API = import.meta.env.DEV ? "" : "http://127.0.0.1:8081";

export interface ModelEntry {
  name: string;
  path: string;
  type: "gguf" | "archive";
  sizeMB: number;
  active: boolean;
}

export interface ModelStatus {
  model: string | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
}

export async function listModels(): Promise<{ models: ModelEntry[]; modelsDir: string }> {
  const r = await fetch(`${API}/api/models`);
  if (!r.ok) throw new Error(`models ${r.status}`);
  return r.json();
}

export async function getStatus(): Promise<ModelStatus> {
  const r = await fetch(`${API}/api/status`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

export async function selectModel(file: string): Promise<void> {
  const r = await fetch(`${API}/api/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(body.error || `select ${r.status}`);
  }
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function execCode(code: string): Promise<ExecResult> {
  const r = await fetch(`${API}/api/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({ error: r.statusText }));
    return { ok: false, stdout: "", stderr: b.error || `exec ${r.status}`, timedOut: false };
  }
  return r.json();
}

// ---- auxiliary service: the reward-gate GGUF (bge-reranker, --reranking) ----
export interface AuxOne {
  ready: boolean;
  loading: boolean;
  error: string | null;
  missing: boolean;
  file: string; // GGUF filename under models/
  port: number;
}
export interface AuxStatus {
  reward: AuxOne;
}

export async function ensureAux(): Promise<AuxStatus> {
  const r = await fetch(`${API}/api/aux/ensure`, { method: "POST" });
  if (!r.ok) throw new Error(`aux ensure ${r.status}`);
  return r.json();
}

export async function getAux(): Promise<AuxStatus> {
  const r = await fetch(`${API}/api/aux/status`);
  if (!r.ok) throw new Error(`aux status ${r.status}`);
  return r.json();
}

// ---- preference-trace store (LoRA training data) ----
export type TraceLabel = "positive" | "negative" | "unlabeled";
export type Feedback = "up" | "down" | null;

export interface TraceEntry {
  id: string;
  ts: string;
  mode: string;
  problem: string;
  cot: string;
  answer: string;
  reward: number | null;
  feedback: Feedback;
  label: TraceLabel;
}

// log a (prompt, CoT, answer) example; returns its id so feedback can attach later
export async function logTrace(entry: {
  mode: string;
  problem: string;
  cot: string;
  answer: string;
  reward: number | null;
}): Promise<string | null> {
  try {
    const r = await fetch(`${API}/api/traces/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    return r.ok ? (await r.json()).id ?? null : null;
  } catch {
    return null;
  }
}

export async function traceFeedback(id: string, feedback: Feedback): Promise<void> {
  try {
    await fetch(`${API}/api/traces/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, feedback }),
    });
  } catch {
    /* best-effort */
  }
}

export async function listTraces(): Promise<TraceEntry[]> {
  try {
    const r = await fetch(`${API}/api/traces/list`);
    return r.ok ? (await r.json()).traces ?? [] : [];
  } catch {
    return [];
  }
}

export async function clearTraces(): Promise<void> {
  await fetch(`${API}/api/traces/clear`, { method: "POST" });
}

// true if the control server itself is up (vs. not started yet)
export async function controlUp(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/status`);
    return r.ok;
  } catch {
    return false;
  }
}
