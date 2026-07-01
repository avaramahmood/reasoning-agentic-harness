// Measurement harness: how reliably does the REAL pipeline answer identity
// lookups? Runs each question N times and reports wrong-answer + persona-echo
// rates, so architecture decisions are made on data, not vibes.
//   node tests/measure-identity.mjs [N]
import { build } from "esbuild";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.argv[2] || 10);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meas-"));
const out = path.join(tmp, "bundle.mjs");
await build({
  entryPoints: [path.join(ROOT, "tests/e2e-entry.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
  define: { "import.meta.env.DEV": "false" },
});
const P = await import("file://" + out);
const noop = () => {};
const ev = { onStep: noop, onToken: noop, onResult: noop };
const ctrl = new AbortController();

async function seed() {
  await P.clearConcepts();
  const put = (c) => P.putConcept(c);
  await put({ type: "Person", title: "Mahmood Hasan", body: "The user's name is Mahmood Hasan.", tags: ["identity", "name"] });
  await put({ type: "Contact", title: "Email avaram.hasan@gmail.com", body: "The user's email is avaram.hasan@gmail.com.", tags: ["email", "contact"] });
  await put({ type: "Person", title: "Lives in Bengaluru", body: "The user lives in Bengaluru, India.", tags: ["location"] });
  await put({ type: "Preference", title: "Favorite foods", body: "The user likes pizza, dosa, sushi, and burritos.", tags: ["preference", "food"] });
  await put({ type: "Fact", title: "Works at Google", body: "The user works at Google.", tags: ["work"] });
}

// question -> regex the CORRECT answer must contain
const CASES = [
  ["what's my name", /mahmood/i],
  ["where do I live?", /bengaluru/i],
  ["what is my email address?", /avaram\.hasan@gmail\.com/i],
  ["where do I work?", /google/i],
  ["can you list my favorite foods?", /pizza|dosa|sushi|burrito/i],
];

async function main() {
  console.log(`Identity reliability — ${N} runs/question through the real pipeline\n` + "=".repeat(60));
  await seed();
  let totWrong = 0, totEcho = 0, tot = 0;
  for (const [q, want] of CASES) {
    let wrong = 0, echo = 0;
    const bad = [];
    for (let i = 0; i < N; i++) {
      const r = await P.runAgent(q, "reasoning", ev, ctrl.signal, { useMemory: true });
      const a = (r.finalAnswer || "").trim();
      if (P.isNonAnswer(a)) { echo++; wrong++; bad.push(`[echo] ${a.slice(0, 70)}`); }
      else if (!want.test(a)) { wrong++; bad.push(`[wrong] ${a.slice(0, 70)}`); }
    }
    tot += N; totWrong += wrong; totEcho += echo;
    const mark = wrong === 0 ? "✅" : "⚠️ ";
    console.log(`${mark} ${q.padEnd(34)} ${N - wrong}/${N} correct  (echo ${echo}, wrong ${wrong - echo})`);
    for (const b of bad) console.log(`      ${b}`);
  }
  console.log("=".repeat(60));
  const acc = (((tot - totWrong) / tot) * 100).toFixed(1);
  console.log(`OVERALL: ${tot - totWrong}/${tot} correct = ${acc}%   (persona-echoes: ${totEcho})`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
