// Set 1a, the full multi-agent loop on 10 questions: does the whole loop (Planner, Research, Skeptic, Writer, Evaluator,
// up to two rounds of search and three repair drafts) get the U.S. label status right as often as the single classification? The 10 are fixed before any
// run: the first 10 questions with a named U.S. product, in the file's order (sample/scoreboard/set1a_questions.json).
// The loop's answer is the U.S. label cell of its final draft (written / partial / not found), scored against the same
// key as every other arm (out/answer_key_v2_independent.json, labelled by a separate AI reviewer, not a pharmacist).
// Output: out/set1a_loop_<label>.json, never overwritten (APRIME_LOOP_LABEL names the run). Usage: node app/scoreloop.ts
// The number is reproducible only live: a replay stops as soon as a step is not in the recording (no offline stub, no
// emulator answer is ever scored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, ROOT, scrub } from "./config.ts";
import { Models, NotRecorded } from "./llm.ts";
import { SqlTool } from "./zetaris.ts";
import { Trace, traceStats } from "./trace.ts";
import { Investigation } from "./agents.ts";

type Q = { id: string; inn: string; signal: string; prac_meeting: string; product: string | null };
const qs: Q[] = JSON.parse(readFileSync(path.join(config.sampleDir, "scoreboard", "set1a_questions.json"), "utf8")).questions;
export const LOOP_IDS = qs.filter((q) => q.product).slice(0, 10).map((q) => q.id);
// the drug as the label table names it (for a combination or a class question, the named product's own substance)
const innOf: Record<string, string> = {};
for (const f of ["spl_section_score.csv", "spl_section.csv"])
  for (const line of readFileSync(path.join(config.sampleDir, "evidence", f), "utf8").split("\n").slice(1)) { const c = line.split(","); if (c[1] && c[2] && !innOf[c[1]]) innOf[c[1]] = c[2]; }
// the key's classes: a related form only is "not found" (the label does not name this reaction); not assessed is no answer
const status = (s: string) => /^written/i.test(s) ? "written" : /^partial/i.test(s) ? "partial" : /related.?only|^not.?found/i.test(s) ? "not found" : "no answer";

const label = process.env.APRIME_LOOP_LABEL || `${new Date().toLocaleDateString("sv-SE")}_${config.sampleMode ? "replay" : "live"}`;
const outFile = path.join(ROOT, "out", `set1a_loop_${label}.json`), traceDir = path.join(ROOT, "out", `set1a_loop_${label}_traces`);
if (existsSync(outFile) || existsSync(traceDir)) { console.error(`out/set1a_loop_${label} exists: runs are never overwritten; set APRIME_LOOP_LABEL`); process.exit(3); }
const answers: Record<string, unknown>[] = [];
for (const q of qs.filter((x) => LOOP_IDS.includes(x.id))) {
  const trace = new Trace(`loop-${q.id}`);
  const inv = new Investigation({ id: `set1a-${q.id}`, substance: innOf[q.product!] ?? q.inn.toLowerCase(), reaction: q.signal, label: `${q.inn} (${q.product}) and ${q.signal}` }, trace, new SqlTool({ prefix: `L${q.id}` }), new Models({ rejudge: config.sampleMode, endAtMiss: config.sampleMode }));
  const t0 = Date.now();
  const models = (inv as unknown as { models: Models }).models, sqlTool = (inv as unknown as { sql: SqlTool }).sql;
  // a replay re-judged with today's checks can reach a step the recording never made (a draft the recording approved is
  // sent back): the question ends there, with a person, and its last recorded draft
  let o: Awaited<ReturnType<Investigation["run"]>>, ended = "";
  try { o = await inv.run(); } catch (e) {
    if (!(e instanceof NotRecorded)) throw e;
    ended = String(e.message);
    const last = trace.events.filter((x) => x.agent === "writer" && x.kind === "draft").at(-1)!;
    o = { status: "needs-person", rounds: Number(last.round), draft: last.detail } as never;
  }
  const st = traceStats(trace.events);
  const stubs = models.calls.filter((c) => c.source === "offline-stub").length, emu = sqlTool.receipts.filter((r) => r.backend === "emulator").length;
  if (stubs || emu) { console.error(`${q.id}: ${stubs} model step(s) answered by the offline stub, ${emu} query(ies) by the emulator: not a recorded or live run, stopping (nothing written).`); process.exit(2); }
  const readLabel = o.draft.cells.US_label.cites.some((x) => /^SPL-|^US-LABELS-SEARCHED$/.test(x));
  // every question keeps its whole trace, so an approval or a hand-off can be checked afterwards
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(path.join(traceDir, `${q.id}.jsonl`), trace.events.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n");
  answers.push({ id: q.id, us_status: readLabel ? status(String(o.draft.cells.US_label.status ?? "")) : "no answer", read_label: readLabel, raw_status: o.draft.cells.US_label.status, finding: o.draft.cells.US_label.finding, cites: o.draft.cells.US_label.cites,
    outcome: o.status, rounds: o.rounds, ...(ended ? { ended_at_recording: `${ended}: today's checks sent back a draft the recording approved; a live run would have repaired it or handed it over` } : {}), modelCalls: st.modelCalls, rejections: st.rejections, errors: trace.events.filter((e) => e.kind === "error").length, secs: Math.round((Date.now() - t0) / 1000),
    sources: { models: models.calls.reduce((a, c) => ((a[c.source] = (a[c.source] ?? 0) + 1), a), {} as Record<string, number>), sql: sqlTool.receipts.reduce((a, r) => ((a[r.backend] = (a[r.backend] ?? 0) + 1), a), {} as Record<string, number>) } });
  console.log(q.id, q.product, "->", status(String(o.draft.cells.US_label.status ?? "")), `(${o.status} after ${o.rounds})`);
}
writeFileSync(outFile, JSON.stringify({ arm: "Full multi-agent loop (Planner, Research, chronology, Skeptic, Writer, Evaluator; up to two rounds of search, then up to three repair drafts)", ids: LOOP_IDS, label, traces: `out/set1a_loop_${label}_traces/`,
  selection: "the first 10 set-1a questions with a named U.S. product, in file order, fixed before any run", run_at: new Date().toLocaleDateString("sv-SE"), run_at_note: "local date (UTC+8) when the run finished", sampleMode: config.sampleMode, answers }, null, 1));
console.log("done", answers.length);
