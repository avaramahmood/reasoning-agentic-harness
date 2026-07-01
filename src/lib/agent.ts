// Three modes over one on-device 7B (no planner model):
//
//   knowledge : 1 pass — recall/commonsense. No tools.
//   thinking  : a ReAct LOOP — chain-of-thought that writes Python whenever a step
//               needs counting / enumeration / arithmetic; we execute it and feed
//               the real result back until it answers.
//   reasoning : the full chatbot — thinking PLUS local memory (OKF) + attached
//               documents as grounding, an active skill, a reward gate (bge GGUF)
//               that scores the chain-of-thought and resamples once if weak, and
//               a preference trace logged for later LoRA training.

import { streamChat, ChatMessage } from "./llm";
import { execCode, logTrace } from "./control";
import { recall, OkfHit } from "./okf";
import { scoreReward } from "./reward";
import { cleanModelOutput } from "./search";
import {
  SYS_KNOWLEDGE,
  SYS_REACT,
  SYS_CODE_ONLY,
  SYS_REASON,
  SYS_CHAT,
  knowledgeUser,
  chatUser,
  reactUser,
  extractAnswer,
  extractThink,
  finalizeAnswer,
  extractCode,
  hasAnswerTag,
  truncateAfterCode,
  detectMechanical,
  buildFallbackCode,
  isNonAnswer,
} from "./prompts";

export type Mode = "knowledge" | "thinking" | "reasoning";

export interface ModeInfo {
  id: Mode;
  label: string;
  blurb: string;
  est: string;
}

export const MODES: ModeInfo[] = [
  { id: "knowledge", label: "Knowledge", blurb: "Facts & recall — one quick pass", est: "fast" },
  { id: "thinking", label: "Thinking", blurb: "Reason and run code until solved", est: "thorough" },
  { id: "reasoning", label: "Reasoning", blurb: "CoT + memory + docs + reward-gated", est: "full" },
];

export type StepKind = "answer" | "solve" | "exec" | "consolidate" | "memory" | "gate";

export interface StepView {
  id: string;
  kind: StepKind;
  title: string;
  blurb: string;
  accent: string;
}

export interface StepResult {
  text?: string;
  answer?: string;
  code?: string;
  output?: string;
  ok?: boolean;
  hits?: OkfHit[];
  score?: number;
  note?: string;
}

export interface PipelineEvents {
  onStep: (s: StepView) => void;
  onToken: (id: string, full: string) => void;
  onResult: (id: string, r: StepResult) => void;
}

export interface PipelineResult {
  finalAnswer: string;
  usedTool: boolean;
  toolGrounded: boolean; // headline answer came straight from executed code
  traceId?: string; // preference-trace id (for 👍/👎 -> LoRA data)
}

export interface RunOpts {
  useMemory?: boolean;
  docContext?: string; // grounding from attached documents (client-side RAG)
  skillAddon?: string; // active skill, appended to the system prompt
  history?: ChatMessage[]; // prior conversation turns
}

const ACCENT: Record<StepKind, string> = {
  answer: "#2dd4bf",
  solve: "#baaf73",
  exec: "#2dd4bf",
  consolidate: "#baaf73",
  memory: "#baaf73",
  gate: "#2dd4bf",
};

const GATE_THRESHOLD = 0.45; // bge-reranker val midpoint (pos~0.56 / neg~0.37)
const GEN_MAX_TOKENS = 768; // reasoning answers (incl. code); bounded to limit drift + latency
// stops include "\nQuestion:"/"\nProblem:" so the model can't drift into a
// self-generated Q&A list after its real answer.
const REACT_STOPS = ["<|im_end|>", "<|endoftext|>", "<|im_start|>", "</answer>", "TOOL OUTPUT", "\nQuestion:", "\nProblem:", "\nUser:", "xmlhttp"];
const MAX_ITERS = 3;

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : s.trim();
}

// knowledge/thinking want a one-line answer; clean + take the first line.
function cleanAnswer(a: string): string {
  const c = cleanModelOutput(a);
  const first = c.split("\n")[0].replace(/[^\x20-\x7E]+$/g, "").trim();
  return first || c.trim();
}

