// Open Knowledge Format (OKF) — fully-local, on-device store.
//
// This is a from-scratch, dependency-free implementation of the OKF format
// (https://github.com/GoogleCloudPlatform/knowledge-catalog, SPEC.md v0.1).
// NONE of Google's cloud reference agent is used: no Gemini, no BigQuery, no
// network. We only adopt the *format* — plain UTF-8 markdown files with YAML
// frontmatter — as the user's private knowledge store on disk.
//
// A "concept" is one .md file:
//
//   ---
//   type: Person                       # REQUIRED (OKF conformance)
//   title: John Smith
//   description: CS student, RIVA teammate
//   tags: [student, teammate]
//   timestamp: 2026-06-30T12:00:00Z
//   marks: { DSA: 87, ML: 92 }         # arbitrary extension keys are allowed
//   ---
//   Free-form markdown body. Link other concepts with [text](/projects/x.md).
//
// Concept ID = path under the store with ".md" removed  (people/john-smith).
// Reserved files index.md and log.md are auto-maintained.
//
// Retrieval here is keyword/overlap scoring — deterministic, instant, and needs
// no model. (You can later swap in a GGUF embedder for semantic search; the
// search() contract stays the same.)

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// store location
// ---------------------------------------------------------------------------
let STORE = null;

export function initStore(dir) {
  STORE = dir;
  fs.mkdirSync(STORE, { recursive: true });
  // no demo seeds — the store holds only the user's real facts (seeds polluted
  // the injected profile, e.g. a phantom "RAG pipeline for legal docs" project).
  rebuildIndex();
  return STORE;
}

function ensure() {
  if (!STORE) throw new Error("OKF store not initialized (call initStore first)");
}

const RESERVED = new Set(["index", "log"]);

// ---------------------------------------------------------------------------
// id <-> path helpers
// ---------------------------------------------------------------------------
function safeId(id) {
  // normalize to forward slashes, strip leading/trailing slashes and any "..",
  // lowercase, and slugify each segment so ids are stable + path-traversal safe.
  const parts = String(id)
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => s.replace(/[^a-z0-9-_ ]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-"));
  return parts.join("/");
}

function pathForId(id) {
  ensure();
  return path.join(STORE, ...safeId(id).split("/")) + ".md";
}

function idForPath(p) {
  return path.relative(STORE, p).replace(/\\/g, "/").replace(/\.md$/i, "");
}

export function slugify(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled";
}

// ---------------------------------------------------------------------------
// minimal YAML frontmatter parse / serialize
//   supports: scalars, inline [a, b] arrays, block "- item" lists, and
//   one-level nested maps (both inline {k: v} and indented).
// ---------------------------------------------------------------------------
function parseScalar(raw) {
  let v = raw.trim();
  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function parseInline(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseScalar(s));
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of inner.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      obj[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1));
    }
    return obj;
  }
  return parseScalar(v);
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const km = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!km) { i++; continue; }
    const key = km[1];
    const rest = km[2];
    if (rest.trim() !== "") {
      meta[key] = parseInline(rest);
      i++;
      continue;
    }
    // value is on following indented lines: either a block list or a nested map
    const block = [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) { block.push(lines[j]); j++; }
    if (block.length && block.every((b) => b.trim().startsWith("- "))) {
      meta[key] = block.map((b) => parseScalar(b.trim().slice(2)));
    } else if (block.length) {
      const obj = {};
      for (const b of block) {
        const bm = b.trim().match(/^([A-Za-z0-9_-]+):(.*)$/);
        if (bm) obj[bm[1]] = parseInline(bm[2]);
      }
      meta[key] = obj;
    } else {
      meta[key] = "";
    }
    i = j;
  }
  return { meta, body: m[2].trim() };
}

