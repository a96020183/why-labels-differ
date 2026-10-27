// A' night scan, gate A5: Markovian vs the fair opponents on the same 197 PRAC rows, same batches, same model,
// same call settings (CALL below). Batch = 3 rows (APRIME_BATCH): Nightshift only answers long scan prompts reliably
// with stream + tier-split off + small batches (from our tests of Nightshift with long prompts).
//   node engine/scan.ts M   -> Markovian (3 jobs of <= 22 chunks; each job seeded with the previous job's final carryover)
//   node engine/scan.ts C   -> evidence ledger + retrieval by ingredient or ATC level 3 (the fair opponent, gating)
//   node engine/scan.ts R   -> evidence ledger + retrieval by reaction words (reported, not gating)
// Every model response is cached under runs/scan_<sys>/ keyed by a hash of the exact prompt, so a crashed run
// resumes where it stopped and the cache doubles as the replay file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Markovian, estimateTokens, type Generator } from "./markovian/index.ts";
import { chat } from "./nightshift.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.APRIME_MODEL || "nvidia/nemotron-3-ultra-550b-a55b"; // requested; the app's auto mode decides, served model is logged
const BATCH = Number(process.env.APRIME_BATCH || 3);
const TRIES = 6; // per batch: HTTP failures and invalid answers together
// Nightshift injects up to 3 "PRIOR VETTED ANSWERS" (its H-MEM, top-k 3, min score 0.35) into every chat request,
// walled only by meterless-scope (engine/js/engine/orchestrator.js). With scope "user" that is ~2,600 extra tokens of
// earlier answers, i.e. earlier ledger rows reach both systems through the runtime. For a controlled comparison each
// request gets its own throw-away scope, so nothing is ever recalled (measured: prompt 2,110 vs 4,751 tokens).
// Identical call settings for every system: stream (SSE assembled in nightshift.ts), tier-split off, fresh iso scope per
// attempt. Only the app name differs (separate apps so no app-level state can carry one system's answers to the other).
const CALL = { stream: true, tierSplit: false, isoScope: true } as const;
const HEADERS = () => ({ "meterless-app": `aprime-scan-${(process.argv[2] || "M").toLowerCase()}` });
const sys = (process.argv[2] || "M").toUpperCase();
const rows: any[] = JSON.parse(fs.readFileSync(path.join(ROOT, "out/rows.json"), "utf8"));
const atc = JSON.parse(fs.readFileSync(path.join(ROOT, "out/atc.json"), "utf8"));
const us = JSON.parse(fs.readFileSync(path.join(ROOT, "out/uslabel.json"), "utf8")).rows;
const outDir = path.join(ROOT, "runs", BATCH === 8 ? `scan_${sys}` : `scan_${sys}_b${BATCH}`); fs.mkdirSync(outDir, { recursive: true });

const fact = (r: any) => {
  const u = us[r.id]; const l = (u.labels || []).find((x: any) => x.status === u.status) || {};
  const where = u.status === "not marketed" ? (u.note || "no US label") : `${l.search || ""}${l.published ? ", label effective " + l.published : ""}${l.hits?.[0] ? ", section: " + l.hits[0].section : ""}`;
  return `${r.id} | PRAC ${r.yr}-${String(r.mo).padStart(2, "0")} | ${r.inn.slice(0, 110)} | ATC3 ${atc.rows[r.id].join(",")} | signal: ${r.sig.slice(0, 120)} | US label: ${u.status} (${where.slice(0, 90)})`;
};
const batches: any[][] = []; for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

const RULES = `You maintain a "divergence ledger" for a hospital medication-safety pharmacist. You scan EMA PRAC signal rows that led to an EU product-information update, in meeting order, and record for each row where the U.S. label stands.
For EVERY row in the current batch output exactly one JSON object on its own line:
{"id":"R###","us":"written|partial|not found|not marketed","cross":[{"row":"R###","substance":"...","us":"written|partial|not found|not marketed"}]}
- "us": copy this row's own U.S. label status from its fact line.
- "cross": EARLIER rows (already scanned, or earlier in this batch) whose signal is the SAME adverse reaction but whose drugs are in a DIFFERENT pharmacological class (different ATC level 3). Give that earlier row's id, substance and its U.S. label status. Same-class rows do not go here. Empty list if none is known to you.
- Use only what is in this prompt. Never guess a row id or a status you were not given.
Output only the JSON lines (plus the state block when asked). No prose.`;

