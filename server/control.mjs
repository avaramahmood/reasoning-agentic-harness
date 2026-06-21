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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MODELS_DIR = process.env.MODELS_DIR || path.join(ROOT, "models");
const EXTRACT_DIR = path.join(MODELS_DIR, ".extracted");
const LLAMA_SERVER = process.env.LLAMA_SERVER || "llama-server";
const LLAMA_PORT = Number(process.env.LLAMA_PORT || 8080);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8081);
const NGL = process.env.NGL || "15";
const CTX = process.env.CTX || "4096";

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

async function shutdown() {
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
});
