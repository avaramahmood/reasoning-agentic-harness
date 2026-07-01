// Self-contained test runner (no test framework): unit + integration + load.
//   node tests/run-tests.mjs
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as okf from "../server/okf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0,
  fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
    pass++;
  } catch (e) {
    console.error("  ✗", name, "\n      " + e.message);
    fail++;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
    pass++;
  } catch (e) {
    console.error("  ✗", name, "\n      " + e.message);
    fail++;
  }
}

// ============================== UNIT: OKF =================================
console.log("\nOKF store");
test("frontmatter round-trips scalars/arrays/nested maps", () => {
  const t = okf.serialize({ type: "Person", title: "Ada", tags: ["x", "y"], marks: { DSA: 90 } }, "the body");
  const { meta, body } = okf.parseFrontmatter(t);
  assert.equal(meta.type, "Person");
  assert.equal(meta.title, "Ada");
  assert.deepEqual(meta.tags, ["x", "y"]);
  assert.equal(meta.marks.DSA, 90);
  assert.equal(body, "the body");
});
test("slugify normalizes", () => assert.equal(okf.slugify("Hello, World!"), "hello-world"));
test("writeConcept requires a type", () => assert.throws(() => okf.writeConcept({ title: "x" })));

const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-"));
okf.initStore(sdir);
test("starts empty (no demo seeds)", () => assert.equal(okf.listConcepts().length, 0));
test("search finds by keyword", () => {
  okf.writeConcept({ id: "people/john", type: "Person", title: "John", body: "John runs the billing project." });
  const hits = okf.search("john project", 3);
  assert.ok(hits.length >= 1 && hits[0].id.includes("john"));
});
test("extension-key values are searchable (ML marks)", () => {
  okf.writeConcept({ id: "people/x", type: "Person", title: "X", extra: { marks: { ML: 88 } }, body: "hi" });
  assert.ok(okf.search("ML marks", 3).some((h) => h.id === "people/x"));
});
test("write/read/delete", () => {
  okf.writeConcept({ id: "t/z", type: "Note", title: "Zed", body: "b" });
  assert.ok(okf.readConcept("t/z"));
  assert.equal(okf.deleteConcept("t/z"), true);
  assert.equal(okf.readConcept("t/z"), null);
});
test("path-traversal ids are sanitized", () => {
  const { id } = okf.writeConcept({ id: "../../evil", type: "Note", title: "E" });
  assert.ok(!id.includes(".."));
});
test("clearAll empties the store", () => {
  okf.clearAll();
  assert.equal(okf.listConcepts().length, 0);
});
test("recall: large store -> whole profile always, unrelated notes filtered", () => {
  okf.clearAll();
  okf.writeConcept({ type: "Person", title: "Mahmood", body: "The user's name is Mahmood." });
  okf.writeConcept({ type: "Contact", title: "Email", body: "The user's email is a@b.com." });
  // preferences share NO vocabulary with a "favorite foods" style query, yet
  // must still be recalled — that's why the whole profile is always injected.
  for (const [t, b] of [["Pineapple", "dislikes pineapple pizza"], ["Coffee", "likes coffee"], ["Tennis", "plays tennis"]])
    okf.writeConcept({ type: "Preference", title: t, body: `The user ${b}.` });
  // unbounded, non-profile notes: injected ONLY when the query matches them.
  for (const [t, b] of [["Note A", "server migration runbook step one"], ["Note B", "tuesday standup meeting log"], ["Note C", "grocery list eggs and milk"]])
    okf.writeConcept({ type: "Note", title: t, body: b });
  const { context } = okf.recall("what food do I like"); // no lexical overlap with the prefs
  assert.ok(/mahmood/i.test(context), "identity (name) not always included");
  assert.ok(/pineapple/i.test(context) && /coffee/i.test(context), "profile preferences not all injected");
  assert.ok(!/grocery list eggs/i.test(context), "unrelated note wrongly injected");
  // a query that DOES match a note pulls it in via keyword search
  assert.ok(/grocery list eggs/i.test(okf.recall("what is on my grocery list").context), "matching note not retrieved");
  okf.clearAll();
});
fs.rmSync(sdir, { recursive: true, force: true });

