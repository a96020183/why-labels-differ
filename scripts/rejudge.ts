// Offline re-judgement of recorded investigations under the current checks (no model, no Zetaris call).
//   node --no-warnings scripts/rejudge.ts snapshot <out.json> [five|loop|all]
//        replay the recorded runs (SAMPLE_MODE) and save, for every draft the Evaluator saw, the draft, what the checks
//        read, the Skeptic's reply and the Evaluator model's own verdict on it
//   node --no-warnings scripts/rejudge.ts judge <snapshot.json>
//        run today's must-hold and coverage checks on those drafts
//   node --no-warnings scripts/rejudge.ts outcomes <snapshot.json> <recorded loop json> <out json>
//        the loop's outcome per question under today's checks: approved at the first recorded draft that passes every
//        must-hold check and that the Evaluator model approved (with no coverage check left, or one it overruled in the
//        recording); otherwise handed to a person with its last draft. The recorded flow is not re-run: a draft the new
//        checks send back ends the question there (a real run could have repaired it).
// A snapshot is taken with the code that made the recording (its prompts match the cassettes, e.g. in a git worktree
// of that commit); judging uses today's code. The Skeptic's readings are the recorded ones.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../app/config.ts";
import * as agents from "../app/agents.ts";
const { Investigation } = agents;
import { Trace } from "../app/trace.ts";
import { SqlTool } from "../app/zetaris.ts";
import { Models } from "../app/llm.ts";
import { QUESTIONS } from "../app/run.ts";

const [mode, file, a3, a4] = process.argv.slice(2);
type Snap = { q: Record<string, unknown>; round: number; draft: unknown; state: Record<string, unknown>; skeptic?: unknown; model?: { modelSays?: string; decidedBy?: string; final?: string } };
const FIELDS = ["items", "tried", "rowsBy", "swept", "exposure", "prevOption", "prevCites", "askedText", "repairs", "disputes", "hypotheses", "falsifications", "terms", "broad", "classTerms", "curRound", "carry", "unanswered"];

