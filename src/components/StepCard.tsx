import { Terminal, Check } from "lucide-react";
import { StepView } from "../lib/agent";
import { extractThink, extractAnswer } from "../lib/prompts";
import { OkfHit } from "../lib/okf";
import MathText from "./MathText";

export type StepStatus = "running" | "done";

export interface StepState {
  status: StepStatus;
  text?: string;
  answer?: string;
  code?: string;
  output?: string;
  ok?: boolean;
  hits?: OkfHit[];
  score?: number;
  note?: string;
}

export default function StepCard({
  view,
  state,
  index,
}: {
  view: StepView;
  state: StepState;
  index: number;
}) {
  const accent = view.accent;
  return (
    <div className="animate-rise rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[13px] font-bold text-white"
          style={{ background: accent, boxShadow: `0 2px 8px ${accent}40` }}
        >
          {view.kind === "exec" ? <Terminal className="h-4 w-4" strokeWidth={2.25} /> : index + 1}
        </div>
        <div className="flex-1">
          <div className="text-[15px] font-semibold leading-tight tracking-tight">{view.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{view.blurb}</div>
        </div>
        <Pill status={state.status} ok={state.ok} kind={view.kind} />
      </div>

      {view.kind === "exec" ? (
        <ExecBody code={state.code} output={state.output} ok={state.ok} status={state.status} />
      ) : view.kind === "memory" ? (
        <MemoryBody hits={state.hits} status={state.status} />
      ) : view.kind === "gate" ? (
        <GateBody score={state.score} ok={state.ok} note={state.note} status={state.status} />
      ) : (
        <ModelBody text={state.text ?? ""} status={state.status} />
      )}
    </div>
  );
}

function GateBody({ score, ok, note, status }: { score?: number; ok?: boolean; note?: string; status: StepStatus }) {
  if (status === "running") return <div className="mt-4 text-sm text-muted-foreground caret">scoring…</div>;
  if (score === undefined)
    return <div className="mt-4 text-sm text-muted-foreground">{note || "Gate skipped (reward model unavailable)."}</div>;
  const pct = Math.round(score * 100);
  const color = ok ? "#10b981" : "#ef4444";
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <span>reward score</span>
        <span className="inline-flex items-center gap-1" style={{ color }}>
          {ok && <Check className="h-3 w-3" strokeWidth={3} />}
          {ok ? "released" : "below threshold"}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="mt-1 text-sm font-semibold" style={{ color }}>
        {pct}/100
      </div>
      {note && <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

function MemoryBody({ hits, status }: { hits?: OkfHit[]; status: StepStatus }) {
  if (status === "running")
    return <div className="mt-4 text-sm text-muted-foreground caret">searching local store…</div>;
  if (!hits || !hits.length)
    return <div className="mt-4 text-sm text-muted-foreground">No relevant facts found in the store.</div>;
  // Keep this compact: just confirm recall happened and how much was grounded —
  // listing every concept + snippet floods the transcript.
  return (
    <div className="mt-4 text-sm text-muted-foreground">
      Grounded {hits.length} relevant fact{hits.length > 1 ? "s" : ""} from local memory into the prompt.
    </div>
  );
}

function ModelBody({ text, status }: { text: string; status: StepStatus }) {
  const think = extractThink(text);
  const hasAnswerTag = /<answer>/i.test(text);
  const answer = hasAnswerTag && status === "done" ? extractAnswer(text) : "";
  const hasCode = /```/.test(text);
  // when the solver wrote code, its inline <answer> is the (unreliable) mental
  // guess — the executed code is the real path, so don't surface that chip.
  const showAnswer = !!answer && !hasCode;
  // show the model's reasoning (between <think>…</think>), or the raw stream
  // (tags stripped) before/if it never uses the tags — never hide it.
  const body = think || stripTags(text);
  return (
    <>
      {(body || status === "running") && (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {hasCode ? "Reasoning + code" : "Reasoning"}
          </div>
          <div
            className={
              "max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-md bg-muted px-4 py-3 text-sm leading-relaxed " +
              (status === "running" && !answer ? "caret" : "")
            }
          >
            <MathText text={body || "…"} />
          </div>
        </div>
      )}
      {showAnswer && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Answer
          </div>
          <div className="whitespace-pre-wrap rounded-md bg-accent px-4 py-3 text-sm font-medium text-accent-foreground">
            <MathText text={answer} />
          </div>
        </div>
      )}
    </>
  );
}

function ExecBody({
  code,
  output,
  ok,
  status,
}: {
  code?: string;
  output?: string;
  ok?: boolean;
  status: StepStatus;
}) {
  return (
    <div className="mt-4 space-y-3">
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Python
        </div>
        <pre className="overflow-x-auto rounded-md bg-[#0d1117] px-4 py-3 font-mono text-[13px] leading-relaxed text-[#e6edf3]">
          <code>{code ?? "…"}</code>
        </pre>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          stdout
          {status === "done" && (
            <span className={"inline-flex items-center gap-1 " + (ok ? "text-primary" : "text-destructive")}>
              {ok && <Check className="h-3 w-3" strokeWidth={3} />}
              {ok ? "exit 0" : "failed"}
            </span>
          )}
        </div>
        <pre
          className={
            "overflow-x-auto rounded-md px-4 py-3 font-mono text-[13px] font-semibold leading-relaxed " +
            (status === "running" ? "caret " : "") +
            (ok === false ? "bg-destructive/10 text-destructive" : "bg-muted")
          }
        >
          <code>{status === "running" ? "running…" : output ?? ""}</code>
        </pre>
      </div>
    </div>
  );
}

function Pill({ status, ok, kind }: { status: StepStatus; ok?: boolean; kind: string }) {
  if (status === "running")
    return (
      <span className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
        <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />
        {kind === "exec"
          ? "running"
          : kind === "memory"
          ? "searching"
          : kind === "gate"
          ? "scoring"
          : "thinking"}
      </span>
    );
  const good = kind !== "exec" || ok;
  return (
    <span
      className={
        "rounded-md px-2.5 py-1 text-xs font-medium " +
        (good ? "bg-accent text-accent-foreground" : "bg-destructive/10 text-destructive")
      }
    >
      {good ? "done" : "error"}
    </span>
  );
}

function stripTags(t: string): string {
  return t.replace(/<\/?(think|answer)>/gi, "").trim();
}
