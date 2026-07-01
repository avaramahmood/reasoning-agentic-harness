// Control server (dependency-free, Node built-ins only).
//
// The browser can't hand a multi-GB model to llama.cpp, so this small local
// service owns the model lifecycle:
//   - GET  /api/models           list .gguf and .tar.gz under MODELS_DIR
//   - GET  /api/status           { model, ready, loading, error }
//   - POST /api/select {file}    extract (if archive) + (re)launch llama-server
//
// It spawns llama-server on LLAMA_PORT (8080) and itself listens on
// CONTROL_PORT (8081). Vite proxies /v1 -> 8080 and /api -> 8081.

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as okf from "./okf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODELS_DIR = process.env.MODELS_DIR || path.join(ROOT, "models");
const OKF_DIR = process.env.OKF_DIR || path.join(ROOT, "okf-store");
// preference-trace store for LoRA: positive/negative (prompt, CoT, answer) examples
// labeled by the reward-gate score AND the user's satisfaction. Separate from OKF.
const TRACES_FILE = process.env.TRACES_FILE || path.join(ROOT, "data", "traces.jsonl");
const EXTRACT_DIR = path.join(MODELS_DIR, ".extracted");
const LLAMA_SERVER = process.env.LLAMA_SERVER || "llama-server";
const LLAMA_PORT = Number(process.env.LLAMA_PORT || 8080);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8081);
const NGL = process.env.NGL || "15";
const CTX = process.env.CTX || "4096";

// Auxiliary service — the reward-gate GGUF (bge-reranker cross-encoder) served
// CPU-only with `--reranking` (scores answer vs question via /v1/rerank).
// (The 0.5B planner was removed — Reasoning mode is now direct 7B chain-of-thought.)
const REWARD_PORT = Number(process.env.REWARD_PORT || 8084);
const AUX_THREADS = process.env.AUX_THREADS || "4";
const AUX_DEFS = {
  reward: { port: REWARD_PORT, model: process.env.REWARD_MODEL || "reward-gate.gguf", ctx: 512, rerank: true },
};

// skills: user-authored markdown files that modify the 7B's behaviour
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(ROOT, "skills");

let child = null;
let state = { model: null, ready: false, loading: false, error: null };

// ---------- model discovery ----------
function isModelFile(name) {
  return /\.gguf$/i.test(name) || /\.(tar\.gz|tgz)$/i.test(name);
}

function listModels() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (isModelFile(e.name)) {
        let sizeMB = 0;
        try {
          sizeMB = Math.round(fs.statSync(p).size / 1e6);
        } catch {
          /* ignore */
        }
        out.push({
          name: path.relative(MODELS_DIR, p),
          path: p,
          type: /\.gguf$/i.test(e.name) ? "gguf" : "archive",
          sizeMB,
          active: state.model === p,
        });
      }
    }
  };
  walk(MODELS_DIR);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function findGguf(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.gguf$/i.test(e.name)) return p;
    }
  }
  return null;
}

function extractArchive(archivePath) {
  const base = path.basename(archivePath).replace(/\.(tar\.gz|tgz)$/i, "");
  const dest = path.join(EXTRACT_DIR, base);
  fs.mkdirSync(dest, { recursive: true });
  // reuse a previous extraction if the gguf is already there
  const existing = findGguf(dest);
  if (existing) return existing;
  console.log(`>> extracting ${archivePath} -> ${dest}`);
  const r = spawnSync("tar", ["-xzf", archivePath, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("tar extraction failed (is `tar` installed?)");
  const gguf = findGguf(dest);
  if (!gguf) throw new Error("no .gguf found inside the archive");
  return gguf;
}

// ---------- llama-server lifecycle ----------
function stopLlama() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    c.once("exit", () => resolve());
    c.kill("SIGTERM");
    setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 4000);
  });
}