// ============================== UNIT: TS libs ============================
console.log("\nclient libs (search / documents)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libs-"));
await build({ entryPoints: [path.join(ROOT, "src/lib/search.ts")], bundle: true, format: "esm", outfile: path.join(tmp, "search.mjs"), logLevel: "error" });
const search = await import("file://" + path.join(tmp, "search.mjs"));
test("tokenize drops stopwords + short tokens", () => assert.deepEqual(search.tokenize("the Quick brown a"), ["quick", "brown"]));
test("rankByKeyword ranks by overlap", () => {
  const r = search.rankByKeyword("error window", [{ t: "server error in a window" }, { t: "unrelated lunch" }], (x) => x.t, 2);
  assert.equal(r[0].item.t, "server error in a window");
});
test("rankByKeyword empty query -> []", () => assert.equal(search.rankByKeyword("", [{ t: "x" }], (x) => x.t).length, 0));
test("stripRunaway cuts repeated-char spew", () => assert.equal(search.stripRunaway("Avara" + "ئ".repeat(80)), "Avara"));
test("stripRunaway cuts repeated-token spew", () => assert.ok(search.stripRunaway("ok " + "na ".repeat(30)).length < 12));
test("stripRunaway leaves clean text", () => assert.equal(search.stripRunaway("a normal sentence."), "a normal sentence."));
test("cleanModelOutput cuts foreign-script garbage", () => assert.equal(search.cleanModelOutput("Here is the answer גודל העותק"), "Here is the answer"));
test("cleanModelOutput stops at a repeated line (loop)", () => {
  const looped = "You can remove the pineapple before eating.\nYou can remove the pineapple before eating.\nYou can remove the pineapple before eating.";
  assert.equal(search.cleanModelOutput(looped), "You can remove the pineapple before eating.");
});
test("cleanModelOutput preserves multi-line code", () => {
  const code = "def f(x):\n    return x + 1\n\nprint(f(2))";
  assert.equal(search.cleanModelOutput(code), code);
});
test("cleanModelOutput cuts a TRUNCATED paragraph repeat (with foreign noise)", () => {
  const p = "You should also consider adding error handling in case GmailApp.sendEmail fails, such as logging.";
  const out = p + "\nביקורת\n" + p.slice(0, 70); // second copy is cut off, foreign line between
  const cleaned = search.cleanModelOutput(out);
  assert.equal((cleaned.match(/you should also consider/gi) || []).length, 1, `not deduped:\n${cleaned}`);
  assert.ok(!/ביקורת/.test(cleaned), "foreign not removed");
});
test("cleanModelOutput cuts a self-generated follow-up question (over-generation)", () => {
  const out = "Here is the script:\nprint('hi')\nI'm trying to create a function that sends emails. Can you provide me with the code?";
  assert.equal(search.cleanModelOutput(out), "Here is the script:\nprint('hi')");
});

// ---- answer finalizer (think-vs-answer + degeneration cleanup) ----
await build({ entryPoints: [path.join(ROOT, "src/lib/prompts.ts")], bundle: true, format: "esm", outfile: path.join(tmp, "prompts.mjs"), logLevel: "error" });
const { finalizeAnswer, isNonAnswer, extractCode, buildFallbackCode, detectMechanical } = await import("file://" + path.join(tmp, "prompts.mjs"));
console.log("\nanswer finalizer");
test("uses clean <answer> when good", () =>
  assert.equal(finalizeAnswer("<think>reasoning</think><answer>The capital is Paris.</answer>"), "The capital is Paris."));
test("falls back to <think> when <answer> is junk (xmlhttp spam)", () => {
  const out = "<think>The roots are x=2 and x=3.</think><answer> xmlhttp://www.google.com/? xmlhttp://www.bing.com/</answer>";
  assert.ok(/roots are x=2 and x=3/.test(finalizeAnswer(out)), finalizeAnswer(out));
});
test("Bengaluru case: cuts foreign + URL spam, keeps the real answer", () => {
  const out = "Yes, Bengaluru is located in India.\nגודל העותק: 106\n\n xmlhttp://www.google.com/?";
  assert.equal(finalizeAnswer(out), "Yes, Bengaluru is located in India.");
});
test("strips think/answer tags from the result", () => {
  assert.ok(!/<\/?(think|answer)>/.test(finalizeAnswer("<think>x</think><answer>hello world this is fine</answer>")));
});
test("strict: uses clean <answer> when good", () =>
  assert.equal(finalizeAnswer("<think>reasoning</think><answer>The capital is Paris.</answer>", true), "The capital is Paris."));
