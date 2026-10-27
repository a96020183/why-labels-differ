// One session = one investigation, then the committee's vote, then (only after "propose") counseling points, the
// patient count and the pharmacist-only list, then the reopen conditions. Also: the 2026 reopen replay.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, scrub } from "./config.ts";
import { Trace, traceStats } from "./trace.ts";
import { SqlTool, asObjects, lit } from "./zetaris.ts";
import { Models, jsonWith } from "./llm.ts";
import { Investigation, counsel, unbackedDates, type Outcome } from "./agents.ts";
import type { Question } from "./sources.ts";

const QFILE = JSON.parse(readFileSync(path.join(config.sampleDir, "questions.json"), "utf8"));
export const QUESTIONS: Question[] = QFILE.questions;
/** who records the vote: the same name in the web app and the CLI, so the recorded INSERT is the one replayed */
export const COMMITTEE = "P&T committee";
export const DECISION_DATE: string = process.env.APRIME_DECISION_DATE || QFILE.decision_date;
const COLUMN = { US_label: "U.S. label", US_regulator: "U.S. FDA" } as const;
const likeAny = (col: string, terms: string[]) => "(" + terms.map((t) => `lower(${col}) LIKE ${lit("%" + t + "%")}`).join(" OR ") + ")";

export class Session {
  id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
  dir: string; trace: Trace; sql: SqlTool; models = new Models({ rejudge: config.sampleMode });
  question: Question; phase: "idle" | "investigating" | "awaiting-vote" | "after-vote" | "needs-live" | "error" = "idle";
  outcome?: Outcome; vote?: { option: string; by: string; at: string; decisionId: string };
  afterVote?: Record<string, unknown>; error?: string; inv?: Investigation;
  constructor(q: Question, opts: { live?: boolean } = {}) {
    this.question = q;
    this.dir = path.join(config.runsDir, this.id);
    this.trace = new Trace(this.id, this.dir);
    this.sql = new SqlTool({ mode: opts.live ? "live" : undefined });
  }
  async start() {
    const recorded = QUESTIONS.find((x) => x.id === this.question.id);
    if (config.sampleMode && !(recorded && recorded.substance === this.question.substance && recorded.reaction === this.question.reaction)) { // never show a stub chain as if it were an answer
      this.phase = "needs-live";
      this.trace.emit({ agent: "system", kind: "info", summary: `${this.question.label}: this question was not recorded. Sample mode only replays recorded runs; start the app with SAMPLE_MODE=false (Zetaris + Nightshift running) to investigate it live.` });
      return;
    }
    this.phase = "investigating";
    try {
      this.trace.emit({ agent: "system", kind: "info", summary: `Session started · SQL: ${this.sql.mode === "sample" ? "SAMPLE_MODE (recorded Zetaris answers)" : "live Zetaris"} · models: ${config.sampleMode ? "recorded Nightshift replies" : "Nightshift"}` });
      this.inv = new Investigation(this.question, this.trace, this.sql, this.models, this.dir);
      this.outcome = await this.inv.run();
      this.phase = "awaiting-vote";
      this.trace.emit({ agent: "committee", kind: "info", summary: `Waiting for the P&T committee vote. Recommendation: ${this.outcome.draft.recommendation.option.replace("_", " ")}` });
      this.save();
    } catch (e) {
      this.phase = "error"; this.error = scrub(String((e as Error).stack ?? e));
      this.trace.emit({ agent: "system", kind: "error", summary: this.error.slice(0, 300) });
    }
  }

