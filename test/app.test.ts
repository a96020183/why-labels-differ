// npm test: no keys, no network, no Zetaris needed (SAMPLE_MODE, the default: recorded answers + local emulator).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, scrub, config } from "../app/config.ts";
assert.equal(config.sampleMode, true, "tests run in SAMPLE_MODE");
import { ZetarisEmulator } from "../app/emulator.ts";
import { SqlTool, asObjects } from "../app/zetaris.ts";
import { Trace, traceStats } from "../app/trace.ts";
import { Models, lastJson } from "../app/llm.ts";
import { Investigation } from "../app/agents.ts";
import { CaseState } from "../app/casestate.ts";
import { Session, QUESTIONS, runReplay } from "../app/run.ts";
import { skepticSql, pushdownSummary, federatedSql } from "../app/sources.ts";

const emu = new ZetarisEmulator(path.join(ROOT, "sample"));
/** records and a draft that pass every must-hold check; a test changes one thing and looks at what fails */
function valid(inv: Investigation) {
  inv.exposure = { patients: "75" }; inv.terms = ["naion", "optic neuropathy"];
  for (const s of ["us_label_sections", "prac_signal_catalogue", "mhra_drug_safety_updates", "fda_potential_signal_lists", "fda_sentinel"]) inv.tried.add(s);
  const it = (eid: string, column: string, source: string, kind: string, date: string, text: string) => ({ eid, column: column as "EU", source, authority: "primary", kind, title: "", date, section: "", text, qid: "Q-" + eid });
  inv.items.push(it("A", "US_regulator", "fda_potential_signal_lists", "fda_potential_signal", "2024-12-31", "FDA is evaluating the need for regulatory action"),
    it("B", "EU", "prac_signal_catalogue", "prac_recommendation", "2025-06-06", "PRAC recommended an update of the product information"),
    it("LBL", "US_label", "us_label_sections", "spl_versions", "", "Searched in full: Ozempic v30. Sections matching: 0."),
    it("UK1", "UK", "mhra_drug_safety_updates", "drug_safety_update", "2026-02-05", "MHRA: a very rare side effect; product information updated"),
    it("FDANF", "US_regulator", "fda_sentinel", "search_without_result", "", "No row names it."));
  const holds = (id: string, f: string[], role = "main", rank = 1) => ({ id, name: `${id.toLowerCase()}_stages_differ`, verdict: "holds", role, rank, why: "PRAC concluded while the FDA is still evaluating", for: f, against: [] as string[] });
  const open = (id: string) => ({ id, name: `${id.toLowerCase()}_other`, verdict: "open", why: "the records do not decide it", for: [] as string[], against: [] as string[] });
  const draft = (o: Record<string, unknown> = {}) => ({
    cells: { EU: { stage: "concluded", finding: "PRAC recommended an update.", cites: ["B"] }, UK: { stage: "concluded", finding: "The MHRA updated the product information.", cites: ["UK1"] },
      US_label: { status: "not found", finding: "The label does not mention it.", cites: ["LBL"] }, US_regulator: { stage: "under_evaluation", finding: "The FDA is evaluating it.", cites: ["A"] } },
    hypotheses: [holds("H1", ["A", "B"])], why: { type: "different_stage", sentence: "The main reason is a different stage, because PRAC concluded while the FDA is evaluating.", cites: ["A", "B"], reasons: [{ type: "different_stage", claim: "PRAC concluded; the FDA is still evaluating.", cites: ["A", "B"] }] },
    evidence: { note: "Observational studies.", cites: ["B"] }, recommendation: { option: "wait", reason: "Wait for the FDA." }, reopen_when: [], ...o });
  return { draft, holds, open };
}
const q = (id: string) => QUESTIONS.find((x) => x.id === id)!;

test("governance: the agent role sees patient ids masked, the pharmacist sees them", () => {
  const sql = "SELECT patient_id FROM aprime_rx.dispense WHERE inn = 'semaglutide' LIMIT 3";
  for (const r of emu.run(sql, "agent").data) assert.match(String(r[0]), /^[*-]+$/);
  for (const r of emu.run(sql, "pharmacist").data) assert.match(String(r[0]), /[0-9a-f]/);
});

test("governance: the agent role cannot read the patient list or write a decision", () => {
  assert.throws(() => emu.run("SELECT * FROM aprime_views.patient_list", "agent"), /does not have privileges/);
  assert.throws(() => emu.run("INSERT INTO aprime_lab.pt_decision VALUES ('x','x','x','propose','x','x','x','x')", "agent"), /INSERT/);
});

test("the patient list stays empty until the committee proposes", () => {
  const e = new ZetarisEmulator(path.join(ROOT, "sample"));
  assert.equal(e.run("SELECT count(*) FROM aprime_views.patient_list", "pharmacist").data[0][0], "0");
  e.run("INSERT INTO aprime_lab.pt_decision VALUES ('PT-1','semaglutide','NAION','propose','p','2026-10-24','r','x')", "pharmacist");
  assert.equal(e.run("SELECT count(*) FROM aprime_views.patient_list", "pharmacist").data[0][0], "75");
});

test("aggregate counts for the agent are not distorted by masking", () => {
  const r = emu.run("SELECT sum(patients) FROM aprime_views.rx_counts WHERE inn = 'semaglutide'", "agent");
  assert.equal(r.data[0][0], "75");
});

test("Evaluator rubric: a press release alone is sent back; a primary EU record is not", () => {
  const inv = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new Models());
  const d = { cells: { EU: { finding: "x", cites: ["P1"] }, UK: { finding: "", cites: [] }, US_label: { finding: "", cites: [] }, US_regulator: { finding: "", cites: [] } },
    hypotheses: [], why: { type: "x", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "propose", reason: "" }, reopen_when: [] };
  inv.items.push({ eid: "P1", column: "EU", source: "ema_announcements", authority: "secondary", kind: "press_release", title: "", date: "", section: "", text: "", qid: "Q-1" });
  inv.tried.add("ema_announcements");
  assert.ok(inv.rubric(d).some((g) => g.column === "EU" && /Only a press release/.test(g.problem)));
  inv.items.push({ eid: "P2", column: "EU", source: "eu_product_information", authority: "primary", kind: "smpc", title: "", date: "", section: "", text: "", qid: "Q-2" });
  assert.ok(!inv.rubric(d).some((g) => g.column === "EU"));
});

test("Evaluator rubric: a label that lacks the warning needs the FDA's own position", () => {
  const inv = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new Models());
  inv.tried.add("us_label_sections");
  const empty = { finding: "", cites: [] };
  const d = { cells: { EU: empty, UK: empty, US_label: empty, US_regulator: empty }, hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "propose", reason: "" }, reopen_when: [] };
  assert.ok(inv.rubric(d).some((g) => g.column === "US_regulator"));
  inv.items.push({ eid: "L1", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "", section: "", text: "", qid: "Q-3" });
  assert.ok(!inv.rubric(d).some((g) => g.column === "US_regulator"));
});

test("Evaluator rubric: the recommendation must follow from the findings, and a search that found nothing rules nothing out", () => {
  const inv = new Investigation(q("gemcitabine-dress"), new Trace("t"), new SqlTool(), new Models());
  inv.items.push({ eid: "W", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "", section: "", text: "", qid: "Q-1" },
    { eid: "NF", column: "US_regulator", source: "fda_sentinel", authority: "primary", kind: "search_without_result", title: "", date: "", section: "", text: "", qid: "Q-2" });
  const empty = { finding: "", cites: [] as string[] };
  const mk = (status: string, option: string, against: string[]) => ({ cells: { EU: empty, UK: empty, US_label: { status, finding: "x", cites: ["W"] }, US_regulator: empty },
    hypotheses: [{ id: "H1", name: "fda_studying_it", verdict: "ruled_out", why: "", for: [], against }], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option, reason: "" }, reopen_when: [] });
  const rec = (d: ReturnType<typeof mk>) => inv.rubric(d).filter((g) => g.column === "recommendation" && g.hard);
  inv.exposure = { patients: "18" };
  assert.equal(rec(mk("written", "propose", ["W"])).length, 1, "U.S. label warns, yet a new reminder is proposed");
  assert.equal(rec(mk("written", "already_covered", ["W"])).length, 0);
  assert.ok(inv.rubric(mk("not found", "already_covered", ["W"])).some((g) => !g.hard && /cites a warning section .* yet says not found/.test(g.problem)), "a cited warning section with another status is raised for the Evaluator (it may be about another exposure)");
  assert.equal(rec(mk("not found", "propose", ["W"])).length, 0);
  inv.exposure = undefined;
  assert.ok(rec(mk("not found", "propose", ["W"])).some((g) => /No patient/.test(g.problem)), "nobody here takes it: no in-house reminder");
  inv.exposure = { patients: "18" }; inv.curRound = 2; inv.prevOption = "wait"; inv.prevCites = new Set(["W"]); inv.askedText = "";
  assert.ok(rec(mk("not found", "propose", ["W"])).some((g) => /changed from "wait"/.test(g.problem)), "wait -> propose with no new record");
  inv.items.push({ eid: "NEW", round: 2, column: "UK", source: "mhra_drug_safety_updates", authority: "primary", kind: "drug_safety_update", title: "", date: "", section: "", text: "", qid: "Q-3" });
  assert.equal(rec(mk("not found", "propose", ["W"])).length, 0, "a new record may change it");
  inv.curRound = 1; inv.prevOption = "";
  assert.ok(inv.rubric(mk("written", "already_covered", ["NF"])).some((g) => g.hard && /found nothing/.test(g.problem)), "ruled out only on an empty search");
  assert.ok(!inv.rubric(mk("written", "already_covered", ["W"])).some((g) => /found nothing/.test(g.problem)));
  const held = { ...mk("written", "already_covered", []), hypotheses: [{ id: "H2", name: "fda_threshold", verdict: "holds", why: "", for: ["NF"], against: [] }] };
  assert.ok(inv.rubric(held).some((g) => g.hard && /Held (?:only|partly) on a search that found nothing/.test(g.problem)), "held only on an empty search");
  inv.items.push({ eid: "PROZAC", column: "US_label", source: "us_label_class_members", authority: "primary", kind: "label_other_section", title: "", date: "", section: "", text: "", qid: "Q-4" });
  const other = { ...mk("partial", "wait", ["W"]), cells: { ...mk("partial", "wait", ["W"]).cells, US_label: { status: "partial", finding: "x", cites: ["PROZAC"] } } };
  assert.ok(inv.rubric(other).some((g) => g.hard && g.column === "US_label" && /another drug/.test(g.problem)), "another drug's label cannot carry this drug's U.S. label cell");
});

