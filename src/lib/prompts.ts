// Tool-Integrated Reasoning pipeline prompts + parsers.
//
// Grounded in:
//   PAL   (Gao et al. 2022, arXiv:2211.10435) — LLM writes a program, an
//         interpreter runs it; offload computation from the (error-prone) model.
//   PoT   (Chen et al. 2022, arXiv:2211.12588) — disentangle reasoning from
//         computation; +12% over CoT.
//   ReAct (Yao et al. 2022, arXiv:2210.03629) — Thought -> Act(tool) -> Observe.
//   Han et al. 2024 (arXiv:2404.17140) — small models are weak self-critics, so
//         the Verifier is grounded on the EXECUTED result, not free self-critique.
//   Strawberry/counting is a TOKENIZATION failure (arXiv:2412.18626, 2410.19730)
//         — only code execution makes counting reliable.
//
// Prompts use the model's trained <think>/<answer> format so the SFT/GRPO model
// stays in-distribution.

export const SYS_KNOWLEDGE =
  "You are answering a knowledge or commonsense question. Give the correct, " +
  "concise answer directly — do not over-think simple questions. Reason briefly " +
  "inside <think> and </think> only if needed, then put the final answer inside " +
  "<answer> and </answer>.";

export function knowledgeUser(problem: string): string {
  return `Question: ${problem}`;
}

// ---- ReAct loop prompt (CoT + tool use, with few-shot that teaches WHEN to code) ----
export const SYS_REACT =
  "You are a reasoning agent that can run Python. Think step by step inside " +
  "<think> and </think>. You are UNRELIABLE at counting letters or items, " +
  "enumerating things, arithmetic, dates, and string operations — for ANY such " +
  "step you MUST use Python instead of doing it in your head. To use the tool, " +
  "write ONE Python code block that prints the result, then STOP and wait:\n" +
  "```python\n# code that prints the result\n```\n" +
  "You will then receive a line 'TOOL OUTPUT: <result>'. Use it to give the final " +
  "answer inside <answer> and </answer>. If genuinely no computation is needed, " +
  "give the answer directly inside <answer> and </answer>.\n\n" +
  "Example 1:\n" +
  "Problem: How many times does the letter p appear in pineapple?\n" +
  "<think>Counting letters by hand is error-prone, so I will use code.</think>\n" +
  '```python\nprint("pineapple".count("p"))\n```\n' +
  "TOOL OUTPUT: 3\n" +
  "<answer>3</answer>\n\n" +
  "Example 2:\n" +
  "Problem: How many days of the week start with the letter T?\n" +
  "<think>I will enumerate the days and filter with code, rather than risk " +
  "missing one.</think>\n" +
  '```python\ndays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]\n' +
  'print(len([d for d in days if d.startswith("T")]))\n```\n' +
  "TOOL OUTPUT: 2\n" +
  "<answer>2</answer>";

export function reactUser(problem: string): string {
  return `Problem: ${problem}`;
}

export function hasAnswerTag(text: string): boolean {
  return /<answer>/i.test(text);
}

// keep only up to the end of the first code block (drop any hallucinated output
// the model wrote after its own code, before the tool ran)
export function truncateAfterCode(text: string): string {
  const m = text.match(/```(?:python|py)?[\s\S]*?```/i);
  if (!m || m.index === undefined) return text;
  return text.slice(0, m.index + m[0].length);
}

export const SYS_SOLVER =
  "You are the SOLVER in a tool-using pipeline. Solve the problem, but follow one " +
  "hard rule: NEVER do arithmetic, count letters/items, reverse strings, or " +
  "compute dates in your head — you are unreliable at that. Instead WRITE PYTHON " +
  "CODE that computes it and prints ONLY the final answer. Put your reasoning " +
  "inside <think> and </think>. Then, if any computation is needed, output exactly " +
  "one Python code block:\n" +
  "```python\n# compute and print only the final answer\n```\n" +
  "If truly no computation is required, put the final answer inside <answer> and " +
  "</answer>.";

export const SYS_CONSOLIDATOR =
  "You are the CONSOLIDATOR. You are given the problem, the solver's worked " +
  "solution, and — if code was run — the TOOL RESULT from executing it. Do NOT " +
  "re-solve the problem from scratch. Synthesize ONE clear final answer: if a " +
  "TOOL RESULT exists it is GROUND TRUTH — use it verbatim. Put a one-line " +
  "justification inside <think> and </think>, then the final answer inside " +
  "<answer> and </answer>.";

