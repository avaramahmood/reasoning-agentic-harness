// Local knowledge store (OKF) browser + editor.
// Everything here is on-device: it talks only to the local control server, which
// reads/writes plain markdown files under ./okf-store. No cloud, no Claude.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, X, Plus, ThumbsUp, ThumbsDown } from "lucide-react";
import { listConcepts, putConcept, deleteConcept, clearConcepts, OkfConcept } from "../lib/okf";
import { listTraces, clearTraces, TraceEntry } from "../lib/control";

export default function MemoryPanel({
  memoryOn,
  onToggle,
  refreshKey = 0,
}: {
  memoryOn: boolean;
  onToggle: (v: boolean) => void;
  refreshKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [concepts, setConcepts] = useState<OkfConcept[]>([]);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [storeDir, setStoreDir] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");

  // new-concept form
  const [type, setType] = useState("Person");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");

  async function refresh() {
    try {
      const r = await listConcepts();
      setConcepts(r.concepts);
      setStoreDir(r.storeDir);
      setTraces(await listTraces());
      setErr("");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function clearAllConcepts() {
    if (!confirm("Delete ALL stored facts? This cannot be undone.")) return;
    try {
      await clearConcepts();
      refresh();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function clearAllTraces() {
    await clearTraces();
    refresh();
  }

  // refresh on open and whenever auto-capture bumps refreshKey (keeps the count + list current)
  useEffect(() => {
    refresh();
  }, [open, refreshKey]);

  async function add() {
    if (!title.trim() || !type.trim()) return;
    try {
      await putConcept({
        type: type.trim(),
        title: title.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        body: body.trim(),
      });
      setTitle("");
      setTags("");
      setBody("");
      setAdding(false);
      refresh();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function remove(id: string) {
    await deleteConcept(id);
    refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 p-3.5">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-muted-foreground">
            {open ? <ChevronDown className="h-4 w-4" strokeWidth={2.5} /> : <ChevronRight className="h-4 w-4" strokeWidth={2.5} />}
          </span>
          Memory
          <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {concepts.length || "OKF"} local
          </span>
        </button>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <span>Ground answers</span>
          <input
            type="checkbox"
            checked={memoryOn}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 rounded accent-[var(--primary)]"
          />
        </label>
      </div>

      {open && (
        <div className="border-t border-border p-3">
          <p className="mb-2 text-[11px] text-muted-foreground">
            Plain markdown + YAML (OKF) under <code className="font-mono">{storeDir || "./okf-store"}</code>. Retrieved
            facts are injected as ground truth before the model answers.
          </p>

          {err && <p className="mb-2 text-xs text-destructive">{err}</p>}

          <div className="space-y-2">
            {concepts.map((c) => (
              <div key={c.id} className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.title}</span>
                    <span className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">
                      {c.type}
                    </span>
                  </div>
                  {c.description && <div className="text-[13px] text-muted-foreground">{c.description}</div>}
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{c.id}</div>
                </div>
                <button
                  onClick={() => remove(c.id)}
                  className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive"
                  title="Delete"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </div>
            ))}
            {!concepts.length && <p className="text-xs text-muted-foreground">No concepts yet.</p>}
          </div>

          {adding ? (
            <div className="mt-3 space-y-2 rounded-md border border-border p-3">
              <div className="flex gap-2">
                <input
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  placeholder="Type (e.g. Person)"
                  className="w-1/3 rounded-md bg-muted px-3 py-2 text-sm outline-none"
                />
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title (e.g. John Smith)"
                  className="flex-1 rounded-md bg-muted px-3 py-2 text-sm outline-none"
                />
              </div>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tags, comma, separated"
                className="w-full rounded-md bg-muted px-3 py-2 text-sm outline-none"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Details / facts (markdown). e.g. Marks: DSA 87, ML 92. Project: RAG legal docs."
                rows={3}
                className="w-full resize-none rounded-md bg-muted px-3 py-2 text-sm outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={add}
                  disabled={!title.trim()}
                  className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                >
                  Save
                </button>
                <button onClick={() => setAdding(false)} className="rounded-md px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
                Add fact
              </button>
              {!!concepts.length && (
                <button
                  onClick={clearAllConcepts}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          {/* preference-trace store (LoRA training data) */}
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Training traces
              </span>
              <span className="flex items-center gap-1.5 text-[10px] font-medium">
                <span className="text-primary">{traces.filter((t) => t.label === "positive").length} pos</span>
                <span className="text-muted-foreground/40">/</span>
                <span className="text-destructive">{traces.filter((t) => t.label === "negative").length} neg</span>
              </span>
              {!!traces.length && (
                <button onClick={clearAllTraces} className="ml-auto text-[11px] text-muted-foreground hover:text-destructive">
                  clear
                </button>
              )}
            </div>
            {traces.length ? (
              <div className="space-y-1">
                {traces.slice(0, 8).map((t) => {
                  const color = t.label === "positive" ? "#10b981" : t.label === "negative" ? "#ef4444" : "#9ca3af";
                  return (
                    <div key={t.id} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-[11px]">
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase text-white" style={{ background: color }}>
                        {t.label === "positive" ? "pos" : t.label === "negative" ? "neg" : "—"}
                      </span>
                      <span className="font-mono text-muted-foreground">{t.reward == null ? "··" : Math.round(t.reward * 100)}</span>
                      <span className="flex-1 truncate text-muted-foreground">{t.problem}</span>
                      {t.feedback &&
                        (t.feedback === "up" ? (
                          <ThumbsUp className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
                        ) : (
                          <ThumbsDown className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
                        ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No traces yet (run Reasoning mode, then rate answers).</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