test("Skeptic query: FDA rows that match the word but name other drugs are found (ALK inhibitors, optic neuropathy)", () => {
  const rows = asObjects(emu.run(skepticSql.termOnlyFda(["optic neuropathy"]), "agent"));
  assert.ok(rows.some((r) => /alectinib/i.test(r.products ?? "")));
  assert.ok(rows.some((r) => /semaglutide/i.test(r.products ?? "")));
});

test("Evaluator rubric: explanations that hold must be decided between (one main cause, the rest ranked)", () => {
  const inv = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new Models());
  inv.exposure = { patients: "75" };
  inv.items.push({ eid: "A", column: "EU", source: "eu_product_information", authority: "primary", kind: "smpc", title: "", date: "", section: "", text: "", qid: "Q-1" });
  const empty = { finding: "", cites: [] as string[] };
  const h = (id: string, role?: string, rank?: number) => ({ id, name: id, verdict: "holds", why: "", for: ["A"], against: [], role, rank });
  const mk = (hs: ReturnType<typeof h>[]) => ({ cells: { EU: empty, UK: empty, US_label: empty, US_regulator: empty }, hypotheses: hs, why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "wait", reason: "" }, reopen_when: [] });
  const rank = (d: ReturnType<typeof mk>) => inv.rubric(d).filter((g) => g.hard && /main cause|without a ranking/.test(g.problem));
  assert.equal(rank(mk([h("H1"), h("H2"), h("H3"), h("H4")])).length, 1, "four that hold and no main cause: sent back");
  assert.equal(rank(mk([h("H1", "main", 1), h("H2", "main", 2)])).length, 1, "two main causes: sent back");
  assert.equal(rank(mk([h("H1", "main", 1), h("H2", "secondary"), h("H3", "secondary")])).length, 1, "three hold, not ranked: sent back");
  assert.equal(rank(mk([h("H1", "main", 1), h("H2", "secondary", 2), h("H3", "secondary", 3)])).length, 0);
  assert.equal(rank(mk([h("H1", "main", 1)])).length, 0);
});

test("recorded hero run (QA round 4, re-judged with the QA round 5 checks): a finding sent back is not answered by rewording; the last draft says the cause cannot be determined while the Skeptic reads H4 as a cause, so it goes to a person; every swept label section read; all evidence through receipts", async () => {
  const s = new Session(q("semaglutide-naion"));
  await s.start();
  const o = s.outcome!;
  assert.equal(o.status, "needs-person"); assert.equal(o.rounds, 5);
  assert.ok(o.gaps[4].some((g) => g.hard && /cause cannot be determined, but the Skeptic reads H4 as a cause/.test(g.problem)), "round 5: undetermined while a checker reads a cause");
  assert.ok(s.models.calls.some((c) => c.rejudged), "the steps whose prompt listed the recording's checks are the recorded replies, re-judged offline");
  assert.ok(o.gaps.slice(2, 4).every((gs) => gs.some((g) => g.hard && /Sent back after draft \d and not answered: .*restate the difference/.test(g.problem))), "rounds 3 and 4: explanations found to restate the difference were reworded, not answered, and stayed open");
  assert.ok(s.trace.events.some((e) => e.kind === "info" && /repair 3 of 3/.test(e.summary)), "the third repair draft answered every finding");
  assert.equal(o.draft.why.type, "undetermined"); assert.deepEqual(o.draft.why.reasons, []);

  assert.equal(o.draft.cells.US_label.status, "not found"); assert.ok(o.draft.cells.US_label.cites.includes("US-LABELS-SEARCHED"), "the label cell cites the labels it read");
  assert.equal(o.draft.cells.US_regulator.stage, "under_evaluation");
  assert.ok(o.draft.cells.US_regulator.cites.some((x) => /^AEMS-/.test(x)), "the FDA cell rests on the FDA's potential-signal entry");
  const sweep = s.trace.events.find((e) => e.agent === "skeptic" && /^Read all \d+ passages/.test(e.summary));
  assert.ok(sweep, "the Skeptic read every swept label section, not the first eight");
  assert.ok(s.models.calls.every((c) => c.source === "replay" && /nemotron/i.test(c.served)), "every model step is a recorded Nemotron reply");
  assert.ok(!s.trace.events.some((e) => e.kind === "error"), "every recorded reply parsed");
  for (const it of o.items) assert.ok(s.sql.receipts.some((r) => r.qid === it.qid), `${it.eid} has a receipt`);
  const known = new Set(o.items.map((i) => i.eid));
  for (const c of Object.values(o.draft.cells)) for (const id of c.cites) assert.ok(known.has(id), `cited ${id} was returned by Research`);
  assert.equal(o.exposure?.patients, "75");
  assert.ok(!JSON.stringify(s.models.calls).includes("SYN-"), "no patient identifier went to a model");
});

test("a question nobody recorded is not answered with stubs in sample mode: it asks for a live run", async () => {
  const s = new Session({ id: "test-gemcitabine-x", substance: "gemcitabine", reaction: "DRESS", label: "test" });
  await s.start();
  assert.equal(s.phase, "needs-live");
  assert.equal(s.models.calls.length, 0);
  assert.ok(s.trace.events.some((e) => /not recorded/.test(e.summary)));
});

test("reopen replay: Yescarta recalled on the 2026-08-17 label, Nubeqa stays on hold (change only outside the warnings)", async () => {
  const res = await runReplay(new Trace("r"), new SqlTool({ prefix: "R" }), new Models());
  const y = res.find((r) => r.id === "R-yescarta")! as unknown as { timeline: { published: string; state: string }[] };
  const n = res.find((r) => r.id === "R-nubeqa")! as unknown as { timeline: { published: string; state: string }[] };
  assert.deepEqual(y.timeline.map((t) => t.state), ["no change", "recall"]);
  assert.equal(y.timeline[1].published, "2026-08-17");
  assert.deepEqual(n.timeline.map((t) => t.state), ["half"]);
});