function dumpScalar(v) {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (s === "" || /[:#\[\]{},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function serialize(meta, body) {
  const order = ["type", "title", "description", "resource", "tags", "timestamp"];
  const keys = [...order.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !order.includes(k))];
  const lines = ["---"];
  for (const k of keys) {
    const v = meta[k];
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(dumpScalar).join(", ")}]`);
    } else if (v && typeof v === "object") {
      lines.push(`${k}: {${Object.entries(v).map(([kk, vv]) => `${kk}: ${dumpScalar(vv)}`).join(", ")}}`);
    } else {
      lines.push(`${k}: ${dumpScalar(v)}`);
    }
  }
  lines.push("---", "", (body || "").trim(), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.md$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

export function listConcepts() {
  ensure();
  const out = [];
  for (const p of walk(STORE)) {
    const id = idForPath(p);
    if (RESERVED.has(id)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(p, "utf8"));
      out.push({ id, type: meta.type || "Concept", title: meta.title || id, description: meta.description || "", tags: meta.tags || [], meta, body, bodyChars: body.length });
    } catch { /* tolerate a malformed file */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function readConcept(id) {
  ensure();
  const p = pathForId(id);
  if (!fs.existsSync(p)) return null;
  const { meta, body } = parseFrontmatter(fs.readFileSync(p, "utf8"));
  return { id: safeId(id), meta, body };
}

export function writeConcept({ id, type, title, description, tags, resource, body, extra }) {
  ensure();
  if (!type || !String(type).trim()) throw new Error("OKF requires a non-empty 'type'");
  if (!id) id = (type ? slugify(type) + "/" : "") + slugify(title || "untitled");
  const sid = safeId(id);
  const meta = { type: String(type).trim() };
  if (title) meta.title = title;
  if (description) meta.description = description;
  if (resource) meta.resource = resource;
  if (Array.isArray(tags) && tags.length) meta.tags = tags;
  meta.timestamp = new Date().toISOString();
  if (extra && typeof extra === "object") for (const [k, v] of Object.entries(extra)) meta[k] = v;

  const p = pathForId(sid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existed = fs.existsSync(p);
  fs.writeFileSync(p, serialize(meta, body || ""), "utf8");
  appendLog(`${existed ? "updated" : "added"} \`${sid}\` (${meta.type}) — ${title || ""}`.trim());
  rebuildIndex();
  return { id: sid, meta };
}

export function deleteConcept(id) {
  ensure();
  const sid = safeId(id);
  const p = pathForId(sid);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p);
  appendLog(`removed \`${sid}\``);
  rebuildIndex();
  return true;
}

