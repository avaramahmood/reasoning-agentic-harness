import { useEffect, useRef, useState } from "react";
import { ModelEntry, ModelStatus, listModels, getStatus, selectModel } from "../lib/control";

interface Props {
  onReadyChange: (ready: boolean) => void;
}

export default function ModelPicker({ onReadyChange }: Props) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsDir, setModelsDir] = useState("");
  const [picked, setPicked] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [controlOffline, setControlOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastReady = useRef<boolean>(false);

  async function refresh() {
    try {
      const [m, s] = await Promise.all([listModels(), getStatus()]);
      // GGUF only — this app loads .gguf directly (no archives)
      const ggufs = m.models.filter((x) => x.type === "gguf");
      setModels(ggufs);
      setModelsDir(m.modelsDir);
      setStatus(s);
      setControlOffline(false);
      if (!picked && ggufs.length) {
        const active = ggufs.find((x) => x.active);
        setPicked(active ? active.path : ggufs[0].path);
      }
      if (s.ready !== lastReady.current) {
        lastReady.current = s.ready;
        onReadyChange(s.ready);
      }
    } catch {
      setControlOffline(true);
      onReadyChange(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 2500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const file = customPath.trim() || picked;
    if (!file) return;
    setBusy(true);
    try {
      await selectModel(file);
    } catch (e) {
      setStatus((s) => ({ ...(s ?? { model: null, ready: false }), loading: false, error: String((e as Error).message) }));
    } finally {
      setBusy(false);
    }
  }

  const loading = status?.loading || busy;
  const activeName: string | null =
    models.find((m) => m.path === status?.model)?.name ?? status?.model?.split("/").pop() ?? null;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model</div>
        <ModelState status={status} controlOffline={controlOffline} activeName={activeName} />
      </div>

      {controlOffline ? (
        <p className="text-sm text-destructive">
          Control server not running. Start it with{" "}
          <code className="rounded bg-muted px-1 font-mono">npm run control</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2">
            <select
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value);
                setCustomPath("");
              }}
              disabled={loading}
              className="min-w-0 flex-1 truncate rounded-md bg-muted px-4 py-2.5 text-sm outline-none"
            >
              {models.length === 0 && <option value="">no .gguf found in {modelsDir}</option>}
              {models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.name} · {fmtMB(m.sizeMB)}
                </option>
              ))}
            </select>
            <button
              onClick={load}
              disabled={loading || (!picked && !customPath.trim())}
              className="shrink-0 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>

          <input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            disabled={loading}
            placeholder="…or paste a full path to any .gguf"
            className="rounded-md bg-muted px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />

          {status?.error && <p className="text-xs text-destructive">{status.error}</p>}
          {loading && (
            <p className="text-xs text-muted-foreground">
              Loading model into llama.cpp — a 7B can take 20–40 s on first load…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ModelState({
  status,
  controlOffline,
  activeName,
}: {
  status: ModelStatus | null;
  controlOffline: boolean;
  activeName: string | null;
}) {
  let cls = "bg-muted text-muted-foreground";
  let label = "no model";
  let pulse = false;
  if (controlOffline) {
    cls = "bg-destructive/10 text-destructive";
    label = "control offline";
  } else if (status?.loading) {
    cls = "bg-accent text-accent-foreground";
    label = "loading";
    pulse = true;
  } else if (status?.ready) {
    cls = "bg-primary/15 text-primary";
    label = activeName ? `online · ${truncate(activeName)}` : "online";
  } else if (status?.error) {
    cls = "bg-destructive/10 text-destructive";
    label = "error";
  }
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${cls}`}>
      <span className={"h-1.5 w-1.5 rounded-full bg-current " + (pulse ? "animate-blink" : "")} />
      {label}
    </span>
  );
}

function fmtMB(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}
function truncate(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
