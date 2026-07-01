// Deterministic fact extraction for OKF capture — the reliable core.
//
// SLMs are unreliable at emitting clean JSON (they even hallucinate facts), so
// the "remember me" cases are handled by high-precision regex rules that produce
// clean concepts every time, offline, no model call. Pure + unit-tested.

export interface Fact {
  type: string; // Person | Preference | Project | Goal | Fact | Contact | Note
  title: string;
  body: string;
  tags: string[];
}

const clip = (s: string, n = 70) => s.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "").slice(0, n);
const titleCase = (s: string) => s.trim().split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

const NOT_NAME = new Set(
  "building working going trying preparing studying learning looking making creating developing here sorry not sure good fine okay ok ready done happy tired excited interested currently now just also still always really very feeling thinking using running".split(" ")
);
const LOC_STOP = new Set("moment present past future denial fear hope peace general particular city town country world house apartment home flat".split(" "));
// attributes after "my … is" that aren't durable facts (or handled elsewhere)
const POSSESSIVE_STOP = new Set("point guess question problem concern issue understanding opinion thought idea name email goal plan answer response reply".split(" "));

const STOP = new Set("a an the of to in on for and or is are was were be i you my me we they this that it here there as at by from with".split(" "));
// significant, lightly-stemmed tokens for dedup
function sigTokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t))
  );
}
function subset(a: Set<string>, b: Set<string>): boolean {
  if (!a.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// bare "remember this" / "save it to memory" — no content; caller uses prior turn.
export function isBareSaveCommand(msg: string): boolean {
  return /^\s*(?:remember|save|note|keep|store)\s*(?:this|it|that|these|those|the above|the following)?\s*(?:to|in|into)?\s*(?:memory|okf)?\s*[.!]?\s*$/i.test(msg);
}

function factsFromClause(text: string): Fact[] {
  const facts: Fact[] = [];
  const add = (type: string, title: string, body: string, tags: string[] = []) => {
    const t = clip(title);
    const b = body.replace(/\s+/g, " ").trim();
    if (t && b) facts.push({ type, title: t, body: b.endsWith(".") ? b : b + ".", tags });
  };

  // --- name ---
  let m = text.match(/\b(?:my name is|i am called|i'?m called|you can call me|call me)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}'-]+){0,2})/iu);
  if (m) {
    const name = titleCase(m[1]);
    add("Person", name, `The user's name is ${name}`, ["identity", "name"]);
  } else {
    const im = text.match(/\b[Ii]'?m\s+([A-Z][a-z]{1,20})\b/);
    if (im && !NOT_NAME.has(im[1].toLowerCase())) add("Person", im[1], `The user's name is ${im[1]}`, ["identity", "name"]);
  }

  // --- email (deterministic — the SLM used to hallucinate this) ---
  if (/\b(?:my |e-?mail|contact|reach me)/i.test(text)) {
    const em = text.match(EMAIL);
    if (em) add("Contact", `Email ${em[0]}`, `The user's email is ${em[0]}`, ["email", "contact"]);
  }

  // --- generic possessive "my X is/are Y" (phone, birthday, hobbies …) ---
  m = text.match(/\bmy\s+([a-z][a-z ]{1,28}?)\s+(is|are)\s+(.+?)(?=[.;\n]|$)/i);
  if (m) {
    const attr = m[1].trim().toLowerCase();
    const verb = m[2].toLowerCase();
    const val = m[3].trim();
    if (val && !POSSESSIVE_STOP.has(attr.split(" ")[0])) add("Fact", `${titleCase(attr)}: ${clip(val, 40)}`, `The user's ${attr} ${verb} ${val}`, [attr.split(" ")[0]]);
  }

  // --- works at ---
  m = text.match(/\b[Ii]\s+work\s+(?:at|for|with)\s+([A-Z][\w&\- ]*[\w)]|[A-Z]\w*)/);
  if (m) add("Fact", `Works at ${m[1].trim()}`, `The user works at ${m[1].trim()}`, ["work"]);

  // --- role ---
  m = text.match(/\b[Ii](?:'?m| am)\s+(?:an?\s+)?([a-z][a-z ]*?(?:engineer|developer|programmer|student|designer|manager|researcher|founder|scientist|analyst|teacher|professor|doctor|nurse|lawyer|architect|consultant|writer|artist|intern|ceo|cto|pm))\b/i);
  if (m) {
    const role = m[1].replace(/^an?\s+/i, "").trim();
    add("Person", role, `The user is a ${role}`, ["role"]);
  }

  // --- location (lowercase ok) ---
  m = text.match(/\bi\s+(?:live|am based|reside)\s+in\s+(?:the\s+)?([a-z][\w .\-]*?)(?=[.,;\n?!]|$)/i);
  if (m) {
    const place = titleCase(m[1].trim());
    if (place && !LOC_STOP.has(place.toLowerCase())) add("Person", `Lives in ${place}`, `The user lives in ${place}`, ["location"]);
  }

  // --- project ---
  m = text.match(/\b[Ii](?:'?m| am)\s+(?:currently\s+)?((?:working on|building|developing|making|creating)\s+.+?)(?=[.;\n]|$)/i);
  if (m) add("Project", m[1], `The user is ${m[1].trim()}`, ["project"]);

  // --- goal ---
  m = text.match(/\b[Ii](?:'?m| am)\s+((?:preparing for|studying for|planning to|aiming to|hoping to|trying to|going to)\s+.+?)(?=[.;\n]|$)/i);
  if (m) add("Goal", m[1], `The user is ${m[1].trim()}`, ["goal"]);

  // --- preference (like/dislike) ---
  m = text.match(/\b[Ii]\s+(prefer|like|love|enjoy|dislike|hate|don'?t like|can'?t stand)\s+(.+?)(?=[.;\n]|$)/i);
  if (m) add("Preference", m[2], `The user ${m[1].toLowerCase()} ${m[2].trim()}`, ["preference"]);

  // --- style preference ---
  m = text.match(/\b(?:always|please)\s+((?:answer|reply|respond|keep|be|use|write|explain|format)\b.+?)(?=[.;\n]|$)/i);
  if (m) add("Preference", m[1], `The user wants you to ${m[1].trim()}`, ["style"]);

  // --- explicit "remember X" / "save X to memory" — only if nothing else fired,
  //     and the content is real (not a bare "this"/"it"). "save"/"store" only
  //     trigger near "memory" or an object, so "I want to save money" is ignored.
  if (!facts.length) {
    m =
      text.match(/\b(?:remember|note|keep in mind)\s*(?:that\s+)?[:\-]?\s*(.+)$/i) ||
      text.match(/\b(?:save|add|store)(?:\s+(?:this|it|that|the following))?\s+(?:to|in)\s+memory\s*[:\-]?\s*(.*)$/i) ||
      text.match(/\bsave\s+(?:this|it|that|the following)\b\s*[:\-]?\s*(.*)$/i);
    if (m) {
      const content = m[1].trim();
      if (content && !/^(?:this|it|that|these|those|the above|the following)\.?$/i.test(content) && content.length > 2) add("Note", content, content, ["note"]);
    }
  }

  return facts;
}

export function extractFactsRules(msg: string): Fact[] {
  // split into clauses, but only on sentence punctuation FOLLOWED BY whitespace,
  // so emails/decimals ("avaram.hasan@gmail.com", "3.14") stay intact.
  const clauses = msg
    .split(/(?<=[.!?;])\s+|\n+|,\s+(?=(?:i\b|i'?m\b|my\b|and\s+i\b))|\s+(?:but|and)\s+(?=(?:i\b|i'?m\b))/i)
    .map((c) => c.trim().replace(/[.!?;,]+$/, "").trim())
    .filter(Boolean);
  const all: Fact[] = [];
  for (const c of clauses) all.push(...factsFromClause(c));

  // dedupe: drop a fact whose meaning is a subset of one already kept (handles
  // "concise answers" vs "prefers concise answers", "like tea" vs "user likes tea").
  const kept: Fact[] = [];
  for (const f of all) {
    const ft = sigTokens(f.title + " " + f.body);
    const dup = kept.some((g) => {
      const gt = sigTokens(g.title + " " + g.body);
      return subset(ft, gt) || subset(gt, ft);
    });
    if (!dup) kept.push(f);
  }
  return kept;
}

// exported for write-time dedup against the existing store
export { sigTokens, subset };