for (const arm of ["M", "MN"]) test(`night scan ${arm} replays through the Markovian engine from the recorded steps and reproduces its ledger exactly`, () => {
  const out = path.join(ROOT, "runs", "test", "scan_" + arm);
  const r = spawnSync(process.execPath, ["--no-warnings", path.join(ROOT, "engine", "scan.ts"), arm], { cwd: ROOT, env: { ...process.env, APRIME_SCAN_REPLAY_ONLY: "1", APRIME_SCAN_OUT: out, APRIME_BATCH: "3" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(readFileSync(path.join(ROOT, "out", `ledger_${arm}.json`), "utf8")).ledger;
  const b = JSON.parse(readFileSync(path.join(out, `ledger_${arm}.json`), "utf8")).ledger;
  assert.deepEqual(b, a);
});

test("secrets are scrubbed from anything logged", () => {
  assert.equal(scrub("Authorization: Bearer abc.def-123"), "Authorization: Bearer <redacted>");
  assert.match(scrub('password "hunter2hunter2"'), /<redacted>/);
});

test("last JSON object wins when a model drafts before answering", () => {
  assert.deepEqual(lastJson('draft {"a":1} final {"a":2}'), { a: 2 });
});

test("the joined query counts with sum(CASE) and joins on the drug, and its numbers match the direct queries", () => {
  const q = { id: "t", substance: "semaglutide", reaction: "x", label: "x" };
  const sql = federatedSql(q, ["naion", "ischemic optic neuropathy"], []);
  assert.match(sql, /LEFT JOIN/); assert.doesNotMatch(sql, /CROSS JOIN/); assert.doesNotMatch(sql, /count\(\*\)/);
  const r = asObjects(emu.run(sql, "agent"))[0];
  const direct = emu.run("SELECT count(*) FROM aprime_lab.spl_section WHERE inn = 'semaglutide' AND purpose IN ('hero','score') AND (lower(text) LIKE '%naion%' OR lower(text) LIKE '%ischemic optic neuropathy%')", "agent").data[0][0];
  assert.equal(r.patients, "75"); assert.equal(r.us_label_sections_naming_it, direct);
});

test("the plan summary is read from Zetaris EXPLAIN text, including Spark's abbreviated filter lists", () => {
  const plan = ["== Physical Plan ==",
    " +- Scan InsertableJDBCTableRelation(x) APRIME_LAB.reg_doc[doc_id#1] PushedFilters: [EqualTo(regulator,EU), IsNotNull(authority), ..., ReadSchema: struct<doc_id:string>",
    " +- FileScan csv APRIME_FILES.aems[products#2] Batched: false, PushedFilters: [], ReadSchema: struct<products:string>"].join("\n");
  const p = pushdownSummary(plan);
  assert.deepEqual(p.map((x) => [x.system, x.table]), [["Postgres", "reg_doc"], ["S3", "aems"]]);
  assert.match(p[0].pushed, /EqualTo\(regulator,EU\)/); assert.equal(p[1].pushed, "");
});

test("recorded runs (QA round 1 and 4 facts): sertraline's label is related only, darolutamide's FDA cell counts the label change, valproate starts in 2024, gemcitabine's U.S. label came first; recommendations differ", async () => {
  const run = async (id: string) => { const s = new Session(q(id)); await s.start(); assert.ok(s.models.calls.every((c) => c.source === "replay"), `${id}: recorded Nemotron replies only`); assert.ok(!s.trace.events.some((e) => e.kind === "error"), `${id}: every recorded reply parsed`); return s; };
  const st = (await run("sertraline-pssd")).outcome!;
  assert.equal(st.draft.cells.US_label.status, "related_only", "Zoloft's W&P 5.11 names sexual dysfunction during treatment, not its persistence");
  assert.ok(st.draft.cells.US_label.cites.some((x) => /^SPL-Zoloft/.test(x)) && !st.draft.cells.US_label.cites.some((x) => /^SPL-Prozac/.test(x)));
  assert.ok(st.draft.cells.UK.cites.some((x) => x.startsWith("UK-DSU-2026-10-15")), "the UK cell rests on MHRA's October 2026 update");
  assert.ok(st.gaps[0].some((g) => g.hard && /boxed warning is about suicidal thoughts/.test(g.problem)), "round 1: a boxed warning tied to the wrong concern was sent back");
  assert.ok(st.gaps[0].some((g) => g.hard && /why rests partly on a search that found nothing/.test(g.problem)), "round 1: a why resting on an empty FDA search was sent back");
  const d = (await run("darolutamide-angioedema")).outcome!;
  assert.ok(!/no_public_action/.test(String(d.draft.cells.US_regulator.stage)), "the FDA-approved label change v24 is an FDA action");
  assert.equal(d.draft.recommendation.option, "already_covered", "EU 4.8 and U.S. Adverse Reactions: the same section level");
  const v = (await run("valproate-paternal")).outcome!;
  assert.ok(v.draft.cells.EU.cites.some((x) => x.startsWith("EU-NEWS-VALPROATE-2024-01")), "the EU cell gives the January 2024 measures");
  assert.ok(v.draft.cells.UK.cites.some((x) => x.startsWith("UK-DSU-2024-09-05")));
  assert.equal(v.exposure, undefined); assert.notEqual(v.draft.recommendation.option, "propose"); assert.equal(v.status, "needs-person");
  const g = (await run("gemcitabine-dress")).outcome!;
  assert.equal(g.status, "approved"); assert.equal(g.draft.why.type, "us_earlier", "the U.S. label warned before the EU acted");
  assert.ok(g.gaps.some((gs) => gs.some((x) => /U\.S\. had it first/.test(x.problem))) || g.rounds === 1, "the order of the records decided the main cause");
  const opts = new Set(await Promise.all(["semaglutide-naion", "sertraline-pssd", "darolutamide-angioedema", "gemcitabine-dress", "valproate-paternal"].map(async (id) => (await run(id)).outcome!.draft.recommendation.option)));
  assert.ok(opts.size >= 3, `recommendations differ with the data: ${[...opts].join(", ")}`);
});

test("every vote is answered by Zetaris in the recording, and the screen says who answered", async () => {
  for (const option of ["propose", "wait", "no_action", "already_covered"]) {
    const s = new Session(q("gemcitabine-dress")); await s.start();
    await s.castVote(option as "propose", "P&T committee");
    const votes = s.sql.receipts.filter((r) => /decision|Agent tries to record/.test(r.purpose));
    assert.ok(votes.length >= 2 && votes.every((r) => r.backend === "replay"), `${option}: the INSERTs replay recorded Zetaris answers`);
    assert.ok(s.trace.events.some((e) => e.kind === "denied" && /refused by Zetaris/.test(e.summary)));
  }
});

test("Skeptic second source: a quote missing from openFDA's copy of the same label version is contradicted; another version is not compared", async () => {
  const zoloft = "Use of SSRIs, including ZOLOFT, may cause symptoms of sexual dysfunction [see Adverse Reactions ( 6.1 )]. In male patients, SSRI use may result in ejaculatory delay or failure";
  class OpenFdaStub extends SqlTool { // stands in for the REST table: openFDA's text of Zoloft v7 and Prozac v58
    async run(sql: string, purpose: string, agent: string, who?: Parameters<SqlTool["run"]>[3]) {
      if (!sql.includes("aprime_openfda.label")) return super.run(sql, purpose, agent, who);
      const r = await super.run("SELECT 1 AS x", purpose, agent, who);
      return { ...r, ok: true, result: { headers: ["product", "inn", "ours", "openfda_version", "wc", "alltext"], data: [["Zoloft", "sertraline", "7", "7", zoloft, zoloft], ["Prozac", "fluoxetine", "59", "58", "", ""]] } };
    }
  }
  const inv = new Investigation(q("sertraline-pssd"), new Trace("t"), new OpenFdaStub(), new Models());
  inv.terms = ["persistent sexual dysfunction"];
  const it = (eid: string, product: string, version: string, text: string) => ({ eid, column: "US_label" as const, source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "", section: "", qid: "Q-1",
    text, meta: { product, path: "5 WARNINGS AND PRECAUTIONS > 5.11 Sexual Dysfunction", version } });
  const items = [it("Z-TRUE", "Zoloft", "7", zoloft), it("Z-MADE-UP", "Zoloft", "7", "Zoloft can cause sexual dysfunction that persists for years after the drug is stopped"), it("P", "Prozac", "59", "anything")];
  const v = items.map((x) => x.eid), c: string[] = [];
  const out = await (inv as unknown as { openFdaCheck: (...a: unknown[]) => Promise<{ verified: number; contradicted: number; notComparable: number }> }).openFdaCheck(items, v, c, new Map(), [], 1);
  assert.deepEqual([out.verified, out.contradicted, out.notComparable], [1, 1, 1]);
  assert.ok(c.some((x) => x.startsWith("Z-MADE-UP: openFDA's copy of Zoloft v7")) && !v.includes("Z-MADE-UP"));
});

test("reopen: the conditions are the Writer's, and rows the investigation already read do not make one come true", async () => {
  for (const id of ["sertraline-pssd", "valproate-paternal", "semaglutide-naion"]) {
    const s = new Session(q(id)); await s.start();
    const after = await s.castVote("wait", "test") as { conditions: { description: string; fired: boolean }[] };
    const asked = s.outcome!.draft.reopen_when.map((c) => String(c.text).trim()).slice(0, 4);
    if (asked.length) assert.deepEqual(after.conditions.map((c) => c.description), asked, `${id}: the Writer's own conditions`);
    else assert.match(after.conditions[0].description, /names .* in Boxed Warning, Warnings and Precautions or Contraindications/, `${id}: the Writer gave none, so the default label watch`);
    assert.ok(after.conditions.every((c) => !c.fired), `${id}: nothing has changed since the decision`);
  }
  // a row the investigation never read goes to the judge; without a recorded judgement it never fires on its own
  const s = new Session(q("valproate-paternal")); await s.start();
  s.outcome!.items = s.outcome!.items.filter((i) => i.column !== "US_label");
  const before = s.models.calls.length;
  const c = (await s.conditions("PT-valproate-paternal"))[0];
  assert.ok(c.newRows > 0 && s.models.calls.length > before && !c.fired);
});

test("reopen: a mention added only under Adverse Reactions is found and sent to the judge (the condition decides whether it counts)", async () => {
  const s = new Session(q("semaglutide-naion")); await s.start();
  const real = s.sql;
  s.sql = new (class extends SqlTool {
    async run(sql: string, purpose: string, agent: string, who?: Parameters<SqlTool["run"]>[3]) {
      const r = await real.run(sql, purpose, agent, who);
      if (!purpose.startsWith("Reopen check") || !sql.includes("aprime_lab.spl_section")) return r;
      return { ...r, ok: true, result: { headers: ["product", "version", "effective", "path", "text"], data: [["Ozempic", "21", "2026-11-01", "6 ADVERSE REACTIONS > 6.2 Postmarketing Experience", "Eye disorders: non-arteritic anterior ischemic optic neuropathy (NAION)"]] } };
    }
  })();
  const label = (await s.conditions("PT-semaglutide-naion")).find((c) => c.kind.startsWith("us_label"))!;
  assert.equal(label.newRows, 1, "the label query reads every section, not only the warnings");
  assert.ok(s.trace.events.some((e) => e.agent === "watcher" && e.kind === "model"), "the new row went to the Nemotron judge");
});

test("send back, new records, approval: the loop path, with a scripted Evaluator (revise, then approve) and the Planner's re-plan", async () => {
  let evals = 0;
  class Script extends Models {
    async chat(...a: Parameters<Models["chat"]>) {
      const r = await super.chat(...a); const tag = a[2].tag;
      if (tag.startsWith("eval:")) return { ...r, text: ++evals === 1 ? '{"verdict":"revise","feedback":"scripted: where does the FDA stand?"}' : '{"verdict":"approve","feedback":"scripted"}' };
      if (tag.startsWith("replan:")) return { ...r, text: '{"add_sources":["fda_sentinel"],"reason":"scripted"}' };
      return r;
    }
  }
  const t = new Trace("t");
  const inv = new Investigation({ id: "t-sendback", substance: "semaglutide", reaction: "NAION", label: "t" }, t, new SqlTool(), new Script());
  inv.rubric = () => []; // only the scripted Evaluator decides here
  const o = await inv.run();
  assert.equal(o.rounds, 2); assert.equal(o.status, "approved");
  assert.ok(o.items.some((i) => i.round === 2 && i.source === "fda_sentinel"), "round 2 Research fetched what the re-plan asked for");
});

test("two rounds without approval go to a person, and the trace counts the escalation", async () => {
  class Strict extends Models { // a scripted Evaluator that never approves: the loop must stop after two rounds, not loop
    async chat(...a: Parameters<Models["chat"]>) { const r = await super.chat(...a); return a[2].tag.startsWith("eval:") ? { ...r, text: '{"verdict":"revise","feedback":"scripted: never satisfied"}' } : r; }
  }
  const t = new Trace("t");
  const o = await new Investigation({ id: "t-escalate", substance: "semaglutide", reaction: "NAION", label: "t" }, t, new SqlTool(), new Strict()).run();
  assert.equal(o.status, "needs-person"); assert.ok(o.rounds >= 2 && o.rounds <= 5, "two rounds, plus up to three repair drafts");
  const st = traceStats(t.events); assert.equal(st.escalations, 1); assert.equal(st.rejections, o.rounds);
});

test("Skeptic: a cited record that the independent fetch does not back up is contradicted, and the draft goes back", async () => {
  const inv = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new Models());
  inv.items.push({ eid: "UK-DSU-2026-02-05-03", column: "UK", source: "mhra_drug_safety_updates", authority: "primary", kind: "drug_safety_update", title: "MHRA", date: "", section: "Advice",
    text: "MHRA says the risk is common and every patient must stop the drug at once", qid: "Q-1", meta: { passage_id: "UK-DSU-2026-02-05-03" } });
  const empty = { finding: "", cites: [] as string[] };
  const d = { cells: { EU: empty, UK: { stage: "concluded", finding: "MHRA says it is common", cites: ["UK-DSU-2026-02-05-03"] }, US_label: empty, US_regulator: empty },
    hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "propose", reason: "" }, reopen_when: [] };
  const f = await inv.falsify(d, 1);
  assert.ok(f.contradicted.some((c) => /UK-DSU-2026-02-05-03/.test(c)), "the made-up wording is not in MHRA's passage");
  assert.ok(inv.rubric(d).some((g) => g.hard && /contradicts/.test(g.problem)), "a contradicted record is a must-hold failure");
  // the same record quoted faithfully is verified
  inv.items[0].text = "patients reporting a sudden loss of vision (including partial loss) should be urgently referred for specialist examination by an ophthalmologist";
  const g = await inv.falsify(d, 1);
  assert.equal(g.contradicted.filter((c) => /UK-DSU/.test(c)).length, 0);
});

test("Skeptic: no false alarm when one FDA quarter lists the term for several products, when later replay label versions exist, or when one label path holds several sections", async () => {
  const g = new Investigation(q("gemcitabine-dress"), new Trace("t"), new SqlTool(), new Models());
  const act = "Updated The “Dosage and Administration”, “Warnings and Precautions”, “Adverse Reactions”, and “Patient Counseling Information” sections of the labeling were updated between May 2024 and September 2024";
  g.items.push({ eid: "AEMS-Q32023-Drug_reaction_with_eosino", column: "US_regulator", source: "fda_potential_signal_lists", authority: "primary", kind: "fda_potential_signal", title: "FDA AEMS", date: "", section: "",
    text: `Products: Gemcitabine. Signal: Drug reaction with eosinophilia and systemic symptoms. FDA: ${act}`, qid: "Q-1", meta: { quarter: "Q3 2023", term: "Drug reaction with eosinophilia and systemic symptoms" } });
  const empty = { finding: "", cites: [] as string[] };
  const draft = (col: string, id: string) => ({ cells: { EU: empty, UK: empty, US_label: empty, US_regulator: empty, [col]: { stage: "concluded", finding: "x", cites: [id] } },
    hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "propose", reason: "" }, reopen_when: [] });
  const ok = await g.falsify(draft("US_regulator", g.items[0].eid), 1);
  assert.equal(ok.verified, 1, "the second product's action on the same row is found"); assert.equal(ok.contradicted.filter((c) => c.startsWith("AEMS")).length, 0);
  g.items[0].text = "Products: Gemcitabine. Signal: DRESS. FDA: no action planned";
  assert.equal((await g.falsify(draft("US_regulator", g.items[0].eid), 1)).contradicted.filter((c) => c.startsWith("AEMS")).length, 1, "a made-up action is still caught");
  const d = new Investigation(q("darolutamide-angioedema"), new Trace("t"), new SqlTool(), new Models());
  d.terms = ["angioedema"];
  const n = emu.run("SELECT count(*) FROM aprime_lab.spl_section WHERE inn = 'darolutamide' AND purpose IN ('hero','score') AND lower(text) LIKE '%angioedema%'", "agent").data[0][0];
  d.items.push({ eid: "US-LABELS-SEARCHED", column: "US_label", source: "us_label_sections", authority: "primary", kind: "spl_versions", title: "", date: "", section: "", text: `Sections matching: ${n}.`, qid: "Q-1" });
  const c = await d.falsify(draft("US_label", "US-LABELS-SEARCHED"), 1);
  assert.equal(c.verified, 1, "the count covers the same label versions the search covered"); assert.equal(c.contradicted.length, 0);
  const s = new Investigation(q("sertraline-pssd"), new Trace("t"), new SqlTool(), new Models());
  s.items.push({ eid: "SPL-Prozac-v59-6-x", column: "US_label", source: "us_label_class_members", authority: "primary", kind: "label_other_section", title: "", date: "", section: "", qid: "Q-1",
    text: "Other adverse reactions in pediatric patients (children and adolescents) — Treatment-emergent adverse reactions were collected in 322 pediatric patients",
    meta: { product: "Prozac", path: "6 ADVERSE REACTIONS > 6.1 Clinical Trials Experience > SPL UNCLASSIFIED SECTION", version: "59" } });
  assert.equal((await s.falsify(draft("US_label", "SPL-Prozac-v59-6-x"), 1)).verified, 1, "the second of two unnamed sections under one label path is found");
});