  /** the committee's vote is written by the pharmacist's own Zetaris identity; agents have no INSERT grant */
  async castVote(option: "propose" | "wait" | "no_action" | "already_covered", by: string) {
    if (!this.outcome) throw new Error("no outcome yet");
    const o = this.outcome, q = this.question;
    // deterministic id and date, so a recorded session replays the exact same SQL (live recording resets the table first)
    const decisionId = `PT-${q.id}-${option}`; // one row per option, so each of the four votes can be recorded
    const at = DECISION_DATE;
    this.vote = { option, by, at, decisionId };
    const ins = `INSERT INTO aprime_lab.pt_decision VALUES (${[decisionId, q.substance.toLowerCase(), q.reaction, option, by, at, o.draft.recommendation.reason.slice(0, 300), q.id].map(lit).join(", ")})`;
    const asAgent = await this.sql.run(ins.replace(decisionId, decisionId + "-agent-try"), "Agent tries to record the decision itself (must be refused)", "committee", "agent");
    const answeredBy = (r: { backend: string }) => r.backend === "emulator" ? "the local emulator (this vote was not recorded against Zetaris)" : "Zetaris";
    this.trace.emit({ agent: "committee", kind: "denied", receipts: [asAgent.receipt.qid], summary: asAgent.ok ? "WARNING: the agent role could write a decision" : `Agent role refused by ${answeredBy(asAgent.receipt)}: ${asAgent.receipt.error?.replace(/^Zetaris: /, "").slice(0, 140)}` });
    const w = await this.sql.run(ins, `Committee decision recorded by ${by}`, "committee", "pharmacist");
    this.trace.emit({ agent: "committee", kind: "vote", receipts: [w.receipt.qid], summary: `Committee voted: ${option.replace("_", " ")} (written by the pharmacist's identity, answered by ${answeredBy(w.receipt)})` });
    const after: Record<string, unknown> = { option };
    if (option === "propose") {
      after.counsel = await counsel(o, this.models, this.trace, this.dir, this.sql);
      const cnt = await this.sql.run(`SELECT dept, sum(patients) AS patients, min(earliest_next_fill) AS next_fill FROM aprime_views.rx_counts WHERE inn = ${lit(q.substance.toLowerCase())} GROUP BY dept ORDER BY patients DESC`, "Patients on the drug by department (aggregate view)", "counsel", "agent");
      after.byDept = asObjects(cnt.result);
      this.trace.emit({ agent: "counsel", kind: "sql", receipts: [cnt.receipt.qid], summary: `Patients by department: ${asObjects(cnt.result).map((r) => `${r.dept} ${r.patients}`).join(", ")}` });
      const listSql = `SELECT mrn, display_name, dept, product, next_fill FROM aprime_views.patient_list WHERE inn = ${lit(q.substance.toLowerCase())} ORDER BY next_fill, mrn LIMIT 25`;
      const asA = await this.sql.run(listSql, "Patient list, asked by the agent role", "counsel", "agent");
      const asP = await this.sql.run(listSql, "Patient list, asked by the pharmacist role", "committee", "pharmacist");
      const rowSql = `SELECT patient_id, inn, dept, next_fill FROM aprime_rx.dispense WHERE inn = ${lit(q.substance.toLowerCase())} ORDER BY next_fill, dispense_id LIMIT 4`;
      const rA = await this.sql.run(rowSql, "Same pharmacy rows, agent role", "counsel", "agent");
      const rP = await this.sql.run(rowSql, "Same pharmacy rows, pharmacist role", "committee", "pharmacist");
      after.identities = {
        list: { agent: { qid: asA.receipt.qid, error: asA.receipt.error }, pharmacist: { qid: asP.receipt.qid, rows: asObjects(asP.result) } },
        rows: { sql: rA.receipt.sql, agent: { qid: rA.receipt.qid, rows: asObjects(rA.result) }, pharmacist: { qid: rP.receipt.qid, rows: asObjects(rP.result) } },
      };
      this.trace.emit({ agent: "committee", kind: "denied", receipts: [asA.receipt.qid, asP.receipt.qid], summary: `Patient list: agent role ${asA.ok ? "GOT ROWS (should not)" : "refused by Zetaris"}; pharmacist role sees the first ${asObjects(asP.result).length} of ${o.exposure?.patients ?? "?"} patients, sorted by next fill` });
      after.conditions = await this.conditions(decisionId);
    } else if (option === "wait") {
      this.trace.emit({ agent: "committee", kind: "info", summary: "Waiting for the U.S.: no reminder and no patient list yet. The decision reopens when one of its conditions comes true." });
      after.conditions = await this.conditions(decisionId);
    } else {
      this.trace.emit({ agent: "committee", kind: "info", summary: "No counseling points, no patient list: the committee did not propose an in-house reminder." });
    }
    this.afterVote = after; this.phase = "after-vote"; this.save();
    return after;
  }