async function startLlama(modelPath) {
  await stopLlama();
  state = { model: modelPath, ready: false, loading: true, error: null };
  console.log(`>> launching llama-server  model=${modelPath}  ngl=${NGL} ctx=${CTX}`);
  const args = [
    "-m", modelPath,
    "-ngl", NGL,
    "-c", CTX,
    "--host", "127.0.0.1",
    "--port", String(LLAMA_PORT),
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
  ];
  let proc;
  try {
    proc = spawn(LLAMA_SERVER, args, { stdio: "inherit" });
  } catch (e) {
    state.loading = false;
    state.error = `failed to spawn llama-server: ${e.message}`;
    return;
  }
  child = proc;
  proc.on("error", (e) => {
    if (state.model === modelPath) {
      state.loading = false;
      state.error = `llama-server error: ${e.message} (check LLAMA_SERVER path)`;
    }
  });
  proc.on("exit", (code) => {
    if (child === proc) child = null;
    if (state.model === modelPath && !state.ready) {
      state.loading = false;
      if (code) state.error = `llama-server exited (code ${code})`;
    } else if (state.model === modelPath) {
      state.ready = false;
    }
  });
  pollReady(modelPath);
}

function pollReady(modelPath, started = Date.now()) {
  if (state.model !== modelPath) return; // superseded by a newer selection
  const req = http.get(
    { host: "127.0.0.1", port: LLAMA_PORT, path: "/health", timeout: 2000 },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        state.ready = true;
        state.loading = false;
        console.log(`>> model ready: ${modelPath}`);
        return;
      }
      retry();
    }
  );
  req.on("error", retry);
  req.on("timeout", () => req.destroy());
  function retry() {
    if (state.model !== modelPath) return;
    if (Date.now() - started > 180000) {
      state.loading = false;
      state.error = "timed out waiting for model to load (180s)";
      return;
    }
    setTimeout(() => pollReady(modelPath, started), 1200);
  }
}

// ---------- auxiliary service: reward-gate GGUF (CPU llama-server --reranking) ----------
// Optional: if reward-gate.gguf is absent, the reasoning pipeline simply skips the
// gate — it never hard-fails.
const aux = {
  reward: { child: null, ready: false, loading: false, error: null, model: null },
};

function auxModelPath(spec) {
  const p = path.isAbsolute(spec) ? spec : path.join(MODELS_DIR, spec);
  return fs.existsSync(p) ? p : null;
}

function startAux(name) {
  const def = AUX_DEFS[name];
  const st = aux[name];
  if (st.child) return; // already running
  const modelPath = auxModelPath(def.model);
  if (!modelPath) {
    st.error = `model file not found: ${def.model}`;
    st.loading = false;
    st.ready = false;
    return;
  }
  st.model = modelPath;
  st.loading = true;
  st.ready = false;
  st.error = null;
  console.log(`>> [${name}] launching aux llama-server  model=${modelPath}  port=${def.port} (CPU${def.rerank ? ", rerank" : ""})`);
  const args = [
    "-m", modelPath,
    "-ngl", "0",
    "-c", String(def.ctx),
    "-t", AUX_THREADS,
    "--host", "127.0.0.1",
    "--port", String(def.port),
    "--no-warmup",
  ];
  if (def.rerank) args.push("--reranking"); // serve the cross-encoder via /v1/rerank
  let proc;
  try {
    proc = spawn(LLAMA_SERVER, args, { stdio: "inherit" });
  } catch (e) {
    st.loading = false;
    st.error = `spawn failed: ${e.message}`;
    return;
  }
  st.child = proc;
  proc.on("error", (e) => {
    st.loading = false;
    st.error = `error: ${e.message}`;
  });
  proc.on("exit", (code) => {
    if (st.child === proc) st.child = null;
    st.ready = false;
    st.loading = false;
    if (code) st.error = `exited (code ${code})`;
  });
  pollAux(name);
}