// Inject the user's profile/memory into the SYSTEM prompt (not the user turn).
// Two rules that must coexist:
//   1. Don't PARROT the profile back unprompted (keeps normal chat clean).
//   2. These facts are GROUND TRUTH — when directly asked about themselves, the
//      model answers from them and never invents.
// (The earlier prompt had only rule 1, phrased "never restate it back to them".
//  For a direct "what's my name" the model read that as "don't say the name" and
//  confabulated a fake persona. The fix keeps rule 1 but carves out the direct-
//  question case and forbids made-up details.)
function contextSystem(ctx: string): string {
  if (!ctx) return "";
  return (
    "\n\n# User profile (ground truth — the user's own saved memory)\n" +
    "These are verified facts about the user. Do NOT repeat, quote, list, or restate " +
    "this profile back to them on your own — never dump it unprompted. BUT when the " +
    "user directly asks about themselves (their name, email, where they live, their " +
    "preferences, projects, etc.), you MUST answer that specific question using the " +
    "exact value from these facts. If the answer is NOT listed here, say you don't " +
    "have that saved yet — NEVER guess, invent, or fill in placeholder details (no " +
    "made-up names, ages, cities, or jobs).\n" +
    ctx
  );
}

// ---- deterministic answer from memory (no LLM) ----
// Turn a stored fact sentence ("The user's name is X" / "The user lives in Y")
// into a direct 2nd-person reply ("Your name is X" / "You live in Y").
export function toSecondPerson(sentence: string): string {
  let s = sentence.trim().replace(/^[-*]\s*/, "");
  s = s.replace(/^the user'?s\b/i, "Your");
  const m = s.match(/^the user\s+([a-z]+)/i);
  if (m) {
    const verb = m[1].toLowerCase();
    const map: Record<string, string> = { is: "are", was: "were", has: "have", does: "do" };
    const v2 = map[verb] ?? verb.replace(/s$/i, ""); // lives->live, likes->like, works->work
    s = s.replace(/^the user\s+[a-z]+/i, "You " + v2);
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// generic modifiers ("favorite") are excluded so a lone shared modifier can't
// bridge unrelated facts ("favorite color" must NOT match "favorite foods").
const AFM_STOP = new Set("a an the of to in on for and or is are was were be i you my me we they this that it as at by from with do does did what which who whom how when where why can could should would will favorite favourite fav list all".split(" "));
function afmTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1 && !AFM_STOP.has(t))
    .map((t) => (t.length > 4 && (t.endsWith("s") || t.endsWith("ing")) ? t.replace(/(?:ing|s)$/, "") : t));
}

// Best-effort direct answer pulled from the recalled facts. Returns "" if no
// fact clearly matches the question (e.g. semantic-gap queries), so callers only
// use it as a guaranteed fallback for attribute lookups (name/email/where/work).
export function answerFromMemory(problem: string, ctx: string): string {
  if (!ctx) return "";
  const qSet = new Set(afmTokens(problem));
  if (!qSet.size) return "";
  // Recall renders each concept as a "- Title (Type)" header line followed by an
  // indented "The user …" body line. Score the body using tokens from BOTH the
  // header and the body — so "list my favorite FOODS" matches the concept titled
  // "Favorite foods" even though its body says "pizza, dosa, sushi" (no lexical
  // overlap with the query). We still RETURN the body sentence as the answer.
  let header = "";
  let best = "";
  let bestScore = 0;
  for (const raw of ctx.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*]\s/.test(line) && !/the user/i.test(line)) { header = line; continue; }
    if (/the user/i.test(line)) {
      const body = line.replace(/^[-*]\s*/, "");
      const fSet = new Set([...afmTokens(header), ...afmTokens(body)]);
      let score = 0;
      for (const q of qSet) if (fSet.has(q)) score++;
      if (score > bestScore) { bestScore = score; best = body; }
    }
  }
  return bestScore > 0 ? toSecondPerson(best) : "";
}