test("World Model case state: what the loop loses without it (verdict history, flips, the Skeptic's targets)", async () => {
  const run = async (enabled: boolean) => {
    const cs = new CaseState("t", enabled);
    await cs.hypotheses([{ id: "H1", name: "different_stage", test: "" }, { id: "H2", name: "wording_or_section", test: "" }], 1);
    await cs.evidence([{ eid: "A", source: "x", round: 1 }], 1);
    await cs.verdicts([{ id: "H1", name: "different_stage", verdict: "holds", for: ["A"], against: [] }, { id: "H2", name: "wording_or_section", verdict: "ruled_out", for: [], against: ["A"] }], 1);
    await cs.verdicts([{ id: "H1", name: "different_stage", verdict: "holds", for: ["A"], against: [] }, { id: "H2", name: "wording_or_section", verdict: "holds", for: ["A"], against: [] }], 2);
    return cs;
  };
  const on = await run(true), off = await run(false);
  assert.deepEqual(on.state().find((h) => h.id === "H2")!.history.map((x) => x.status), ["open", "ruled_out", "holds"], "history kept: a later verdict closes the earlier edge, never deletes it");
  assert.equal(on.flipFlops(new Set()).length, 1, "H2 flipped with no new record: the Evaluator gets a must-hold failure");
  assert.deepEqual(on.holdingRecords(), ["A"], "the Skeptic attacks the record holding up the verdicts");
  assert.match(on.describe(), /r1 ruled_out -> r2 holds/);
  assert.equal(off.flipFlops(new Set()).length, 0); assert.deepEqual(off.holdingRecords(), []); assert.equal(off.describe(), "");
  assert.ok((on.summary() as { supersededVerdicts: number }).supersededVerdicts >= 3);
});

test("web app: POST /api/scan starts the night-scan replay (GET only reports it), a custom question is never answered with stubs, and dates no record contains are caught", async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "app", "server.ts")], { cwd: ROOT, env: { ...process.env, PORT: String(port), SAMPLE_MODE: "true" }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(url + "/api/meta"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.deepEqual(await (await fetch(url + "/api/scan", { method: "POST" })).json(), { ok: true });
    let st: { running: boolean; chunks: unknown[] } = { running: true, chunks: [] };
    for (let i = 0; i < 300 && st.running; i++) { await new Promise((r) => setTimeout(r, 100)); st = await (await fetch(url + "/api/scan")).json(); }
    assert.ok(st.chunks.length > 0, "the replay ran through the engine");
    await fetch(url + "/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ custom: { id: "semaglutide-naion", substance: "x", reaction: "y", label: "x" } }) });
    let phase = "";
    for (let i = 0; i < 50 && !["needs-live", "awaiting-vote"].includes(phase); i++) { await new Promise((r) => setTimeout(r, 100)); phase = (await (await fetch(url + "/api/state")).json()).phase; }
    assert.equal(phase, "needs-live", "a recorded id with another drug or reaction is not replayed");
  } finally { srv.kill(); }
  const { unbackedDates } = await import("../app/agents.ts");
  assert.deepEqual(unbackedDates("still in progress with an estimated completion date of September 2026", "status: in progress (snapshot 2026-09-22)"), ["estimated completion date of September 2026"]);
  assert.deepEqual(unbackedDates("expected to conclude in 2028; EU acted in January 2024", "the study is expected to conclude in 2028. 2024-01-26 news"), []);
});

test("Evaluator rubric (QA round 1): first action before a re-review, a recent FDA label change is an FDA action, ruled out needs a record against, no unbacked dates, PRAC means concluded", () => {
  const inv = new Investigation(q("valproate-paternal"), new Trace("t"), new SqlTool(), new Models());
  inv.exposure = { patients: "3" };
  const it = (eid: string, column: string, kind: string, date: string, source = "x") => ({ eid, column: column as "EU", source, authority: "primary", kind, title: "", date, section: "", text: "kept the measures in 2026; acted in 2024", qid: "Q-1" });
  inv.items.push(it("EU-2024", "EU", "press_release", "2024-01-26"), it("EU-2026", "EU", "prac_recommendation", "2026-06-11"), it("LBL", "US_label", "label_other_section", "2026-09-28", "us_label_sections"));
  const empty = { finding: "", cites: [] as string[] };
  const mk = (eu: string[], euStage: string, usReg: string, hyp: { verdict: string; against: string[] }, finding = "x") => ({
    cells: { EU: { stage: euStage, finding, cites: eu }, UK: empty, US_label: { status: "partial", finding: "x", cites: ["LBL"] }, US_regulator: { stage: usReg, finding: "x", cites: [] } },
    hypotheses: [{ id: "H1", name: "h", verdict: hyp.verdict, why: "", for: ["EU-2026"], against: hyp.against, role: hyp.verdict === "holds" ? "main" : undefined, rank: hyp.verdict === "holds" ? 1 : undefined }],
    why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "wait", reason: "" }, reopen_when: [] });
  const has = (d: ReturnType<typeof mk>, re: RegExp) => inv.rubric(d).some((g) => g.hard && re.test(g.problem));
  assert.ok(has(mk(["EU-2026"], "concluded", "concluded", { verdict: "holds", against: [] }), /first acted in 2024/), "a 2026 re-review alone");
  assert.ok(!has(mk(["EU-2024", "EU-2026"], "concluded", "concluded", { verdict: "holds", against: [] }), /first acted/));
  assert.ok(has(mk(["EU-2024"], "concluded", "no_public_action_found", { verdict: "holds", against: [] }), /FDA approves every label version/));
  assert.ok(has(mk(["EU-2024"], "concluded", "concluded", { verdict: "ruled_out", against: [] }), /Ruled out with no record against/));
  assert.ok(has(mk(["EU-2024"], "concluded", "concluded", { verdict: "holds", against: [] }, "completion expected in March 2027"), /do not contain/));
  assert.ok(has(mk(["EU-2024", "EU-2026"], "agreed_with_noted_conflict", "concluded", { verdict: "holds", against: [] }), /PRAC recommendation/), "only 'concluded' fits a PRAC recommendation");
});

test("Evaluator rubric: a related form found by the Skeptic makes the label partial; a boxed warning keeps the topic its record gives", () => {
  const inv = new Investigation(q("sertraline-pssd"), new Trace("t"), new SqlTool(), new Models());
  inv.exposure = { patients: "62" };
  inv.items.push({ eid: "Z511", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "", section: "", text: "may cause symptoms of sexual dysfunction", qid: "Q-1", note: "Skeptic: related to the reaction but not the same: during treatment" },
    { eid: "UK1", column: "UK", source: "mhra_drug_safety_updates", authority: "primary", kind: "drug_safety_update", title: "", date: "2026-10-15", section: "", text: "A new boxed warning in the PILs to better highlight information on suicidal thoughts and behaviours. The term PSSD will be added.", qid: "Q-2" });
  const empty = { finding: "", cites: [] as string[] };
  const mk = (status: string, uk: string) => ({ cells: { EU: empty, UK: { stage: "concluded", finding: uk, cites: ["UK1"] }, US_label: { status, finding: "x", cites: ["Z511"] }, US_regulator: empty },
    hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "wait", reason: "" }, reopen_when: [] });
  const has = (d: ReturnType<typeof mk>, re: RegExp) => inv.rubric(d).some((g) => g.hard && re.test(g.problem));
  assert.ok(has(mk("not found", "x"), /status is related_only/));
  assert.ok(!has(mk("related_only", "x"), /status is related_only/));
  assert.ok(has(mk("partial", "MHRA added PSSD and a new boxed warning in the PIL"), /boxed warning is about suicidal thoughts/));
  assert.ok(!has(mk("partial", "MHRA added a boxed warning on suicidal thoughts and the term PSSD"), /boxed warning is about/));
});