  /** "reopen when": the conditions the Writer named (draft.reopen_when). For each, code fetches the rows that could
   *  show it (a stored Zetaris query, re-run every night); when rows come back, Nemotron (through Nightshift) judges
   *  whether they are what the committee is waiting for. A row about another reaction, population or section is not. */
  async conditions(decisionId: string) {
    const o = this.outcome!, q = this.question, s = q.substance.toLowerCase();
    const terms = o.terms.slice(0, 6), names = [s, ...o.classTerms.map((c) => c.toLowerCase())];
    const asked = (o.draft.reopen_when ?? []).filter((c) => c && String(c.text ?? "").trim()).slice(0, 4);
    const list = asked.length ? asked : [{ kind: "us_label_warning", text: `The U.S. label of ${q.substance} names ${q.reaction} in Boxed Warning, Warnings and Precautions or Contraindications` }];
    const studies = o.items.filter((i) => i.kind === "sentinel_study").map((i) => i.eid);
    const where = (kind: string) => {
      if (kind === "fda_list_update") return { column: "US_regulator" as const, sql: `SELECT quarter, term, products, fda_action FROM aprime_files.aems WHERE (${names.map((n) => `lower(products) LIKE ${lit("%" + n + "%")}`).join(" OR ")}) AND ${likeAny("term", terms)}` };
      if (kind === "fda_study_result") return { column: "US_regulator" as const, sql: `SELECT study_id, title, status, snapshot FROM aprime_files.sentinel WHERE (${[...names.map((n) => `lower(title) LIKE ${lit("%" + n + "%")} OR lower(product_scope) LIKE ${lit("%" + n + "%")}`), ...(studies.length ? [`study_id IN (${studies.map(lit).join(", ")})`] : [])].join(" OR ")})` };
      // every section, not only the warnings: a condition may count a mention under Adverse Reactions or postmarketing
      // reports, and when it does not, the judge (not a section filter) says that a mention elsewhere is not enough
      return { column: "US_label" as const, sql: `SELECT product, version, effective, path, text FROM aprime_lab.spl_section WHERE inn = ${lit(s)} AND purpose IN ('hero', 'score') AND ${likeAny("text", terms)}` };
    };
    const seen = o.items.map((i) => `${i.meta ? Object.values(i.meta).join("|") : ""} ${i.eid} ${i.text}`.toLowerCase());
    const known = (r: Record<string, string | null>) => {
      if (r.path && r.product) return o.items.some((i) => i.meta?.product === r.product && i.meta?.path === r.path && i.meta?.version === String(r.version));
      if (r.quarter) return o.items.some((i) => i.meta?.quarter === r.quarter && i.meta?.term === r.term && i.text.includes(String(r.fda_action ?? "").slice(0, 60)));
      if (r.study_id) return seen.some((x) => x.includes(String(r.study_id).toLowerCase()) && x.includes(String(r.status ?? "").toLowerCase()));
      return false;
    };
    const out = [];
    for (const [i, c] of list.entries()) {
      let kind = ["us_label_warning", "us_label_any_section", "fda_list_update", "fda_study_result"].includes(String(c.kind)) ? String(c.kind) : "us_label_warning";
      const description = String(c.text).trim();
      // the watch must be able to see what the words ask for: a label change is watched in the label, whatever kind was given
      if (/^fda_/.test(kind) && /\blabel|boxed|warnings? and precautions|adverse reactions|postmarketing/i.test(description)) kind = "us_label_any_section";
      // a Drug Safety Communication is in none of these sources: say so instead of watching the wrong table
      const unwatchable = /safety communication|\bDSC\b/i.test(description) && !/\blabel|boxed|signal list|potential.signal|AEMS|sentinel/i.test(description);
      const w = where(kind), id = `${decisionId}-C${i + 1}`;
      const ins = await this.sql.run(`INSERT INTO aprime_lab.reopen_condition VALUES (${[id, decisionId, kind, description, w.sql, "waiting", DECISION_DATE, ""].map(lit).join(", ")})`, `Store reopen condition ${id}`, "watcher", "pharmacist");
      const chk = await this.sql.run(w.sql, `Reopen check: rows that could show "${description}"`, "watcher", "agent");
      const all = chk.ok ? asObjects(chk.result) : [];
      // only what is new since the decision can make a condition come true: rows the investigation already read are the
      // state the committee decided on (same label section and version, same FDA list row and action, same study status)
      const rows = all.filter((r) => !known(r));
      let fired = false, note = unwatchable ? "Not watched automatically: FDA Drug Safety Communications are not among these sources, so a person checks for it." : all.length ? `Nothing new since the decision (${all.length} row(s) the investigation already read).` : "No row could show it yet.", judged = false;
      if (rows.length && !unwatchable) {
        const system = `You are the Evaluator for a P&T committee's reopen condition on ${q.substance} and "${q.reaction}". The committee is waiting for: "${description}".
What the investigation found at the time of the decision (${COLUMN[w.column]}): ${o.draft.cells[w.column]?.finding ?? ""}
Rows the stored query returns now:
${rows.slice(0, 4).map((r, n) => `#${n + 1} ${Object.values(r).map((v) => String(v ?? "").slice(0, 600)).join(" | ")}`).join("\n")}
Has the condition come true? Judge only what the committee is waiting for: a row about another reaction, another population or exposure, another section, or a state the investigation already knew does not count.
Reply with one JSON object only: {"condition_met":false,"why":"one sentence"}`;
        const r = await this.models.chat("fast", system, { tag: `reopen:${q.id}:C${i + 1}`, runDir: this.dir, maxTokens: 3000, valid: (t) => !!jsonWith(t, ["condition_met"]),
          stub: () => JSON.stringify({ condition_met: false, why: "Offline stub: not judged by a model." }) });
        const j = jsonWith<{ condition_met: boolean | string; why: string }>(r.text, ["condition_met"]);
        judged = r.source !== "offline-stub" && !!j;
        fired = judged && String(j!.condition_met) === "true"; note = String(j?.why ?? "");
        // the judge's reason may not add dates or forecasts the rows do not contain
        const bad = unbackedDates(note, rows.map((x) => Object.values(x).join(" ")).join(" ") + " " + JSON.stringify(o.draft.cells));
        if (bad.length) note = `${rows.length} new row(s) read; condition ${fired ? "met" : "not met"} (the judge's wording was dropped: it gave ${bad.join(", ")}, which no row contains)`;
        this.trace.emit({ agent: "watcher", kind: "model", summary: `Reopen judge for ${id} (${r.source === "offline-stub" ? "offline stub" : r.served})`, model: { lane: "fast", requested: r.requested, served: r.served, source: r.source, latencyMs: r.latencyMs, tokens: r.tokens } });
      }
      this.trace.emit({ agent: "watcher", kind: fired ? "fired" : "held", receipts: [ins.receipt.qid, chk.receipt.qid], summary: `${fired ? "Condition already true" : "Waiting"}: ${description} (${rows.length ? `${rows.length} new row(s) judged: ` : ""}${note})` });
      out.push({ id, kind, description, sql: w.sql, fired, judged, rows: all.length, newRows: rows.length, note, qid: chk.receipt.qid, watched: !unwatchable });
    }
    return out;
  }

  state() {
    return { id: this.id, phase: this.phase, question: this.question, stats: traceStats(this.trace.events), outcome: this.outcome, items: this.outcome?.items ?? this.inv?.items ?? [], vote: this.vote, afterVote: this.afterVote, error: this.error,
      sqlMode: this.sql.mode, receipts: this.sql.receipts, models: this.models.calls.map((c) => ({ lane: c.lane, requested: c.requested, served: c.served, source: c.source })) };
  }
  save() { mkdirSync(this.dir, { recursive: true }); writeFileSync(path.join(this.dir, "state.json"), scrub(JSON.stringify(this.state(), null, 1))); }
}

// ---------------- reopen replay: two real 2026 U.S. label events (demo only) ----------------
export type ReplayDecision = { id: string; product: string; inn: string; setid: string; reaction: string; decided: string; prac: string; waitingFor: string; strict: string[]; all: string[]; fromVersion: number };
export const REPLAY: ReplayDecision[] = JSON.parse(readFileSync(path.join(config.sampleDir, "replay.json"), "utf8")).decisions;

export async function runReplay(trace: Trace, sql: SqlTool, models: Models, dir?: string) {
  const results: Record<string, unknown>[] = [];
  for (const d of REPLAY) {
    const vs = await sql.run(`SELECT version, published FROM aprime_lab.spl_version WHERE setid = ${lit(d.setid)} AND version > ${d.fromVersion} ORDER BY version`, `Label versions of ${d.product} after the decision (${d.decided})`, "watcher");
    const nights = asObjects(vs.result);
    trace.emit({ agent: "watcher", kind: "sql", receipts: [vs.receipt.qid], summary: `${d.product}: decision on hold since ${d.decided}, waiting for: ${d.waitingFor}. ${nights.length} new U.S. label version(s) since.` });
    const timeline: Record<string, unknown>[] = [];
    for (const n of nights) {
      const base = `FROM aprime_lab.spl_section WHERE setid = ${lit(d.setid)} AND purpose = 'replay' AND version = ${n.version}`;
      const strictSql = `SELECT version, published, path, text ${base} AND sec_code IN ('34066-1', '43685-7', '34071-1', '34070-3') AND ${d.strict.map((g) => likeAny("text", g.split("|"))).join(" AND ")}`;
      const looseSql = `SELECT version, published, sec_title, path, text ${base} AND ${d.all.map((g) => likeAny("text", g.split("|"))).join(" AND ")}`;
      const st = await sql.run(strictSql, `${d.product} v${n.version}: condition as written (warning sections)`, "watcher");
      const lo = await sql.run(looseSql, `${d.product} v${n.version}: same words anywhere in the label`, "watcher");
      const sRows = asObjects(st.result), lRows = asObjects(lo.result);
      let state = "no change", note = "";
      if (sRows.length || lRows.length) {
        const passages = (sRows.length ? sRows : lRows).slice(0, 3).map((r) => `${r.path}: ${String(r.text).slice(0, 700)}`).join("\n\n");
        const system = `You are the Evaluator for a P&T committee's reopen condition. The committee put this on hold: "${d.product} (${d.inn}) — ${d.reaction}". It is waiting for: ${d.waitingFor}.
U.S. label version ${n.version} (published ${n.published}) contains:
${passages}
SQL said: warning-section match = ${sRows.length > 0}; match anywhere = ${lRows.length > 0}.
Has the committee's condition come true? Only what they waited for counts (a change in another section is not enough).
Reply with one JSON object only: {"condition_met":true,"what_changed":"one sentence","action":"recall to committee|keep on hold and note it"}`;
        const r = await models.chat("deep", system, { tag: `replay:${d.id}:v${n.version}`, runDir: dir, maxTokens: 3000, valid: (t) => !!jsonWith(t, ["condition_met"]),
          stub: () => JSON.stringify({ condition_met: sRows.length > 0, what_changed: "Offline stub: decided by the SQL condition only.", action: sRows.length ? "recall to committee" : "keep on hold and note it" }) });
        const j = jsonWith<{ condition_met: boolean; what_changed: string; action: string }>(r.text, ["condition_met"]) ?? { condition_met: sRows.length > 0, what_changed: "", action: "" };
        trace.emit({ agent: "evaluator", kind: "model", summary: `Reopen check ${d.product} v${n.version} (${r.source === "offline-stub" ? "offline stub" : r.served})`, model: { lane: "deep", requested: r.requested, served: r.served, source: r.source, latencyMs: r.latencyMs, tokens: r.tokens } });
        state = String(j.condition_met) === "true" ? "recall" : "half"; note = j.what_changed; // the judgement decides; the keyword queries only find candidates
        trace.emit({ agent: "watcher", kind: state === "recall" ? "fired" : "held", receipts: [st.receipt.qid, lo.receipt.qid],
          summary: state === "recall" ? `${d.product} v${n.version}, ${n.published}: condition met. Recall "${d.reaction}" to the committee. ${note}` : `${d.product} v${n.version}, ${n.published}: changed, but not what the committee waited for. Stays on hold. ${note}` });
      } else trace.emit({ agent: "watcher", kind: "held", receipts: [st.receipt.qid, lo.receipt.qid], summary: `${d.product} v${n.version}, ${n.published}: not mentioned. Stays on hold.` });
      timeline.push({ version: n.version, published: n.published, state, note, strictQid: st.receipt.qid, looseQid: lo.receipt.qid });
      if (state === "recall") break;
    }
    results.push({ ...d, timeline });
  }
  return results;
}
