import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Square,
  Paperclip,
  Sparkles,
  SlidersHorizontal,
  Sun,
  Moon,
  Check,
  BadgeCheck,
  ThumbsUp,
  ThumbsDown,
  ChevronRight,
  ChevronDown,
  X,
} from "lucide-react";
import { runAgent, StepView, Mode, MODES } from "./lib/agent";
import { ChatMessage } from "./lib/llm";
import { finalizeAnswer } from "./lib/prompts";
import StepCard, { StepState } from "./components/StepCard";
import ModelPicker from "./components/ModelPicker";
import MemoryPanel from "./components/MemoryPanel";
import SkillsPanel from "./components/SkillsPanel";
import MathText from "./components/MathText";
import { ensureAux, getAux, AuxStatus, traceFeedback } from "./lib/control";
import { captureMemory } from "./lib/memory";
import { listSkills, Skill, skillSystemAddon } from "./lib/skills";
import { ingestFile, retrieveChunks, chunksToContext, AttachedDoc } from "./lib/documents";

interface Turn {
  id: string;
  question: string;
  steps: StepView[];
  sstate: Record<string, StepState>;
  answer: string;
  grounded: boolean;
  traceId: string | null;
  feedback: "up" | "down" | null;
}

export default function App() {
  const [problem, setProblem] = useState("");
  const [mode, setMode] = useState<Mode>("reasoning");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [active, setActive] = useState<{ question: string; steps: StepView[]; sstate: Record<string, StepState> } | null>(null);
  const [running, setRunning] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [memoryOn, setMemoryOn] = useState(true);
  const [memVersion, setMemVersion] = useState(0);
  const [remembered, setRemembered] = useState<number | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeSkillId, setActiveSkillId] = useState<string>("");
  const [docs, setDocs] = useState<AttachedDoc[]>([]);
  const [aux, setAux] = useState<AuxStatus | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setDark(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false), []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    listSkills().then(setSkills);
  }, [memVersion]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, active]);

  // Reasoning mode needs the reward-gate service; ask the control server to spawn it.
  useEffect(() => {
    if (mode !== "reasoning") return;
    let live = true;
    ensureAux().then((s) => live && setAux(s)).catch(() => {});
    const iv = window.setInterval(async () => {
      try {
        const s = await getAux();
        if (live) setAux(s);
      } catch { /* control down */ }
    }, 1500);
    return () => { live = false; window.clearInterval(iv); };
  }, [mode]);

  const activeSkill = useMemo(() => skills.find((s) => s.id === activeSkillId) ?? null, [skills, activeSkillId]);

  async function onAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of files) {
      try {
        const doc = await ingestFile(f);
        setDocs((d) => [...d, doc]);
      } catch (err) {
        setError(`couldn't read ${f.name}: ${String((err as Error).message ?? err)}`);
      }
    }
  }

  async function start(q?: string) {
    const text = (q ?? problem).trim();
    if (!text || running || !modelReady) return;
    const prevQuestion = turns.length ? turns[turns.length - 1].question : undefined; // for "remember this"
    setProblem("");
    setError("");
    setRunning(true);

    const steps: StepView[] = [];
    const sstate: Record<string, StepState> = {};
    setActive({ question: text, steps, sstate });

    // build short history + grounding from attached docs
    const history: ChatMessage[] = turns.slice(-4).flatMap((t) => [
      { role: "user" as const, content: t.question },
      { role: "assistant" as const, content: t.answer },
    ]);
    const docContext = docs.length ? chunksToContext(retrieveChunks(text, docs, 4)) : "";
    const skillAddon = skillSystemAddon(activeSkill);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await runAgent(
        text,
        mode,
        {
          onStep: (v) => {
            steps.push(v);
            sstate[v.id] = { status: "running" };
            setActive({ question: text, steps: [...steps], sstate: { ...sstate } });
          },
          onToken: (id, full) => {
            sstate[id] = { ...sstate[id], status: "running", text: full };
            setActive({ question: text, steps: [...steps], sstate: { ...sstate } });
          },
          onResult: (id, r) => {
            sstate[id] = { ...sstate[id], status: "done", ...r };
            setActive({ question: text, steps: [...steps], sstate: { ...sstate } });
          },
        },
        ac.signal,
        { useMemory: memoryOn, docContext, skillAddon, history }
      );
      setTurns((prev) => [
        ...prev,
        {
          id: "turn_" + Date.now().toString(36),
          question: text,
          steps: [...steps],
          sstate: { ...sstate },
          answer: result.finalAnswer,
          grounded: result.toolGrounded,
          traceId: result.traceId ?? null,
          feedback: null,
        },
      ]);
      if (memoryOn)
        captureMemory(text, prevQuestion).then((n) => {
          if (n) {
            setMemVersion((v) => v + 1);
            setRemembered(n);
            window.setTimeout(() => setRemembered(null), 5000);
          }
        });
    } catch (e) {
      if (!ac.signal.aborted) setError(String((e as Error).message ?? e));
    } finally {
      setActive(null);
      setRunning(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setActive(null);
    setRunning(false);
  }

  async function rate(turnId: string, traceId: string | null, f: "up" | "down") {
    setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, feedback: f } : t)));
    if (traceId) {
      await traceFeedback(traceId, f);
      setMemVersion((v) => v + 1);
    }
  }

  const activeMode = MODES.find((m) => m.id === mode)!;
  const empty = turns.length === 0 && !active;

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-5">
      {/* header */}
      <header className="sticky top-0 z-10 -mx-5 flex items-center gap-3 border-b border-border bg-background/80 px-5 py-3.5 backdrop-blur-xl">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground shadow-sm">R</div>
        <div className="flex-1">
          <div className="text-[15px] font-semibold leading-none tracking-tight">Reasoning Agent</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={"h-1.5 w-1.5 rounded-full " + (modelReady ? "bg-primary" : "bg-muted-foreground/40")} />
            on-device · llama.cpp · {modelReady ? "online" : "offline"}
          </div>
        </div>
        <button
          onClick={() => setSettingsOpen((s) => !s)}
          className={
            "grid h-9 w-9 place-items-center rounded-md border transition-colors " +
            (settingsOpen ? "border-primary/40 bg-accent text-accent-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground")
          }
          title="Settings"
        >
          <SlidersHorizontal className="h-[17px] w-[17px]" strokeWidth={2} />
        </button>
        <button
          onClick={() => setDark((d) => !d)}
          className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
          title="Toggle theme"
        >
          {dark ? <Sun className="h-[17px] w-[17px]" strokeWidth={2} /> : <Moon className="h-[17px] w-[17px]" strokeWidth={2} />}
        </button>
      </header>

      {/* settings drawer */}
      {settingsOpen && (
        <div className="mt-4 flex flex-col gap-3">
          <ModelPicker onReadyChange={setModelReady} />
          <MemoryPanel memoryOn={memoryOn} onToggle={setMemoryOn} refreshKey={memVersion} />
          <SkillsPanel refreshKey={memVersion} onChange={() => setMemVersion((v) => v + 1)} />
        </div>
      )}

      {/* conversation */}
      <div className="flex flex-1 flex-col gap-6 py-6">
        {empty && (
          <div className="mx-auto mt-16 max-w-md text-center">
            <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-lg border border-border bg-card shadow-sm">
              <Sparkles className="h-6 w-6 text-primary" strokeWidth={1.75} />
            </div>
            <div className="text-2xl font-semibold tracking-tight">What should we reason about?</div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
              {modelReady ? "Chain-of-thought with tools and local memory, reward-gated. Attach a document or pick a skill to begin." : "Open Settings and load a model to begin."}
            </p>
          </div>
        )}

        {turns.map((t) => (
          <TurnView key={t.id} turn={t} onRate={(f) => rate(t.id, t.traceId, f)} />
        ))}

        {active && <ActiveTurn active={active} />}
        {error && <p className="text-sm text-destructive">Error: {error}</p>}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <div className="sticky bottom-0 -mx-5 border-t border-border bg-background/85 px-5 pb-5 pt-3 backdrop-blur-xl">
        {remembered && (
          <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            Remembered {remembered} detail{remembered > 1 ? "s" : ""} to memory
          </div>
        )}
        {/* tool row */}
        <div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs">
          <div className="flex rounded-md border border-border bg-card p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                disabled={running}
                className={
                  "rounded-[5px] px-3 py-1 font-medium transition-colors disabled:opacity-50 " +
                  (m.id === mode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted")
                }
                title={m.blurb}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="relative flex items-center">
            <Sparkles className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
            <select
              value={activeSkillId}
              onChange={(e) => setActiveSkillId(e.target.value)}
              className="rounded-md border border-border bg-card py-1 pl-7 pr-3 text-muted-foreground outline-none transition-colors hover:text-foreground"
              title="Active skill (changes behaviour)"
            >
              <option value="">No skill</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Paperclip className="h-3.5 w-3.5" strokeWidth={2} />
            Attach
          </button>
          <input ref={fileRef} type="file" multiple accept=".txt,.md,.markdown,.csv,.json,.log,.py,.js,.ts,.tsx,.html,.pdf" onChange={onAttach} className="hidden" />

          {docs.map((d) => (
            <span key={d.id} className="flex items-center gap-1.5 rounded-md border border-primary/20 bg-accent px-2.5 py-1 text-accent-foreground">
              {d.name} · {d.chunks.length} chunks
              <button onClick={() => setDocs((x) => x.filter((y) => y.id !== d.id))} className="text-accent-foreground/60 transition-colors hover:text-destructive" title="Remove">
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </span>
          ))}

          {mode === "reasoning" && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: aux?.reward?.ready ? "#10b981" : aux?.reward?.missing ? "#9ca3af" : "#f59e0b" }} />
              reward {aux?.reward?.ready ? "ready" : aux?.reward?.missing ? "add reward-gate.gguf" : "loading"}
            </span>
          )}
        </div>

        <div className="flex items-end gap-2 rounded-lg border border-border bg-card p-2 shadow-sm transition-colors focus-within:border-primary/50">
          <textarea
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                start();
              }
            }}
            placeholder={modelReady ? `Message · ${activeMode.label} mode  (Enter to send)` : "Load a model in Settings first…"}
            rows={1}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {!running ? (
            <button
              onClick={() => start()}
              disabled={!problem.trim() || !modelReady}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
              title="Send"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
            </button>
          ) : (
            <button onClick={stop} className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-destructive text-destructive-foreground" title="Stop">
              <Square className="h-4 w-4 fill-current" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// live view during a run: the answer streams (finalized from think/answer as it
// goes), with the raw steps shown below.
function ActiveTurn({ active }: { active: { question: string; steps: StepView[]; sstate: Record<string, StepState> } }) {
  const liveStep = [...active.steps].reverse().find((s) => s.kind === "solve" || s.kind === "answer");
  const liveText = liveStep ? active.sstate[liveStep.id]?.text ?? "" : "";
  const liveAnswer = liveText ? finalizeAnswer(liveText) : "";
  return (
    <div className="flex flex-col gap-3">
      <UserBubble text={active.question} />
      {/* pipeline / reasoning ABOVE the answer (like o1 / Claude) */}
      <div className="flex flex-col gap-3">
        {active.steps.map((view, i) => (
          <StepCard key={view.id} view={view} index={i} state={active.sstate[view.id] ?? { status: "running" }} />
        ))}
      </div>
      <div className="rounded-lg rounded-bl-sm border border-border bg-card p-5 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">Answer</div>
        <div className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground caret">
          {liveAnswer ? <MathText text={liveAnswer} /> : <span className="text-muted-foreground">thinking…</span>}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground shadow-sm">
        {text}
      </div>
    </div>
  );
}

function TurnView({ turn, onRate }: { turn: Turn; onRate: (f: "up" | "down") => void }) {
  const [showSteps, setShowSteps] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <UserBubble text={turn.question} />

      {/* reasoning / pipeline ABOVE the answer (collapsible, like o1 / Claude) */}
      {!!turn.steps.length && (
        <div className="flex flex-col gap-2.5">
          <button
            onClick={() => setShowSteps((s) => !s)}
            className="flex items-center gap-1.5 self-start rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {showSteps ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} /> : <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} />}
            {showSteps ? "Hide reasoning" : "Show reasoning & pipeline"}
          </button>
          {showSteps && (
            <div className="flex flex-col gap-3">
              {turn.steps.map((view, i) => (
                <StepCard key={view.id} view={view} index={i} state={turn.sstate[view.id] ?? { status: "done" }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* assistant answer BELOW */}
      <div className="rounded-lg rounded-bl-sm border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">Answer</span>
          {turn.grounded && (
            <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
              <BadgeCheck className="h-3 w-3" strokeWidth={2.5} />
              grounded by code
            </span>
          )}
        </div>
        <div className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
          <MathText text={turn.answer} />
        </div>

        <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
          <span className="text-[11px] font-medium text-muted-foreground">Helpful?</span>
          <button
            onClick={() => onRate("up")}
            className={
              "grid h-7 w-7 place-items-center rounded-md border transition-colors " +
              (turn.feedback === "up" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground")
            }
            title="Helpful"
          >
            <ThumbsUp className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            onClick={() => onRate("down")}
            className={
              "grid h-7 w-7 place-items-center rounded-md border transition-colors " +
              (turn.feedback === "down" ? "border-destructive bg-destructive text-destructive-foreground" : "border-border text-muted-foreground hover:text-foreground")
            }
            title="Not helpful"
          >
            <ThumbsDown className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          {turn.feedback && <span className="text-[11px] text-muted-foreground">saved as {turn.feedback === "up" ? "positive" : "negative"} trace</span>}
        </div>
      </div>
    </div>
  );
}
