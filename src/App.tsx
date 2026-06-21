import { useEffect, useRef, useState } from "react";
import { runAgent, StepView, Mode, MODES } from "./lib/agent";
import StepCard, { StepState } from "./components/StepCard";
import ModelPicker from "./components/ModelPicker";
import MathText from "./components/MathText";

export default function App() {
  const [problem, setProblem] = useState("");
  const [mode, setMode] = useState<Mode>("thinking");
  const [steps, setSteps] = useState<StepView[]>([]);
  const [sstate, setSstate] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const [finalAnswer, setFinalAnswer] = useState("");
  const [toolGrounded, setToolGrounded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setDark(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  async function start(q?: string) {
    const text = (q ?? problem).trim();
    if (!text || running || !modelReady) return;
    setProblem(text);
    setError("");
    setFinalAnswer("");
    setToolGrounded(false);
    setSteps([]);
    setSstate({});
    setRunning(true);
    setElapsed(0);

    const t0 = performance.now();
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await runAgent(
        text,
        mode,
        {
          onStep: (v) => {
            setSteps((prev) => (prev.some((s) => s.id === v.id) ? prev : [...prev, v]));
            setSstate((prev) => ({ ...prev, [v.id]: { status: "running" } }));
          },
          onToken: (id, full) =>
            setSstate((prev) => ({ ...prev, [id]: { ...prev[id], status: "running", text: full } })),
          onResult: (id, r) =>
            setSstate((prev) => ({ ...prev, [id]: { ...prev[id], status: "done", ...r } })),
        },
        ac.signal
      );
      setFinalAnswer(result.finalAnswer);
      setToolGrounded(result.toolGrounded);
    } catch (e) {
      if (!ac.signal.aborted) setError(String((e as Error).message ?? e));
    } finally {
      setRunning(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRunning(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
  }

  const activeMode = MODES.find((m) => m.id === mode)!;

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-4 pb-10">
      <header className="sticky top-0 z-10 -mx-4 mb-1 bg-background/85 px-4 pb-3 pt-7 backdrop-blur">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[28px] font-bold leading-tight tracking-tight">Reasoning Agent</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">On-device SLM · llama.cpp · tool-grounded</p>
          </div>
          <button
            onClick={() => setDark((d) => !d)}
            className="rounded-full border border-border bg-card px-3 py-2 text-sm shadow-sm"
            title="Toggle theme"
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <ModelPicker onReadyChange={setModelReady} />

      {/* mode selector */}
      <div className="rounded-lg border border-border bg-card p-2 shadow-sm">
        <div className="grid grid-cols-2 gap-1">
          {MODES.map((m) => {
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                disabled={running}
                className={
                  "rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 " +
                  (active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted")
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="px-1.5 pt-2 text-center text-xs text-muted-foreground">{activeMode.blurb}</p>
      </div>

      {/* composer */}
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <textarea
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
          }}
          placeholder="Ask a question…  (⌘/Ctrl + Enter to run)"
          rows={3}
          className="w-full resize-none rounded-md bg-muted px-4 py-3 text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!running ? (
            <button
              onClick={() => start()}
              disabled={!problem.trim() || !modelReady}
              className="rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              Run · {activeMode.label}
            </button>
          ) : (
            <button
              onClick={stop}
              className="rounded-full bg-destructive px-6 py-2.5 text-sm font-semibold text-destructive-foreground"
            >
              Stop
            </button>
          )}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {elapsed > 0 ? `${elapsed.toFixed(1)}s` : ""}
          </span>
        </div>
        {!modelReady && <p className="mt-3 text-xs text-muted-foreground">Load a model above to enable the agent.</p>}
        {error && <p className="mt-3 text-xs text-destructive">Error: {error}</p>}
      </div>

      {/* verified answer */}
      {finalAnswer && (
        <div className="animate-rise rounded-lg border-2 border-primary bg-accent p-5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">Answer</span>
            {toolGrounded && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                ✓ grounded by code
              </span>
            )}
          </div>
          <div className="mt-1 whitespace-pre-wrap text-lg font-semibold text-foreground">
            <MathText text={finalAnswer} />
          </div>
        </div>
      )}

      {/* pipeline steps */}
      <div className="flex flex-col gap-3">
        {steps.map((view, i) => (
          <StepCard key={view.id} view={view} index={i} state={sstate[view.id] ?? { status: "running" }} />
        ))}
      </div>

      <footer className="pt-2 text-center text-xs text-muted-foreground">
        Tool-Integrated Reasoning · PAL · PoT · ReAct · on-device llama.cpp
      </footer>
    </div>
  );
}