if (mode === "snapshot") {
  if (!config.sampleMode) throw new Error("snapshot replays the recording: run with SAMPLE_MODE=true");
  const which = a3 ?? "all";
  const snaps: Snap[] = [];
  // the Skeptic's own reply to the draft being judged (the checks added later read it again, offline)
  let lastSkeptic: unknown = undefined;
  const chat = Models.prototype.chat;
  Models.prototype.chat = async function (this: Models, ...a: Parameters<Models["chat"]>) {
    const r = await chat.apply(this, a);
    if (a[2].tag.startsWith("falsify:")) { const { jsonWith } = await import("../app/llm.ts"); lastSkeptic = jsonWith(r.text, ["claims"]); }
    return r;
  };
  const orig = Investigation.prototype.rubric;
  Investigation.prototype.rubric = function (this: InstanceType<typeof Investigation>, d) {
    const me = this as unknown as Record<string, unknown>;
    const state = Object.fromEntries(FIELDS.map((k) => [k, me[k] instanceof Set ? [...(me[k] as Set<string>)] : me[k]]));
    snaps.push(JSON.parse(JSON.stringify({ q: this.q, round: this.curRound, draft: d, state, skeptic: lastSkeptic })));
    return orig.call(this, d);
  };
  // the Evaluator model's own verdict on each draft, as recorded
  const evaluate = Investigation.prototype.evaluate;
  Investigation.prototype.evaluate = async function (this: InstanceType<typeof Investigation>, ...a: Parameters<InstanceType<typeof Investigation>["evaluate"]>) {
    const r = await evaluate.apply(this, a);
    const ev = this.trace.events.filter((e) => e.agent === "evaluator" && (e.kind === "approve" || e.kind === "reject")).at(-1);
    const det = (ev?.detail ?? {}) as { modelSays?: string; decidedBy?: string };
    const last = snaps.at(-1);
    if (last) last.model = { modelSays: det.modelSays, decidedBy: det.decidedBy, final: r.v.verdict };
    return r;
  };
  const qs: { id: string; substance: string; reaction: string; label: string }[] = which === "loop" ? [] : QUESTIONS.slice(0, 5);
  // the 10-question loop, as app/scoreloop.ts builds its questions
  const set = JSON.parse(readFileSync(path.join(config.sampleDir, "scoreboard", "set1a_questions.json"), "utf8")).questions as { id: string; inn: string; signal: string; product: string | null }[];
  const innOf: Record<string, string> = {};
  for (const f of ["spl_section_score.csv", "spl_section.csv"])
    for (const line of readFileSync(path.join(config.sampleDir, "evidence", f), "utf8").split("\n").slice(1)) { const c = line.split(","); if (c[1] && c[2] && !innOf[c[1]]) innOf[c[1]] = c[2]; }
  if (which !== "five") for (const x of set.filter((y) => y.product).slice(0, 10)) qs.push({ id: `set1a-${x.id}`, substance: innOf[x.product!] ?? x.inn.toLowerCase(), reaction: x.signal, label: `${x.inn} (${x.product}) and ${x.signal}` });
  const report: string[] = [];
  for (const q of qs) {
    const before = snaps.length;
    const models = new Models();
    const inv = new Investigation(q, new Trace(q.id), new SqlTool(q.id.startsWith("set1a-") ? { prefix: `L${q.id.slice(6)}` } : {}), models);
    let status = "";
    try { status = (await inv.run()).status; } catch (e) { status = "error: " + String(e).slice(0, 80); }
    const stubs = models.calls.filter((c) => c.source === "offline-stub").length;
    if (stubs) snaps.splice(before); // not a recorded run: nothing from it is kept
    report.push(`${q.id}: ${stubs ? `not in the recording (${stubs} offline step(s)), skipped` : `${status}, ${snaps.length - before} draft(s) judged`}`);
  }
  writeFileSync(file, JSON.stringify(snaps));
  console.log(report.join("\n"));
} else if (mode === "judge" || mode === "outcomes") {
  const snaps: Snap[] = JSON.parse(readFileSync(file, "utf8"));
  const judged = snaps.map((s, k) => {
    const inv = new Investigation(s.q as never, new Trace("rejudge"), new SqlTool(), new Models());
    const me = inv as unknown as Record<string, unknown>;
    for (const k of FIELDS) if (s.state[k] !== undefined && s.state[k] !== null) me[k] = ["tried", "prevCites"].includes(k) ? new Set(s.state[k] as string[]) : s.state[k];
    const d = (inv as unknown as { normalize: (x: unknown) => unknown }).normalize(s.draft) as agents.Draft;
    // the previous draft of the same question gives the cells' earlier stages (a snapshot from older code does not hold them)
    const prev = k > 0 && (snaps[k - 1].q as { id: string }).id === (s.q as { id: string }).id ? (inv as unknown as { normalize: (x: unknown) => agents.Draft }).normalize(snaps[k - 1].draft) : undefined;
    if (prev && !Object.keys((me.prevCells as object) ?? {}).length) me.prevCells = Object.fromEntries(Object.entries(prev.cells).map(([c, x]) => [c, String((c === "US_label" ? x.status : x.stage) ?? "")]));
    // checks added after the recording read the recorded Skeptic reply again
    const f = inv.falsifications.at(-1) as { causes?: unknown } | undefined;
    if (f && !f.causes && s.skeptic) f.causes = (agents as unknown as { skepticCauses: (r: unknown, d: unknown) => unknown }).skepticCauses(s.skeptic, d);
    const gaps = inv.rubric(d as never);
    return { s, d, hard: gaps.filter((g) => g.hard), soft: gaps.filter((g) => !g.hard) };
  });
  if (mode === "judge") {
    console.log(judged.map(({ s, hard, soft }) => `${String((s.q as { id: string }).id).padEnd(26)} r${s.round}  must-hold ${hard.length}  coverage ${soft.length}  (recorded: ${s.model?.final ?? "?"}, model said ${s.model?.modelSays ?? "?"})${hard.length ? "\n    " + hard.map((g) => g.problem.slice(0, 150)).join("\n    ") : ""}`).join("\n"));
  } else {
    const rec = JSON.parse(readFileSync(a3, "utf8"));
    const status = (x: string) => /^written/i.test(x) ? "written" : /^partial/i.test(x) ? "partial" : /related.?only|^not.?found/i.test(x) ? "not found" : "no answer";
    const answers = rec.answers.filter((a: { id: string }) => judged.some((j) => (j.s.q as { id: string }).id === `set1a-${a.id}`)).map((a: Record<string, unknown>) => {
      const mine = judged.filter((j) => (j.s.q as { id: string }).id === `set1a-${a.id}`);
      const ok = mine.find((j) => !j.hard.length && j.s.model?.modelSays === "approve" && (!j.soft.length || /overruled/.test(j.s.model?.decidedBy ?? "")));
      // the recorded flow stops at the first draft that new checks would send back after the model approved it
      const end = ok ?? mine.at(-1)!;
      const cells = end.d.cells.US_label;
      const readLabel = cells.cites.some((x) => /^SPL-|^US-LABELS-SEARCHED$/.test(x));
      return { id: a.id, us_status: readLabel ? status(String(cells.status ?? "")) : "no answer", read_label: readLabel, raw_status: cells.status, cites: cells.cites,
        outcome: ok ? "approved" : "needs-person", rounds: end.s.round, recorded: { outcome: a.outcome, rounds: a.rounds, us_status: a.us_status },
        open_items: ok ? [] : end.hard.map((g) => g.problem.slice(0, 200)) };
    });
    const out = { arm: `${rec.arm}, re-judged offline with today's checks`, ids: rec.ids, label: `${rec.label}_rejudged`, selection: rec.selection, run_at: rec.run_at,
      rejudged_at: new Date().toLocaleDateString("sv-SE"), rejudged_with: "the must-hold and coverage checks of this commit, on the recorded drafts, Skeptic readings and Evaluator model verdicts (scripts/rejudge.ts outcomes)",
      complete: rec.complete !== false && answers.length === rec.ids.length, answers };
    if (existsSync(a4)) throw new Error(`${a4} exists: never overwritten`);
    writeFileSync(a4, JSON.stringify(out, null, 1));
    for (const x of answers) console.log(`${x.id}: ${x.recorded.outcome} after ${x.recorded.rounds} (${x.recorded.us_status}) -> ${x.outcome} after ${x.rounds} (${x.us_status})`);
  }
} else console.log("usage: node scripts/rejudge.ts snapshot|judge|outcomes ...");