test("Evaluator rubric (QA round 2): EU 4.8 and U.S. postmarketing are the same level; 'the U.S. lacks it' cannot be the main cause; absence cannot prop up a holding explanation; a 'no action' cell cites its search", () => {
  const inv = new Investigation(q("darolutamide-angioedema"), new Trace("t"), new SqlTool(), new Models());
  inv.exposure = { patients: "15" };
  inv.items.push({ eid: "EU48", column: "EU", source: "eu_procedure_records", authority: "primary", kind: "prac_recommendation", title: "", date: "2026-06-11", section: "", text: "4.8 Undesirable effects: Angioedema, frequency not known", qid: "Q-1" },
    { eid: "NUB62", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_other_section", title: "", date: "2026-09-28", section: "", text: "6.2 Postmarketing: angioedema", qid: "Q-2" },
    { eid: "NF", column: "US_regulator", source: "fda_potential_signal_lists", authority: "primary", kind: "search_without_result", title: "", date: "", section: "", text: "", qid: "Q-3" });
  const empty = { finding: "", cites: [] as string[] };
  const mk = (opt: string, why: string, forIds: string[], uk = { stage: "not_found_in_sources", finding: "x", cites: [] as string[] }) => ({
    cells: { EU: { stage: "concluded", finding: "x", cites: ["EU48"] }, UK: uk, US_label: { status: "partial", finding: "x", cites: ["NUB62"] }, US_regulator: { stage: "concluded", finding: "x", cites: ["NUB62"] } },
    hypotheses: [{ id: "H1", name: "h1", verdict: "holds", role: "main", rank: 1, why, for: forIds, against: [] }],
    why: { type: "", sentence: "s", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: opt, reason: "" }, reopen_when: [] });
  const has = (d: ReturnType<typeof mk>, re: RegExp) => inv.rubric(d).some((g) => g.hard && re.test(g.problem));
  assert.ok(has(mk("propose", "both list it", ["EU48"]), /same level/), "parity: propose needs another reason");
  assert.ok(!has(mk("already_covered", "both list it", ["EU48"]), /Already covered/), "same section level (EU 4.8, U.S. Adverse Reactions): already covered is allowed");
  assert.ok(has(mk("already_covered", "EU signal not replicated: FDA has not detected it", ["EU48"]), /main cause .* lacks it/));
  assert.ok(has(mk("already_covered", "both list it", ["EU48", "NF"]), /Held partly on a search that found nothing/), "one empty search among the records is enough to fail");
  assert.ok(has(mk("already_covered", "both list it", ["EU48"]), /No citation for: UK/), "a 'not found' UK cell must cite its search");
});

test("Skeptic direction check is a coverage check: a record filed for an explanation that the Skeptic reads as showing it false is caught, and the Evaluator model can overrule it with a reason that the trace keeps", async () => {
  const run = async (rebut: "send_back" | "overrule") => {
    class Script extends Models {
      async chat(...a: Parameters<Models["chat"]>) {
        const r = await super.chat(...a); const tag = a[2].tag;
        if (tag.startsWith("falsify:")) return { ...r, text: JSON.stringify({ claims: [1, 2, 3, 4, 5].map((n) => ({ n, judgement: "supports", why: "scripted: the claim follows from its record" })),
          explanations: [{ h: "H5", records: { A: "shows_true", B: "shows_false" }, why: "scripted: the FDA entry shows it; the EU record speaks against it" }] }) };
        if (tag.startsWith("eval:")) return { ...r, text: '{"verdict":"approve","feedback":"scripted"}' };
        if (tag.startsWith("rebut:")) { // answers every coverage check the same way
          return { ...r, text: JSON.stringify({ replies: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, decision: rebut, reason: "scripted: the EU record is the other side of the difference, filed for the explanation's claim that the stages differ" })) }) }; }
        return r;
      }
    }
    const t = new Trace("t");
    const inv = new Investigation(q("semaglutide-naion"), t, new SqlTool(), new Script());
    const v = valid(inv);
    const r = await inv.evaluate(v.draft({ hypotheses: [1, 2, 3, 4].map((n) => v.open(`H${n}`)).concat([v.holds("H5", ["A", "B"])]) }) as never, 1);
    return { r, inv, t };
  };
  const caught = await run("send_back");
  assert.deepEqual(caught.inv.falsifications.at(-1)!.reversed, ["H5: B is filed for it but shows it is not the case"], "the reversed filing is found from the Skeptic's reading of each record (true positive)");
  assert.ok(caught.r.gaps.some((g) => !g.hard && /other way round/.test(g.problem)), "as a coverage check, not a must-hold one");
  assert.deepEqual(caught.r.gaps.filter((g) => g.hard).map((g) => g.problem), [], "nothing else fails: the draft is otherwise valid");
  assert.equal(caught.r.v.verdict, "revise", "the model accepted it: sent back");
  const overruled = await run("overrule");
  assert.equal(overruled.r.v.verdict, "approve", "the model overruled it with a reason: not escalated on that alone");
  const ev = overruled.t.events.find((e) => e.agent === "evaluator" && e.kind === "approve")!.detail as { reply: { reason: string }[] };
  assert.match(ev.reply[0].reason, /other side of the difference/, "the overrule reason is in the trace");
});

// ---------------- QA round 3: truncation, rule consistency, the revision loop and the Writer that argues ----------------
test("Skeptic sees the record around the quoted words, never a blind cut: a sentence 2,300 characters into a 5,000-character section is shown", async () => {
  const { recordView } = await import("../app/agents.ts");
  const row = emu.run("SELECT text FROM aprime_lab.spl_section WHERE product = 'Prozac' AND path = '6 ADVERSE REACTIONS > 6.1 Clinical Trials Experience > SPL UNCLASSIFIED SECTION'", "agent").data.map((r) => String(r[0])).find((t) => t.includes("occasionally persist"))!;
  const at = row.indexOf("Symptoms of sexual dysfunction occasionally persist");
  assert.ok(row.length > 4000 && at > 2000, `the sentence sits ${at} characters into ${row.length}`);
  const view = recordView(row, "Symptoms of sexual dysfunction occasionally persist after discontinuation of fluoxetine treatment.", ["persist"]);
  assert.ok(view.includes("occasionally persist after discontinuation"));
  // and through the Skeptic itself: the claim judge's prompt carries that sentence
  const prompts: string[] = [];
  class Spy extends Models { async chat(...a: Parameters<Models["chat"]>) { if (a[2].tag.startsWith("falsify:")) prompts.push(a[1]); return super.chat(...a); } }
  const inv = new Investigation(q("sertraline-pssd"), new Trace("t"), new SqlTool(), new Spy());
  inv.terms = ["persist"];
  inv.items.push({ eid: "SPL-Prozac-v59-6-1qmx", column: "US_label", source: "us_label_class_members", authority: "primary", kind: "label_other_section", title: "Prozac", date: "", section: "", qid: "Q-1",
    text: "Symptoms of sexual dysfunction occasionally persist after discontinuation of fluoxetine treatment.", meta: { product: "Prozac", path: "6 ADVERSE REACTIONS > 6.1 Clinical Trials Experience > SPL UNCLASSIFIED SECTION", version: "59" } });
  const empty = { finding: "", cites: [] as string[] };
  await inv.falsify({ cells: { EU: empty, UK: empty, US_label: { status: "related_only", finding: "Prozac notes persistence after stopping", cites: ["SPL-Prozac-v59-6-1qmx"] }, US_regulator: empty },
    hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "wait", reason: "" }, reopen_when: [] } as never, 1);
  assert.ok(prompts[0].includes("occasionally persist after discontinuation"), "the Skeptic is shown the sentence it judges");
});

test("rule consistency: a change a check asked for is a correction, not a flip; an unasked change with no new record is still refused", () => {
  const inv = new Investigation(q("darolutamide-angioedema"), new Trace("t"), new SqlTool(), new Models());
  inv.exposure = { patients: "15" };
  inv.items.push({ eid: "E", column: "EU", source: "x", authority: "primary", kind: "prac_recommendation", title: "", date: "2026-06-11", section: "", text: "4.4 warning", qid: "Q-1" });
  const empty = { finding: "", cites: [] as string[] };
  const d = { cells: { EU: { stage: "concluded", finding: "x", cites: ["E"] }, UK: empty, US_label: empty, US_regulator: empty }, hypotheses: [], why: { type: "", sentence: "", cites: [], reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "no_action", reason: "" }, reopen_when: [] };
  const changed = () => inv.rubric(d as never).some((g) => /recommendation changed/.test(g.problem));
  inv.curRound = 2; inv.prevOption = "propose"; inv.prevCites = new Set(["E"]);
  inv.askedText = "A new in-house reminder needs a reason beyond a label difference; otherwise recommend already covered or no action.";
  assert.equal(changed(), false, "the check asked for it");
  inv.askedText = "";
  assert.equal(changed(), true, "nobody asked and no new record");
});

test("rule consistency: a verdict a check named may change without a new record (case state)", async () => {
  const cs = new CaseState("t", true);
  await cs.hypotheses([{ id: "H2", name: "class_effect", test: "" }], 1);
  await cs.verdicts([{ id: "H2", name: "class_effect", verdict: "ruled_out", for: [], against: ["A"] }], 1);
  await cs.verdicts([{ id: "H2", name: "class_effect", verdict: "holds", for: ["A"], against: [] }], 2);
  assert.equal(cs.flipFlops(new Set()).length, 1);
  assert.equal(cs.flipFlops(new Set(), new Set(["H2"])).length, 0);
});

// a scripted loop: the Writer argues, the Skeptic and the checks decide
type Script = { write: () => object; repair: (n: number) => object; falsify: () => object; evaluate: () => object };
type G = { column: string; hard: boolean; problem: string; want: string[] };
const scripted = (sc: Script, rubric?: (inv: Investigation, d: unknown) => G[]) => {
  const prompts: Record<string, string[]> = {};
  let repairs = 0;
  class S extends Models {
    async chat(...a: Parameters<Models["chat"]>) {
      const r = await super.chat(...a); const tag = a[2].tag.split(":")[0]; (prompts[tag] ??= []).push(a[1]);
      const text = tag === "write" ? sc.write() : tag === "repair" ? sc.repair(++repairs) : tag === "falsify" ? sc.falsify() : tag === "eval" ? sc.evaluate() : tag === "rebut" ? { replies: [] } : tag === "replan" ? { add_sources: [], reason: "scripted" } : undefined;
      return text ? { ...r, text: JSON.stringify(text) } : r;
    }
  }
  const inv = new Investigation({ id: "t-argue", substance: "semaglutide", reaction: "NAION", label: "t" }, new Trace("t"), new SqlTool(), new S());
  if (rubric) inv.rubric = (d) => rubric(inv, d) as never;
  return { inv, prompts };
};
const D = (claim: string, extra: object = {}) => ({ cells: { EU: { stage: "concluded", finding: claim, cites: ["EU-SMPC-OZEMPIC-01"] }, UK: { stage: "concluded", finding: "x", cites: [] }, US_label: { status: "not found", finding: "x", cites: [] }, US_regulator: { stage: "under_evaluation", finding: "x", cites: [] } },
  hypotheses: [], why: { type: "x", sentence: "s", reasons: [] }, evidence: { note: "", cites: [] }, recommendation: { option: "propose", reason: "r" }, reopen_when: [], ...extra });
