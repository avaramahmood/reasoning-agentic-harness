// Two modes over one on-device SLM:
//
//   knowledge : 1 model pass — recall/commonsense. No tools.
//   thinking  : a ReAct LOOP — the model reasons (CoT), and whenever a step needs
//               counting / enumeration / arithmetic it writes Python; we execute
//               it, feed the real result back, and the model continues until it
//               gives a final answer. A few-shot prompt teaches it WHEN to code,
//               and a deterministic fallback guarantees the common mechanical
//               cases even if the model fails to.

import { streamChat, ChatMessage } from "./llm";
import { execCode } from "./control";
import {
  SYS_KNOWLEDGE,
  SYS_REACT,
  knowledgeUser,
  reactUser,
  extractAnswer,
  extractCode,
  hasAnswerTag,
  truncateAfterCode,
  detectMechanical,
  buildFallbackCode,
} from "./prompts";

export type Mode = "knowledge" | "thinking";

export interface ModeInfo {
  id: Mode;
  label: string;
  blurb: string;
  est: string;
}

export const MODES: ModeInfo[] = [
  { id: "knowledge", label: "Knowledge", blurb: "Facts & recall — one quick pass", est: "fast" },
  { id: "thinking", label: "Thinking", blurb: "Reason ⇄ run code until solved", est: "thorough" },
];

export type StepKind = "answer" | "solve" | "exec" | "consolidate";

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
}

const ACCENT: Record<StepKind, string> = {
  answer: "#10b981",
  solve: "#1c5fd6",
  exec: "#f59e0b",
  consolidate: "#14b8a6",
};

const REACT_STOPS = ["<|im_end|>", "<|endoftext|>", "</answer>", "TOOL OUTPUT"];
const MAX_ITERS = 3;

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : s.trim();
}

// this small model occasionally appends non-ASCII spew after the real answer;
// keep the first line and trim a trailing non-printable-ASCII tail.
function cleanAnswer(a: string): string {
  const first = a.split("\n")[0];
  const cleaned = first.replace(/[^\x20-\x7E]+$/g, "").trim();
  return cleaned || a.trim();
}

export async function runAgent(
  problem: string,
  mode: Mode,
  ev: PipelineEvents,
  signal: AbortSignal
): Promise<PipelineResult> {
  // ---- KNOWLEDGE: single fast pass ----
  if (mode === "knowledge") {
    const id = "answer";
    ev.onStep({ id, kind: "answer", title: "Answer", blurb: "Direct response", accent: ACCENT.answer });
    const full = await streamChat(
      [
        { role: "system", content: SYS_KNOWLEDGE },
        { role: "user", content: knowledgeUser(problem) },
      ],
      { maxTokens: 420, temperature: 0.3, signal, onToken: (_d, f) => ev.onToken(id, f) }
    );
    const answer = extractAnswer(full);
    ev.onResult(id, { text: full, answer });
    return { finalAnswer: answer, usedTool: false, toolGrounded: false };
  }

  // ---- THINKING: ReAct loop ----
  const mechanical = detectMechanical(problem);
  const messages: ChatMessage[] = [
    { role: "system", content: SYS_REACT },
    { role: "user", content: reactUser(problem) },
  ];

  let finalAnswer = "";
  let usedTool = false;
  let grounded = false;
  let lastToolOut = "";

  for (let i = 0; i < MAX_ITERS; i++) {
    const rid = `reason-${i}`;
    ev.onStep({
      id: rid,
      kind: "solve",
      title: i === 0 ? "Reasoning" : "Continue",
      blurb: i === 0 ? "Chain-of-thought · decides if code is needed" : "Reads the tool output",
      accent: ACCENT.solve,
    });
    const full = await streamChat(messages, {
      maxTokens: 640,
      temperature: 0.3,
      signal,
      stop: REACT_STOPS,
      onToken: (_d, f) => ev.onToken(rid, f),
    });
    ev.onResult(rid, { text: full, answer: hasAnswerTag(full) ? extractAnswer(full) : undefined });

    let code = extractCode(full);
    if (!code && mechanical && i === 0) code = buildFallbackCode(problem); // safety net

    if (code) {
      usedTool = true;
      messages.push({ role: "assistant", content: truncateAfterCode(full) });

      const eid = `exec-${i}`;
      ev.onStep({ id: eid, kind: "exec", title: "Execute", blurb: "Run code — ground truth", accent: ACCENT.exec });
      const res = await execCode(code);
      const out = res.ok
        ? res.stdout.trim() || "(no output)"
        : `error: ${res.stderr || (res.timedOut ? "timed out" : "failed")}`;
      ev.onResult(eid, { code, output: out, ok: res.ok });
      if (res.ok) lastToolOut = lastLine(out);

      // mechanical + clean run -> executed value IS the answer (for sure)
      if (res.ok && mechanical) {
        finalAnswer = lastLine(out);
        grounded = true;
        break;
      }
      // otherwise feed the result back and let the model conclude
      messages.push({ role: "user", content: `TOOL OUTPUT: ${out}` });
      continue;
    }

    // no code this turn -> the model's answer is final
    finalAnswer = cleanAnswer(extractAnswer(full));
    break;
  }

  if (!finalAnswer) finalAnswer = lastToolOut || "(no answer)";
  return { finalAnswer, usedTool, toolGrounded: grounded };
}