// wipe every concept (keeps reserved index.md/log.md, which get rebuilt)
export function clearAll() {
  ensure();
  let n = 0;
  for (const p of walk(STORE)) {
    if (RESERVED.has(idForPath(p))) continue;
    try { fs.rmSync(p); n++; } catch { /* ignore */ }
  }
  // drop now-empty subdirectories
  for (const e of fs.readdirSync(STORE, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = path.join(STORE, e.name);
    if (!walk(d).length) fs.rmSync(d, { recursive: true, force: true });
  }
  appendLog(`cleared all (${n} concepts removed)`);
  rebuildIndex();
  return n;
}

// ---------------------------------------------------------------------------
// retrieval — keyword/overlap scoring (deterministic, no model)
// ---------------------------------------------------------------------------
const STOP = new Set("a an the of to in on for and or is are was were be been being do does did has have had i you he she it we they my your our their this that these those with as at by from about what which who whom how when where why can could should would will my me".split(" "));

function tokenize(s) {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    // light stemming so word variants match: lives->live, likes->like, coding->code-ish
    .map((t) => (t.length > 4 && (t.endsWith("s") || t.endsWith("ing")) ? t.replace(/(?:ing|s)$/, "") : t));
}

export function search(query, k = 4) {
  ensure();
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qSet = new Set(qTokens);
  const results = [];
  for (const p of walk(STORE)) {
    const id = idForPath(p);
    if (RESERVED.has(id)) continue;
    let meta, body;
    try { ({ meta, body } = parseFrontmatter(fs.readFileSync(p, "utf8"))); } catch { continue; }

    // weighted fields: title/tags/type matter more than body
    const fields = [
      [tokenize(meta.title || id), 5],
      [tokenize(Array.isArray(meta.tags) ? meta.tags.join(" ") : ""), 4],
      [tokenize(meta.type || ""), 3],
      [tokenize(meta.description || ""), 2],
      [tokenize(body), 1],
      [tokenize(id.replace(/[/-]/g, " ")), 3],
      [tokenize(factLine(meta)), 2], // extension keys: marks, status, experience, …
    ];
    let score = 0;
    for (const [toks, w] of fields) {
      const set = new Set(toks);
      for (const q of qSet) if (set.has(q)) score += w;
    }
    // substring bonus: whole query phrase appears in title/body
    const hay = `${meta.title || ""} ${meta.description || ""} ${body}`.toLowerCase();
    if (query.trim().length > 2 && hay.includes(query.trim().toLowerCase())) score += 6;

    if (score > 0) {
      results.push({
        id,
        score,
        type: meta.type || "Concept",
        title: meta.title || id,
        description: meta.description || "",
        meta,
        snippet: snippet(body || meta.description || "", qSet),
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

function snippet(body, qSet, span = 220) {
  const clean = body.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const lower = clean.toLowerCase();
  let at = -1;
  for (const q of qSet) { const i = lower.indexOf(q); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return clean.slice(0, span) + (clean.length > span ? "…" : "");
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + clean.slice(start, start + span) + (start + span < clean.length ? "…" : "");
}

// Render retrieved concepts as a compact grounding block for the model prompt.
export function asContextBlock(hits) {
  if (!hits.length) return "";
  const lines = hits.map((h) => {
    const facts = factLine(h.meta);
    return `- [${h.id}] ${h.title}${h.type ? ` (${h.type})` : ""}${facts ? ` — ${facts}` : ""}${h.snippet ? `\n    ${h.snippet}` : ""}`;
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// recall — the grounding the model actually gets.
//   A personal store is SMALL, so for reliability we inject the WHOLE profile
//   (no keyword gamble) until it exceeds `cap`. Past that we keyword-search but
//   ALWAYS also include identity-ish facts (Person/Preference/Goal/Profile) so
//   "what is my name / where do I work / what are my goals" never miss.
// ---------------------------------------------------------------------------
// PROFILE = the user's own durable self-facts: who they are (Person/Contact),
// what they like (Preference), and what they're aiming at (Goal). These are few
// and almost always relevant to "about me" questions, and — crucially — keyword
// search can't bridge vocabulary gaps ("list my favorite foods" shares no words
// with "likes pizza, dosa, sushi"). So we ALWAYS inject the whole profile
// (bounded by maxProfile) and only keyword-match the unbounded rest (Notes,
// Facts, Projects, references, info about other people), which keeps recall
// small as the store grows without ever dropping the user's own facts.
const PROFILE_TYPES = new Set(["person", "contact", "preference", "goal", "profile"]);
const PROFILE_TAGS = new Set(["identity", "name", "email", "preference", "location", "role", "goal", "style"]);
function isProfile(it) {
  const type = String(it.meta.type || "").toLowerCase();
  if (PROFILE_TYPES.has(type)) return true;
  const tags = Array.isArray(it.meta.tags) ? it.meta.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.some((t) => PROFILE_TAGS.has(t))) return true;
  return /the user'?s? (?:name|email|phone|birthday) |the user (?:lives|likes|loves|prefers|enjoys|dislikes|hates|wants|is an?|is based|works)/i.test(it.body || "");
}

function allConcepts() {
  ensure();
  const out = [];
  for (const p of walk(STORE)) {
    const id = idForPath(p);
    if (RESERVED.has(id)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(p, "utf8"));
      out.push({ id, meta, body });
    } catch { /* skip malformed */ }
  }
  return out;
}

function renderConcept({ id, meta, body }, qSet) {
  const facts = factLine(meta);
  const title = meta.title || meta.name || id.split("/").pop();
  const snip = snippet(body || meta.description || "", qSet || new Set(), 240);
  return `- ${title}${meta.type ? ` (${meta.type})` : ""}${facts ? ` — ${facts}` : ""}${snip ? `\n    ${snip}` : ""}`;
}

// Recall: the whole user PROFILE (self-facts) is always injected so personal
// questions never miss on a vocabulary gap; the unbounded rest (Notes, Facts,
// Projects, references) is keyword-matched to the query so recall stays small as
// the store grows. Tiny stores just inject everything.
export function recall(query, { injectAll = 5, maxProfile = 24, k = 4 } = {}) {
  ensure();
  const items = allConcepts();
  if (!items.length) return { context: "", hits: [] };

  const qSet = new Set(tokenize(query));
  let chosen;
  if (items.length <= injectAll) {
    chosen = items; // tiny store -> inject everything
  } else {
    const profile = items.filter(isProfile).slice(0, maxProfile); // all self-facts, bounded
    const profileIds = new Set(profile.map((it) => it.id));
    const byId = new Map(items.map((it) => [it.id, it]));
    const matches = search(query, k)
      .map((h) => byId.get(h.id))
      .filter((it) => it && !profileIds.has(it.id)); // best keyword matches for the rest
    chosen = [...profile, ...matches];
  }

  const context = chosen.map((it) => renderConcept(it, qSet)).join("\n");
  const hits = chosen.map((it) => ({
    id: it.id,
    score: 0,
    type: it.meta.type || "Concept",
    title: it.meta.title || it.meta.name || it.id.split("/").pop(),
    description: it.meta.description || "",
    meta: it.meta,
    snippet: snippet(it.body || it.meta.description || "", qSet, 200),
  }));
  return { context, hits };
}

// flatten extension keys (e.g. marks: {DSA:87}) into a one-line fact string
function factLine(meta) {
  const skip = new Set(["type", "title", "description", "resource", "tags", "timestamp"]);
  const parts = [];
  for (const [k, v] of Object.entries(meta)) {
    if (skip.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parts.push(`${k}: ${Object.entries(v).map(([kk, vv]) => `${kk} ${vv}`).join(", ")}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}: ${v.join(", ")}`);
    } else if (v !== "" && v != null) {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// reserved files: index.md (listing) + log.md (history)
// ---------------------------------------------------------------------------
function rebuildIndex() {
  ensure();
  const items = listConcepts();
  const byType = {};
  for (const it of items) (byType[it.type] ||= []).push(it);
  const lines = ["---", "type: Index", "title: Knowledge Store Index", `timestamp: ${new Date().toISOString()}`, "---", "", `# Knowledge Store (${items.length} concepts)`, ""];
  for (const t of Object.keys(byType).sort()) {
    lines.push(`## ${t}`, "");
    for (const it of byType[t]) lines.push(`- [${it.title}](/${it.id}.md)${it.description ? ` — ${it.description}` : ""}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(STORE, "index.md"), lines.join("\n"), "utf8");
}

function appendLog(message) {
  ensure();
  const p = path.join(STORE, "log.md");
  const day = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 19);
  let text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "---\ntype: Log\ntitle: Change History\n---\n";
  const heading = `## ${day}`;
  const entry = `- ${time} — ${message}`;
  if (text.includes(heading)) {
    text = text.replace(heading, `${heading}\n${entry}`);
  } else {
    text += `\n${heading}\n${entry}\n`;
  }
  fs.writeFileSync(p, text, "utf8");
}

// ---------------------------------------------------------------------------
// seed a couple of example concepts so retrieval works out of the box
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  if (listConcepts().length) return;
  writeConcept({
    id: "people/john-smith",
    type: "Person",
    title: "John Smith",
    description: "CS student and teammate on the RIVA project.",
    tags: ["student", "teammate", "riva"],
    extra: { marks: { DSA: 87, ML: 92, Networks: 74 }, experience: "2y React, 1y PyTorch" },
    body:
      "John is a computer-science student currently working on a " +
      "[RAG pipeline for legal documents](/projects/rag-legal-docs.md).\n\n" +
      "# Notes\n- Prefers concise, technical answers.\n- Strong in ML, weaker in Networks.",
  });
  writeConcept({
    id: "projects/rag-legal-docs",
    type: "Project",
    title: "RAG pipeline for legal docs",
    description: "On-device retrieval-augmented generation over legal documents.",
    tags: ["rag", "legal", "nlp"],
    extra: { status: "in-progress", owner: "John Smith" },
    body:
      "A retrieval-augmented generation system over a corpus of legal documents.\n\n" +
      "Owner: [John Smith](/people/john-smith.md). Uses a local embedder + vector store.",
  });
}