const onlySkeptic = (inv: Investigation): G[] => { const f = inv.falsifications.at(-1); return f?.contradicted.length ? [{ column: "citations", hard: true, problem: `The Skeptic's independent check contradicts: ${f.contradicted.join("; ")}.`, want: [] }] : []; };
const smpc = () => emu.run("SELECT p.text FROM aprime_lab.reg_passage p WHERE p.passage_id = 'EU-SMPC-OZEMPIC-01'", "agent").data[0][0] as string;

test("a Writer that argues with a made-up quote: every dispute is refused, the claim stays contradicted, and after three repairs it goes to a person", async () => {
  const { inv } = scripted({ write: () => D("EU says NAION is common"), evaluate: () => ({ verdict: "revise", feedback: "scripted" }),
    repair: () => ({ replies: [{ n: 1, action: "disputed", record_ids: ["EU-SMPC-OZEMPIC-01"], quote: "NAION is a common side effect in every patient", reason: "I am sure the SmPC says it is common" }], draft: D("EU says NAION is common") }),
    falsify: () => ({ claims: [{ n: 1, judgement: "contradicts", direction: "ok", why: "the SmPC says very rare" }] }) }, onlySkeptic);
  inv.items.push({ eid: "EU-SMPC-OZEMPIC-01", column: "EU", source: "eu_product_information", authority: "primary", kind: "smpc", title: "SmPC", date: "", section: "4.4", text: smpc(), qid: "Q-0", meta: { passage_id: "EU-SMPC-OZEMPIC-01" } });
  const o = await inv.run();
  assert.equal(o.status, "needs-person"); assert.equal(o.rounds, 5);
  assert.ok(o.disputes!.length === 3 && o.disputes!.every((x) => !x.accepted && /quoted words are not in the cited records/.test(x.why)));
});

test("a Writer that argues with a real quote from an unrelated part of the record: the dispute is verified but the Skeptic, shown only the records, still contradicts; it goes to a person", async () => {
  const quote = smpc().slice(0, 60);
  const { inv, prompts } = scripted({ write: () => D("EU says NAION is common"), evaluate: () => ({ verdict: "revise", feedback: "scripted" }),
    repair: () => ({ replies: [{ n: 1, action: "disputed", record_ids: ["EU-SMPC-OZEMPIC-01"], quote, reason: "ARGUMENT-TEXT-THE-SKEPTIC-MUST-NOT-SEE" }], draft: D("EU says NAION is common") }),
    falsify: () => ({ claims: [{ n: 1, judgement: "contradicts", direction: "ok", why: "the SmPC says very rare" }] }) }, onlySkeptic);
  inv.items.push({ eid: "EU-SMPC-OZEMPIC-01", column: "EU", source: "eu_product_information", authority: "primary", kind: "smpc", title: "SmPC", date: "", section: "4.4", text: smpc(), qid: "Q-0", meta: { passage_id: "EU-SMPC-OZEMPIC-01" } });
  const o = await inv.run();
  assert.equal(o.status, "needs-person"); assert.equal(o.rounds, 5);
  assert.ok(o.disputes!.some((x) => x.accepted), "the quote is real, so the dispute itself is verified");
  assert.ok(prompts.falsify.every((p) => !p.includes("ARGUMENT-TEXT-THE-SKEPTIC-MUST-NOT-SEE")), "the Skeptic never sees the Writer's argument");
  assert.ok(prompts.eval.some((p) => p.includes("drafting agent's claims, not evidence")), "the Evaluator sees it marked as the drafting agent's claim");
});

test("a must-hold check cannot be argued away: a dispute without changing the draft fails the check again; after three repairs it goes to a person", async () => {
  const H = [{ id: "H1", name: "h1", verdict: "ruled_out", why: "x", for: [], against: [] }];
  const { inv } = scripted({ write: () => D("x", { hypotheses: H }), evaluate: () => ({ verdict: "approve", feedback: "scripted" }), falsify: () => ({ claims: [{ n: 1, judgement: "supports", direction: "ok", why: "ok" }] }),
    repair: () => ({ replies: [{ n: 1, action: "disputed", record_ids: ["EU-SMPC-OZEMPIC-01"], quote: "x", reason: "it is obviously ruled out" }], draft: D("x", { hypotheses: H }) }) },
    (inv, d) => Investigation.prototype.rubric.call(inv, d as never).filter((g) => /Ruled out with no record against it/.test(g.problem)));
  const o = await inv.run();
  assert.equal(o.status, "needs-person"); assert.equal(o.rounds, 5);
});

test("a true correction is approved without using all three repairs", async () => {
  const { inv } = scripted({ write: () => D("EU says NAION is common"), evaluate: () => ({ verdict: "approve", feedback: "scripted" }),
    repair: () => ({ replies: [{ n: 1, action: "fixed", reason: "corrected to very rare" }], draft: D("EU says NAION is very rare") }),
    falsify: () => ({ claims: [{ n: 1, judgement: "supports", direction: "ok", why: "ok" }] }) },
    (inv) => inv.falsifications.length < 3 ? [{ column: "citations", hard: true, problem: "The Skeptic's independent check contradicts: scripted.", want: [] }] : []);
  const o = await inv.run();
  assert.equal(o.status, "approved"); assert.equal(o.rounds, 3);
});

// ---------------- QA round 4: one set of general rules (no drug names): hard checks, schema, consistency, the deadlock ----------------
const hardOf = (inv: Investigation, d: unknown) => inv.rubric(d as never).filter((g) => g.hard).map((g) => g.problem);
const fresh = (id = "semaglutide-naion") => { const inv = new Investigation(q(id), new Trace("t"), new SqlTool(), new Models()); return { inv, v: valid(inv) }; };

test("QA4 hard checks the model cannot overrule: the drug's own label not read; a U.S. label cell that cites an FDA list entry instead of the label (R160); a status outside the schema; a joined why type", async () => {
  const { inv, v } = fresh();
  assert.deepEqual(hardOf(inv, v.draft()), [], "the starting draft passes every must-hold check");
  inv.tried.delete("us_label_sections");
  assert.ok(hardOf(inv, v.draft()).some((p) => /own U.S. label was not read/.test(p)), "not reading the label is a must-hold check now");
  inv.tried.add("us_label_sections");
  const r160 = v.draft(); r160.cells.US_label = { status: "no_action_by_fda", finding: "The FDA took no action.", cites: ["A"] };
  const h = hardOf(inv, r160);
  assert.ok(h.some((p) => /does not cite semaglutide's own label/.test(p)), "an FDA list entry is not the label");
  assert.ok(h.some((p) => /Values outside the allowed lists: U\.S\. label status "no_action_by_fda"/.test(p)), "an unknown status is sent back, not passed through");
  const joined = v.draft({ why: { type: "different_stage+different_evidence", sentence: "s", cites: ["A", "B"], reasons: [{ type: "different_stage+different_evidence", claim: "c", cites: ["A", "B"] }] } });
  assert.ok(hardOf(inv, joined).some((p) => /why type "different_stage\+different_evidence"/.test(p)), "one type per reason");
  const n = (inv as unknown as { normalize: (x: unknown) => { why: { type: string } } }).normalize(v.draft({ why: { type: "x", sentence: "s", cites: [], reasons: [{ type: "Different stage", claim: "main", cites: ["A"] }, { type: "different_evidence", claim: "second", cites: ["B"] }] } }));
  assert.equal(n.why.type, "different_stage", "the why type is the main cause's type, not the reasons joined");
  // a scripted Evaluator that approves and overrules everything still cannot approve it
  class Approve extends Models { async chat(...a: Parameters<Models["chat"]>) { const r = await super.chat(...a); const t = a[2].tag;
    return t.startsWith("falsify:") ? { ...r, text: '{"claims":[{"n":1,"judgement":"supports","why":"scripted"}]}' } : t.startsWith("eval:") ? { ...r, text: '{"verdict":"approve","feedback":"scripted"}' }
      : t.startsWith("rebut:") ? { ...r, text: JSON.stringify({ replies: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, decision: "overrule", reason: "scripted" })) }) } : r; } }
  const inv2 = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new Approve()); const v2 = valid(inv2);
  inv2.tried.delete("us_label_sections");
  const e = await inv2.evaluate(v2.draft() as never, 1);
  assert.equal(e.v.verdict, "revise"); assert.equal(e.v.decidedBy, "checks (must-hold)");
});

test("QA4 the empty-search rule covers the why: a reason or a why sentence citing a search that found nothing is sent back (sertraline); an undetermined why may cite it for where a regulator stands", () => {
  const { inv, v } = fresh();
  const re = /why rests partly on a search that found nothing/;
  assert.ok(hardOf(inv, v.draft({ why: { type: "different_stage", sentence: "The FDA has not identified a signal.", cites: ["FDANF"], reasons: [{ type: "different_stage", claim: "The FDA has not identified a signal.", cites: ["B", "FDANF"] }] } })).some((p) => re.test(p)), "a reason on an empty search");
  assert.ok(hardOf(inv, v.draft({ why: { type: "different_stage", sentence: "s", cites: ["A", "B", "FDANF"], reasons: [{ type: "different_stage", claim: "c", cites: ["A", "B"] }] } })).some((p) => re.test(p)), "the why sentence on an empty search");
  const und = v.draft({ hypotheses: [v.open("H1"), v.open("H2")], why: { type: "undetermined", sentence: "PRAC concluded in 2025 and the FDA records show no public action; the public records do not show why they differ.", cites: ["B", "FDANF"], reasons: [] } });
  assert.deepEqual(hardOf(inv, und), [], "undetermined: no cause claimed, so citing the empty search for the FDA's stage is allowed");
});

test("QA4 consistency between the explanation and the cells: us_earlier while the U.S. says nothing (semaglutide); 'the U.S. label already lists it' against a 'not found' label; the U.S. label warned before the EU first acted (gemcitabine)", () => {
  const { inv, v } = fresh();
  const usEarlier = v.draft({ why: { type: "different_stage", sentence: "s", cites: ["A", "B"], reasons: [{ type: "different_stage", claim: "c", cites: ["A", "B"] }, { type: "us_earlier", claim: "The FDA flagged the class first.", cites: ["A"] }] } });
  assert.ok(hardOf(inv, usEarlier).some((p) => /contradicts the cells: why type us_earlier/.test(p)));
  const says = v.draft({ hypotheses: [{ ...v.holds("H1", ["A", "B"]), why: "The U.S. label already lists it in section 6." }] });
  assert.ok(hardOf(inv, says).some((p) => /H1 says the U\.S\. already has it/.test(p)));
  const negated = v.draft({ hypotheses: [{ ...v.holds("H1", ["A", "B"]), why: "The U.S. label does not list it; PRAC concluded while the FDA is evaluating." }] });
  assert.deepEqual(hardOf(inv, negated), [], "a negated sentence is not such a claim");
  // the drug's own label warned (a warning section, 2024) before the first EU record (2025): the U.S. was first
  inv.items.push({ eid: "W", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "2024-05-01", section: "5.3", text: "DRESS", qid: "Q-W" });
  const first = (type: string) => v.draft({ cells: { ...v.draft().cells, US_label: { status: "written", finding: "Warnings and Precautions 5.3 name it.", cites: ["W"] }, US_regulator: { stage: "concluded", finding: "The FDA approved the label.", cites: ["W"] } },
    hypotheses: [{ ...v.holds("H1", ["W", "B"]), why: "The U.S. label warned before the EU acted." }], recommendation: { option: "already_covered", reason: "The label warns." },
    why: { type, sentence: "s", cites: ["W", "B"], reasons: [{ type, claim: "c", cites: ["W", "B"] }] } });
  assert.ok(hardOf(inv, first("different_stage")).some((p) => /U\.S\. had it first .*us_earlier/.test(p)), "the main cause must say the U.S. was first");
  assert.deepEqual(hardOf(inv, first("us_earlier")), []);
});