// Markovian state = the ledger summary only (bounded context): no narrative, no DECISIONS, just the cross-entry index.
// Budget = the registered V8 bound (800 tokens); the content is cut to the ledger summary alone.
const CARRY_TOKENS = Number(process.env.APRIME_CARRY || 800);
// Host-supplied compressor instructions (the engine's cascade calls compressorFn when a state block is over budget):
// the result must stay the same index, never a prose summary.
const COMPRESS_RULES = `The state's CONTEXT is a cross-entry index: "reaction: R### substance ATC3 status, R### ...; reaction: ...". Keep exactly that format and the four labels COMPLETED / REMAINING / DECISIONS / CONTEXT (DECISIONS: -). To fit the limit, shorten substance names to one word, and drop whole reaction entries that are least likely to recur in another drug class (one-off interactions, product-specific issues) first. Never replace the index with a prose summary. Output only the state block.`;
const MSTATE = `State block (keep it minimal, it is your only memory of earlier rows):
COMPLETED: last row id done
REMAINING: number of rows left
DECISIONS: -
CONTEXT: ledger summary = cross-entry index of the adverse reactions seen so far that could recur in another drug class. One entry per reaction: the reaction's own short name, a colon, then every row with it as "R### substance ATC3 status" (status: w|p|nf|nm), rows separated by ",", entries by "; ". Example of the format only (made-up rows): "angioedema: R140 samplopril C09A w, R151 examplumab L04A p; optic neuritis: R144 demonib L01E nf". Merge the current batch into the previous CONTEXT. Keep the whole state under ${CARRY_TOKENS * 4 - 200} characters; shorten substance names and drop the reactions least likely to recur first.`;

