// Thinking-mode behavior test: classify FIRST, then code-directly or reason.
//   node tests/thinking.mjs
// Verifies the exact failures the user reported (r in strawberry -> 1, LEVEL -> 120,
// s in submission -> spew) are fixed by going straight to code, and that non-code
// questions reason without spawning code.
import { build } from "esbuild";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "think-"));
const out = path.join(tmp, "bundle.mjs");
await build({
  entryPoints: [path.join(ROOT, "tests/e2e-entry.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
  define: { "import.meta.env.DEV": "false" },
});
const P = await import("file://" + out);

let pass = 0, fail = 0;
const FOREIGN = /[֐-׿؀-ۿЀ-ӿ一-鿿]/;
function spewy(s) {
  if (FOREIGN.test(s) || /xmlhttp/i.test(s)) return true;
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 8);
  const c = {};
  for (const l of lines) if ((c[l] = (c[l] || 0) + 1) >= 3) return true;
  return false;
}

async function run(name, q, { want, usedTool }) {
  const steps = [];
  const ev = {
    onStep: (v) => steps.push(v),
    onToken: () => {},
    onResult: () => {},
  };
  try {
    const r = await P.runAgent(q, "thinking", ev, new AbortController().signal, {});
    const a = (r.finalAnswer || "").trim();
    const okWant = want.test(a);
    const okTool = usedTool === undefined || r.usedTool === usedTool;
    const okSpew = !spewy(a);
    if (okWant && okTool && okSpew) {
      console.log(`  ✅ ${name}  -> "${a.slice(0, 60)}"  (usedTool=${r.usedTool})`);
      pass++;
    } else {
      const why = [!okWant && `want ${want}`, !okTool && `usedTool ${r.usedTool}!=${usedTool}`, !okSpew && "SPEW"].filter(Boolean).join(", ");
      console.log(`  ❌ ${name}  [${why}]  -> "${a.slice(0, 80)}"  (usedTool=${r.usedTool})`);
      fail++;
    }
  } catch (e) {
    console.log(`  ❌ ${name}  threw: ${e.message}`);
    fail++;
  }
}

async function main() {
  console.log("Thinking mode — classify then code/reason\n" + "=".repeat(55));
  console.log("CODE path (must run code, must be exact):");
  await run("r in strawberry", "How many times does the letter r appear in the word strawberry?", { want: /\b3\b/, usedTool: true });
  await run("s in submission", "How many times does the letter s occur in submission?", { want: /\b3\b/, usedTool: true });
  await run("LEVEL arrangements", 'Look closely at the word "LEVEL". How many unique, distinct 5-letter arrangements can you make using these exact letters?', { want: /\b30\b/, usedTool: true });
  await run("months with J", "How many months start with the letter J?", { want: /\b3\b/, usedTool: true });
  await run("arithmetic expr", "What is 17 * 23 + 5?", { want: /\b396\b/, usedTool: true });

  console.log("\nREASON path (no code, reason then answer):");
  await run("logic: syllogism", "If all roses are flowers and some flowers fade quickly, can we conclude that all roses fade quickly? Answer yes or no.", { want: /\bno\b|cannot|can't/i, usedTool: false });
  await run("commonsense", "A cup of hot coffee is left on a table in a cool room for an hour. Does it get hotter or colder?", { want: /colder|cool/i, usedTool: false });

  console.log("=".repeat(55));
  console.log(`${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