test("QA4 deadlock (valproate shape): 'no explanation holds' and 'cannot hold on an empty search' never ask for opposite things; following either message reaches an undetermined why that passes", async () => {
  const { inv, v } = fresh("valproate-paternal");
  const cells = { ...v.draft().cells, US_regulator: { stage: "no_public_action_found", finding: "No FDA record names it.", cites: ["FDANF"] } };
  const fdaHasNot = { id: "H6", name: "fda_has_not_acted", verdict: "holds", role: "main", rank: 1, why: "The FDA has not acted.", for: ["FDANF"], against: [] as string[] };
  // 1. the explanation that holds rests on the empty search: sent back, and the message says "judge it open"
  const s1 = v.draft({ cells, hypotheses: [v.open("H1"), fdaHasNot], why: { type: "different_stage", sentence: "The main reason is that the FDA has not acted.", cites: ["FDANF"], reasons: [{ type: "different_stage", claim: "The FDA has not acted.", cites: ["FDANF"] }] } });
  assert.ok(hardOf(inv, s1).some((p) => /Held partly on a search that found nothing.*judge it open/.test(p)));
  // 2. the Writer judges it open but keeps the reason: sent back, and the message says "make the why undetermined"
  const s2 = { ...s1, hypotheses: [v.open("H1"), { ...fdaHasNot, verdict: "open", role: undefined, rank: undefined }] };
  const g2 = hardOf(inv, s2);
  assert.ok(g2.some((p) => /No explanation is judged to hold.*make the why undetermined/.test(p)));
  assert.ok(!g2.some((p) => /Add the explanation the records show|already says it/.test(p)), "no message asks for an explanation to hold again (the old wrong-way example is gone)");
  // 3. undetermined, no reason, no cause claimed: passes
  const s3 = { ...s2, why: { type: "undetermined", sentence: "The EU and the UK acted; the FDA records show no public action; the public records do not show why they differ.", cites: ["B", "FDANF"], reasons: [] } };
  assert.deepEqual(hardOf(inv, s3), []);
  // ruled out with the record moved to "for" (the Skeptic read it the other way): the message says "judge it open", which passes
  const s4 = { ...s3, hypotheses: [v.open("H1"), { id: "H2", name: "uk_aligned", verdict: "ruled_out", why: "x", for: ["UK1"], against: [] as string[] }] };
  assert.ok(hardOf(inv, s4).some((p) => /Ruled out with no record against it.*judge it open/.test(p)));
  assert.deepEqual(hardOf(inv, { ...s4, hypotheses: [v.open("H1"), { ...s4.hypotheses[1], verdict: "open" }] }), []);
  // an undetermined why that still claims a cause, or with an explanation that holds, is not undetermined
  assert.ok(hardOf(inv, { ...s3, why: { ...s3.why, sentence: "They differ because the FDA has not acted." } }).some((p) => /undetermined why claims no cause/.test(p)));
  assert.ok(hardOf(inv, { ...s3, hypotheses: [v.holds("H1", ["A", "B"])] }).some((p) => /cause cannot be determined, yet H1 hold/.test(p)));
  // and the Evaluator approves the undetermined draft when the model approves (nothing for it to overrule)
  class Approve extends Models { async chat(...a: Parameters<Models["chat"]>) { const r = await super.chat(...a); const t = a[2].tag;
    return t.startsWith("falsify:") ? { ...r, text: JSON.stringify({ claims: [1, 2, 3, 4].map((n) => ({ n, judgement: "supports", why: "scripted" })) }) } : t.startsWith("eval:") ? { ...r, text: '{"verdict":"approve","feedback":"scripted"}' }
      : t.startsWith("rebut:") ? { ...r, text: JSON.stringify({ replies: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, decision: "overrule", reason: "scripted" })) }) } : r; } }
  const inv2 = new Investigation(q("valproate-paternal"), new Trace("t"), new SqlTool(), new Approve()); valid(inv2);
  const e = await inv2.evaluate(s3 as never, 1);
  assert.equal(e.v.verdict, "approve", "a valid conclusion: the facts are right and no cause is claimed");
});

test("QA4 every explanation that holds needs a record that shows it, and every ruled-out one a record that shows it is not the case (the Skeptic reads each record about the explanation itself; silence is not against)", async () => {
  const run = async (records: Record<string, string>, hyp: Record<string, unknown>, extra: object = {}) => {
    class S extends Models { async chat(...a: Parameters<Models["chat"]>) { const r = await super.chat(...a); const t = a[2].tag;
      return t.startsWith("falsify:") ? { ...r, text: JSON.stringify({ claims: [1, 2, 3, 4, 5].map((n) => ({ n, judgement: "supports", why: "ok" })), explanations: [{ h: "H1", records, why: "scripted" }] }) }
        : t.startsWith("eval:") ? { ...r, text: '{"verdict":"approve","feedback":"scripted"}' } : t.startsWith("rebut:") ? { ...r, text: '{"replies":[]}' } : r; } }
    const inv = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new S()); const v = valid(inv);
    return (await inv.evaluate(v.draft({ hypotheses: [hyp], ...extra }) as never, 1)).gaps.filter((g) => g.hard).map((g) => g.problem);
  };
  const { v } = fresh();
  assert.ok((await run({ A: "silent", B: "silent" }, v.holds("H1", ["A", "B"]))).some((p) => /hold that no cited record shows .*H1 \(main cause\)/.test(p)), "an inference no record states (semaglutide H3, H5)");
  assert.deepEqual(await run({ A: "shows_true", B: "silent" }, v.holds("H1", ["A", "B"])), [], "one record that shows it is enough");
  const out = { id: "H1", name: "different_causality", verdict: "ruled_out", why: "PRAC does not say causality is established", for: [], against: ["B"] };
  const und = { why: { type: "undetermined", sentence: "PRAC concluded; the FDA is evaluating; the public records do not show why they differ.", cites: ["A", "B"], reasons: [] } };
  assert.ok((await run({ B: "silent" }, out, und)).some((p) => /Ruled out, but no record filed against it shows it is false/.test(p)), "ruled out because a record does not mention it (darolutamide H5)");
  assert.deepEqual(await run({ B: "shows_false" }, out, und), []);
});

test("QA4 a finding sent back about what an explanation says is answered only by changing the verdict, a new record, or a verified dispute; rewording or citing the same records again is not an answer (semaglutide)", async () => {
  const { inv, v } = fresh();
  const rec = (o: object = {}) => ({ round: 3, records: 0, verified: 0, contradicted: [], unchecked: 0, claims: 0, claimsSupported: 0, claimsNotEnough: 0, restatesIds: [], unsupportedIds: [], outUnsupportedIds: [], ...o });
  inv.falsifications = [rec()]; inv.curRound = 3;
  inv.carry = { round: 2, hyps: { H1: { verdict: "holds", for: ["A", "B"], against: [] } }, restates: ["H1"], unsupported: [], outUnsupported: [] };
  const reworded = v.draft({ hypotheses: [{ ...v.holds("H1", ["A", "B"]), why: "Reworded: the EU and the FDA are at different stages, as the records show [A, B]." }] });
  assert.ok(hardOf(inv, reworded).some((p) => /Sent back after draft 2 and not answered: H1 still hold/.test(p)), "the Skeptic now says nothing, but the finding was never answered");
  const changed = v.draft({ hypotheses: [{ ...v.holds("H1", ["A", "B"]), verdict: "not_a_cause", role: undefined, rank: undefined }], why: { type: "undetermined", sentence: "PRAC concluded; the FDA is evaluating; the public records do not show why they differ.", cites: ["A", "B"], reasons: [] } });
  assert.deepEqual(hardOf(inv, changed), [], "judged not a cause: answered");
  inv.disputes.push({ round: 3, n: 1, item: "[coverage] Explanations that only restate the difference: H1 (...)", accepted: true, why: "record and quote verified", record_ids: ["A"], quote: "q", reason: "r" });
  const g = inv.rubric(reworded as never).find((x) => /Sent back after draft 2/.test(x.problem))!;
  assert.equal(g.hard, false, "a verified dispute leaves it to the Evaluator model");
  inv.disputes = [];
  inv.carry = { round: 2, hyps: { H1: { verdict: "holds", for: ["A"], against: [] } }, restates: [], unsupported: ["H1"], outUnsupported: [] };
  assert.ok(hardOf(inv, v.draft({ hypotheses: [v.holds("H1", ["A"])] })).some((p) => /still hold with no new record/.test(p)), "the same record again");
  assert.ok(!hardOf(inv, v.draft({ hypotheses: [v.holds("H1", ["A", "B"])] })).some((p) => /Sent back after/.test(p)), "a new record for it: the Skeptic judges it again");
  // evaluate() remembers what it sent back
  class S extends Models { async chat(...a: Parameters<Models["chat"]>) { const r = await super.chat(...a); const t = a[2].tag;
    return t.startsWith("falsify:") ? { ...r, text: JSON.stringify({ claims: [1, 2, 3, 4, 5].map((n) => ({ n, judgement: "supports", why: "ok" })), explanations: [{ h: "H1", records: { A: "shows_true" }, restates: true, why: "restates" }] }) }
      : t.startsWith("eval:") ? { ...r, text: '{"verdict":"revise","feedback":"scripted"}' } : r; } }
  const inv2 = new Investigation(q("semaglutide-naion"), new Trace("t"), new SqlTool(), new S()); const v2 = valid(inv2);
  await inv2.evaluate(v2.draft() as never, 2);
  assert.deepEqual(inv2.carry?.restates, ["H1"]);
});

