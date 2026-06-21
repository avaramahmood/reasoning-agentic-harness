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

// true if the control server itself is up (vs. not started yet)
export async function controlUp(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/status`);
    return r.ok;
  } catch {
    return false;
  }
}