function pollAux(name, started = Date.now()) {
  const def = AUX_DEFS[name];
  const st = aux[name];
  if (!st.child) return;
  const req = http.get(
    { host: "127.0.0.1", port: def.port, path: "/health", timeout: 2000 },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        st.ready = true;
        st.loading = false;
        console.log(`>> [${name}] ready on :${def.port}`);
        return;
      }
      retry();
    }
  );
  req.on("error", retry);
  req.on("timeout", () => req.destroy());
  function retry() {
    if (!st.child) return;
    if (Date.now() - started > 180000) {
      st.loading = false;
      st.error = "timed out waiting for aux model (180s)";
      return;
    }
    setTimeout(() => pollAux(name, started), 1200);
  }
}

function stopAux(name) {
  const st = aux[name];
  if (!st.child) return;
  const c = st.child;
  st.child = null;
  st.ready = false;
  try { c.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
}

function auxStatus() {
  const out = {};
  for (const name of Object.keys(AUX_DEFS)) {
    const st = aux[name];
    out[name] = {
      ready: st.ready,
      loading: st.loading,
      error: st.error,
      missing: !auxModelPath(AUX_DEFS[name].model),
      file: AUX_DEFS[name].model,
      port: AUX_DEFS[name].port,
    };
  }
  return out;
}

// ---------- http ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

// ---- preference-trace store (append-only JSONL; feedback updates rewrite) ----
// Each row is a LoRA training candidate: (prompt, CoT, answer) with a label that
// comes from the reward-gate score and is overridden by the user's thumbs up/down.
function deriveLabel(reward, feedback) {
  if (feedback === "up") return "positive";
  if (feedback === "down") return "negative";
  if (typeof reward !== "number") return "unlabeled";
  return reward >= 0.45 ? "positive" : "negative"; // matches GATE_THRESHOLD
}

function readRawTraces() {
  try {
    return fs
      .readFileSync(TRACES_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendTrace(entry) {
  const reward = typeof entry.reward === "number" ? entry.reward : null;
  const row = {
    id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    mode: String(entry.mode || "reasoning"),
    problem: String(entry.problem || ""),
    cot: String(entry.cot || ""),
    answer: String(entry.answer || ""),
    reward,
    feedback: null,
    label: deriveLabel(reward, null),
  };
  try {
    fs.mkdirSync(path.dirname(TRACES_FILE), { recursive: true });
    fs.appendFileSync(TRACES_FILE, JSON.stringify(row) + "\n");
  } catch {
    /* best-effort */
  }
  return row.id;
}

// user satisfaction overrides the reward-based label (the whole point: align the
// LoRA to what the user actually liked, not just the gate's guess).
function updateTraceFeedback(id, feedback) {
  const rows = readRawTraces();
  let found = false;
  for (const r of rows) {
    if (r.id === id) {
      r.feedback = feedback === "up" || feedback === "down" ? feedback : null;
      r.label = deriveLabel(r.reward, r.feedback);
      found = true;
      break;
    }
  }
  if (found) {
    try {
      fs.writeFileSync(TRACES_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch {
      /* best-effort */
    }
  }
  return found;
}

function readTraces() {
  return readRawTraces().slice(-100).reverse();
}

// read+parse a JSON request body, then hand it to `cb` (errors -> 400)
function readJson(req, res, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      cb(JSON.parse(body || "{}"));
    } catch (e) {
      send(res, 400, { error: `bad JSON: ${String(e.message || e)}` });
    }
  });
}

function resolveModel(file) {
  // accept a name relative to MODELS_DIR, or an absolute path (desktop/Tauri)
  const p = path.isAbsolute(file) ? file : path.join(MODELS_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
  return p;
}

// ---------- code execution tool (PAL/PoT/ReAct "Act -> Observe") ----------
// Runs model-written Python in an isolated subprocess with a hard timeout and a
// scrubbed environment. NOTE: this is a LOCAL single-user demo sandbox — it
// blocks network via env and caps time/output, but is not a full jail. For a
// hardened deployment, run inside firejail/nsjail or a container.
function runPython(code) {
  return new Promise((resolve) => {
    const py = process.env.PYTHON || "python3";
    const child = spawn(py, ["-I", "-c", code], {
      timeout: 6000,
      killSignal: "SIGKILL",
      env: { PATH: process.env.PATH, PYTHONHASHSEED: "0", no_proxy: "*" },
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 8000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, stdout: "", stderr: String(e.message), timedOut }));
    child.on("close", (codeNum, sig) => {
      if (sig === "SIGKILL") timedOut = true;
      resolve({
        ok: codeNum === 0 && !timedOut,
        stdout: out.slice(0, 8000),
        stderr: err.slice(0, 2000),
        timedOut,
      });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.url === "/api/exec" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { code } = JSON.parse(body || "{}");
        if (!code || typeof code !== "string") return send(res, 400, { error: "missing 'code'" });
        const result = await runPython(code);
        send(res, 200, result);
      } catch (e) {
        send(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }

  // ---------- aux service (reward gate) ----------
  if (req.url === "/api/aux/status" && req.method === "GET") {
    return send(res, 200, auxStatus());
  }
  if (req.url === "/api/aux/ensure" && req.method === "POST") {
    startAux("reward");
    return send(res, 200, auxStatus());
  }
  if (req.url === "/api/aux/stop" && req.method === "POST") {
    stopAux("reward");
    return send(res, 200, { ok: true });
  }

  // ---------- skills (behaviour modifiers) ----------
  if (req.url.startsWith("/api/skills")) {
    const route = new URL(req.url, "http://x").pathname;
    if (route === "/api/skills/list" && req.method === "GET") {
      return send(res, 200, { skills: listSkills() });
    }
    if (route === "/api/skills/put" && req.method === "POST") {
      return readJson(req, res, (b) => {
        try { send(res, 200, writeSkill(b)); }
        catch (e) { send(res, 400, { error: String(e.message || e) }); }
      });
    }
    if (route === "/api/skills/delete" && req.method === "POST") {
      return readJson(req, res, ({ id }) => send(res, 200, { ok: deleteSkill(id) }));
    }
    return send(res, 404, { error: "not found" });
  }

  // ---------- OKF local knowledge store ----------
  if (req.url.startsWith("/api/okf")) {
    const u = new URL(req.url, "http://x");
    const route = u.pathname;

    if (route === "/api/okf/list" && req.method === "GET") {
      return send(res, 200, { concepts: okf.listConcepts(), storeDir: OKF_DIR });
    }
    if (route === "/api/okf/get" && req.method === "GET") {
      const id = u.searchParams.get("id");
      const c = id && okf.readConcept(id);
      return c ? send(res, 200, c) : send(res, 404, { error: "not found" });
    }
    if (route === "/api/okf/search" && req.method === "POST") {
      return readJson(req, res, ({ query, k }) => {
        if (!query) return send(res, 400, { error: "missing 'query'" });
        send(res, 200, { hits: okf.search(query, k || 4) });
      });
    }
    if (route === "/api/okf/recall" && req.method === "POST") {
      return readJson(req, res, ({ query }) => {
        send(res, 200, okf.recall(String(query || "")));
      });
    }
    if (route === "/api/okf/put" && req.method === "POST") {
      return readJson(req, res, (b) => {
        try { send(res, 200, okf.writeConcept(b)); }
        catch (e) { send(res, 400, { error: String(e.message || e) }); }
      });
    }
    if (route === "/api/okf/delete" && req.method === "POST") {
      return readJson(req, res, ({ id }) => {
        if (!id) return send(res, 400, { error: "missing 'id'" });
        send(res, 200, { ok: okf.deleteConcept(id) });
      });
    }
    if (route === "/api/okf/clear" && req.method === "POST") {
      return send(res, 200, { ok: true, removed: okf.clearAll() });
    }
    return send(res, 404, { error: "not found" });
  }

  // ---------- preference-trace store (LoRA training data, JSONL) ----------
  if (req.url.startsWith("/api/traces")) {
    const route = new URL(req.url, "http://x").pathname;
    if (route === "/api/traces/list" && req.method === "GET") {
      return send(res, 200, { traces: readTraces() });
    }
    if (route === "/api/traces/log" && req.method === "POST") {
      return readJson(req, res, (entry) => send(res, 200, { id: appendTrace(entry) }));
    }
    if (route === "/api/traces/feedback" && req.method === "POST") {
      return readJson(req, res, ({ id, feedback }) => send(res, 200, { ok: updateTraceFeedback(id, feedback) }));
    }
    if (route === "/api/traces/clear" && req.method === "POST") {
      try { fs.rmSync(TRACES_FILE); } catch { /* already gone */ }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  if (req.url === "/api/models" && req.method === "GET") {
    return send(res, 200, { models: listModels(), modelsDir: MODELS_DIR });
  }

  if (req.url === "/api/status" && req.method === "GET") {
    return send(res, 200, state);
  }

  if (req.url === "/api/select" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { file } = JSON.parse(body || "{}");
        if (!file) return send(res, 400, { error: "missing 'file'" });
        let modelPath = resolveModel(file);
        if (/\.(tar\.gz|tgz)$/i.test(modelPath)) modelPath = extractArchive(modelPath);
        // respond immediately; the UI polls /api/status until ready
        send(res, 200, { ok: true, model: modelPath });
        startLlama(modelPath);
      } catch (e) {
        send(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }

  send(res, 404, { error: "not found" });
});

// ---------- skills store (markdown + YAML frontmatter, reuses the OKF parser) ----------
function skillFile(id) {
  const slug = okf.slugify(id);
  return { slug, path: path.join(SKILLS_DIR, slug + ".md") };
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(SKILLS_DIR)) {
    if (!/\.md$/i.test(e)) continue;
    try {
      const { meta, body } = okf.parseFrontmatter(fs.readFileSync(path.join(SKILLS_DIR, e), "utf8"));
      out.push({ id: e.replace(/\.md$/i, ""), name: meta.name || meta.title || e, description: meta.description || "", body });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function writeSkill({ id, name, description, body }) {
  if (!name && !id) throw new Error("skill requires a name");
  const { slug, path: p } = skillFile(id || name);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const meta = { type: "Skill", name: name || slug };
  if (description) meta.description = description;
  meta.timestamp = new Date().toISOString();
  fs.writeFileSync(p, okf.serialize(meta, body || ""), "utf8");
  return { id: slug, name: meta.name };
}

function deleteSkill(id) {
  const { path: p } = skillFile(id);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p);
  return true;
}

function seedSkills() {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (listSkills().length) return;
  writeSkill({
    id: "concise-mentor",
    name: "Concise Mentor",
    description: "Terse, technical, no fluff — explains like a senior engineer.",
    body:
      "Answer like a senior engineer mentoring a strong junior. Be terse and " +
      "technical. Skip pleasantries and obvious caveats. Prefer concrete examples " +
      "and code over prose. If something is wrong, say so directly.",
  });
}

async function shutdown() {
  stopAux("reward");
  await stopLlama();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(CONTROL_PORT, "127.0.0.1", () => {
  console.log(`control server on http://127.0.0.1:${CONTROL_PORT}`);
  console.log(`models dir: ${MODELS_DIR}`);
  console.log(`llama-server binary: ${LLAMA_SERVER}  (will serve on :${LLAMA_PORT})`);
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  okf.initStore(OKF_DIR);
  seedSkills();
  console.log(`okf store: ${OKF_DIR}  (${okf.listConcepts().length} concepts)`);
  console.log(`skills dir: ${SKILLS_DIR}  (${listSkills().length} skills)`);
});