test("QA4 dates are checked against the record each sentence cites ('June 2025' per a record with no date); already covered is judged by section level (EU 4.8 with U.S. Adverse Reactions; not an EU warning)", () => {
  const { inv, v } = fresh();
  inv.items.push({ eid: "EPAR", column: "EU", source: "eu_procedure_records", authority: "primary", kind: "epar", title: "", date: "", section: "", text: "Studies suggest an increased risk.", qid: "Q-E" });
  const h2 = (cites: string[]) => v.draft({ hypotheses: [v.holds("H1", ["A", "B"]), { id: "H2", name: "timing", verdict: "open", why: "PRAC concluded in June 2025 per EPAR.", for: cites, against: [] }] });
  assert.ok(hardOf(inv, h2(["EPAR"])).some((p) => /June 2025 \(H2; it is in B, which it does not cite\)/.test(p)), "the date is in another record, not the one the sentence cites, and the message says which");
  assert.deepEqual(hardOf(inv, h2(["B"])), [], "the cited record has it (2025-06)");
  const { inv: d, v: dv } = fresh("darolutamide-angioedema");
  d.items.push({ eid: "EU48", column: "EU", source: "eu_procedure_records", authority: "primary", kind: "smpc", title: "", date: "2026-06-11", section: "", text: "4.8 Undesirable effects: Angioedema, frequency not known", qid: "Q-1" },
    { eid: "EU44", column: "EU", source: "eu_procedure_records", authority: "primary", kind: "smpc", title: "", date: "2026-06-11", section: "", text: "4.4 Special warnings: angioedema", qid: "Q-2" },
    { eid: "NUB62", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_other_section", title: "", date: "2026-09-28", section: "", text: "6.2 Postmarketing: angioedema", qid: "Q-3" });
  const covered = (eu: string, us: string[]) => hardOf(d, dv.draft({ cells: { ...dv.draft().cells, EU: { stage: "concluded", finding: "PRAC added it.", cites: [eu] }, US_label: { status: "partial", finding: "Postmarketing lists it.", cites: us }, US_regulator: { stage: "concluded", finding: "The FDA approved the label.", cites: us } },
    hypotheses: [{ ...dv.holds("H1", [eu, ...us]), name: "same_position", why: "Both labels list it at the same level." }], why: { type: "same_position", sentence: "s", cites: [eu, ...us], reasons: [{ type: "same_position", claim: "c", cites: [eu, ...us] }] }, recommendation: { option: "already_covered", reason: "The label lists it." } }))
    .filter((p) => /Already covered/.test(p));
  assert.deepEqual(covered("EU48", ["NUB62"]), [], "EU 4.8 and U.S. Adverse Reactions: the same level");
  assert.equal(covered("EU44", ["NUB62"]).length, 1, "an EU warning needs a U.S. warning");
  assert.equal(covered("EU48", ["LBL"]).length, 1, "the cell must cite the label section that says it");
});

test("QA4 scope: the product sends meterless-scope user; only a recording or an evaluation sends a fresh iso scope; the headers are logged as sent with the token masked", async () => {
  const { isoScopes, sendLogged } = await import("../app/llm.ts");
  const { createServer } = await import("node:http");
  const { mkdtempSync } = await import("node:fs"); const os = await import("node:os");
  const before = process.env.METERLESS_SCOPE;
  delete process.env.METERLESS_SCOPE; assert.equal(isoScopes(), false, "default (not recording): the contract's user");
  process.env.METERLESS_SCOPE = "iso"; assert.equal(isoScopes(), true, "an evaluation run asks for iso");
  if (before === undefined) delete process.env.METERLESS_SCOPE; else process.env.METERLESS_SCOPE = before;
  const seen: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => { seen.push(req.headers); res.end("{}"); }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "hdr-")), "sent.jsonl"); process.env.APRIME_HEADER_LOG = log;
  await (await sendLogged(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer test-token-value-123", "meterless-app": "aprime-why-labels-differ", "meterless-scope": "user" }, body: "{}" }, "t:1")).text();
  srv.close(); delete process.env.APRIME_HEADER_LOG;
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(seen[0]["meterless-scope"], "user"); assert.equal(line.headers["meterless-scope"], "user", "the log has the header the server received");
  assert.equal(line.headers.Authorization, "Bearer <masked>"); assert.ok(!readFileSync(log, "utf8").includes("test-token-value-123"));
});

// ---------------- QA round 5: undetermined is checked against what the checkers read, and by meaning, not two words ----------------
test("QA5 a why cannot be undetermined while the Skeptic reads an explanation as a cause with a record that shows it (semaglutide H4)", async () => {
  const { skepticCauses } = await import("../app/agents.ts");
  const { inv, v } = fresh();
  const und = v.draft({ hypotheses: [{ ...v.holds("H4", ["A"]), verdict: "not_a_cause", role: undefined, rank: undefined }], why: { type: "undetermined", sentence: "PRAC concluded; the FDA is evaluating; the public records do not show why they differ.", cites: ["A", "B"], reasons: [] } });
  const reply = { claims: [], explanations: [{ h: "H4", records: { A: "shows_true" }, restates: false, why: "a distinct regulatory status" }] };
  assert.deepEqual(skepticCauses(reply, und as never), [{ hid: "H4", records: ["A"] }]);
  inv.falsifications = [{ round: 1, records: 0, verified: 0, contradicted: [], unchecked: 0, claims: 0, claimsSupported: 0, claimsNotEnough: 0, causes: skepticCauses(reply, und as never) }];
  assert.ok(hardOf(inv, und).some((p) => /cause cannot be determined, but the Skeptic reads H4 as a cause of the difference, shown by A/.test(p)));
  inv.falsifications = [{ round: 1, records: 0, verified: 0, contradicted: [], unchecked: 0, claims: 0, claimsSupported: 0, claimsNotEnough: 0, causes: skepticCauses({ explanations: [{ h: "H4", records: { A: "shows_true" }, restates: true }] }, und as never) }];
  assert.deepEqual(hardOf(inv, und), [], "a record read as a restatement of the difference is not a cause");
});

test("QA5 an undetermined why is checked for a named cause by meaning: 'The main reason is undetermined because the records do not explain why' passes (darolutamide); 'because the FDA has not acted' does not", async () => {
  const { namedCause } = await import("../app/agents.ts");
  assert.equal(namedCause("The main reason is undetermined because the public records show where each regulator stands but do not explain why they differ."), "");
  assert.equal(namedCause("The reason for the divergence is undetermined. The EU concluded, while the FDA lists it."), "");
  assert.match(namedCause("They differ because the FDA has not acted."), /because the FDA has not acted/);
  assert.match(namedCause("The main reason is that the FDA is still evaluating."), /main reason is that the FDA/);
  const { inv, v } = fresh();
  const und = (sentence: string) => v.draft({ hypotheses: [v.open("H1")], why: { type: "undetermined", sentence, cites: ["A", "B"], reasons: [] } });
  assert.deepEqual(hardOf(inv, und("The main reason is undetermined because the public records show where each regulator stands but do not explain why they differ.")), []);
  assert.ok(hardOf(inv, und("They differ because the FDA has not acted.")).some((p) => /names one \("because the FDA has not acted"\)/.test(p)), "the message says which words name the cause");
});

// ---------------- after QA round 5: a cell's status cannot drift, and a section read as the same reaction is named ----------------
test("QA5 a cell's status may not change between rounds with no new record and no check asking (R161: partial became related only by itself)", async () => {
  const { askedColumns } = await import("../app/agents.ts");
  const { inv, v } = fresh();
  inv.items.push({ eid: "SEC62", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_other_section", title: "", date: "2026-03-02", section: "6.2", text: "Gastrointestinal disorders: Immune-mediated colitis", qid: "Q-62", round: 1 });
  const cell = (status: string) => v.draft({ cells: { ...v.draft().cells, US_label: { status, finding: "6.2 lists immune-mediated colitis.", cites: ["SEC62", "LBL"] } } });
  // what round 1 sent back (the R161 recording): EU citations, the why type (with the schema's list of values), the FDA stage
  inv.curRound = 2; inv.prevCells = { US_label: "partial" };
  inv.askedText = 'No citation for: EU (EMA / PRAC). Values outside the allowed lists: why type "unclear". Stage: concluded | agreed_with_noted_conflict | under_evaluation | no_public_action_found | not_found_in_sources. U.S. label status: written | partial | related_only | not found. Why type, one per reason: different_stage | different_evidence | different_scope | us_earlier | same_position (or undetermined, with no reason). Recommendation: propose | wait | no_action | already_covered. Revise US_regulator stage.';
  assert.ok(!askedColumns(inv.askedText).has("US_label"), "the list of allowed values does not count as asking about the U.S. label");
  assert.ok(hardOf(inv, cell("related_only")).some((p) => /U\.S\. label status changed from "partial" to "related_only" with no new record/.test(p)));
  assert.ok(!hardOf(inv, cell("partial")).some((p) => /changed from/.test(p)), "unchanged: nothing to explain");
  inv.askedText = "The U.S. label cell says partial, but the cited section names a narrower form.";
  assert.ok(!hardOf(inv, cell("related_only")).some((p) => /changed from/.test(p)), "a check that named the U.S. label asked for it: a correction");
  inv.askedText = "";
  inv.items.push({ eid: "SEC5", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_warning_section", title: "", date: "2026-03-02", section: "5.4", text: "colitis", qid: "Q-5", round: 2 });
  const withNew = v.draft({ cells: { ...v.draft().cells, US_label: { status: "written", finding: "5.4 names colitis.", cites: ["SEC5", "LBL"] } } });
  assert.ok(!hardOf(inv, withNew).some((p) => /changed from/.test(p)), "a record Research found this round may change it");
});

test("QA5 a label section the Skeptic's sweep read as the same reaction cannot be 'related only' or 'not found' (R161)", () => {
  const { inv, v } = fresh();
  inv.items.push({ eid: "SEC62", column: "US_label", source: "us_label_sections", authority: "primary", kind: "label_other_section", title: "", date: "2026-03-02", section: "6.2", text: "Gastrointestinal disorders: Immune-mediated colitis", qid: "Q-62" });
  inv.sameReaction.add("SEC62");
  const cell = (status: string) => v.draft({ cells: { ...v.draft().cells, US_label: { status, finding: "6.2 lists immune-mediated colitis.", cites: ["SEC62", "LBL"] } } });
  assert.ok(hardOf(inv, cell("related_only")).some((p) => /SEC62, which the Skeptic read as the same reaction, yet says "related_only"/.test(p)));
  assert.ok(hardOf(inv, cell("not found")).some((p) => /read as the same reaction/.test(p)));
  assert.ok(!hardOf(inv, cell("partial")).some((p) => /read as the same reaction/.test(p)));
  inv.sameReaction.clear();
  assert.ok(!hardOf(inv, cell("related_only")).some((p) => /read as the same reaction/.test(p)), "without the Skeptic's reading, the Writer's call stands");
});
