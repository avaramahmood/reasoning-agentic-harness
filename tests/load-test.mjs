// Load test for the control server (OKF + traces + skills).
//   node tests/load-test.mjs
// Spawns an isolated server, seeds a realistic store, then hammers it at rising
// concurrency with a read-heavy mix (recall/search reads, trace writes, okf puts)
// and reports throughput + latency percentiles.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8090;
const base = `http://127.0.0.1:${PORT}`;

const okfDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-okf-"));
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-skl-"));
const tracesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lt-tr-")), "traces.jsonl");

const srv = spawn("node", [path.join(ROOT, "server/control.mjs")], {
  env: { ...process.env, CONTROL_PORT: String(PORT), OKF_DIR: okfDir, SKILLS_DIR: skillsDir, TRACES_FILE: tracesFile, LLAMA_SERVER: "/bin/false" },
  stdio: "ignore",
});

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (p) => fetch(base + p);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// one random request from the mix; returns a promise
const WORDS = ["pizza", "python", "berlin", "email", "project", "coffee", "riva", "goal", "name", "meeting"];
function randomReq(i) {
  const r = i % 10;
  const w = WORDS[i % WORDS.length];
  if (r < 5) return post("/api/okf/recall", { query: `what about my ${w}` }); // 50% reads (recall)
  if (r < 7) return post("/api/okf/search", { query: `${w} note`, k: 5 }); // 20% search
  if (r < 9) return post("/api/traces/log", { mode: "reasoning", problem: `q${i} ${w}`, cot: "c", answer: "a", reward: Math.random() }); // 20% trace writes
  return post("/api/okf/put", { type: "Note", title: `note ${i}`, body: `about ${w} number ${i}` }); // 10% writes
}

async function wave(n, label) {
  const lat = [];
  let errors = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const s = performance.now();
      return randomReq(i)
        .then((res) => {
          lat.push(performance.now() - s);
          if (!res.ok) errors++;
          return res.text();
        })
        .catch(() => {
          errors++;
        });
    })
  );
  const ms = Date.now() - t0;
  lat.sort((a, b) => a - b);
  const thru = ((n / ms) * 1000).toFixed(0);
  console.log(
    `${label.padEnd(22)} ${String(n).padStart(5)} reqs  ${String(ms).padStart(6)}ms  ${String(thru).padStart(6)} req/s  ` +
      `p50 ${pct(lat, 50).toFixed(1)}  p95 ${pct(lat, 95).toFixed(1)}  p99 ${pct(lat, 99).toFixed(1)}  max ${pct(lat, 100).toFixed(1)} ms  errors ${errors}`
  );
  return errors;
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await get("/api/status")).ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // seed a realistic store (parallel)
  await Promise.all(Array.from({ length: 200 }, (_, i) => post("/api/okf/put", { type: i % 3 ? "Note" : "Preference", title: `seed ${i}`, body: `${WORDS[i % WORDS.length]} fact ${i}` })));
  console.log(`seeded store: ${(await (await get("/api/okf/list")).json()).concepts.length} concepts\n`);

  console.log("burst waves (all requests fired at once):");
  let totalErr = 0;
  for (const n of [100, 500, 1000, 2000, 5000]) totalErr += await wave(n, "  burst");

  console.log("\nsustained (5 back-to-back waves of 1000):");
  for (let i = 0; i < 5; i++) totalErr += await wave(1000, `  wave ${i + 1}`);

  console.log(`\nTOTAL ERRORS: ${totalErr}`);
  srv.kill("SIGKILL");
  for (const d of [okfDir, skillsDir, path.dirname(tracesFile)]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
main();