function hash(s: string) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
// Output check (reasoning can leak into content and eat the token budget): every batch row must have a JSON line at
// line start; for Markovian the state block and marker must follow. An invalid answer is never cached and is asked again (up to TRIES times).
// The kept answer is rebuilt host-side, identically for every system: the LAST well-formed JSON line of each batch row
// (reasoning drafts before it are dropped); for Markovian also the LAST of each state line after the last
// [STATE_CHECKPOINT], so leaked reasoning never becomes carryover. marker: "state" = non-final chunk, "final" = last
// chunk of a job (state block, then [TASK_COMPLETE]), undefined = no state (opponents).
function cleanAnswer(text: string, ids: string[], marker?: "state" | "final"): string | null {
  const out: string[] = [];
  for (const id of ids) {
    const ms = [...text.matchAll(new RegExp('^\\{"id"\\s*:\\s*"' + id + '".*$', "gm"))].map((m) => m[0].trim());
    const ok = ms.reverse().find((l) => { try { const o = JSON.parse(l); return o.id === id && typeof o.us === "string" && Array.isArray(o.cross ?? []); } catch { return false; } });
    if (!ok) return null;
    out.push(ok);
  }
  if (!marker) return out.join("\n");
  if (marker === "state" && /\[TASK_COMPLETE\]/.test(text.slice(text.lastIndexOf("[STATE_CHECKPOINT]")))) return null;
  if (marker === "final" && !/\[TASK_COMPLETE\]/.test(text)) return null;
  const at = text.lastIndexOf("[STATE_CHECKPOINT]"); if (at < 0) return null;
  const tail = text.slice(at);
  const last = (k: string) => [...tail.matchAll(new RegExp("^\\s*" + k + ":[ \\t]*(.*)$", "gm"))].map((m) => m[1].trim()).pop();
  const st = { COMPLETED: last("COMPLETED"), REMAINING: last("REMAINING"), DECISIONS: last("DECISIONS") ?? "-", CONTEXT: last("CONTEXT") };
  if (!st.COMPLETED || st.CONTEXT === undefined) return null;
  out.push("[STATE_CHECKPOINT]", `COMPLETED: ${st.COMPLETED}`, `REMAINING: ${st.REMAINING ?? "-"}`, `DECISIONS: ${st.DECISIONS}`, `CONTEXT: ${st.CONTEXT}`);
  if (marker === "final") out.push("[TASK_COMPLETE]");
  return out.join("\n");
}
const batchIds = (user: string) => [...user.slice(user.lastIndexOf("[BATCH")).matchAll(/^(R\d{3}) \| PRAC/gm)].map((m) => m[1]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Message layout, the same for every system: the rules AND the task text (Markovian chunk prompt with its carryover, or
// the opponent's retrieved rows + batch) go in the system message; the user turn is one fixed short line. Measured
// 2026-10-23: with tier-split off, Nightshift routes a request whose LAST USER message is longer than about 1,100
// characters to a lane that never answers (two 45 s deadlines, then 404 from a retired model), while the same text in
// the system message (tested up to 8,400 characters) is answered by Ultra within seconds.
const ASK = "Answer now for the current batch: one JSON line per row, then anything else the instructions above ask for.";
async function cachedChat(tag: string, rules: string, task: string, maxTokens = 8000, check?: (t: string) => string | null, ask = ASK) {
  const system = rules + "\n\n" + task, user = ask;
  const key = hash(MODEL + "|iso|" + system + "\n" + user); const f = path.join(outDir, `${tag}_${key}.json`);
  if (fs.existsSync(f)) {
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!check || check(c.text) !== null) return { ...c, text: check ? check(c.text) : c.text, cached: true };
    fs.renameSync(f, f.replace(/.json$/, ".invalid.json"));
  }
  if (process.env.APRIME_SCAN_REPLAY_ONLY) throw new Error(`${tag}: not in the recorded chunks (replay-only mode never calls a model)`);
  fs.writeFileSync(path.join(outDir, "_pending_prompt.json"), JSON.stringify({ tag, system, user }));
  let last = "";
  for (let k = 0; k < TRIES; k++) {
    if (k) await sleep(Math.min(180_000, 15_000 * 2 ** (k - 1))); // 15, 30, 60, 120, 180 s
    let r;
    try { r = await chat([{ role: "system", content: system }, { role: "user", content: user }], { model: MODEL, maxTokens, tag: `aprime-scan-${sys}-${tag}`, headers: HEADERS(), retries: 1, timeoutMs: 600_000, ...CALL }); }
    catch (e) { last = String((e as Error).message).slice(0, 160); console.log(tag, "try", k + 1, "failed:", last); continue; }
    const text = check ? check(r.text) : r.text;
    if (text === null) { last = "invalid answer"; console.log(tag, "try", k + 1, "invalid answer from", r.served); fs.writeFileSync(f.replace(/.json$/, `.invalid${k}.json`), JSON.stringify({ served: r.served, usage: r.usage, text: r.text }, null, 1)); continue; }
    const rec = { tag, requested: MODEL, served: r.served, usage: r.usage, latency: r.latency, hadThink: r.hadThink, tries: k + 1, call: CALL,
      promptTokensEstimated: estimateTokens(system + user), rawChars: r.text.length, task, text };
    fs.writeFileSync(f, JSON.stringify(rec, null, 1)); return rec;
  }
  throw new Error(`${tag}: no valid answer in ${TRIES} tries (${last})`);
}

const ledger: Record<string, any> = {};
const skipped: { tag: string; rows: string[]; error: string }[] = [];
function parseLedger(text: string) {
  for (const m of text.matchAll(/\{[^{}]*"id"\s*:\s*"R\d{3}"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
    try { const o = JSON.parse(m[0]); if (o.id) ledger[o.id] = o; } catch { /* malformed line: counted as missing */ }
  }
}

/** MN: the reaction-name index (code) hands each batch row its earlier same-name rows; the model decides which are the
 *  same reaction in a different class, and keeps its own carried index for the synonyms the names miss. */
function nameHints(bi: number) {
  const lines = batches[bi].map((x: any) => {
    const i = rows.indexOf(x);
    const c = nameCandidates(x, i, true).slice(-6);
    return c.length ? `${x.id}: ${c.map((p: any) => `${p.id} ${p.inn.slice(0, 40)} ATC3 ${atc.rows[p.id].join(",")} US ${us[p.id].status} ("${p.sig.slice(0, 60)}")`).join("; ")}` : "";
  }).filter(Boolean);
  return lines.length ? `\n[NAME-INDEX CANDIDATES - earlier rows whose reaction name shares most words; check class and meaning yourself]\n${lines.join("\n")}` : "";
}

async function runM() {
  const per = Math.ceil(batches.length / Math.ceil(batches.length / 22)); // maxChunks <= 32 per job
  const jobs: number[][] = []; for (let a = 0; a < batches.length; a += per) jobs.push([a, Math.min(batches.length, a + per)]);
  let memory = ""; const report: any[] = [];
  for (const [ji, [a, b]] of jobs.entries()) {
    let callNo = 0; const n = b - a;
    const gen: Generator = async (prompt, _att, systemPrompt) => {
      callNo++;
      const ids = batchIds(prompt); const tag = `job${ji + 1}_c${String(callNo).padStart(2, "0")}`;
      try {
        const r = await cachedChat(tag, systemPrompt || RULES, prompt, 8000, (t) => cleanAnswer(t, ids, callNo === n ? "final" : "state"));
        if (process.env.APRIME_SCAN_PROGRESS) console.log("CHUNK " + JSON.stringify({ job: ji + 1, chunk: callNo, of: n, rows: ids, served: r.served, cached: !!r.cached,
          promptTokens: estimateTokens((systemPrompt || RULES) + prompt), carryTokens: estimateTokens(prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)\n\nContinue exactly/)?.[1] ?? "") }));
        return { text: r.text, metadata: { usage: r.usage, model: r.served } };
      } catch (e) {
        // TRIES used up: the batch's rows stay missing (scored 0) and the state passes through unchanged.
        skipped.push({ tag, rows: ids, error: String((e as Error).message).slice(0, 200) }); console.log("SKIP", tag, ids.join(","));
        const prev = prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)\n\nContinue exactly/)?.[1] ?? (memory || "COMPLETED: -\nREMAINING: -\nDECISIONS: -\nCONTEXT: (none)");
        return { text: `[STATE_CHECKPOINT]\n${prev}${callNo === n ? "\n[TASK_COMPLETE]" : ""}`, metadata: { model: "skipped" } };
      }
    };
    const compressor = async (p: string, s: string) => (await cachedChat(`job${ji + 1}_compress`, s + "\n" + COMPRESS_RULES, p, 4000, undefined, "Write the compressed state block now.")).text;
    const m = new Markovian({ chunkConfig: { chunkSize: 8000, maxChunks: 32, carryoverTokens: CARRY_TOKENS }, compressorFn: compressor, historyDir: path.join(process.env.APRIME_SCAN_OUT ?? outDir, "history") });
    const run = await m.run({
      goal: `Scan PRAC rows batch ${a + 1}-${b} into the divergence ledger and keep the cross-entry index in CONTEXT.`,
      mode: "RESEARCH", generator: gen, memoryContext: memory ? `[MEMORY FROM PREVIOUS NIGHT JOB]\n${memory}` : undefined, reflect: false,
      systemPrompt: RULES + "\n" + MSTATE,
      stepInput: (step) => step > n ? undefined :
        `[BATCH ${a + step} of ${batches.length}; chunk ${step} of ${n} in this job${step === n ? " (LAST chunk of this job: after the JSON lines write [STATE_CHECKPOINT] and the state block, then [TASK_COMPLETE] as the very last line)" : ""}]\n` +
        batches[a + step - 1].map(fact).join("\n") + (sys === "MN" ? nameHints(a + step - 1) : ""),
    });
    if (run.status !== "completed") throw new Error(`job ${ji + 1} ended ${run.status}: ${run.error ?? ""} (rerun to resume from the cached chunks)`);
    parseLedger(run.output);
    memory = run.finalCarryover;
    report.push({ job: ji + 1, status: run.status, chunks: run.chunks.map((c) => ({ id: c.id, inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      promptTokensEstimated: c.promptTokensEstimated, carryoverTokensIn: estimateTokens(c.carryover), cascade: c.cascade, model: c.model })),
      tokenLabel: run.tokenLabel, efficiencyPercent: run.efficiencyPercent, finalCarryoverTokens: estimateTokens(run.finalCarryover), error: run.error });
    // a replay writes its results next to the replay output, never over the recorded chunks it reads
    fs.writeFileSync(path.join(process.env.APRIME_SCAN_OUT ?? outDir, `job${ji + 1}_finalCarryover.txt`), run.finalCarryover);
  }
  return report;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/\([^)]*\)/g, " ").match(/[a-z]{4,}/g)?.filter((w) =>
  !["with", "from", "risk", "known", "aspect", "related", "drug", "patients", "information", "including", "associated", "after", "during", "leading"].includes(w)) ?? []);