test("strict: does not fall back to <think> when <answer> is missing", () =>
  assert.equal(finalizeAnswer("<think>The roots are x=2 and x=3.</think>", true), ""));
test("strict: does not fall back to whole when <answer> is missing", () =>
  assert.equal(finalizeAnswer("Yes, Bengaluru is located in India.", true), ""));
test("extractCode: clean fenced block", () =>
  assert.equal(extractCode('```python\nprint("hi")\n```'), 'print("hi")'));
test("extractCode: MANGLED closing fence (degeneration ate the ```)", () => {
  const mangled = '```python\nfrom itertools import permutations\nprint(len(set(permutations("LEVEL"))))\n``㎟\nגודל: 100';
  assert.equal(extractCode(mangled), 'from itertools import permutations\nprint(len(set(permutations("LEVEL"))))');
});
test("extractCode: no code -> null", () => assert.equal(extractCode("just prose, no code here"), null));
test("buildFallbackCode: LEVEL arrangements -> deterministic permutation code", () => {
  const code = buildFallbackCode('Look closely at the word "LEVEL". How many unique, distinct 5-letter arrangements can you make?');
  assert.ok(/permutations\("LEVEL"\)/.test(code) && /len\(set\(/.test(code), `got: ${code}`);
});
test("buildFallbackCode: 'anagrams of the letters in cheese'", () => {
  const code = buildFallbackCode("How many anagrams of the letters in cheese are there?");
  assert.ok(/permutations\("CHEESE"\)/.test(code), `got: ${code}`);
});
test("detectMechanical routes arrangements to code", () =>
  assert.ok(detectMechanical('How many distinct arrangements of the word "LEVEL" are there?')));
test("isNonAnswer flags persona-echo and empties, not real answers", () => {
  assert.ok(isNonAnswer("You are a helpful assistant who provides information."));
  assert.ok(isNonAnswer("As an AI language model, I cannot..."));
  assert.ok(isNonAnswer(""));
  assert.ok(!isNonAnswer("Your name is Mahmood Hasan."));
  assert.ok(!isNonAnswer("You live in Bengaluru, India."));
});

// ---- deterministic identity answering (skip-the-LLM path) ----
await build({ entryPoints: [path.join(ROOT, "src/lib/agent.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "agent.mjs"), logLevel: "error", define: { "import.meta.env.DEV": "false" } });
const agent = await import("file://" + path.join(tmp, "agent.mjs"));
const MEMCTX = [
  "- Mahmood Hasan (Person)\n    The user's name is Mahmood Hasan.",
  "- Email (Contact)\n    The user's email is avaram.hasan@gmail.com.",
  "- Lives in Bengaluru (Person)\n    The user lives in Bengaluru, India.",
  "- Works at Google (Fact)\n    The user works at Google.",
  "- Favorite foods (Preference)\n    The user likes pizza, dosa, sushi, and burritos.",
].join("\n");
console.log("\ndeterministic identity answering");
test("toSecondPerson rephrases stored facts naturally", () => {
  assert.equal(agent.toSecondPerson("The user's name is Mahmood Hasan."), "Your name is Mahmood Hasan.");
  assert.equal(agent.toSecondPerson("The user lives in Bengaluru, India."), "You live in Bengaluru, India.");
  assert.equal(agent.toSecondPerson("The user works at Google."), "You work at Google.");
  assert.equal(agent.toSecondPerson("The user likes pizza, dosa, sushi, and burritos."), "You like pizza, dosa, sushi, and burritos.");
});
test("isIdentityLookup: pure attribute lookups only", () => {
  for (const q of ["what's my name", "where do I live?", "what is my email address?", "where do I work?", "who am I?", "can you list my favorite foods?"])
    assert.ok(agent.isIdentityLookup(q), `should be a lookup: ${q}`);
  for (const q of ["what do you think of my favorite foods?", "write code to email my foods", "why do I like pizza", "should I move to Bengaluru", "how do I cook dosa"])
    assert.ok(!agent.isIdentityLookup(q), `should NOT be a lookup: ${q}`);
});
test("answerFromMemory returns the exact fact, not a paraphrase", () => {
  assert.match(agent.answerFromMemory("what's my name", MEMCTX), /^Your name is Mahmood Hasan\./);
  assert.match(agent.answerFromMemory("where do I live?", MEMCTX), /You live in Bengaluru, India\./);
  assert.match(agent.answerFromMemory("what is my email address?", MEMCTX), /avaram\.hasan@gmail\.com/);
  assert.match(agent.answerFromMemory("where do I work?", MEMCTX), /You work at Google\./);
  // title-match bridges the vocab gap: "foods" query -> "Favorite foods" concept
  assert.match(agent.answerFromMemory("can you list my favorite foods?", MEMCTX), /pizza, dosa, sushi, and burritos/);
});
test("answerFromMemory returns '' when no fact matches (defers to LLM)", () => {
  assert.equal(agent.answerFromMemory("what's my favorite color", MEMCTX), "");
  assert.equal(agent.answerFromMemory("", MEMCTX), "");
});

await build({
  entryPoints: [path.join(ROOT, "src/lib/documents.ts")],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "documents.mjs"),
  logLevel: "error",
  external: ["pdfjs-dist", "pdfjs-dist/*"],
});
const docs = await import("file://" + path.join(tmp, "documents.mjs"));
test("chunkText splits long text with overlap", () => {
  const c = docs.chunkText("x ".repeat(1400), 900, 150);
  assert.ok(c.length >= 3, `expected >=3 chunks, got ${c.length}`);
});
test("chunkText keeps short text as one chunk", () => assert.deepEqual(docs.chunkText("short note"), ["short note"]));
test("retrieveChunks returns the relevant chunk", () => {
  const d = [{ id: "d", name: "f", chars: 0, chunks: [
    { docId: "d", docName: "f", index: 0, text: "the database error rolling window threshold" },
    { docId: "d", docName: "f", index: 1, text: "lunch menu options today" },
  ] }];
  assert.equal(docs.retrieveChunks("database error window", d, 1)[0].index, 0);
});
// ---- fact extraction (the "remember" half) ----
await build({ entryPoints: [path.join(ROOT, "src/lib/extract.ts")], bundle: true, format: "esm", outfile: path.join(tmp, "extract.mjs"), logLevel: "error" });
const { extractFactsRules, isBareSaveCommand, sigTokens, subset } = await import("file://" + path.join(tmp, "extract.mjs"));
const oneFact = (msg, type, bodyRe) => () => {
  const f = extractFactsRules(msg);
  assert.ok(f.length >= 1, `no fact from "${msg}"`);
  const hit = f.find((x) => x.type === type);
  assert.ok(hit, `expected a ${type} from "${msg}", got ${JSON.stringify(f)}`);
  assert.ok(bodyRe.test(hit.body), `body "${hit.body}" !~ ${bodyRe}`);
};
console.log("\nfact extraction (capture rules)");
test("name: 'my name is Avara'", oneFact("my name is Avara", "Person", /name is Avara/i));
test("name: 'call me Sam'", oneFact("hey, call me Sam please", "Person", /name is Sam/i));
test("name: \"I'm Avara\"", oneFact("hi I'm Avara", "Person", /name is Avara/i));
test("name false-positive guard: 'I'm building X' is NOT a name", () => {
  const f = extractFactsRules("I'm building a chatbot");
  assert.ok(!f.some((x) => /name is Building/i.test(x.body)));
});
test("employer: 'I work at RIVA Labs'", oneFact("I work at RIVA Labs", "Fact", /works at RIVA Labs/i));
test("role: 'I am a software engineer'", oneFact("I am a software engineer", "Person", /is a software engineer/i));
test("role: \"I'm a student\"", oneFact("btw I'm a student", "Person", /is a student/i));
test("location: 'I live in Berlin'", oneFact("I live in Berlin", "Person", /lives in Berlin/i));
test("location lowercase + trailing clause: 'I live in banglore. which country'", oneFact("I live in banglore. which country is it in", "Person", /lives in Banglore/i));
test("location guard: 'I live in the moment' is NOT a place", () => assert.ok(!extractFactsRules("I live in the moment").some((f) => /lives in/i.test(f.body))));
test("project: 'I'm building RIVA'", oneFact("I'm building RIVA, an on-device agent", "Project", /building RIVA/i));
test("goal: 'I'm preparing for a system-design interview'", oneFact("I'm preparing for a system-design interview", "Goal", /preparing for a system-design interview/i));
test("preference: 'I prefer concise answers'", oneFact("I prefer concise answers", "Preference", /prefer concise answers/i));
test("style: 'always answer concisely'", oneFact("always answer concisely", "Preference", /answer concisely/i));
test("email: 'my email is avaram.hasan@gmail.com' (not shattered by dots)", oneFact("my email is avaram.hasan@gmail.com", "Contact", /email is avaram\.hasan@gmail\.com/i));
test("email in a multi-sentence message", () => {
  const f = extractFactsRules("My name is Mahmood. My email is avaram.hasan@gmail.com. I live in Bengaluru.");
  assert.ok(f.some((x) => /avaram\.hasan@gmail\.com/.test(x.body)), JSON.stringify(f.map((x) => x.body)));
  assert.equal(f.length, 3);
});
test("possessive: 'my phone is 12345'", oneFact("my phone is 12345", "Fact", /phone is 12345/i));
test("possessive: 'my birthday is June 5'", oneFact("my birthday is June 5", "Fact", /birthday is June 5/i));
test("possessive guard: 'my point is that X' is not stored", () => assert.equal(extractFactsRules("my point is that we should ship").length, 0));
test("explicit: 'remember that my deadline is Friday'", oneFact("remember that my deadline is Friday", "Fact", /deadline is Friday/i));
test("no double-capture: 'remember that I like tea' -> ONE fact", () => assert.equal(extractFactsRules("remember that I like tea").length, 1));
test("bare 'remember this' captures nothing (uses prior turn instead)", () => assert.equal(extractFactsRules("remember this").length, 0));
test("isBareSaveCommand detects save phrases", () =>
  assert.ok(isBareSaveCommand("remember this") && isBareSaveCommand("save it to memory") && !isBareSaveCommand("remember that I like tea")));
// --- capture scenarios: lists, natural statements, explicit save wordings ---
test("list of likes: 'I like coffee, tea, and hiking'", oneFact("I like coffee, tea, and hiking", "Preference", /coffee, tea, and hiking/i));
test("contrasting prefs split cleanly: 'I love pizza but I hate pineapple'", () => {
  const f = extractFactsRules("I love pizza but I hate pineapple");
  assert.equal(f.length, 2);
  assert.ok(f.some((x) => /love pizza/i.test(x.body)) && f.some((x) => /hate pineapple/i.test(x.body)), JSON.stringify(f.map((x) => x.body)));
});
test("'and I' splits prefs: 'I prefer dark mode and I dislike long meetings'", () => assert.equal(extractFactsRules("I prefer dark mode and I dislike long meetings").length, 2));
test("plural possessive grammar: 'My hobbies are reading and chess'", oneFact("My hobbies are reading and chess", "Fact", /hobbies are reading and chess/i));
test("mixed natural statement -> 3 facts", () => {
  const f = extractFactsRules("My name is Sara, I work at Acme, and my email is sara@acme.com");
  assert.equal(f.length, 3);
});
test("explicit 'save to memory: X'", oneFact("save to memory: my gym opens at 6am", "Note", /gym opens at 6am/i));
test("explicit 'note that I am allergic to peanuts'", oneFact("note that I am allergic to peanuts", "Note", /allergic to peanuts/i));
test("negative: 'I want to save money' does NOT create a note", () => assert.equal(extractFactsRules("I want to save money").length, 0));

// --- capture dedup regression: a one-word existing concept must NOT swallow a
//     superset new fact (the "Dosa" concept ate "pizza, dosa, sushi, burritos"). ---
// Replicates captureMemory's conservative rule: skip a new fact ONLY if it is
// fully contained in some existing concept (new ⊆ existing).
const dedupSurvivors = (facts, existingTexts) => {
  const seen = existingTexts.map(sigTokens);
  return facts.filter((f) => !seen.some((g) => subset(sigTokens(f.title + " " + f.body), g)));
};
test("capture dedup: existing 'Dosa' does not swallow a new food list", () => {
  const existing = ["Dosa The user loves to eat Dosa.", "Dislikes pineapple on pizza The user likes pizza but dislikes pineapple as a topping."];
  const saved = dedupSurvivors(extractFactsRules("I like pizza, dosa, sushi, burritos"), existing);
  const body = saved.map((s) => s.body).join(" ");
  assert.ok(saved.length >= 1, "multi-food fact was wrongly swallowed");
  assert.ok(/sushi/i.test(body) && /burrito/i.test(body), `sushi/burritos lost: ${body}`);
});
test("capture dedup: a truly redundant restatement IS skipped", () => {
  const existing = ["Concise answers The user prefers concise, technical answers."];
  const saved = dedupSurvivors(extractFactsRules("I prefer concise answers"), existing);
  assert.equal(saved.length, 0, `redundant fact re-added: ${JSON.stringify(saved.map((s) => s.body))}`);
});

test("task content -> no facts", () => assert.equal(extractFactsRules("how many r's are in strawberry?").length, 0));
test("multi-fact (commas) extracts several", () => {
  const f = extractFactsRules("My name is Avara, I work at RIVA Labs, and I prefer concise answers.");
  assert.ok(f.length >= 3, `expected >=3 facts, got ${f.length}`);
});
test("multi-sentence (periods) does NOT leak across sentences", () => {
  const f = extractFactsRules("My name is Avara. I work at RIVA Labs. I am preparing for a system-design interview. I prefer concise answers.");
  assert.equal(f.length, 4, `expected 4 facts, got ${f.length}: ${JSON.stringify(f.map((x) => x.body))}`);
  const name = f.find((x) => /name/i.test(x.body));
  assert.equal(name.body, "The user's name is Avara.", `name leaked: "${name.body}"`);
  const work = f.find((x) => /works at/i.test(x.body));
  assert.equal(work.body, "The user works at RIVA Labs.", `employer leaked: "${work.body}"`);
});

// ---- full loop: remember (rules) -> store (okf) -> fetch (recall) ----
console.log("\nremember -> fetch loop");
await atest("captured facts are recalled regardless of question phrasing", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  okf.initStore(d);
  okf.clearAll(); // start empty
  for (const f of extractFactsRules("My name is Avara, I work at RIVA Labs, I'm preparing for a system-design interview, and I prefer concise answers."))
    okf.writeConcept({ type: f.type, title: f.title, body: f.body, tags: f.tags });
  const has = (q, re) => assert.ok(re.test(okf.recall(q).context), `recall("${q}") missing ${re}`);
  has("what is my name", /avara/i);
  has("where do I work", /riva/i);
  has("what am I preparing for", /interview/i);
  has("how should you answer me", /concise/i);
  has("tell me everything about me", /avara/i);
  fs.rmSync(d, { recursive: true, force: true });
  okf.initStore(path.join(os.tmpdir(), "noop")); // detach from temp
});
await atest("preference list -> store -> recall a specific one", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-"));
  okf.initStore(d);
  okf.clearAll();
  // user lists preferences in one message
  for (const f of extractFactsRules("My name is Kai. I love pizza but I hate pineapple, and I prefer concise answers."))
    okf.writeConcept({ type: f.type, title: f.title, body: f.body, tags: f.tags });
  assert.ok(okf.listConcepts().length >= 3, "list not fully captured");
  assert.ok(/pineapple/i.test(okf.recall("do I like pineapple").context), "pineapple pref not recalled");
  assert.ok(/pizza/i.test(okf.recall("what food do I like").context), "pizza pref not recalled");
  fs.rmSync(d, { recursive: true, force: true });
  okf.initStore(path.join(os.tmpdir(), "noop"));
});
fs.rmSync(tmp, { recursive: true, force: true });

// ============================ INTEGRATION + LOAD =========================
console.log("\nintegration + load (live control server)");
const okfDir = fs.mkdtempSync(path.join(os.tmpdir(), "iokf-"));
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "iskl-"));
const tracesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "itr-")), "traces.jsonl");
const PORT = 8099;
const srv = spawn("node", [path.join(ROOT, "server/control.mjs")], {
  env: { ...process.env, CONTROL_PORT: String(PORT), OKF_DIR: okfDir, SKILLS_DIR: skillsDir, TRACES_FILE: tracesFile, LLAMA_SERVER: "/bin/false" },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

try {
  // wait for ready
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/api/status")).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  await atest("okf put + search + clear", async () => {
    await post("/api/okf/put", { type: "Person", title: "Avara", tags: ["founder"], body: "builds RIVA" });
    const { hits } = await post("/api/okf/search", { query: "avara founder", k: 3 });
    assert.ok(hits.length >= 1);
    const c = await post("/api/okf/clear", {});
    assert.equal(c.ok, true);
  });

  await atest("okf recall is phrasing-proof for personal Qs (small store -> full profile)", async () => {
    await post("/api/okf/clear", {});
    await post("/api/okf/put", { type: "Person", title: "Avara", body: "The user's name is Avara." });
    await post("/api/okf/put", { type: "Project", title: "Employer", body: "The user works at RIVA Labs." });
    // queries that share NO keywords with the stored facts must still surface them
    for (const q of ["what is my name", "where do I work", "tell me about myself"]) {
      const { context } = await post("/api/okf/recall", { query: q });
      assert.ok(/avara/i.test(context), `recall("${q}") missing name:\n${context}`);
      assert.ok(/riva/i.test(context), `recall("${q}") missing employer`);
    }
    await post("/api/okf/clear", {});
  });

  await atest("skills put + list + delete (seeded skill present)", async () => {
    const { skills } = await j("/api/skills/list");
    assert.ok(skills.some((s) => s.id === "concise-mentor"));
    const { id } = await post("/api/skills/put", { name: "Test Skill", description: "d", body: "be terse" });
    assert.ok((await j("/api/skills/list")).skills.some((s) => s.id === id));
    assert.equal((await post("/api/skills/delete", { id })).ok, true);
  });

  await atest("traces log -> feedback flips label -> clear", async () => {
    const { id } = await post("/api/traces/log", { mode: "reasoning", problem: "q", cot: "c", answer: "a", reward: 0.2 });
    let t = (await j("/api/traces/list")).traces.find((x) => x.id === id);
    assert.equal(t.label, "negative");
    await post("/api/traces/feedback", { id, feedback: "up" });
    t = (await j("/api/traces/list")).traces.find((x) => x.id === id);
    assert.equal(t.label, "positive");
    await post("/api/traces/clear", {});
    assert.equal((await j("/api/traces/list")).traces.length, 0);
  });

  await atest("aux status reports reward gate", async () => {
    const s = await j("/api/aux/status");
    assert.ok("reward" in s && typeof s.reward.port === "number");
  });

  await atest("LOAD: 300 concurrent mixed requests all 200, p ok", async () => {
    const N = 300;
    const t0 = Date.now();
    const reqs = [];
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) reqs.push(post("/api/okf/put", { type: "Note", title: "n" + i, body: "load " + i }));
      else if (i % 3 === 1) reqs.push(post("/api/okf/search", { query: "load note", k: 5 }));
      else reqs.push(post("/api/traces/log", { mode: "reasoning", problem: "p" + i, cot: "c", answer: "a", reward: Math.random() }));
    }
    const results = await Promise.allSettled(reqs);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const ms = Date.now() - t0;
    assert.equal(ok, N, `${N - ok} requests failed`);
    console.log(`      ${N} reqs in ${ms}ms (${(ms / N).toFixed(1)}ms/req)`);
    await post("/api/okf/clear", {});
    await post("/api/traces/clear", {});
  });
} finally {
  srv.kill("SIGKILL");
  for (const d of [okfDir, skillsDir, path.dirname(tracesFile)]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
