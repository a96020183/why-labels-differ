// Command line: run the whole flow without the browser.
//   node app/cli.ts                         hero question, vote "propose", reopen replay (SAMPLE_MODE by default)
//   node app/cli.ts <question-id> [vote]    any question in sample/questions.json; vote = agents (default: the agents'
//                                           own recommendation) | propose | wait | no_action | already_covered | none
//   APRIME_ALL_VOTES=1 also casts the other three votes (used when recording, so every vote replays from Zetaris)
//   node app/cli.ts replay                  the 2026 reopen replay only
import { config } from "./config.ts";
import { Session, QUESTIONS, runReplay, COMMITTEE } from "./run.ts";
import { Trace, traceStats } from "./trace.ts";
import { SqlTool } from "./zetaris.ts";
import { Models } from "./llm.ts";

const [arg = QUESTIONS[0].id, voteArg = "agents"] = process.argv.slice(2);
const OPTIONS = ["propose", "wait", "no_action", "already_covered"];
const t0 = Date.now();
const print = (e: { seq: number; agent: string; kind: string; round?: number; summary: string; receipts?: string[]; model?: { served: string; source: string } }) =>
  console.log(`${String(e.seq).padStart(3)} ${(e.round ? "r" + e.round : "  ")} ${e.agent.padEnd(9)} ${e.kind.padEnd(8)} ${e.summary}${e.receipts?.length ? "  [" + e.receipts.join(", ") + "]" : ""}`);

console.log(`Why Labels Differ · ${config.sampleMode ? "SAMPLE_MODE (recorded Zetaris + Nightshift answers)" : "LIVE (Zetaris + Nightshift)"}${config.record ? " · recording" : ""}\n`);
if (arg === "scan") {
  const { nightScan } = await import("./board.ts");
  const s = nightScan();
  while (s.state().running) await new Promise((r) => setTimeout(r, 200));
  const st = s.state();
  for (const c of st.chunks as { job: number; chunk: number; rows: string[]; carryTokens: number; promptTokens: number }[]) console.log(`job ${c.job} step ${String(c.chunk).padStart(2)}  ${c.rows.join(",").padEnd(14)} prompt ${c.promptTokens} tokens, carried ${c.carryTokens}`);
  console.log(st.error ? "error: " + st.error : st.done + " (replayed from the recorded steps; no model called)");
} else if (arg === "ledger") {
  const { ledgerTop } = await import("./board.ts");
  const l = await ledgerTop() as { rows: Record<string, unknown>[]; receipt: { qid: string; backend: string } };
  for (const r of l.rows) console.log(`${r.row_id} ${r.substance} | ${r.signal} | ${r.us_prescreen} | patients ${r.patients} | FDA rows ${r.fda_list_rows}`);
  console.log(l.receipt.backend);
} else if (arg !== "replay") {
  const q = QUESTIONS.find((x) => x.id === arg);
  if (!q) { console.error("unknown question; choose one of: " + QUESTIONS.map((x) => x.id).join(", ")); process.exit(2); }
  const s = new Session(q);
  s.trace.on(print);
  await s.start();
  if (s.phase === "error") { console.error(s.error); process.exit(1); }
  if (s.phase === "needs-live") process.exit(0);
  const o = s.outcome!;
  console.log(`\n== ${o.status.toUpperCase()} after ${o.rounds} round(s) · why: ${o.draft.why.type}\n   ${o.draft.why.sentence}`);
  for (const [c, cell] of Object.entries(o.draft.cells)) console.log(`   ${c.padEnd(13)} ${cell.stage ?? cell.status ?? ""} — ${cell.finding} [${cell.cites.join(", ")}]`);
  console.log(`   Patients here: ${o.exposure?.patients ?? "?"} · recommendation: ${o.draft.recommendation.option}`);
  const vote = voteArg === "agents" ? (o.status === "approved" ? o.draft.recommendation.option : "none") : voteArg; // a hand-off makes no suggestion, so no vote is cast for it
  if (OPTIONS.includes(vote)) {
    const after = await s.castVote(vote as "propose", COMMITTEE);
    if (after.counsel) console.log(`\n== Counseling points: ${JSON.stringify(after.counsel)}`);
  }
  if (process.env.APRIME_ALL_VOTES) for (const other of OPTIONS.filter((x) => x !== vote)) await s.castVote(other as "propose", COMMITTEE);
  console.log(`\n== Trace: ${JSON.stringify(traceStats(s.trace.events))}`);
  if (process.env.APRIME_TRACE_OUT) { // export the trace (scrubbed) for docs/traces
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(process.env.APRIME_TRACE_OUT, { recursive: true });
    writeFileSync(`${process.env.APRIME_TRACE_OUT}/${q.id}.jsonl`, s.trace.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(`${process.env.APRIME_TRACE_OUT}/${q.id}.stats.json`, JSON.stringify({ question: q.id, status: o.status, rounds: o.rounds, ...traceStats(s.trace.events) }, null, 1));
  }
}
if (arg === "replay" || process.argv.length <= 2) {
  if (arg === "ledger" || arg === "scan") process.exit(0);
  const tr = new Trace("replay"); tr.on(print);
  console.log("\n== Reopen replay (two real 2026 U.S. label changes; committee decisions are illustrative)");
  await runReplay(tr, new SqlTool({ prefix: "R" }), new Models());
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