async function runRetrieval(kind: "C" | "R") {
  const report: any[] = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]; const prior = rows.slice(0, bi * BATCH);
    const hit = prior.filter((p) => batch.some((x) => kind === "C"
      ? atc.rows[p.id].some((c: string) => atc.rows[x.id].includes(c)) || p.substances.some((s: string) => x.substances.includes(s))
      : [...words(p.sig)].some((w) => words(x.sig).has(w))));
    const ret = hit.slice(-30); // cap: 30 most recent retrieved rows
    const retTxt = ret.map((p) => `${fact(p)} | ledger: ${JSON.stringify(ledger[p.id] ?? {})}`).join("\n");
    const user = `[RETRIEVED EVIDENCE LEDGER ROWS - ${kind === "C" ? "same ingredient or same ATC level 3 as a row in this batch" : "signal shares a word with a row in this batch"}; ${ret.length} of ${hit.length} matches, most recent]\n${retTxt || "(none)"}\n\n[BATCH ${bi + 1} of ${batches.length}]\n${batch.map(fact).join("\n")}`;
    // Leak guard: an opponent prompt is built only from fact lines and this process's own ledger; it must never carry
    // anything from a Markovian run (its state block, carryover or memory).
    if (/\[CARRYOVER STATE\]|\[STATE_CHECKPOINT\]|MEMORY FROM PREVIOUS NIGHT JOB|CONTEXT:/.test(user)) throw new Error("opponent prompt carries Markovian state");
    const ids = batchIds(user); const tag = `b${String(bi + 1).padStart(2, "0")}`;
    let r;
    try { r = await cachedChat(tag, RULES, user, 8000, (t) => cleanAnswer(t, ids)); }
    catch (e) { // TRIES used up: rows stay missing (scored 0), as for Markovian
      skipped.push({ tag, rows: ids, error: String((e as Error).message).slice(0, 200) }); console.log("SKIP", tag, ids.join(","));
      report.push({ batch: bi + 1, retrieved: ret.length, matched: hit.length, skipped: true }); continue;
    }
    parseLedger(r.text);
    report.push({ batch: bi + 1, retrieved: ret.length, matched: hit.length, inputTokens: r.usage?.prompt_tokens, outputTokens: r.usage?.completion_tokens, served: r.served });
    console.log(kind, "batch", bi + 1, "retrieved", ret.length, "in", r.usage?.prompt_tokens, "served", r.served);
  }
  return report;
}

