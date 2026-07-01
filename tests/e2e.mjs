// End-to-end integration test: drives the REAL agent pipeline (recall + CoT +
// reward gate + capture) against the live 7B, on COMBINED scenarios.
//   node tests/e2e.mjs
// Requires the control server (:8081), the 7B (:8080), and ideally the reward
// gate (:8084) to be running. Seeds a known profile, then asserts the model
// recalls exact facts, references file contents, never spews, saves facts from
// chat + on request, and handles a combined codegen+memory task.
import { build } from "esbuild";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));

// bundle the pipeline for Node; force the "packaged" branch so client modules
// hit 127.0.0.1:{8080,8081,8084} directly instead of the Vite proxy.
const out = path.join(tmp, "bundle.mjs");
await build({
  entryPoints: [path.join(ROOT, "tests/e2e-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
  define: { "import.meta.env.DEV": "false" },
});
const P = await import("file://" + out);

// ---- tiny assertion harness ----
let pass = 0, fail = 0;
const noop = () => {};
const ev = { onStep: noop, onToken: noop, onResult: noop };
const ctrl = new AbortController();

const SPEW = [
  [/xmlhttp/i, "xmlhttp spam"],
  [/https?:\/\//i, "invented URL"],
  [/[֐-׿؀-ۿЀ-ӿ一-鿿]/, "foreign-script garbage"],
];
function spewReason(s) {
  for (const [re, why] of SPEW) if (re.test(s)) return why;
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const counts = {};
  for (const l of lines) if (l.length > 8) { counts[l] = (counts[l] || 0) + 1; if (counts[l] >= 3) return "repeated line loop"; }
  return null;
}

async function scenario(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    pass++;
    console.log(`  ✅ PASS`);
  } catch (e) {
    fail++;
    console.log(`  ❌ FAIL — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function ask(problem, mode = "reasoning", opts = {}) {
  const r = await P.runAgent(problem, mode, ev, ctrl.signal, { useMemory: true, ...opts });
  const a = r.finalAnswer || "";
  const why = spewReason(a);
  if (why) throw new Error(`answer spewed (${why}):\n---\n${a}\n---`);
  if (P.isNonAnswer(a)) throw new Error(`model returned a non-answer (persona echo / empty):\n---\n${a}\n---`);
  return a;
}

// ---- seed a known profile ----
async function seed() {
  await P.clearConcepts();
  const put = (c) => P.putConcept(c);
  await put({ type: "Person", title: "Mahmood Hasan", body: "The user's name is Mahmood Hasan.", tags: ["identity", "name"] });
  await put({ type: "Contact", title: "Email avaram.hasan@gmail.com", body: "The user's email is avaram.hasan@gmail.com.", tags: ["email", "contact"] });
  await put({ type: "Person", title: "Lives in Bengaluru", body: "The user lives in Bengaluru, India.", tags: ["location"] });
  await put({ type: "Preference", title: "Favorite foods", body: "The user likes pizza, dosa, sushi, and burritos.", tags: ["preference", "food"] });
  await put({ type: "Preference", title: "Concise answers", body: "The user prefers concise, technical answers.", tags: ["style"] });
  await put({ type: "Project", title: "RIVA", body: "RIVA is the user's on-device reasoning agent project, built on a local 7B model.", tags: ["project"] });
  const n = (await P.listConcepts()).concepts.length;
  console.log(`seeded ${n} concepts`);
}

async function main() {
  console.log("E2E integration — real 7B pipeline\n" + "=".repeat(50));
  await seed();

  // 1. exact fact recall
  await scenario("recall exact name", async () => {
    const a = await ask("what's my name");
    assert(/mahmood hasan/i.test(a), `expected "Mahmood Hasan", got: ${a}`);
  });
  await scenario("recall exact location", async () => {
    const a = await ask("where do I live?");
    assert(/bengaluru/i.test(a), `expected Bengaluru, got: ${a}`);
  });
  await scenario("recall exact email", async () => {
    const a = await ask("what is my email address?");
    assert(/avaram\.hasan@gmail\.com/i.test(a), `expected exact email, got: ${a}`);
  });

  // 2. reference exactly what's in a file (the RIVA project concept)
  await scenario("reference file contents (RIVA project)", async () => {
    const a = await ask("what is my RIVA project about?");
    // must reference the stored facts (on-device reasoning agent on a local 7B)
    assert(/reasoning agent|on-device|7b|7 ?b|local/i.test(a), `did not reference stored RIVA facts: ${a}`);
    // must not invent a wholly different kind of project
    assert(!/\b(mobile app|website|video game|e-?commerce|social network)\b/i.test(a), `invented an unrelated project type: ${a}`);
  });

  // 3. list favorite foods (vocab-gap recall)
  await scenario("recall favorite foods (no lexical overlap)", async () => {
    const a = await ask("can you list my favorite foods?");
    const hits = ["pizza", "dosa", "sushi", "burrito"].filter((f) => new RegExp(f, "i").test(a));
    assert(hits.length >= 3, `expected >=3 of the 4 foods, got ${hits.length}: ${a}`);
  });

  // 4. save a fact THROUGH chat (implicit), then recall it
  await scenario("save fact from chat -> recall", async () => {
    const saved = await P.captureMemory("By the way, I work at Google and I love playing chess.");
    assert(saved >= 1, `captureMemory saved nothing`);
    const ctx = (await P.recall("where do I work and what are my hobbies")).context;
    assert(/google/i.test(ctx), `Google not stored/recalled: ${ctx}`);
    assert(/chess/i.test(ctx), `chess not stored/recalled: ${ctx}`);
    const a = await ask("where do I work?");
    assert(/google/i.test(a), `model didn't use saved employer: ${a}`);
  });

  // 5. explicit "remember this" save, then recall
  await scenario("explicit save on request -> recall", async () => {
    const saved = await P.captureMemory("Please remember that my anniversary is on June 12.");
    assert(saved >= 1, `explicit save stored nothing`);
    const ctx = (await P.recall("when is my anniversary")).context;
    assert(/june 12/i.test(ctx), `anniversary not saved: ${ctx}`);
  });

  // 6. THE COMBINED TASK: codegen that references a personal fact from memory
  await scenario("combined: apps-script email referencing favorite foods", async () => {
    const a = await ask("Give me Google Apps Script code to send an email to myself reminding me about my favorite foods.");
    assert(/MailApp|GmailApp/.test(a), `no Apps Script email API in output: ${a}`);
    assert(/function\s|\bvar\b|\bconst\b|```/.test(a), `does not look like code: ${a}`);
    const foods = ["pizza", "dosa", "sushi", "burrito"].filter((f) => new RegExp(f, "i").test(a));
    assert(foods.length >= 2, `email body didn't pull foods from memory (${foods.length}): ${a}`);
    // "to myself" = either the literal saved email OR the idiomatic self-send
    // (Session.getActiveUser().getEmail()), which is the correct Apps Script way.
    assert(
      /avaram\.hasan@gmail\.com/i.test(a) || /getActiveUser\(\)|Session\.getActiveUser|getEmail\(\)/.test(a),
      `did not address the email to the user themselves: ${a}`
    );
  });

  console.log("\n" + "=".repeat(50));
  console.log(`${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