// ---- user-message builders ----
export function solverUser(problem: string): string {
  return `Problem: ${problem}`;
}
export function consolidatorUser(
  problem: string,
  solverReasoning: string,
  toolResult: string | null
): string {
  const tool = toolResult
    ? `\n\nTOOL RESULT (ground truth, from executing the solver's code):\n${toolResult}`
    : "\n\n(No tool was used for this problem.)";
  return `Problem: ${problem}\n\nSOLVER SOLUTION:\n${solverReasoning}${tool}`;
}

// ---- parsers ----
export function extractAnswer(text: string): string {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (m) return m[1].trim();
  const open = text.match(/<answer>([\s\S]*)$/i);
  if (open) return open[1].trim();
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : text.trim();
}

export function extractThink(text: string): string {
  const m = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (m) return m[1].trim();
  const open = text.match(/<think>([\s\S]*)$/i);
  if (open) return open[1].trim();
  return "";
}

// pull the first python code block (``` fences) or <code>…</code>
export function extractCode(text: string): string | null {
  const fence = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const tag = text.match(/<code>([\s\S]*?)<\/code>/i);
  if (tag) return tag[1].trim();
  return null;
}

// ---- deterministic router: force the code path for mechanical questions ----
// (so strawberry-class questions are guaranteed, not dependent on the small
//  model choosing to write code.)
export function detectMechanical(problem: string): boolean {
  const p = problem.toLowerCase();
  return (
    /how many\s+(times|letters?|characters?|words?|vowels?|[a-z]'?s?\b)/.test(p) ||
    /\bcount\b|\bnumber of\b|\bhow many\b/.test(p) ||
    /\breverse\b|\bsort\b|\bspell\b/.test(p) ||
    /\d[\d,\.]*\s*[\+\-\*x×÷/]\s*\d/.test(p) // an explicit arithmetic expression
  );
}

// Last-resort code so the most common mechanical questions are guaranteed even
// when the small model fails to emit code (which it often does). Covers:
//   (a) letter-in-word counting   "how many r's in strawberry" / "count the e in excellence"
//   (b) a bare arithmetic expression   "what is 17 * 1.20 / 3"
const MONTHS =
  '["January","February","March","April","May","June","July","August","September","October","November","December"]';
const DAYS = '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]';

export function buildFallbackCode(problem: string): string | null {
  // (0) enumerate-and-count over months / days of the week starting with a letter
  const enumMatch = problem.match(
    /how many\s+(months?|days?)[\s\S]*?\bstart(?:s|ing)?\s+with\s+(?:the\s+letter\s+)?["']?([a-zA-Z])/i
  );
  if (enumMatch) {
    const list = /day/i.test(enumMatch[1]) ? DAYS : MONTHS;
    const letter = enumMatch[2].toUpperCase().replace(/[^A-Z]/g, "");
    if (letter) return `print(len([x for x in ${list} if x.startswith("${letter}")]))`;
  }

  // (a) letter counting — accept how many / count / count the number of / number of
  const letterMatch = problem.match(
    /(?:how many|count(?:\s+the\s+number\s+of)?|number of)\s+(?:times\s+(?:does|do)\s+)?(?:the\s+)?(?:letter\s+)?["']?([a-zA-Z])["']?(?:'s|s)?\b[\s\S]*?\bin\b\s+(?:the\s+word\s+)?["']?([A-Za-z][A-Za-z-]*)["']?/i
  );
  if (letterMatch) {
    const letter = letterMatch[1].toLowerCase().replace(/[^a-z]/g, "");
    const word = letterMatch[2].toLowerCase().replace(/[^a-z-]/g, "");
    if (letter && word) return `print("${word}".count("${letter}"))`;
  }

  // (b) a self-contained arithmetic expression (digit op digit, possibly chained)
  const arith = problem.match(/(\d[\d.,]*\s*(?:[+\-*/×x÷]\s*\d[\d.,]*\s*)+)/);
  if (arith) {
    const expr = arith[1]
      .replace(/[×x]/g, "*")
      .replace(/÷/g, "/")
      .replace(/,/g, "")
      .replace(/[^0-9+\-*/(). ]/g, "")
      .trim();
    if (expr && /[+\-*/]/.test(expr)) return `print(${expr})`;
  }
  return null;
}