// ---- reaction-name index (code, no model): earlier rows whose signal shares at least half its words with this one ----
const NAME_STOP = new Set(["with", "and", "the", "of", "in", "after", "drug", "risk", "known", "aspect", "new", "related", "including", "associated", "leading", "during", "from", "to", "or", "a", "an", "use", "due", "induced"]);
const nameWords = (s: string) => new Set((s.toLowerCase().replace(/\([^)]*\)/g, " ").match(/[a-z]{3,}/g) ?? []).filter((w) => !NAME_STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((x) => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0; };
const diffClass = (p: any, x: any) => !atc.rows[p.id].some((c: string) => atc.rows[x.id].includes(c)) && !p.substances.some((s: string) => x.substances.includes(s));
function nameCandidates(x: any, upTo: number, all = false) {
  const wx = nameWords(x.sig);
  return rows.slice(0, upTo).filter((p) => p.id !== x.id && jaccard(nameWords(p.sig), wx) >= 0.5 && (all || diffClass(p, x)));
}

if (sys === "N") { // the name-matching baseline: no model, the cross links are exactly the index's different-class hits
  const t0 = Date.now();
  rows.forEach((x: any, i: number) => {
    ledger[x.id] = { id: x.id, us: us[x.id].status, cross: nameCandidates(x, i).map((p: any) => ({ row: p.id, substance: p.inn.slice(0, 60), us: us[p.id].status })) };
  });
  fs.writeFileSync(path.join(process.env.APRIME_SCAN_OUT || path.join(ROOT, "out"), "ledger_N.json"), JSON.stringify({ system: "N", requestedModel: "none (code)", batch: BATCH, ledger, skipped: [], seconds: (Date.now() - t0) / 1000 }, null, 1));
  console.log("N done", Object.keys(ledger).length); process.exit(0);
}

if (sys === "FR") { // re-read the whole ledger every step, with the model (same rules, same batches, same call settings)
  const t0 = Date.now(); const report: any[] = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const prior = rows.slice(0, bi * BATCH).map((p: any) => `${fact(p)} | ledger: ${JSON.stringify(ledger[p.id] ?? {})}`).join("\n");
    const task = `[FULL LEDGER SO FAR - every earlier row with its ledger line]\n${prior || "(none)"}\n\n[BATCH ${bi + 1} of ${batches.length}]\n${batches[bi].map(fact).join("\n")}`;
    const ids = batchIds(task); const tag = `b${String(bi + 1).padStart(2, "0")}`;
    let r;
    try { r = await cachedChat(tag, RULES, task, 8000, (t) => cleanAnswer(t, ids)); }
    catch (e) { skipped.push({ tag, rows: ids, error: String((e as Error).message).slice(0, 200) }); report.push({ batch: bi + 1, skipped: true }); continue; }
    parseLedger(r.text);
    report.push({ batch: bi + 1, promptTokensEstimated: r.promptTokensEstimated, latency: r.latency, served: r.served });
    console.log("FR batch", bi + 1, "prompt ~", r.promptTokensEstimated, "tokens", r.latency ?? "cached", "s", r.served);
  }
  fs.writeFileSync(path.join(process.env.APRIME_SCAN_OUT || path.join(ROOT, "out"), "ledger_FR.json"), JSON.stringify({ system: "FR", requestedModel: MODEL, batch: BATCH, call: CALL, ledger, skipped, report, seconds: (Date.now() - t0) / 1000 }, null, 1));
  console.log("FR done", Object.keys(ledger).length); process.exit(0);
}