// A pure "look up an attribute of me" question ("what's my name", "where do I
// live/work", "what is my email"). NOT an opinion/creative/compute request —
// those still want the LLM. For pure lookups the exact answer is already in
// memory, and routing it through the quantized 7B only adds spelling drift and
// confabulation (observed: "Mahmoud", or Google's HQ address for "where I live"),
// so we answer deterministically from memory instead.
export function isIdentityLookup(problem: string): boolean {
  const p = problem.trim().toLowerCase();
  if (p.length > 90) return false; // long/compound asks aren't simple lookups
  // opinion / action / creative intents must go to the model
  if (/\b(think|opinion|feel|should|recommend|suggest|advice|why|how (?:do|can|should)|better|good|best|write|generate|create|make|code|script|plan|explain|summar|list everything|tell me about)\b/.test(p)) return false;
  // must be a question about ME
  if (!/\b(my|i|me|mine)\b/.test(p)) return false;
  return (
    /\bwhat(?:'?s| is| are)\s+(?:my|the)\b/.test(p) ||
    /\bwhere\s+(?:do|am)\s+i\b/.test(p) ||
    /\bwhere\s+is\s+my\b/.test(p) ||
    /\bwho\s+am\s+i\b/.test(p) ||
    /\b(?:what|which)\s+.*\bmy\b/.test(p) ||
    /\blist\s+(?:my|all)\b/.test(p) ||
    /\bdo\s+i\s+(?:like|have|prefer)\b/.test(p)
  );
}

// strip <think>/<answer> tags but keep text — the document the reward gate scores.
function scoreDoc(full: string): string {
  return full.replace(/<\/?(think|answer)>/gi, " ").replace(/\s+/g, " ").trim();
}

// ---- grounding: OKF recall (+ attached docs) ----
async function recallContext(
  problem: string,
  ev: PipelineEvents,
  signal: AbortSignal,
  docContext: string
): Promise<string> {
  const id = "memory";
  ev.onStep({ id, kind: "memory", title: "Recall", blurb: "Local memory + attached docs", accent: ACCENT.memory });
  let hits: OkfHit[] = [];
  let okfCtx = "";
  try {
    const r = await recall(problem);
    hits = r.hits;
    okfCtx = r.context;
  } catch {
    /* store unavailable */
  }
  if (signal.aborted) return docContext;
  const parts = [okfCtx, docContext].filter(Boolean);
  ev.onResult(id, { hits, text: parts.join("\n") || "(no relevant facts or document chunks)" });
  return parts.join("\n");
}

// ---- the ReAct chain-of-thought loop (shared by thinking + reasoning) ----
interface SolveOut {
  full: string; // concatenated reasoning of the final attempt
  answer: string;
  usedTool: boolean;
  grounded: boolean;
  verified: string; // executed tool outputs (ground truth) for the reward gate
}

async function reactSolve(
  problem: string,
  ctx: string,
  sysExtra: string,
  history: ChatMessage[],
  ev: PipelineEvents,
  signal: AbortSignal,
  tag: string,
  multiline: boolean
): Promise<SolveOut> {
  const mechanical = detectMechanical(problem);
  const messages: ChatMessage[] = [
    { role: "system", content: SYS_REACT + sysExtra + contextSystem(ctx) },
    ...history,
    { role: "user", content: reactUser(problem) },
  ];

  let answer = "";
  let usedTool = false;
  let grounded = false;
  let lastToolOut = "";
  let lastFull = "";
  const verified: string[] = [];

  for (let i = 0; i < MAX_ITERS; i++) {
    if (signal.aborted) break;
    const rid = `${tag}reason-${i}`;
    ev.onStep({
      id: rid,
      kind: "solve",
      title: i === 0 ? "Reasoning" : "Continue",
      blurb: i === 0 ? "Chain-of-thought · decides if code is needed" : "Reads the tool output",
      accent: ACCENT.solve,
    });
    const full = await streamChat(messages, {
      maxTokens: multiline ? GEN_MAX_TOKENS : 640,
      temperature: 0.3,
      signal,
      stop: REACT_STOPS,
      frequencyPenalty: 0.5, // kill repeated-token spew on the quantized 7B
      presencePenalty: 0.3,
      onToken: (_d, f) => ev.onToken(rid, f),
    });
    lastFull = full;
    ev.onResult(rid, { text: full, answer: hasAnswerTag(full) ? extractAnswer(full) : undefined });

    let code = extractCode(full);
    if (!code && mechanical && i === 0) code = buildFallbackCode(problem);

    if (code) {
      usedTool = true;
      messages.push({ role: "assistant", content: truncateAfterCode(full) });
      const eid = `${tag}exec-${i}`;
      ev.onStep({ id: eid, kind: "exec", title: "Execute", blurb: "Run code — ground truth", accent: ACCENT.exec });
      const res = await execCode(code);
      const out = res.ok ? res.stdout.trim() || "(no output)" : `error: ${res.stderr || (res.timedOut ? "timed out" : "failed")}`;
      ev.onResult(eid, { code, output: out, ok: res.ok });
      if (res.ok) {
        lastToolOut = lastLine(out);
        verified.push(lastToolOut);
      }
      if (res.ok && mechanical) {
        answer = lastLine(out);
        grounded = true;
        break;
      }
      messages.push({ role: "user", content: `TOOL OUTPUT: ${out}` });
      continue;
    }

    answer = multiline ? finalizeAnswer(full) : cleanAnswer(finalizeAnswer(full));
    break;
  }

  if (!answer) answer = lastToolOut || "(no answer)";
  return { full: lastFull, answer, usedTool, grounded, verified: verified.join("\n") };
}

// THINKING mode, code branch: the router decided this needs computation, so go
// STRAIGHT to code — no in-head reasoning (that's what produced the wrong "1"/"120"
// direct answers and the pre-code spew). The MODEL writes the Python (this is the
// showcase); buildFallbackCode is only a deterministic SAFETY NET when the model
// emits no usable code or its code errors. Execute → answer is the output.
async function codeSolve(
  problem: string,
  ctx: string,
  history: ChatMessage[],
  ev: PipelineEvents,
  signal: AbortSignal,
  tag: string
): Promise<SolveOut> {
  const rid = `${tag}code-0`;
  ev.onStep({ id: rid, kind: "solve", title: "Write code", blurb: "Needs computation · writing Python", accent: ACCENT.solve });

  // 1. The model writes the code.
  const full = await streamChat(
    [{ role: "system", content: SYS_CODE_ONLY + contextSystem(ctx) }, ...history, { role: "user", content: reactUser(problem) }],
    { maxTokens: 320, temperature: 0.2, signal, stop: REACT_STOPS, frequencyPenalty: 0.5, presencePenalty: 0.3, onToken: (_d, f) => ev.onToken(rid, f) }
  );
  let code = extractCode(full);
  const modelWroteCode = !!code;
  // 2. Safety net only if the model produced nothing usable.
  if (!code) code = buildFallbackCode(problem);
  ev.onResult(rid, { text: full, code: code ?? undefined });

  if (code && !signal.aborted) {
    const eid = `${tag}exec-0`;
    ev.onStep({ id: eid, kind: "exec", title: "Execute", blurb: "Run code — ground truth", accent: ACCENT.exec });
    const res = await execCode(code);
    const out = res.ok ? res.stdout.trim() || "(no output)" : `error: ${res.stderr || (res.timedOut ? "timed out" : "failed")}`;
    ev.onResult(eid, { code, output: out, ok: res.ok });
    if (res.ok) {
      const answer = lastLine(out);
      return { full, answer, usedTool: true, grounded: true, verified: answer };
    }
    // The model's code errored → try the deterministic net before giving up.
    if (modelWroteCode && !signal.aborted) {
      const fb = buildFallbackCode(problem);
      if (fb) {
        const eid2 = `${tag}exec-1`;
        ev.onStep({ id: eid2, kind: "exec", title: "Execute", blurb: "Retry — verified code", accent: ACCENT.exec });
        const res2 = await execCode(fb);
        const out2 = res2.ok ? res2.stdout.trim() || "(no output)" : `error: ${res2.stderr || "failed"}`;
        ev.onResult(eid2, { code: fb, output: out2, ok: res2.ok });
        if (res2.ok) {
          const answer = lastLine(out2);
          return { full, answer, usedTool: true, grounded: true, verified: answer };
        }
      }
    }
  }
  // no usable code, or every execution errored → fall back to plain reasoning.
  return reasonSolve(problem, ctx, history, ev, signal, tag);
}

// THINKING mode, reason branch: no computation needed — reason, then answer.
async function reasonSolve(
  problem: string,
  ctx: string,
  history: ChatMessage[],
  ev: PipelineEvents,
  signal: AbortSignal,
  tag: string
): Promise<SolveOut> {
  const rid = `${tag}reason-0`;
  ev.onStep({ id: rid, kind: "solve", title: "Reasoning", blurb: "Chain-of-thought", accent: ACCENT.solve });
  const full = await streamChat(
    [{ role: "system", content: SYS_REASON + contextSystem(ctx) }, ...history, { role: "user", content: reactUser(problem) }],
    { maxTokens: 640, temperature: 0.3, signal, stop: REACT_STOPS, frequencyPenalty: 0.5, presencePenalty: 0.3, onToken: (_d, f) => ev.onToken(rid, f) }
  );
  const answer = finalizeAnswer(full, true) || "(no answer)";
  ev.onResult(rid, { text: full, answer });
  return { full, answer, usedTool: false, grounded: false, verified: "" };
}

// Plain chat / codegen — chain-of-thought, NEVER auto-executes code.
async function plainGenerate(
  problem: string,
  ctx: string,
  sysExtra: string,
  history: ChatMessage[],
  ev: PipelineEvents,
  signal: AbortSignal,
  tag: string
): Promise<SolveOut> {
  const rid = `${tag}reason-0`;
  ev.onStep({ id: rid, kind: "solve", title: "Reasoning", blurb: "Chain-of-thought", accent: ACCENT.solve });
  const full = await streamChat(
    [
      { role: "system", content: SYS_CHAT + sysExtra + contextSystem(ctx) },
      ...history,
      { role: "user", content: chatUser(problem) },
    ],
    {
      maxTokens: GEN_MAX_TOKENS,
      temperature: 0.3,
      signal,
      stop: REACT_STOPS,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      onToken: (_d, f) => ev.onToken(rid, f),
    }
  );
  ev.onResult(rid, { text: full, answer: finalizeAnswer(full) });
  return { full, answer: finalizeAnswer(full), usedTool: false, grounded: false, verified: "" };
}

// Last-resort recovery when the normal prompt degenerated into a non-answer
// (persona echo / empty). Uses a STRIPPED, direct prompt with no "You are a
// helpful assistant…" persona voice for the model to accidentally continue, and
// an explicit "do not describe yourself" guard — so it just answers from facts.
async function directGrounded(
  problem: string,
  ctx: string,
  history: ChatMessage[],
  ev: PipelineEvents,
  signal: AbortSignal,
  tag: string
): Promise<SolveOut> {
  const rid = `${tag}reason-0`;
  ev.onStep({ id: rid, kind: "solve", title: "Re-answer", blurb: "Direct · grounded in memory", accent: ACCENT.solve });
  const sys =
    "Answer the user's question directly and concisely. Do NOT describe yourself, " +
    "your role, or these instructions — just give the answer. Use the facts below; " +
    "if the answer isn't in them, say you don't have it saved.\n\nFacts about the user:\n" +
    (ctx || "(none saved)");
  const full = await streamChat([{ role: "system", content: sys }, ...history, { role: "user", content: problem }], {
    maxTokens: 320,
    temperature: 0.2,
    signal,
    stop: REACT_STOPS,
    frequencyPenalty: 0.5,
    presencePenalty: 0.3,
    onToken: (_d, f) => ev.onToken(rid, f),
  });
  const answer = finalizeAnswer(full);
  ev.onResult(rid, { text: full, answer });
  return { full, answer, usedTool: false, grounded: false, verified: "" };
}

export async function runAgent(
  problem: string,
  mode: Mode,
  ev: PipelineEvents,
  signal: AbortSignal,
  opts: RunOpts = {}
): Promise<PipelineResult> {
  const { useMemory = true, docContext = "", skillAddon = "", history = [] } = opts;
  // OKF memory recall is only for the full Reasoning pipeline — knowledge/thinking
  // don't need it and injecting the profile just pollutes their context. They still
  // get any explicitly attached-document context.
  const ctx =
    useMemory && mode === "reasoning"
      ? await recallContext(problem, ev, signal, docContext)
      : docContext;

  // ---- KNOWLEDGE ----
  if (mode === "knowledge") {
    const id = "answer";
    ev.onStep({ id, kind: "answer", title: "Answer", blurb: "Direct response", accent: ACCENT.answer });
    const full = await streamChat(
      [
        { role: "system", content: SYS_KNOWLEDGE + skillAddon + contextSystem(ctx) },
        ...history,
        { role: "user", content: knowledgeUser(problem) },
      ],
      // same anti-degeneration guards as thinking/reasoning: hard stops (incl.
      // "\nQuestion:"/"\nUser:") + freq/presence penalties so the quantized 7B
      // can't spew repeated tokens or roll into a self-generated Q&A list.
      {
        maxTokens: 420,
        temperature: 0.3,
        signal,
        stop: REACT_STOPS,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        onToken: (_d, f) => ev.onToken(id, f),
      }
    );
    const answer = finalizeAnswer(full, true) || "(no answer)";
    ev.onResult(id, { text: full, answer });
    return { finalAnswer: answer, usedTool: false, toolGrounded: false };
  }

  // ---- THINKING ----
  // Classify the question FIRST, then commit to one path:
  //   needs computation  -> write code DIRECTLY (no in-head reasoning, which is
  //                         where it wrongly answered "1"/"120" or spewed), run it,
  //                         and the executed output IS the answer.
  //   no computation      -> reason step by step, then answer.
  if (mode === "thinking") {
    const r = detectMechanical(problem)
      ? await codeSolve(problem, ctx, history, ev, signal, "")
      : await reasonSolve(problem, ctx, history, ev, signal, "");
    return { finalAnswer: r.answer, usedTool: r.usedTool, toolGrounded: r.grounded };
  }

  // ---- REASONING (full pipeline) ----
  // The MODEL recalls and answers from the injected OKF memory — that's the
  // showcase. The deterministic answerFromMemory() is NOT a fast-path shortcut
  // here; it's kept only as a SAFETY NET further down (the `if (bad)` guarantee),
  // used when the model degenerates into a non-answer. Regex second, model first.

  // Only genuine computations (counting/arithmetic/string ops) go down the
  // tool-executing ReAct path. Codegen ("write a script…"), statements, and
  // normal questions are plain chat — code is shown, NEVER auto-executed.
  const solveOnce = (extraSys: string, tag: string) =>
    detectMechanical(problem)
      ? reactSolve(problem, ctx, skillAddon + extraSys, history, ev, signal, tag, true)
      : plainGenerate(problem, ctx, skillAddon + extraSys, history, ev, signal, tag);

  let r = await solveOnce("", "");

  // Quality gate: resample once if the answer is weak. Two independent triggers,
  // so the pipeline self-corrects even when the reward model is offline:
  //   (a) reward gate (bge-reranker) scores the chain-of-thought below threshold;
  //   (b) a deterministic non-answer check (persona echo / empty / refusal).
  const gateId = "gate";
  ev.onStep({ id: gateId, kind: "gate", title: "Reward gate", blurb: "bge-reranker · scores before release", accent: ACCENT.gate });
  let score = await scoreReward(problem, r.verified, scoreDoc(r.full), signal);
  let bad = isNonAnswer(r.answer);
  const weakScore = score !== null && score < GATE_THRESHOLD;
  let note = score === null ? (bad ? "no score — answer looks weak" : "reward gate unavailable — skipped") : `score ${(score * 100).toFixed(0)}/100`;
  if ((weakScore || bad) && !signal.aborted) {
    ev.onResult(gateId, { score: score ?? undefined, note: `${bad ? "non-answer" : `${((score ?? 0) * 100).toFixed(0)}/100 < ${(GATE_THRESHOLD * 100).toFixed(0)}`} → resampling` });
    // A persona-echo/non-answer means the heavy prompt derailed the model — retry
    // with a stripped, direct prompt. A merely low SCORE just gets a normal redo.
    const r2 = bad
      ? await directGrounded(problem, ctx, history, ev, signal, "retry-")
      : await solveOnce("\nThe previous attempt may be wrong, empty, or off-topic. Answer the question directly and correctly.", "retry-");
    const s2 = await scoreReward(problem, r2.verified, scoreDoc(r2.full), signal);
    const bad2 = isNonAnswer(r2.answer);
    // prefer a real answer over a non-answer; otherwise take the higher score.
    const take2 = bad && !bad2 ? true : bad2 ? false : (s2 ?? 0) >= (score ?? 0);
    if (take2) {
      r = r2;
      score = s2;
      bad = bad2;
    }
    note = `best of 2 → ${score === null ? (bad ? "still weak" : "ok") : `${((score ?? 0) * 100).toFixed(0)}/100`}`;
  }
  // Final guarantee: if generation STILL degenerated into a non-answer but the
  // recall context clearly contains the fact, answer deterministically from
  // memory — an identity lookup must never show persona-echo to the user.
  if (bad) {
    const fromMem = answerFromMemory(problem, ctx);
    if (fromMem) {
      r = { ...r, answer: fromMem };
      bad = false;
      note += " · answered from memory";
    }
  }

  const passed = bad ? false : score === null ? true : score >= GATE_THRESHOLD;
  ev.onResult(gateId, { score: score ?? undefined, ok: passed, note });

  // preference trace for LoRA: (prompt, CoT, answer) + reward label, refinable by 👍/👎
  const cot = extractThink(r.full) || scoreDoc(r.full);
  const traceId = (await logTrace({ mode: "reasoning", problem, cot, answer: r.answer, reward: score })) ?? undefined;

  return { finalAnswer: r.answer, usedTool: r.usedTool, toolGrounded: r.grounded, traceId };
}