if (sys === "F") {
  // Opponent "evidence ledger + re-read the whole ledger every step": no model calls; prompt size per batch, using
  // Markovian's ledger lines as the stand-in for what each earlier row's ledger line would be.
  const lm = JSON.parse(fs.readFileSync(path.join(ROOT, "out/ledger_M.json"), "utf8")).ledger;
  const sizes = batches.map((b, bi) => {
    const prior = rows.slice(0, bi * BATCH).map((p) => `${fact(p)} | ledger: ${JSON.stringify(lm[p.id] ?? {})}`).join("\n");
    return estimateTokens(RULES + "\n[FULL LEDGER]\n" + prior + "\n[BATCH]\n" + b.map(fact).join("\n"));
  });
  const first = sizes.findIndex((s) => s > 8000);
  const cutRows = sizes.map((s) => Math.max(0, Math.ceil((s - 8000) / (sizes[1] - sizes[0]) * BATCH)));
  fs.writeFileSync(path.join(ROOT, "out", "fullreread_tokens.json"), JSON.stringify({ estimated: true, perBatchPromptTokens: sizes,
    firstBatchOver8000: first + 1, firstRowOver8000: first * BATCH + 1, lastBatchTokens: sizes.at(-1),
    rowsThatWouldNotFitAt8000InLastBatch: cutRows.at(-1), totalInputTokens: sizes.reduce((a, b) => a + b, 0) }, null, 1));
  console.log("full re-read: first batch over 8000 =", first + 1, "sizes", sizes.join(","));
  process.exit(0);
}
const t0 = Date.now();
const report = sys === "M" || sys === "MN" ? await runM() : await runRetrieval(sys as "C" | "R");
const LEDGER_OUT = process.env.APRIME_SCAN_OUT || path.join(ROOT, "out"); fs.mkdirSync(LEDGER_OUT, { recursive: true });
fs.writeFileSync(path.join(LEDGER_OUT, `ledger_${sys}.json`), JSON.stringify({ system: sys, requestedModel: MODEL, batch: BATCH, call: CALL, ...(sys === "M" || sys === "MN" ? { carryoverTokens: CARRY_TOKENS } : {}), ledger, skipped, report, seconds: (Date.now() - t0) / 1000 }, null, 1));
console.log(sys, "done:", Object.keys(ledger).length, "ledger rows in", Math.round((Date.now() - t0) / 1000), "s");
