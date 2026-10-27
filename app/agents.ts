// The investigation, as competing hypotheses:
//   Planner  (Nemotron fast lane)  reads this drug's PRAC rows and names the explanations to test (1 to 6, no list given),
//            what would confirm or rule out each, and the sources to query
//   Research (code)                turns each chosen source into SQL and runs it through Zetaris (run_sql only)
//   Skeptic  (Nemotron fast lane + SQL), before the draft: sweeps every U.S. label section for the reaction under another
//            name, and blocks FDA rows that match the word but name other drugs
//   Writer   (Nemotron deep lane)  judges every hypothesis (holds / ruled out / open) with the records for and against it,
//            and drafts where each regulator stands and what the committee could do (knowing how many patients here)
//   Skeptic, after the draft: fetches each supporting record again by its own key, checks the U.S. label column against
//            openFDA's copy (a Zetaris REST table), and Nemotron judges each claim against the records
//   Evaluator(Nemotron deep lane)  decides approve or send back; code adds must-hold checks and coverage advice, and the
//            model answers each piece of advice once (send back / overrule)
//   Case state (Meterless World Model) holds hypotheses, verdict history and contradicted records across rounds
// At most two rounds; after that the item is marked "needs a person". Patient data never goes to a model.
import { Models, lastJson, jsonWith, type Lane } from "./llm.ts";
import { SqlTool, asObjects, type Receipt } from "./zetaris.ts";
import { Trace } from "./trace.ts";
import { CaseState } from "./casestate.ts";
import { lit } from "./zetaris.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { SOURCES, byId, cleanTerms, federatedSql, pushdownSummary, skepticSql, type Column, type Question } from "./sources.ts";

export type Item = { eid: string; column: Column; source: string; authority: string; kind: string; title: string; date: string; section: string; text: string; url?: string; qid: string; scope?: string; substances?: string; round?: number; meta?: Record<string, string>; note?: string };
export type Cell = { stage?: string; status?: string; finding: string; cites: string[] };
export type Reason = { type: string; claim: string; cites: string[] };
export type Hypothesis = { id: string; name: string; verdict: string; why: string; for: string[]; against: string[]; role?: string; rank?: number };
export type Draft = { cells: Record<Column, Cell>; hypotheses: Hypothesis[]; why: { type: string; sentence: string; cites: string[]; reasons: Reason[] }; evidence: { note: string; cites: string[] }; recommendation: { option: string; reason: string }; reopen_when: { kind: string; text: string }[] };
export type Verdict = { verdict: "approve" | "revise"; columns?: Record<string, { supported: boolean; note: string }>; feedback: string; decidedBy?: string };
export type Gap = { column: Column | "citations" | "hypotheses"; problem: string; want: string[]; hard?: boolean };
export type Falsification = { round: number; records: number; verified: number; contradicted: string[]; reversed?: string[]; unjudged?: boolean; irrelevant?: string[]; restates?: string[]; restatesIds?: string[]; mainUnsupported?: string[]; unsupported?: string[]; unsupportedIds?: string[]; outUnsupported?: string[]; outUnsupportedIds?: string[]; causes?: { hid: string; records: string[] }[]; unchecked: number; claims: number; claimsSupported: number; claimsNotEnough: number;
  /** the U.S. label column checked against a second source (openFDA's copy of the label, a Zetaris REST table) */
  second?: { checked: number; verified: number; contradicted: number; notComparable: number; unavailable: boolean } };
export type Outcome = {
  question: Question; status: "approved" | "needs-person"; rounds: number; draft: Draft; verdicts: Verdict[]; gaps: Gap[][];
  items: Item[]; terms: string[]; classTerms: string[]; skeptic: { kept: string[]; dropped: string[]  }; disputes?: { round: number; n: number; item: string; accepted: boolean; why: string; record_ids: string[]; quote: string; reason: string }[]; exposure?: Record<string, string | null>;
  explain?: string; federatedQid?: string; pushdown?: { system: string; table: string; pushed: string }[];
  hypotheses: { id: string; name: string; test: string; sources: string[] }[]; falsification: Falsification[]; worldModel: Record<string, unknown>;
};

const COLS: Column[] = ["EU", "UK", "US_label", "US_regulator"];
const KEYS: Record<string, string[]> = { repair: ["replies"], plan: ["round1", "terms", "hypotheses"], replan: ["add_sources"], write: ["cells"], eval: ["verdict", "columns", "US_regulator"], skeptic: ["judgements"], falsify: ["claims"], rebut: ["replies"] };
const COLUMN_NAME: Record<Column, string> = { EU: "EU (EMA / PRAC)", UK: "UK (MHRA)", US_label: "U.S. label", US_regulator: "U.S. FDA" };
const WARN_CODES = new Set(["34066-1", "43685-7", "34071-1", "34070-3"]); // boxed warning, W&P, warnings, contraindications
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);
const around = (text: string, terms: string[], n = 520) => {
  const lo = text.toLowerCase(); const i = Math.min(...terms.map((t) => lo.indexOf(t)).filter((x) => x >= 0), Infinity);
  if (!Number.isFinite(i)) return clip(text, n);
  const a = Math.max(0, i - 160); return (a ? "… " : "") + clip(text.slice(a), n);
};

/** a readable, unique id for one U.S. label section: product, version, section number, short hash of the full path */
export function splEid(x: Record<string, string | null>) {
  const p = x.path ?? ""; let h = 0; for (const ch of p) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const num = (p.split(" > ").pop() ?? "").match(/^\d+(\.\d+)?/)?.[0] ?? (p.match(/^\d+(\.\d+)?/)?.[0] ?? "s");
  return `SPL-${x.product}-v${x.version}-${num}-${h.toString(36).slice(0, 4)}`;
}

/** the sentences of a long label section that share the most query words (stems of 6 letters), best first */
const STEM_STOP = new Set(["with", "after", "drug", "from", "that", "this", "were", "have", "been"]);
export function bestSentences(text: string, phrases: string[], n = 560) {
  const stems = [...new Set(phrases.flatMap((p) => p.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 4 && !STEM_STOP.has(w)).map((w) => w.slice(0, 6)))];
  const sents = text.split(/(?<=[.;:])\s+/).map((t, i) => ({ t, i, has: stems.filter((st) => t.toLowerCase().includes(st)) }));
  // a stem found in few sentences says more than one found everywhere (weight 1 / sentences containing it)
  const df: Record<string, number> = {};
  for (const x of sents) for (const st of x.has) df[st] = (df[st] ?? 0) + 1;
  const best = sents.filter((x) => x.has.length >= 2).map((x) => ({ ...x, w: x.has.reduce((a, st) => a + 1 / df[st], 0) })).sort((a, b) => b.w - a.w || a.i - b.i);
  let out = "";
  for (const x of best) { if (out.length + x.t.length > n) continue; out += (out ? " … " : "") + x.t; }
  return { text: out, score: best.length ? Math.max(...best.map((x) => x.has.length)) : 0 };
}

const DECISION: string = process.env.APRIME_DECISION_DATE || JSON.parse(readFileSync(path.join(config.sampleDir, "questions.json"), "utf8")).decision_date;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
/** dates in a model's text that appear in none of the records (ISO dates, "Month YYYY", "Qn YYYY", bare years) */
export function unbackedDates(text: string, corpus: string) {
  const c = corpus.toLowerCase();
  const isoParts = (iso: string) => { const [y, m] = iso.split("-"); const name = MONTHS.split("|")[Number(m) - 1]?.toLowerCase(); return [iso, `${name} ${y}`, `${y}${m}`]; };
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(`\\b(?:\\d{1,2}\\s+)?(${MONTHS})\\s+(?:\\d{1,2},\\s+)?((?:19|20)\\d{2})\\b|\\b((?:19|20)\\d{2})-(\\d{2})(?:-(\\d{2}))?\\b|\\b(Q[1-4])\\s+((?:19|20)\\d{2})\\b|\\b((?:19|20)\\d{2})\\b`, "gi"))) {
    const [all, mon, y1, y2, m2, , q, y3, y4] = m;
    const ok = mon ? c.includes(`${mon.toLowerCase()} ${y1}`) || c.includes(`${y1}-${String(MONTHS.toLowerCase().split("|").indexOf(mon.toLowerCase()) + 1).padStart(2, "0")}`)
      : y2 ? isoParts(`${y2}-${m2}`).some((x) => c.includes(x.toLowerCase())) || c.includes(all.toLowerCase())
      : q ? c.includes(`${q.toLowerCase()} ${y3}`) || c.includes(`${y3} ${q.toLowerCase()}`) || c.includes(`${q.toLowerCase()}${y3}`)
      : c.includes(String(y4));
    if (!ok) found.add(all);
  }
  // a forecast ("estimated completion ... 2026") must be a record's own forecast, not the model's
  const PRED = "estimated|expected|projected|anticipated|scheduled|due|planned";
  for (const m of text.matchAll(new RegExp(`\\b(${PRED})\\b[^.]{0,60}?\\b((?:19|20)\\d{2})\\b`, "gi")))
    if (!new RegExp(`\\b(${PRED})\\b[^.]{0,80}?${m[2]}`, "i").test(c)) found.add(m[0]);
  return [...found];
}
/** the words of a long record around the quoted excerpt (and the reaction terms), never a blind cut: a record up to
 *  6,000 characters is shown whole; a longer one is shown as windows around every place the excerpt or a term occurs */
export function recordView(full: string, excerpt: string, terms: string[] = []) {
  if (full.length <= 6000) return full;
  const lo = full.toLowerCase(), spans: [number, number][] = [];
  const pieces = excerpt.split(" … ").map((x) => x.replace(/^…\s*/, "").trim()).filter((x) => x.length > 20);
  for (const p of pieces) { const k = lo.indexOf(p.toLowerCase().slice(0, 60)); if (k >= 0) spans.push([Math.max(0, k - 700), Math.min(full.length, k + p.length + 700)]); }
  for (const t of terms) { let k = lo.indexOf(t.toLowerCase()); for (let n = 0; k >= 0 && n < 4; n++, k = lo.indexOf(t.toLowerCase(), k + 1)) spans.push([Math.max(0, k - 500), Math.min(full.length, k + 500)]); }
  if (!spans.length) return full; // nothing located: the whole record, not a guess
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  return merged.map(([a, b]) => `${a ? "… " : ""}${full.slice(a, b)}${b < full.length ? " …" : ""}`).join(" ");
}
/** the verdicts and statuses a model may write, mapped to the ones the checks and the screen know */
export function normVerdict(v: unknown) {
  const s = String(v ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return /^(holds|supported|true|confirmed)$/.test(s) ? "holds" : /^(ruled_out|rejected|false|refuted)$/.test(s) ? "ruled_out" : /^not_a_cause$/.test(s) ? "not_a_cause" : "open";
}
export function normStatus(v: unknown) {
  const s = String(v ?? "").toLowerCase();
  return /^written/.test(s) ? "written" : /^partial/.test(s) ? "partial" : /^related/.test(s) ? "related_only" : /^not.?assessed/.test(s) ? "not_assessed" : /^not.?found|^$/.test(s) ? "not found" : s;
}
/** the values a draft may use; anything else is sent back (a value the checks do not know is not a finding) */
export const SCHEMA = {
  stage: ["concluded", "agreed_with_noted_conflict", "under_evaluation", "no_public_action_found", "not_found_in_sources"],
  status: ["written", "partial", "related_only", "not found"],
  why: ["different_stage", "different_evidence", "different_scope", "us_earlier", "same_position"],
  option: ["propose", "wait", "no_action", "already_covered"],
};
const normWord = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
/** does a sentence name a specific cause? "The main reason is undetermined because the records do not show why" does
 *  not; "they differ because the FDA has not acted" does. A causal phrase counts only when what it introduces is not
 *  itself the lack of an explanation. Returns the words that make the claim, or "" */
export function namedCause(sentence: string) {
  const NONE = /\b(?:undetermined|unknown|unclear|cannot be determined|not (?:be )?determin\w*|no record|do(?:es)? not (?:show|explain|say|state|establish|give)|not shown|not explained)\b/i;
  const main = sentence.match(/\bthe (?:main |principal |primary )?(?:reason|cause)\b[^.;]*?\bis\s+([^.;,]{0,80})/i);
  if (main && !NONE.test(main[1].split(/\bbecause\b/i)[0])) return main[0].trim();
  for (const m of sentence.matchAll(/\b(because|due to|caused by|stems from|driven by|explained by|as a result of)\b([^.;]*)/gi))
    if (!NONE.test(m[2]) && !NONE.test(sentence.slice(0, m.index ?? 0).split(/[.;]/).pop() ?? "") ) return m[0].trim();
  return "";
}
/** explanations the Skeptic reads as a cause of the difference: a record it reads as showing the explanation, and not a
 *  restatement of the difference (from its reply, so a recorded reply can be read again offline) */
export function skepticCauses(reply: unknown, d: Draft) {
  const ex = (Array.isArray((reply as { explanations?: unknown })?.explanations) ? (reply as { explanations: Record<string, unknown>[] }).explanations : []);
  return ex.filter((x) => { const h = d.hypotheses.find((y) => y.id === String(x.h)); const recs = (x.records && typeof x.records === "object" ? x.records : {}) as Record<string, unknown>;
    return h && String(x.restates) !== "true" && h.for.concat(h.against).some((id) => String(recs[id] ?? "").toLowerCase().replace(/[\s-]+/g, "_") === "shows_true"); })
    .map((x) => ({ hid: String(x.h), records: Object.entries(x.records as Record<string, unknown>).filter(([, v]) => String(v).toLowerCase().replace(/[\s-]+/g, "_") === "shows_true").map(([k]) => k) }));
}
/** the cells a check or the Evaluator named last time (a change there is a correction, not an unexplained change); the
 *  list of allowed values that a schema message quotes names every column, so it is left out */
export function askedColumns(text: string) {
  const t = text.replace(/Stage: concluded \|[\s\S]*?Recommendation: [^.]*\./g, " ");
  const NAMES: Record<Column, RegExp> = { EU: /\bEU\b|EMA|PRAC|European/i, UK: /\bUK\b|MHRA|United Kingdom/i, US_label: /U\.?S\.? label|US_label|label status/i, US_regulator: /U\.?S\.? FDA|US_regulator|\bFDA\b/i };
  return new Set(COLS.filter((c) => NAMES[c].test(t)));
}
export function normStage(v: unknown) { const s = normWord(v); return SCHEMA.stage.includes(s) ? s : String(v ?? ""); }
/** a cause no record states (an explanation with only its own words behind it) compares equal after its record ids go */
const substance = (h: { verdict: string; role?: string; name: string; why: string }) =>
  [h.verdict, h.role ?? "", h.name, h.why.replace(/\[[^\]]*\]/g, " ").replace(/\b[A-Z][A-Z0-9]*(?:[-_][A-Za-z0-9().]+)+/g, " ").replace(/\b(?:per|see|in|from|cites?|citing)\s*(?=[\s,;.)]|$)/gi, " ")]
    .join("|").toLowerCase().replace(/[^a-z0-9|]+/g, " ").replace(/\s+/g, " ").trim();
export { substance as hypothesisSubstance };

export class Investigation {
  q: Question; trace: Trace; sql: SqlTool; models: Models; runDir?: string;
  items: Item[] = []; tried = new Set<string>(); rowsBy: Record<string, number> = {};
  swept = false; exposure?: Record<string, string | null>; prevOption = ""; prevCites = new Set<string>(); askedText = ""; repairs = 0;
  /** each cell's stage or status in the last draft (a change needs a new record or a check that asked for it) */
  prevCells: Partial<Record<Column, string>> = {};
  /** own-label sections the Skeptic's sweep read as the same reaction (kept apart from the prompts' notes) */
  sameReaction = new Set<string>();
  disputes: { round: number; n: number; item: string; accepted: boolean; why: string; record_ids: string[]; quote: string; reason: string }[] = [];
  /** findings about what an explanation says, sent back to the Writer: they stay open until the verdict changes, a new
   *  record is cited for (or against) it, or a dispute with a verified record and quote answers them */
  carry?: { round: number; hyps: Record<string, { verdict: string; for: string[]; against: string[] }>; restates: string[]; unsupported: string[]; outUnsupported: string[] };
  unanswered = { restates: [] as string[], unsupported: [] as string[], outUnsupported: [] as string[] }; hypotheses: { id: string; name: string; test: string; sources: string[] }[] = []; falsifications: Falsification[] = []; cs: CaseState; terms: string[] = []; broad: string[] = []; classTerms: string[] = [];
  constructor(q: Question, trace: Trace, sql: SqlTool, models: Models, runDir?: string) { this.q = q; this.trace = trace; this.sql = sql; this.models = models; this.runDir = runDir; this.cs = new CaseState(q.id); }

  private async model(lane: Lane, agent: "planner" | "writer" | "evaluator" | "skeptic" | "counsel", tag: string, system: string, stub: () => string, round?: number, maxTokens = 2500) {
    const keys = KEYS[tag.split(":")[0]] ?? [];
    // a reply cut short can still contain a JSON fragment that echoes the asked shape: the Writer's must be a whole draft
    const whole = (o: Record<string, unknown> | undefined) => !!o && (!["write", "repair"].includes(tag.split(":")[0]) ||
      ((dr) => !!dr.cells && COLS.filter((c) => (dr.cells as Record<string, unknown>)[c]).length >= 3 && !JSON.stringify(dr).includes("holds|ruled_out|open"))((tag.startsWith("repair") && o.draft ? o.draft : o) as Record<string, unknown>));
    const r = await this.models.chat(lane, system, { tag, stub, maxTokens, runDir: this.runDir, valid: (t) => whole(jsonWith(t, keys)) });
    this.trace.emit({ agent, kind: "model", round, summary: `${lane === "deep" ? "Deep" : "Fast"} lane answered (${r.source === "offline-stub" ? "offline stub, not a model" : r.served})${r.rejudged ? " · recorded reply of this step, re-judged offline: its prompt listed the code checks of the recording, today's checks may differ" : ""}`,
      model: { lane, requested: r.requested, served: r.served, source: r.source, latencyMs: r.latencyMs, tokens: r.tokens, ...(r.rejudged ? { rejudged: true } : {}) } });
    const got = jsonWith<Record<string, unknown>>(r.text, keys), parsed = whole(got) ? got : undefined;
    if (!parsed) this.trace.emit({ agent, kind: "error", round, summary: "The reply was not in the asked format (cut short?); the deterministic fallback answers this step." });
    return parsed ?? lastJson<Record<string, unknown>>(stub())!;
  }

  // ---------- Planner ----------
  async plan() {
    // a first look at the EU trigger, so the explanations come from this pair's records rather than a fixed list
    const first = await this.sql.run(`SELECT s.row_id, s.signal, s.meeting FROM aprime_lab.prac_signal s JOIN aprime_lab.prac_substance ps ON ps.row_id = s.row_id WHERE lower(ps.substance) LIKE ${lit("%" + this.q.substance.toLowerCase() + "%")} ORDER BY s.row_id`, `Planner: PRAC signals that name ${this.q.substance}`, "planner");
    const start = asObjects(first.result).slice(0, 8).map((r) => `- ${r.meeting}: ${r.signal}`).join("\n");
    this.trace.emit({ agent: "planner", kind: "sql", round: 1, receipts: [first.receipt.qid], summary: `Starting records: ${asObjects(first.result).length} PRAC signal row(s) name ${this.q.substance}` });
    const reg = SOURCES.map((s) => `- ${s.id} [${COLUMN_NAME[s.column]}; ${s.authority}]: ${s.describe}`).join("\n");
    const system = `You plan an evidence search for a hospital medication-safety pharmacist.
Question: The EU warns about "${this.q.reaction}" with ${this.q.substance}. Where do the EU, UK and U.S. regulators each stand, and why do they differ?
Evidence sources you can ask Research to query (all through SQL on Zetaris):
${reg}
What the EU's signal catalogue already records for this drug (starting point; the search has not run yet):
${start || "(no PRAC signal row names this drug)"}
First set out the competing explanations worth testing for why the regulators may differ on this pair. A competing explanation is one reason the positions could differ that a record in these sources could confirm or rule out. Base them on this pair and the starting records, name each in snake_case in your own words, and give only as many as the records could tell apart (1 to 6). For each, say what would confirm it, what would rule it out, and which sources test it.
Each source costs one query. Choose the sources round 1 needs to test your hypotheses (between 3 and 6, any mix); an Evaluator will check the result and can ask for more.
Also give search terms: the reaction's name, abbreviation, US and British spellings, close medical synonyms (max 8, lower case); broad words a label might use for the same body system (max 4); and drug class names the regulators may use instead of the drug name (max 3).
Reply with one JSON object only: {"hypotheses":[{"id":"H1","name":"snake_case_name","test":"what would confirm or rule it out, one sentence","sources":["source_id"]}],"terms":["..."],"broad_terms":["..."],"class_terms":["..."],"round1":["source_id", "..."],"reason":"one sentence"}`;
    const stub = () => JSON.stringify({ hypotheses: [], terms: this.q.reaction.toLowerCase().split(/[(),;]/).map((x) => x.trim()).filter(Boolean), broad_terms: [], class_terms: this.q.classTerms ?? [],
      round1: ["prac_signal_catalogue", "mhra_drug_safety_updates", "us_label_sections"], reason: "offline stub" });
    const p = await this.model("fast", "planner", `plan:${this.q.id}`, system, stub, 1);
    this.terms = cleanTerms(p.terms, 8);
    if (!this.terms.length) this.terms = cleanTerms([this.q.reaction]);
    const STOP = new Set(["disorder", "disorders", "disease", "syndrome", "reaction", "reactions", "after", "with", "drug", "drugs", "stopping", "persistent", "risk", "increased", "that", "the", "and",
      "adverse", "effect", "effects", "side", "system", "function", "post", "event", "events", "symptom", "symptoms", "treatment", "other", "related", "severe", "acute", "chronic", "induced", "associated"]);
    this.broad = cleanTerms([...(Array.isArray(p.broad_terms) ? p.broad_terms : []), ...this.terms].flatMap((x) => String(x).toLowerCase().split(/[\s\-]+/)).filter((w) => w.length >= 4 && !STOP.has(w) && !this.terms.includes(w)), 8);
    const cls = [...(Array.isArray(p.class_terms) ? p.class_terms : []), ...(this.q.classTerms ?? [])].map((x) => String(x).toLowerCase());
    this.classTerms = cleanTerms([...cls, ...cls.map((x) => x.split(/\s+/)[0]).filter((w) => /\d|-/.test(w) || /^[a-z]{3,5}s?$/.test(w))], 6);
    const r1 = Array.isArray(p.round1) ? p.round1 : Object.values((p.round1 ?? {}) as Record<string, string>);
    let chosen = [...new Set(r1.map(String).filter((x) => byId(x) && x !== "us_label_class_members"))].slice(0, 6);
    if (!chosen.length) chosen = ["prac_signal_catalogue", "mhra_drug_safety_updates", "us_label_sections"];
    // the U.S. label column rests on the drug's own label, so Research always reads it in round 1
    if (!chosen.includes("us_label_sections")) chosen = ["us_label_sections", ...chosen].slice(0, 6);
    this.hypotheses = (Array.isArray(p.hypotheses) ? p.hypotheses : []).slice(0, 6).map((h: Record<string, unknown>, i: number) => ({
      id: String(h.id ?? `H${i + 1}`), name: String(h.name ?? ""), test: String(h.test ?? ""), sources: (Array.isArray(h.sources) ? h.sources : []).map(String).filter((x: string) => byId(x)) }));
    await this.cs.hypotheses(this.hypotheses, 1);
    if (this.hypotheses.length) this.trace.emit({ agent: "planner", kind: "plan", round: 1, summary: `Competing explanations to test: ${this.hypotheses.map((h) => `${h.id} ${h.name.replace(/_/g, " ")}`).join("; ")}`, detail: this.hypotheses });
    this.trace.emit({ agent: "planner", kind: "plan", round: 1, summary: `Round 1 sources: ${chosen.join(", ")}. Terms: ${this.terms.join(", ")}`, detail: { terms: this.terms, broad: this.broad, classTerms: this.classTerms, chosen, reason: p.reason } });
    return chosen;
  }

  /** every EU and UK record that names this drug (or its class) and the reaction, with all its passages (up to 6), so
   *  the Writer sees the whole chronology (a first action in 2024 and a 2026 re-review, not only the latest) and what
   *  each measure in a document is about (MHRA 2026-10-15: the boxed warning is about suicidal thoughts, PSSD is a term) */
  async chronology(round: number) {
    const names = [this.q.substance.toLowerCase(), ...this.classTerms].filter((x) => x.length >= 4);
    const like = (col: string, ts: string[]) => "(" + ts.map((t) => `lower(${col}) LIKE ${lit("%" + t.toLowerCase() + "%")}`).join(" OR ") + ")";
    const sql = `SELECT p.passage_id, d.doc_id, d.regulator, d.body, d.doc_type, d.authority, d.title, d.published, d.url, d.scope, d.substances, p.section, p.text
FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id
WHERE d.regulator IN ('EU', 'UK') AND ${like("d.substances", names)} AND (${like("p.text", this.terms)} OR ${like("d.reaction_key", this.terms)})
ORDER BY d.published, p.passage_id`;
    const r = await this.sql.run(sql, `EU and UK records on ${this.q.substance} and this reaction, in date order (the chronology)`, "research");
    const firstPerDoc = new Map<string, Record<string, string | null>>();
    for (const x of asObjects(r.result)) if (!firstPerDoc.has(String(x.doc_id))) firstPerDoc.set(String(x.doc_id), x);
    let n = 0;
    const perDoc = new Map<string, number>();
    for (const x of asObjects(r.result)) {
      const k = String(x.doc_id); perDoc.set(k, (perDoc.get(k) ?? 0) + 1);
      if (perDoc.get(k)! > 6 || this.items.some((i) => i.eid === x.passage_id)) continue;
      this.items.push({ round, eid: String(x.passage_id), column: x.regulator === "UK" ? "UK" : "EU", source: "regulator_chronology", authority: String(x.authority), kind: String(x.doc_type), title: `${x.body}: ${x.title}`,
        date: String(x.published ?? ""), section: String(x.section ?? ""), text: around(String(x.text ?? ""), this.terms), url: x.url ?? undefined, scope: x.scope ?? undefined, substances: x.substances ?? undefined, qid: r.receipt.qid, meta: { passage_id: String(x.passage_id) } });
      n++;
    }
    const dates = [...firstPerDoc.values()].map((x) => `${x.regulator} ${x.published}`).join(", ");
    this.trace.emit({ agent: "research", kind: "sql", round, receipts: [r.receipt.qid], summary: `Chronology: ${firstPerDoc.size} EU/UK document(s) on this drug and reaction${dates ? ` (${dates})` : ""}${n ? `, ${n} added` : ""}` });
  }

  // ---------- Research ----------
  curRound = 1;
  async research(sourceIds: string[], round: number) {
    this.curRound = round;
    for (const id of sourceIds) {
      const s = byId(id); if (!s || this.tried.has(id)) continue;
      this.tried.add(id);
      // connecting to other products casts a wider net (the reaction words plus the broad words), the rest stays strict
      const terms = s.id === "us_label_class_members" ? [...this.terms, ...this.broad] : this.terms;
      const { ok, result, receipt } = await this.sql.run(s.sql(this.q, terms, this.classTerms, this.members()), `${s.describe} — ${this.q.substance} × ${this.q.reaction}`, "research");
      const rows = asObjects(result);
      this.rowsBy[s.id] = rows.length;
      const added = this.collect(s.id, rows, receipt);
      await this.cs.evidence(this.items.filter((i) => i.round === round), round);
      this.trace.emit({ agent: "research", kind: "sql", round, receipts: [receipt.qid], summary: ok ? `${s.id}: ${rows.length} row(s) via ${receipt.systems.join(" + ")}${added ? `, ${added} new evidence item(s)` : ""}` : `${s.id}: ${receipt.error}` });
      if (ok && !rows.length && (s.column === "US_regulator" || s.column === "UK")) { // a search that found nothing is still evidence, with its own receipt
        this.items.push({ round, eid: `${s.id.toUpperCase()}-NOTHING-FOUND`, column: s.column, source: s.id, authority: "primary", kind: "search_without_result", title: `${s.describe}: searched`,
          date: "", section: "no matching row", text: `No row names ${this.q.substance}${this.classTerms.length ? " or " + this.classTerms.join(" / ") : ""} with ${this.terms.slice(0, 4).join(", ")}.`, qid: receipt.qid });
      }
      if (s.id === "us_label_sections") {
        const v = await this.sql.run(skepticSql.labelVersions(this.q), `U.S. label versions searched for ${this.q.substance}`, "research");
        const versions = asObjects(v.result).map((r) => `${r.product} v${r.version} (published ${r.latest_published})`);
        this.items.push({ round, eid: `US-LABELS-SEARCHED`, column: "US_label", source: s.id, authority: "primary", kind: "spl_versions", title: "U.S. labels searched",
          date: "", section: "versions", text: `${versions.length ? `Searched in full: ${versions.join("; ")}` : `No U.S. label version of ${this.q.substance} is in the label table`}. Search terms: ${this.terms.join(", ")}. Sections matching: ${rows.length}.`, qid: v.receipt.qid });
        this.trace.emit({ agent: "research", kind: "sql", round, receipts: [v.receipt.qid], summary: `Label versions searched: ${versions.join("; ") || "none in the label table"}` });
      }
    }
  }

  private collect(source: string, rows: Record<string, string | null>[], r: Receipt) {
    const s = byId(source)!; let n = 0;
    const push = (it: Omit<Item, "qid" | "source">) => { if (!this.items.some((x) => x.eid === it.eid)) { this.items.push({ ...it, source, qid: r.qid, round: this.curRound }); n++; } };
    if (source === "us_label_class_members") { // keep the sections that say most about the reaction, best first
      const words = [...this.terms, ...this.broad];
      rows = rows.map((x) => ({ x, sc: bestSentences(x.text ?? "", words).score })).filter((r) => r.sc >= 2).sort((a, b) => b.sc - a.sc).map((r) => r.x);
    }
    for (const x of rows.slice(0, 12)) {
      if (x.passage_id) push({ meta: { passage_id: x.passage_id! }, eid: x.passage_id!, column: s.column, authority: x.authority ?? s.authority, kind: x.doc_type ?? "", title: `${x.body}: ${x.title}`, date: x.published ?? "", section: x.section ?? "", text: around(x.text ?? "", this.terms), url: x.url ?? undefined, scope: x.scope ?? undefined, substances: x.substances ?? undefined });
      else if (x.row_id) {
        const subs = [...new Set(rows.filter((y) => y.row_id === x.row_id).map((y) => (y.substance ?? "").replace(/^.*:\s*/, "")))];
        push({ meta: { row_id: x.row_id! }, eid: `PRAC-${x.row_id}`, column: "EU", authority: "primary", kind: "prac_signal", title: "EMA catalogue of PRAC signal recommendations", date: x.meeting ?? "", section: "signal recommendation",
          text: `Signal "${x.signal}" (${subs.join(", ")}): PRAC recommended an update of the EU product information (${x.meeting}).`, scope: subs.length > 1 ? "class" : "product", substances: subs.join(";") });
      }
      else if (x.sec_code !== undefined && x.product) push({ meta: { product: x.product!, path: x.path ?? "", version: x.version ?? "" }, eid: splEid(x), column: "US_label", authority: "primary", kind: WARN_CODES.has(x.sec_code ?? "") ? "label_warning_section" : "label_other_section",
        title: `${x.product}${x.inn && x.inn !== this.q.substance.toLowerCase() ? ` (${x.inn})` : ""} U.S. label v${x.version} (effective ${x.effective})`, date: x.effective ?? "", section: x.path ?? "", text: bestSentences(x.text ?? "", [...this.terms, ...this.broad]).text || around(x.text ?? "", this.terms) });
      else if (x.quarter) push({ meta: { quarter: x.quarter!, term: x.term ?? "" }, eid: `AEMS-${x.quarter.replace(" ", "")}-${(x.term ?? "").slice(0, 24).replace(/[^A-Za-z0-9]+/g, "_")}`, column: "US_regulator", authority: "primary", kind: "fda_potential_signal",
        title: `FDA AEMS potential signals, ${x.quarter} (as of ${x.as_of || "n/a"})`, date: x.as_of ?? "", section: x.term ?? "", text: `Products: ${clip(x.products ?? "", 420)}. Signal: ${x.term}. FDA: ${x.fda_action}`, url: x.page ?? undefined });
      else if (x.study_id) push({ eid: x.study_id, column: "US_regulator", authority: "primary", kind: "sentinel_study", title: `FDA Sentinel: ${clip(x.title ?? "", 140)}`, date: x.date_posted ?? "",
        section: `status: ${x.status} (page snapshot ${x.snapshot})`, text: `Status: ${x.status}. Posted ${x.date_posted}. Scope: ${x.product_scope}. ${x.description} ${x.protocol_note}`, url: x.url ?? undefined });
    }
    return n;
  }

  /** other drugs that an EU class-level record names (connects the EU class decision to each U.S. product) */
  members() {
    const own = this.q.substance.toLowerCase();
    // a salt or form of the same drug (it shares the drug's first six letters, as valproic acid and sodium valproate do) is
    // not another drug of the class; "related substances" is a heading, not a drug
    const stem = own.slice(0, 6), same = (x: string) => x.split(/\s+/).some((w) => w.length >= 6 && w.slice(0, 6) === stem);
    return [...new Set(this.items.filter((i) => i.column === "EU" && i.scope === "class").flatMap((i) => (i.substances ?? "").toLowerCase().split(/[;,]/).map((x) => x.trim())))]
      .filter((x) => x && x !== own && !same(x) && !/^related substances?$/.test(x)).slice(0, 12);
  }

  private pack() {
    return this.items.map((i) => `[${i.eid}] ${COLUMN_NAME[i.column]} | ${i.authority} | ${i.kind} | ${i.title} | ${i.date} | ${i.section}${i.note ? `\n(${i.note})` : ""}\n${i.text}`).join("\n\n");
  }

  // ---------- Writer ----------
  async write(round: number, notes: string) {
    const system = `You write the "why" evidence chain for a hospital P&T committee. Use ONLY the evidence items below; cite item ids in brackets' content exactly.
Question: the EU warns about "${this.q.reaction}" with ${this.q.substance}. Where does each regulator stand, why do they differ, and should the committee put it on next month's agenda?
Use exactly these values. Stages: concluded | agreed_with_noted_conflict | under_evaluation | no_public_action_found | not_found_in_sources. U.S. label status: written (boxed warning / warnings and precautions / contraindications) | partial (adverse reactions, postmarketing or patient information only) | related_only (the label names only a broader or narrower form, for example the reaction without the qualifier the question names; it does not name this reaction) | not found.
Why types, one per reason: different_stage | different_evidence | different_scope (product vs drug class) | us_earlier | same_position. The why type is the main cause's type. If no explanation holds, the why type is "undetermined": the public records show where each regulator stands but not why they differ; then give no reasons, claim no cause, and say only where each regulator stands and that the records do not show why.
Check scope: is each regulator's record about this one drug, or about a whole drug class? Check timing: which regulator acted first?
Never say the risk exists or does not exist for a patient. Absence from the U.S. label does not mean the risk exists or does not exist.
Keep a frequency category (for example "very rare: up to 1 in 10,000 people") separate from an excess-risk figure (for example "about 1 extra case per 10,000 person-years"); never merge them into one number.
Say what kind of evidence the regulators relied on (for example observational studies, trials, spontaneous reports) and whether the sources call it conflicting.
When the Evaluator asked for a record and Research found it, cite that record in the column it answers (prefer a regulator's own record over a press release).
Competing explanations the Planner set out to test (judge each one: holds, ruled_out, open when the records cannot decide, or not_a_cause when it is true but does not explain why the regulators differ; give the records for and against; you may add one the records point to). "holds" needs a record that shows it (an inference no record states stays open); "ruled_out" needs a record that shows it false (a record that only does not mention it is silent, so the explanation stays open). "for" holds the records that show the explanation true, "against" the ones that show it false, whatever the verdict. An explanation may not contradict your cells (for example "the U.S. acted first" when the U.S. label says nothing):
${this.hypotheses.map((h) => `- ${h.id} ${h.name}: ${h.test}`).join("\n") || "- (none listed: name the explanations yourself)"}
Then decide between the ones that hold (if none holds, the why is undetermined): name exactly one main cause (role "main", rank 1) and rank the others that hold as secondary (role "secondary", rank 2, 3, ...), saying why the main one weighs more. The "why" reasons are the hypotheses that hold, main cause first; the "why" sentence says "The main reason is ..., because ...".
${notes ? "Notes from earlier checks:\n" + notes + "\n" : ""}${round > 1 && this.cs.enabled ? "Case state (World Model) from the earlier round. Keep a verdict unless a record changes it; if you change one, cite the record that changed it:\n" + this.cs.describe() + "\n" : ""}EVIDENCE ITEMS:
${this.pack() || "(none)"}
Reply with one JSON object only:
{"hypotheses":[{"id":"H1","name":"the Planner's name","verdict":"holds|ruled_out|open|not_a_cause","role":"main|secondary (only when it holds)","rank":1,"why":"one sentence","for":["id"],"against":["id"]}],"cells":{"EU":{"stage":"...","finding":"one sentence","cites":["id"]},"UK":{"stage":"...","finding":"...","cites":[]},"US_label":{"status":"...","finding":"...","cites":[]},"US_regulator":{"stage":"...","finding":"...","cites":[]}},"why":{"reasons":[{"type":"different_stage","claim":"one sentence, max 30 words","cites":["id"]}],"sentence":"max 40 words"},"evidence":{"note":"one sentence on the kind and strength of evidence","cites":["id"]},"recommendation":{"option":"propose|wait|no_action|already_covered","reason":"one sentence"},"reopen_when":[{"kind":"us_label_warning|us_label_any_section|fda_study_result|fda_list_update","text":"..."}]}
The committee's hospital dispenses the U.S. products and labels. Patients here who take ${this.q.substance}: ${this.exposure ? this.patientsHere() : "0 (not dispensed here)"}.
The U.S. label cell is about ${this.q.substance}'s own U.S. labels only: cite its own label sections (or the "U.S. labels searched" record when none says it). Another drug's label, even in the same class, is not this drug's label: put it in the evidence note as a class comparison and say which drug it is. Options: propose = add an in-house reminder and counseling at the next dispensing now; wait = wait for the U.S. and reopen when a stated condition comes true; already_covered = ${this.q.substance}'s own U.S. label already says it at the EU's section level or higher, so the label's own counseling covers it: a warning section (Boxed Warning, Warnings and Precautions or Contraindications) when the EU warns, or at least Adverse Reactions when the EU lists it only as an undesirable effect (SmPC 4.8); no_action = the records give no reason to act or to watch. The recommendation must follow from your cells.
Reopen conditions: what would make the committee look again. Use us_label_warning when only a warning section counts, us_label_any_section when a mention anywhere in the U.S. label (Adverse Reactions, postmarketing) counts.
If the U.S. label has only a related form of the reaction (a passage the Skeptic marked "related", for example the reaction without the qualifier the question names), the U.S. label status is related_only: say what it says and what it leaves out.
Give each regulator's first action and any later review in date order; a re-review that keeps earlier measures is not the first action.
When a record lists several measures, say which concern each one addresses, as the record says (for example a boxed warning about one risk and a new term for another); do not tie a measure to this reaction unless the record does.
Every date you write must come from a record that the same sentence cites; do not estimate or predict dates.
A search that found nothing is not a record for or against an explanation, nor a reason: with only such a search, judge it "open", and do not cite it for the why (unless the why is undetermined).`;
    const d = await this.model("deep", "writer", `write:${this.q.id}:r${round}`, system, () => JSON.stringify(this.stubDraft()), round, 14000); // the deep lane reasons in the reply before the JSON
    const dd = d as Record<string, unknown>;
    const draft = this.normalize((dd.cells ? dd : { ...dd, cells: Object.fromEntries(COLS.map((c) => [c, dd[c]])) }) as unknown as Draft);
    await this.cs.verdicts(draft.hypotheses, round);
    this.trace.emit({ agent: "writer", kind: "draft", round, summary: `Draft ${round}: ${draft.why.type} — ${clip(draft.why.sentence, 160)}`, detail: draft });
    return draft;
  }
  /** what the last evaluation found, as numbered items: every must-hold and coverage check, the Evaluator model's own
   *  points and the disputes refused last time. The Writer answers each one. */
  findings(gaps: Gap[], v: Verdict) {
    const items = gaps.map((g) => `${g.hard ? "[must hold] " : "[coverage] "}${g.problem}`);
    if (v.feedback) items.push(`[Evaluator] ${v.feedback}`);
    for (const x of this.disputes.filter((x) => !x.accepted && x.round === this.curRound)) items.push(`[your dispute was refused] ${x.item} — ${x.why}`);
    return items;
  }
  /** a repair draft (rounds 3 to 5, no new search): the Writer gets its last draft, the numbered findings and the records
   *  they name, fixes or disputes each item, and returns the whole draft. A dispute counts only if it cites record ids
   *  from the evidence and quotes words that are in those records; the checks then run again on the new draft. */
  async repair(prev: Draft, items: string[], round: number) {
    const ids = [...new Set(items.flatMap((p) => p.match(/[A-Z][A-Za-z0-9()-]+-\d[\w().-]*/g) ?? []))];
    const recs = this.items.filter((i) => ids.includes(i.eid) || COLS.some((c) => prev.cells[c].cites.includes(i.eid))).map((i) => `[${i.eid}] ${i.title} | ${i.section}\n${i.text}`).join("\n\n");
    const system = `You wrote the draft below. The checks found these items:
${items.map((x, i) => `${i + 1}. ${x}`).join("\n")}
The records these items and your cells refer to:
${recs || "(see the draft's own citations)"}
Answer every item. Either fix it in the draft ("fixed"), or dispute it ("disputed") with the record ids that show you are right and the exact words from those records ("quote"). A dispute without a record and its exact words does not count. An item about what an explanation says (it restates the difference, no record shows it, no record shows it false, it contradicts a cell) is fixed by changing its verdict, or by citing a record that shows it; rewording it or adding the same record ids again does not fix it. If no explanation is left that holds, make the why undetermined (no reasons, no cause claimed). Change only what the items name, cite only record ids that appear in the draft or above, use only the listed values, and say what each measure is about as its record says.
DRAFT:
${JSON.stringify(prev)}
Reply with one JSON object only: {"replies":[{"n":1,"action":"fixed|disputed","record_ids":["id"],"quote":"exact words","reason":"short"}],"draft":{...the whole corrected draft, same shape...}}`;
    const d = await this.model("deep", "writer", `repair:${this.q.id}:r${round}`, system, () => JSON.stringify({ replies: [], draft: prev }), round, 16000);
    const dd = ((d as Record<string, unknown>).draft ?? d) as Record<string, unknown>;
    const draft = this.normalize((dd.cells ? dd : prev) as unknown as Draft);
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const replies = (Array.isArray((d as Record<string, unknown>).replies) ? (d as { replies: Record<string, unknown>[] }).replies : []);
    for (const r of replies) {
      if (String(r.action) !== "disputed") continue;
      const rids = (Array.isArray(r.record_ids) ? r.record_ids : []).map(String), quote = String(r.quote ?? "");
      const known = rids.map((x) => this.items.find((i) => i.eid === x)).filter((i): i is Item => !!i);
      const found = quote.length >= 15 && known.some((i) => norm(i.text).includes(norm(quote)));
      const why = !known.length ? "no record id from the evidence" : !found ? "the quoted words are not in the cited records" : "record and quote verified";
      this.disputes.push({ round, n: Number(r.n), item: clip(items[Number(r.n) - 1] ?? "", 160), accepted: found && !!known.length, why, record_ids: rids, quote: clip(quote, 200), reason: clip(String(r.reason ?? ""), 200) });
    }
    await this.cs.verdicts(draft.hypotheses, round);
    const mine = this.disputes.filter((x) => x.round === round);
    this.trace.emit({ agent: "writer", kind: "draft", round, summary: `Draft ${round} (repair ${round - 2} of 3): ${draft.why.type} — ${clip(draft.why.sentence, 120)}${mine.length ? ` · disputes: ${mine.filter((x) => x.accepted).length} with a verified record and quote, ${mine.filter((x) => !x.accepted).length} refused` : ""}`, detail: { ...draft, disputes: mine,
      replies: replies.map((r) => ({ n: Number(r.n), item: clip(items[Number(r.n) - 1] ?? "", 160), action: String(r.action ?? ""), record_ids: (Array.isArray(r.record_ids) ? r.record_ids : []).map(String), reason: clip(String(r.reason ?? ""), 200) })) } });
    return draft;
  }

  private normalize(d: Draft): Draft {
    const cells = {} as Record<Column, Cell>;
    for (const c of COLS) { const x = (d?.cells?.[c] ?? {}) as Cell; cells[c] = { stage: c === "US_label" ? x.stage : x.stage === undefined ? undefined : normStage(x.stage), status: c === "US_label" ? normStatus(x.status) : x.status, finding: String(x.finding ?? ""), cites: (Array.isArray(x.cites) ? x.cites : []).map(String) }; }
    const arr = (x: unknown) => (Array.isArray(x) ? x : []).map(String);
    const reasons = (Array.isArray(d?.why?.reasons) ? d.why.reasons : []).map((r) => ({ type: normWord(r?.type), claim: String(r?.claim ?? ""), cites: arr(r?.cites) })).filter((r) => r.claim);
    // the why type is the main cause's type (reasons come main cause first), or "undetermined" when the records show no cause
    const declared = normWord(d?.why?.type);
    const type = /^undetermined|cannot_be_determined/.test(declared) ? "undetermined" : reasons.length ? reasons[0].type : declared || "unclear";
    const hypotheses = (Array.isArray(d?.hypotheses) ? d.hypotheses : []).map((h, i) => ({ id: String(h?.id ?? `H${i + 1}`), name: String(h?.name ?? ""),
      verdict: normVerdict(h?.verdict), why: String(h?.why ?? ""), for: arr(h?.for), against: arr(h?.against),
      role: normVerdict(h?.verdict) === "holds" ? String(h?.role ?? "") : undefined, rank: normVerdict(h?.verdict) === "holds" && Number(h?.rank) > 0 ? Number(h?.rank) : undefined })).filter((h) => h.name);
    return { cells, hypotheses, why: { type, sentence: String(d?.why?.sentence ?? ""), cites: [...new Set([...arr(d?.why?.cites), ...reasons.flatMap((r) => r.cites)])], reasons },
      evidence: { note: String(d?.evidence?.note ?? ""), cites: arr(d?.evidence?.cites) },
      recommendation: { option: d?.recommendation?.option === undefined ? "none" : normWord(d.recommendation.option), reason: String(d?.recommendation?.reason ?? "") }, reopen_when: Array.isArray(d?.reopen_when) ? d.reopen_when : [] };
  }
  private stubDraft(): Draft {
    const of = (c: Column) => this.items.filter((i) => i.column === c);
    const cell = (c: Column): Cell => ({ stage: "not_assessed", status: c === "US_label" ? "not_assessed" : undefined, cites: of(c).slice(0, 2).map((i) => i.eid),
      finding: of(c).length ? `Not assessed: ${of(c).length} record(s) found, but no model was available to read them.` : "Not assessed: no record found and no model available." });
    return { cells: { EU: cell("EU"), UK: cell("UK"), US_label: cell("US_label"), US_regulator: cell("US_regulator") }, hypotheses: [], why: { type: "unclear", sentence: "No model was available to read the records.", cites: [], reasons: [] },
      evidence: { note: "", cites: [] }, recommendation: { option: "none", reason: "No recommendation without a model reading the records." }, reopen_when: [] };
  }

  // ---------- Evaluator: code checks ----------
  /** hard checks must hold (made-up ids, unbacked verdicts, contradicted records, verdict flips); coverage checks are
   *  advice the Evaluator model may overrule once, with a reason */
  rubric(d: Draft): Gap[] {
    const gaps: Gap[] = [];
    const has = (c: Column, f: (i: Item) => boolean = () => true) => this.items.some((i) => i.column === c && f(i));
    const untried = (ids: string[]) => ids.filter((x) => !this.tried.has(x));
    if (!has("EU")) gaps.push({ column: "EU", hard: false, want: untried(["prac_signal_catalogue", "eu_procedure_records", "eu_product_information"]),
      problem: this.tried.has("prac_signal_catalogue") && !this.rowsBy["prac_signal_catalogue"]
        ? "PRAC's signal catalogue has no entry for this. If PRAC concluded, it did so through another procedure (a PSUR, a LEG or a referral): where is that record?"
        : "No EU record found yet." });
    else if (!has("EU", (i) => i.authority === "primary"))
      gaps.push({ column: "EU", hard: false, problem: "Only a press release. Where is PRAC's own conclusion?", want: untried(["prac_signal_catalogue", "eu_procedure_records", "eu_product_information"]) });
    if (!has("UK") && untried(["mhra_drug_safety_updates"]).length) gaps.push({ column: "UK", hard: false, problem: "MHRA not checked yet.", want: ["mhra_drug_safety_updates"] });
    const labelChecked = this.tried.has("us_label_sections");
    const labelWarn = has("US_label", (i) => i.kind === "label_warning_section");
    // the U.S. label column is about the drug's own label: not reading it cannot be overruled
    if (!labelChecked) gaps.push({ column: "US_label", hard: true, problem: `${this.q.substance}'s own U.S. label was not read.`, want: ["us_label_sections"] });
    const fdaTried = ["fda_potential_signal_lists", "fda_sentinel"].filter((x) => this.tried.has(x));
    if (!labelWarn && !fdaTried.length)
      gaps.push({ column: "US_regulator", hard: false, problem: "The U.S. side rests on the label alone. Absence from the label is not evidence of FDA inaction: where does the FDA stand?", want: untried(["fda_potential_signal_lists", "fda_sentinel"]) });
    else if (!labelWarn && has("US_regulator", (i) => i.kind === "fda_potential_signal" && /evaluating/i.test(i.text)) && untried(["fda_sentinel"]).length)
      gaps.push({ column: "US_regulator", hard: false, problem: "The FDA lists this as a potential signal it is still evaluating. Is a study under way (Sentinel)?", want: ["fda_sentinel"] });
    if (this.members().length && untried(["us_label_class_members"]).length)
      gaps.push({ column: "US_label", hard: false, problem: `The EU record covers a whole class (${this.members().slice(0, 4).join(", ")}…). Do the other U.S. labels in that class say it?`, want: ["us_label_class_members"] });
    if (d.hypotheses.some((h) => /wording|section|synonym|other name|another name|terminolog/i.test(h.name + " " + h.why) && h.verdict === "ruled_out") && !this.swept && labelChecked && !labelWarn)
      gaps.push({ column: "hypotheses", hard: false, problem: "Ruling out \"the U.S. label says it in other words or another section\" needs a sweep of every label section, not only the exact terms.", want: [] });
    // hard
    const known = new Set(this.items.map((i) => i.eid));
    const bad = [...new Set([...COLS.flatMap((c) => d.cells[c].cites), ...d.hypotheses.flatMap((h) => [...h.for, ...h.against])].filter((x) => !known.has(x)))];
    const uncited = COLS.filter((c) => !d.cells[c].cites.length && (this.items.some((i) => i.column === c) || /no_public|not_found|not found/i.test(String(d.cells[c].stage ?? d.cells[c].status ?? ""))));
    if (bad.length || uncited.length) gaps.push({ column: "citations", hard: true, problem: `${bad.length ? `Cites ids that Research never returned: ${bad.join(", ")}. ` : ""}${uncited.length ? `No citation for: ${uncited.map((c) => COLUMN_NAME[c]).join(", ")}.` : ""}`.trim(), want: [] });
    if (this.hypotheses.length && !d.hypotheses.length) gaps.push({ column: "hypotheses", hard: true, problem: "The draft does not judge the competing explanations the Planner set out to test.", want: [] });
    const unbacked = d.hypotheses.filter((h) => h.verdict !== "open" && !h.for.length && !h.against.length);
    if (unbacked.length) gaps.push({ column: "hypotheses", hard: true, problem: `No record given for: ${unbacked.map((h) => `${h.id} ${h.name.replace(/_/g, " ")}`).join(", ")}.`, want: [] });
    const f = this.falsifications.at(-1);
    // a finding sent back last time is answered only by changing the verdict, by a new record for (or against) the
    // explanation, or by a verified dispute; rewording it or adding the same records again does not answer it
    const c = this.carry, still = { restates: [] as string[], unsupported: [] as string[], outUnsupported: [] as string[] };
    if (c && c.round < this.curRound) {
      const byId = (hid: string) => d.hypotheses.find((h) => h.id === hid);
      const newFor = (hid: string, side: "for" | "against") => (byId(hid)?.[side] ?? []).some((x) => !(c.hyps[hid]?.[side] ?? []).includes(x));
      still.restates = c.restates.filter((hid) => byId(hid)?.verdict === "holds");
      still.unsupported = c.unsupported.filter((hid) => byId(hid)?.verdict === "holds" && !newFor(hid, "for") && !f?.unsupportedIds?.includes(hid));
      still.outUnsupported = c.outUnsupported.filter((hid) => byId(hid)?.verdict === "ruled_out" && !newFor(hid, "against") && !f?.outUnsupportedIds?.includes(hid));
      const disputed = (hid: string) => this.disputes.some((x) => x.round === this.curRound && x.accepted && new RegExp(`\\b${hid}\\b`).test(x.item));
      const say = (hids: string[], what: string) => hids.length ? [`${hids.join(", ")} ${what}`] : [];
      for (const soft of [true, false]) {
        const pick = (xs: string[]) => xs.filter((hid) => disputed(hid) === soft);
        const parts = [...say(pick(still.restates), "still hold though they were found to restate the difference (judge them not_a_cause, or open)"),
          ...say(pick(still.unsupported), "still hold with no new record for them, though no cited record showed them"),
          ...say(pick(still.outUnsupported), "are still ruled out with no new record against them, though no cited record showed them false")];
        if (parts.length) gaps.push({ column: "hypotheses", hard: !soft, problem: `Sent back after draft ${c.round} and not answered: ${parts.join("; ")}. Rewording an explanation or citing the same records again does not answer a finding${soft ? "; the Writer disputed it with a verified record and quote, for the Evaluator to weigh" : ""}.`, want: [] });
      }
    }
    this.unanswered = still;
    if (f?.contradicted.length) gaps.push({ column: "citations", hard: true, problem: `The Skeptic's independent check contradicts: ${f.contradicted.join("; ")}.`, want: [] });
    if (f?.unjudged) gaps.push({ column: "citations", hard: true, problem: "The Skeptic's claim check did not run (its reply was cut short or not in the asked format): the claims were not judged against their records.", want: [] });
    const unsupported = f?.unsupported ?? f?.mainUnsupported ?? [];
    if (unsupported.length) gaps.push({ column: "hypotheses", hard: true, problem: `Explanations judged to hold that no cited record shows (the Skeptic read every record filed for them): ${unsupported.join("; ")}. An inference no record states is not a finding: cite a record that shows it, or judge it open.`, want: [] });
    if (f?.outUnsupported?.length) gaps.push({ column: "hypotheses", hard: true, problem: `Ruled out, but no record filed against it shows it is false (a record that does not mention it is silent): ${f.outUnsupported.join("; ")}. Cite the record that shows it false, or judge it open.`, want: [] });
    if (f?.irrelevant?.length) gaps.push({ column: "citations", hard: false, problem: `Cited records that do not bear on their claim: ${f.irrelevant.join("; ")}. Cite the record that says it, or drop the citation.`, want: [] });
    const restatesNow = (f?.restates ?? []).filter((x) => !still.restates.includes(x.split(" ")[0]));
    if (restatesNow.length) gaps.push({ column: "hypotheses", hard: false, problem: `Explanations that only restate the difference, not a cause of it: ${restatesNow.join("; ")}. Judge them not_a_cause, or say what they explain.`, want: [] });
    if (f?.reversed?.length) gaps.push({ column: "hypotheses", hard: false, problem: `The Skeptic reads some records the other way round: ${f.reversed.join("; ")}. If you agree, move the record and make the verdict follow it (an explanation a record shows true cannot be ruled out; one a record shows false cannot hold).`, want: [] });
    // a change the previous round's checks or the Evaluator asked for is a correction, not a flip
    const askedIds = new Set([...this.askedText.matchAll(/\bH\d+\b/g)].map((m) => m[0]));
    for (const h of d.hypotheses) if (h.name && this.askedText.toLowerCase().includes(h.name.toLowerCase().replace(/_/g, " ").slice(0, 24))) askedIds.add(h.id);
    const newRecs = new Set([...this.items.filter((i) => i.round === this.curRound && this.curRound > 1).map((i) => i.eid), ...[...COLS.flatMap((c) => d.cells[c].cites), ...d.hypotheses.flatMap((h) => [...h.for, ...h.against])].filter((x) => !this.prevCites.has(x))]);
    const flips = this.cs.flipFlops(newRecs, askedIds);
    if (flips.length) gaps.push({ column: "hypotheses", hard: true, problem: `Case state shows a verdict that flipped: ${flips.join("; ")}.`, want: [] });
    // the recommendation must follow from the findings
    const kindOf = (id: string) => this.items.find((i) => i.eid === id)?.kind;
    const item = (id: string) => this.items.find((i) => i.eid === id);
    const status = String(d.cells.US_label.status ?? "");
    // the drug's own label sections the U.S. label cell cites (a section the Skeptic marked "related" names another form)
    const ownCited = d.cells.US_label.cites.map(item).filter((i): i is Item => !!i && i.source === "us_label_sections" && /^label_/.test(i.kind) && !/^Skeptic: related/.test(i.note ?? ""));
    const citesOwnWarning = ownCited.some((i) => i.kind === "label_warning_section");
    const usWarns = status === "written" && citesOwnWarning;
    if (citesOwnWarning && status === "not found")
      gaps.push({ column: "US_label", hard: false, problem: `The U.S. label cell cites a warning section of ${this.q.substance}'s own label (${ownCited.filter((i) => i.kind === "label_warning_section").map((i) => i.eid).slice(0, 2).join(", ")}) yet says not found. If that section names this reaction with the qualifier the question names, the status is written; if it names only another form (another group of people, a broader or narrower reaction), the status is related_only.`, want: [] });
    const opt = d.recommendation.option;
    if (usWarns && opt === "propose") gaps.push({ column: "recommendation", hard: true, problem: "The U.S. label already warns about it in a warning section, yet the draft proposes a new in-house reminder. Recommend already covered or no action.", want: [] });
    // the same level on both sides: EU only in the undesirable-effects section (4.8), U.S. only outside the warnings
    const euTexts = d.cells.EU.cites.map((x) => this.items.find((i) => i.eid === x)?.text ?? "").join(" ");
    const parity = /\b4\.8\b/.test(euTexts) && !/\b4\.4\b/.test(euTexts) && /^partial/i.test(String(d.cells.US_label.status ?? ""));
    const mainH = d.hypotheses.find((h) => h.verdict === "holds" && /^main/i.test(h.role ?? ""));
    if (parity && opt === "propose") gaps.push({ column: "recommendation", hard: true, problem: "The EU lists it only as an undesirable effect (SmPC 4.8) and the U.S. label lists it outside the warnings too: the two labels say it at the same level. A new in-house reminder needs a reason beyond a label difference; otherwise recommend already covered or no action.", want: [] });
    if (parity && mainH && /\b(lack|lacks|lacking|not (?:yet )?(?:detected|replicated|listed|flagged)|no such signal|has not)\b/i.test(`${mainH.name} ${mainH.why}`))
      gaps.push({ column: "hypotheses", hard: true, problem: `The main cause (${mainH.id}) says the U.S. side lacks it, but both labels list it at the same level (EU 4.8, U.S. outside the warnings). Choose the explanation the records support.`, want: [] });
    // already covered, by section: the drug's own U.S. label says it at the EU's level or higher, cited in the cell
    // (a warning section for an EU warning; at least Adverse Reactions when the EU lists it only under SmPC 4.8)
    const usListed = status === "partial" && ownCited.length > 0;
    if (opt === "already_covered" && !usWarns && !(parity && usListed))
      gaps.push({ column: "recommendation", hard: true, problem: `"Already covered" needs ${this.q.substance}'s own U.S. label to say it at the EU's section level or higher, cited in the U.S. label cell: a warning section (Boxed Warning, Warnings and Precautions, Contraindications) when the EU warns, or at least Adverse Reactions when the EU lists it only as an undesirable effect (SmPC 4.8). ${usListed ? "The EU records cited are not only an SmPC 4.8 listing." : "The cell cites no such section of the drug's own label."}`, want: [] });
    if (opt === "propose" && !this.patientsHere()) gaps.push({ column: "recommendation", hard: true, problem: `No patient in this hospital takes ${this.q.substance}, yet the draft proposes an in-house reminder and counseling. Recommend no action (or wait), and say so.`, want: [] });
    // a recommendation may change when a check or the Evaluator asked about it, or when a record not cited before is behind it
    const fresh = this.items.some((i) => i.round === this.curRound && i.kind !== "search_without_result") || [...COLS.flatMap((c) => d.cells[c].cites)].some((x) => !this.prevCites.has(x) && this.items.find((i) => i.eid === x)?.kind !== "search_without_result");
    const askedRec = /recommend|propose|already covered|no action|in-house reminder/i.test(this.askedText);
    if (this.curRound > 1 && this.prevOption && this.prevOption !== "none" && opt !== this.prevOption && !fresh && !askedRec) // giving a recommendation where there was none is not a change
      gaps.push({ column: "recommendation", hard: true, problem: `The recommendation changed from "${this.prevOption.replace("_", " ")}" to "${opt.replace("_", " ")}" with no new record behind the change.`, want: [] });
    const otherDrug = d.cells.US_label.cites.filter((x) => this.items.find((i) => i.eid === x)?.source === "us_label_class_members");
    if (otherDrug.length) gaps.push({ column: "US_label", hard: true, problem: `The U.S. label cell cites another drug's label (${otherDrug.join(", ")}). It must rest on ${this.q.substance}'s own label; put other drugs in the evidence note as a class comparison.`, want: [] });
    // and it must cite that label: a section of it, or the record of the label versions searched when none says it
    const readsOwnLabel = d.cells.US_label.cites.some((x) => { const i = item(x); return i?.source === "us_label_sections" && (/^label_/.test(i.kind) || i.kind === "spl_versions"); });
    if (labelChecked && !readsOwnLabel) gaps.push({ column: "US_label", hard: true, problem: `The U.S. label cell does not cite ${this.q.substance}'s own label. Cite the label sections it read, or the "U.S. labels searched" record (US-LABELS-SEARCHED) when none of them says it; an FDA list entry or any other record is not the label.`, want: [] });
    // only the listed values: a stage, status, type or option the checks do not know is not a finding
    const off = [...(["EU", "UK", "US_regulator"] as Column[]).filter((c) => !SCHEMA.stage.includes(String(d.cells[c].stage ?? ""))).map((c) => `${COLUMN_NAME[c]} stage "${d.cells[c].stage ?? ""}"`),
      ...(SCHEMA.status.includes(status) ? [] : [`U.S. label status "${status}"`]),
      ...d.why.reasons.filter((r) => !SCHEMA.why.includes(r.type) && r.type !== "undetermined").map((r) => `why type "${r.type}"`), // an undetermined why with reasons has its own check
      ...(d.why.type === "undetermined" || SCHEMA.why.includes(d.why.type) || d.why.reasons.length ? [] : [`why type "${d.why.type}"`]),
      ...(SCHEMA.option.includes(opt) ? [] : [`recommendation "${opt}"`])];
    if (off.length) gaps.push({ column: "citations", hard: true, problem: `Values outside the allowed lists: ${off.join("; ")}. Stage: ${SCHEMA.stage.join(" | ")}. U.S. label status: ${SCHEMA.status.join(" | ")}. Why type, one per reason: ${SCHEMA.why.join(" | ")} (or undetermined, with no reason). Recommendation: ${SCHEMA.option.join(" | ")}.`, want: [] });
    const pracConcluded = d.cells.EU.cites.some((x) => { const i = this.items.find((y) => y.eid === x); return i?.kind === "prac_signal" || i?.kind === "prac_recommendation"; });
    if (pracConcluded && String(d.cells.EU.stage ?? "") !== "concluded")
      gaps.push({ column: "EU", hard: true, problem: `The EU cell cites a PRAC recommendation that updated the product information, yet calls the EU stage "${String(d.cells.EU.stage).replace(/_/g, " ")}".`, want: [] });
    // an explanation that holds may not rest, even in part, on a search that found nothing ("the FDA has not ...")
    const holdsOnAbsence = d.hypotheses.filter((h) => h.verdict === "holds" && h.for.some((x) => kindOf(x) === "search_without_result"));
    if (holdsOnAbsence.length) gaps.push({ column: "hypotheses", hard: true, problem: `Held partly on a search that found nothing: ${holdsOnAbsence.map((h) => `${h.id} ${h.name.replace(/_/g, " ")}`).join(", ")}. Not finding a record does not show a reason: judge it open, or cite a record that shows it.`, want: [] });
    // the same for the why itself: a reason may not rest on a search that found nothing (an undetermined why may cite it
    // for where a regulator stands, since it claims no cause)
    const emptyWhy = [...new Set([...d.why.reasons.flatMap((r) => r.cites), ...(d.why.type === "undetermined" ? [] : d.why.cites)].filter((x) => kindOf(x) === "search_without_result"))];
    if (emptyWhy.length) gaps.push({ column: "hypotheses", hard: true, problem: `The why rests partly on a search that found nothing (${emptyWhy.join(", ")}). Not finding a record does not show a reason: cite a record that shows the reason, or, if no record does, make the why undetermined (where each regulator stands, and that the public records do not show why).`, want: [] });
    // the explanation may not contradict the cells: "the U.S. acted first" or "same position" needs a U.S. that says it
    const usSays = status === "written" || status === "partial" || String(d.cells.US_regulator.stage ?? "") === "concluded";
    const usTypes = [...new Set([d.why.type, ...d.why.reasons.map((r) => r.type)])].filter((t) => t === "us_earlier" || t === "same_position");
    const NEG = /\b(?:not|no|never|without|yet to|lacks?)\b/i;
    // "the U.S. label already lists it", "the FDA acted first" (a sentence with a negation is not such a claim)
    const LABEL_SAYS = /\b(?:U\.?S\.?|FDA|American)\s+(?:\S+\s+){0,2}?label(?:s|ing)?\s+(?:\S+\s+)?(?:already\s+)?(?:warns?|warned|lists?|listed|includes?|included|contains?|names?|named|mentions?|says|describes?|carries|has)\b/i;
    const US_FIRST = /\b(?:U\.?S\.?|FDA)\b(?:\s+\S+){0,2}?\s+(?:acted|warned|moved|labell?ed)\s+(?:first|earlier)\b|\b(?:U\.?S\.?|FDA)\s+was\s+first\b/i;
    const usClaims = [...d.hypotheses.filter((h) => h.verdict === "holds").map((h) => ({ who: h.id, t: `${h.name.replace(/_/g, " ")}. ${h.why}` })), ...d.why.reasons.map((r, i) => ({ who: `reason ${i + 1}`, t: r.claim }))]
      .filter((x) => x.t.split(/(?<=[a-z0-9)][.;])\s+/).some((sen) => (LABEL_SAYS.test(sen) || US_FIRST.test(sen)) && !NEG.test(sen)));
    if (!usSays && (usTypes.length || usClaims.length))
      gaps.push({ column: "hypotheses", hard: true, problem: `The explanation contradicts the cells: ${[...usTypes.map((t) => `why type ${t}`), ...usClaims.map((x) => `${x.who} says the U.S. already has it`)].join("; ")}, but the U.S. label cell says ${status || "nothing"} and the FDA cell ${String(d.cells.US_regulator.stage ?? "nothing").replace(/_/g, " ")}. Change the explanation or the cell, whichever the records show.`, want: [] });
    // the records show the drug's own U.S. label warned before the EU or UK first acted: then the U.S. was first
    const MON = MONTHS.toLowerCase().split("|");
    const dayOf = (i: Item) => { const t = `${i.date}`, iso = t.match(/\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/), mon = t.toLowerCase().match(new RegExp(`\\b(${MONTHS.toLowerCase()})\\s+((?:19|20)\\d{2})\\b`));
      return iso ? iso[0] : mon ? `${mon[2]}-${String(MON.indexOf(mon[1]) + 1).padStart(2, "0")}` : (t.match(/\b(?:19|20)\d{2}\b/) ?? [""])[0]; };
    const before = (a: string, b: string) => (a.length >= 7 && b.length >= 7 ? a.slice(0, 7) < b.slice(0, 7) : a.slice(0, 4) < b.slice(0, 4));
    const usFirst = ownCited.filter((i) => i.kind === "label_warning_section" && dayOf(i)).sort((a, b) => dayOf(a).localeCompare(dayOf(b)))[0];
    const euFirst = this.items.filter((i) => (i.column === "EU" || i.column === "UK") && dayOf(i)).sort((a, b) => dayOf(a).localeCompare(dayOf(b)))[0];
    if (usWarns && usFirst && euFirst && before(dayOf(usFirst), dayOf(euFirst)) && !["us_earlier", "same_position"].includes(d.why.type))
      gaps.push({ column: "hypotheses", hard: true, problem: `${this.q.substance}'s own U.S. label already warned by ${dayOf(usFirst)} (${usFirst.eid}), before the first EU or UK action in the records (${dayOf(euFirst)}, ${euFirst.eid}). The main cause is then that the U.S. had it first and the EU followed: an explanation that holds on these two records, named the main cause, with why type us_earlier, unless a record shows otherwise; the why type is "${d.why.type}".`, want: [] });
    // the Skeptic found a related form of the reaction in this drug's own label: the label is partial, not "not found"
    // the Skeptic's sweep read a section of the drug's own label as the same reaction: the label names it, so its status is
    // written or partial by section, not "related only" or "not found"
    const same = d.cells.US_label.cites.filter((x) => this.sameReaction.has(x) && item(x)?.source === "us_label_sections");
    if (same.length && /^(related_only|not found)$/.test(status))
      gaps.push({ column: "US_label", hard: true, problem: `The U.S. label cell cites ${same.slice(0, 2).join(", ")}, which the Skeptic read as the same reaction, yet says "${status}". The label names it: the status is written (a warning section) or partial (anywhere else).`, want: [] });
    // a cell's stage or status may change between rounds only with a new record for that column or a check that asked
    const asked = askedColumns(this.askedText);
    for (const c of COLS) {
      const before = this.prevCells[c], now = String((c === "US_label" ? d.cells[c].status : d.cells[c].stage) ?? "");
      if (this.curRound < 2 || !before || before === now || asked.has(c)) continue;
      const fresh = this.items.some((i) => i.column === c && i.round === this.curRound && d.cells[c].cites.includes(i.eid));
      if (!fresh) gaps.push({ column: c, hard: true, problem: `The ${COLUMN_NAME[c]} ${c === "US_label" ? "status" : "stage"} changed from "${before}" to "${now}" with no new record for it and no check asking for it. Keep "${before}", or cite the new record that changes it.`, want: [] });
    }
    const related = this.items.filter((i) => /^label_/.test(i.kind) && i.source === "us_label_sections" && /^Skeptic: related/.test(i.note ?? ""));
    if (related.length && /not.?found/i.test(String(d.cells.US_label.status ?? "")))
      gaps.push({ column: "US_label", hard: true, problem: `The Skeptic found a related form of the reaction in ${this.q.substance}'s own label (${related.slice(0, 2).map((i) => i.eid).join(", ")}): the U.S. label status is related_only, not "not found". Say what the label says and what it leaves out.`, want: [] });
    // a measure from a record must be described with what the record says it is about (a boxed warning on one risk is not a warning on another)
    for (const col of COLS) {
      const f = String(d.cells[col].finding ?? "");
      if (!/boxed warning/i.test(f)) continue;
      const topics = d.cells[col].cites.map((x) => this.items.find((i) => i.eid === x)?.text ?? "").join(" ")
        .match(/boxed warning[^.]{0,80}?\b(?:information on|about|regarding)\s+([a-z][a-z ]{3,40}?)(?:\s+and\s+|,|\.|$)/i);
      if (topics && !f.toLowerCase().includes(topics[1].trim().split(" ")[0].toLowerCase()))
        gaps.push({ column: col, hard: true, problem: `The ${COLUMN_NAME[col]} cell mentions a boxed warning, but its record says the boxed warning is about ${topics[1].trim()}. Say what each measure is about, as the record does.`, want: [] });
    }
    // the first action, not only the latest review: the earliest dated record of a regulator must be in its cell
    const yearOf = (i: Item) => Number((`${i.date} ${i.title}`.match(/\b(19|20)\d{2}\b/) ?? [])[0] ?? 0);
    for (const col of ["EU", "UK"] as Column[]) {
      const dated = this.items.filter((i) => i.column === col && yearOf(i) > 0);
      if (!dated.length || !d.cells[col].cites.length) continue;
      const first = Math.min(...dated.map(yearOf));
      const citedYears = d.cells[col].cites.map((x) => this.items.find((i) => i.eid === x)).filter((i): i is Item => !!i).map(yearOf);
      if (!citedYears.includes(first) && !String(d.cells[col].finding).includes(String(first)) && citedYears.some((y) => y > first))
        gaps.push({ column: col, hard: true, problem: `${COLUMN_NAME[col]} first acted in ${first} (${dated.filter((i) => yearOf(i) === first).map((i) => i.eid).slice(0, 2).join(", ")}), but the cell gives only a later action. Give the first action, then the later review.`, want: [] });
    }
    // an FDA-approved label change in the last year is a public FDA action
    const labelRecent = d.cells.US_label.cites.map((x) => this.items.find((i) => i.eid === x)).some((i) => i && /^label_/.test(i.kind) && i.source !== "us_label_class_members" && /^\d{4}-\d{2}-\d{2}$/.test(i.date) && (Date.parse(DECISION) - Date.parse(i.date)) / 864e5 <= 365);
    if (labelRecent && /^(written|partial)/.test(String(d.cells.US_label.status ?? "")) && /no_public_action/.test(String(d.cells.US_regulator.stage ?? "")))
      gaps.push({ column: "US_regulator", hard: true, problem: "The draft cites a U.S. label version from the last year that mentions the reaction, yet the U.S. FDA cell says no public action. The FDA approves every label version: either change the FDA stage to concluded (the label was updated) and say which version added it, or, if the label's mention is not this reaction, change the U.S. label status to not found.", want: [] });
    const outNoAgainst = d.hypotheses.filter((h) => h.verdict === "ruled_out" && !h.against.length);
    if (outNoAgainst.length) gaps.push({ column: "hypotheses", hard: true, problem: `Ruled out with no record against it: ${outNoAgainst.map((h) => `${h.id} ${h.name.replace(/_/g, " ")}`).join(", ")}. Put the record that shows it false under "against", or, if no record does, judge it open.`, want: [] });
    // every date must come from a record the same sentence cites (not from some other record in the evidence)
    const corpusOf = (ids: string[]) => ids.map(item).filter((i): i is Item => !!i).map((i) => `${i.date} ${i.title} ${i.section} ${i.text}`).join(" ") + " " + DECISION;
    const allCited = [...new Set([...COLS.flatMap((c) => d.cells[c].cites), ...d.hypotheses.flatMap((h) => [...h.for, ...h.against]), ...d.why.cites, ...d.evidence.cites])];
    const units: [string, string, string[]][] = [...COLS.map((c): [string, string, string[]] => [`${COLUMN_NAME[c]} cell`, d.cells[c].finding, d.cells[c].cites]),
      ...d.hypotheses.map((h): [string, string, string[]] => [h.id, h.why, [...h.for, ...h.against]]), ...d.why.reasons.map((r, i): [string, string, string[]] => [`reason ${i + 1}`, r.claim, r.cites]),
      ["why sentence", d.why.sentence, d.why.cites], ["evidence note", d.evidence.note, d.evidence.cites], ["recommendation", d.recommendation.reason, allCited]];
    // say where the date is, when some other record has it, so the sentence can cite that record
    const holder = (date: string) => this.items.filter((i) => !unbackedDates(date, corpusOf([i.eid])).length).map((i) => i.eid).slice(0, 2);
    const undated = units.flatMap(([w, t, ids]) => unbackedDates(t, corpusOf(ids)).map((x) => `${x} (${w}${holder(x).length ? `; it is in ${holder(x).join(", ")}, which it does not cite` : "; no record has it"})`));
    if (undated.length) gaps.push({ column: "citations", hard: true, problem: `Dates that the records each sentence cites do not contain: ${undated.slice(0, 5).join(", ")}. Every date must come from a record the same sentence cites; do not estimate or predict.`, want: [] });
    // competing explanations must be decided between: one main cause, the rest ranked
    const holding = d.hypotheses.filter((h) => h.verdict === "holds");
    const mains = holding.filter((h) => /^main/i.test(h.role ?? ""));
    const ranks = holding.map((h) => h.rank).filter((x): x is number => !!x);
    // "the public records do not show why" is a valid conclusion: no explanation holds, no cause is claimed
    const undetermined = d.why.type === "undetermined";
    if (!holding.length && d.hypotheses.length && d.why.sentence.trim() && !undetermined)
      gaps.push({ column: "hypotheses", hard: true, problem: "No explanation is judged to hold, yet the why gives a reason. If a record shows the reason, judge that explanation holds and name it the main cause; if no record does, make the why undetermined: say where each regulator stands and that the public records do not show why they differ.", want: [] });
    if (undetermined && holding.length)
      gaps.push({ column: "hypotheses", hard: true, problem: `The why says the cause cannot be determined, yet ${holding.map((h) => h.id).join(", ")} hold. Name the main cause, or judge them open.`, want: [] });
    const named = undetermined ? namedCause(d.why.sentence) : "";
    if (undetermined && (d.why.reasons.length || named))
      gaps.push({ column: "hypotheses", hard: true, problem: `An undetermined why claims no cause: ${d.why.reasons.length ? `it gives ${d.why.reasons.length} reason(s)` : `the sentence names one ("${clip(named, 90)}")`}. Give no reasons, and say only where each regulator stands and that the public records do not show why they differ.`, want: [] });
    // a checker that reads an explanation as a cause, with a record that shows it, rules out "the cause cannot be determined"
    const read = f?.causes ?? [];
    if (undetermined && read.length)
      gaps.push({ column: "hypotheses", hard: true, problem: `The why says the cause cannot be determined, but the Skeptic reads ${read.map((c) => `${c.hid} as a cause of the difference, shown by ${c.records.slice(0, 3).join(", ")}`).join("; ")}. Judge it on those records (holds, as the main cause, or dispute the reading with a record and its words); a why cannot be undetermined while a checker reads a cause in the records.`, want: [] });
    if (holding.length && mains.length !== 1)
      gaps.push({ column: "hypotheses", hard: true, problem: `${holding.length} explanations hold but ${mains.length ? `${mains.length} are` : "none is"} named the main cause. Name exactly one main cause and say why it weighs more than the others.`, want: [] });
    else if (holding.length > 2 && (ranks.length !== holding.length || new Set(ranks).size !== ranks.length))
      gaps.push({ column: "hypotheses", hard: true, problem: `${holding.length} explanations hold without a ranking. Rank them (1 = main cause), or judge as not a cause the ones that are true but do not explain the difference.`, want: [] });
    // a search that found nothing cannot rule an explanation out on its own
    const onAbsence = d.hypotheses.filter((h) => h.verdict === "ruled_out" && h.against.length && h.against.every((x) => kindOf(x) === "search_without_result"));
    if (onAbsence.length) gaps.push({ column: "hypotheses", hard: true, problem: `Ruled out only on a search that found nothing: ${onAbsence.map((h) => `${h.id} ${h.name.replace(/_/g, " ")}`).join(", ")}. Not finding a record is not a record against it: judge it open, or cite a record that rules it out.`, want: [] });
    return gaps;
  }

  /** an independent way to fetch one cited record: by its own key, from its own table, with a different query than Research used */
  private idQuery(it: Item): { sql: string; check: (rows: Record<string, string | null>[]) => string | null; pick?: (rows: Record<string, string | null>[]) => Record<string, string | null>[] } | undefined {
    const m = it.meta ?? {};
    const norm = (s: string) => s.toLowerCase().replace(/…/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
    const contains = (big: string, small: string) => { const s = norm(small).split(" ").slice(0, 14).join(" "); return !s || norm(big).includes(s); };
    if (it.kind === "prac_signal" && m.row_id) return { sql: `SELECT row_id, signal, meeting FROM aprime_lab.prac_signal WHERE row_id = ${lit(m.row_id)}`,
      check: (r) => !r.length ? "the PRAC row is not in the catalogue" : !it.text.toLowerCase().includes(String(r[0].signal).toLowerCase().slice(0, 30)) ? "the PRAC signal text differs" : null };
    if (m.passage_id) return { sql: `SELECT d.doc_id, d.authority, d.published, p.text FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id WHERE p.passage_id = ${lit(m.passage_id)}`,
      check: (r) => !r.length ? "the passage is not in the regulator table" : !contains(String(r[0].text), it.text.split(" … ").pop() ?? "") ? "the quoted words are not in the regulator's passage" : null };
    if (m.product && m.path) return { sql: `SELECT s.version, s.text, v.latest FROM aprime_lab.spl_section s LEFT JOIN (SELECT product, max(version) AS latest FROM aprime_lab.spl_version GROUP BY product) v ON v.product = s.product
WHERE s.product = ${lit(m.product)} AND s.path = ${lit(m.path)} AND s.purpose IN ('hero', 'score')`,
      pick: (r) => r.filter((x) => contains(String(x.text), it.text.split(" … ")[0])),
      check: (r) => !r.length ? "the label section is not in the label table" : r[0].latest && Number(r[0].latest) > Number(r[0].version) ? `a newer label version (v${r[0].latest}) exists` : !r.some((x) => contains(String(x.text), it.text.split(" … ")[0])) ? "the quoted words are not in that label section" : null }; // a label can carry several unnamed sections under one path
    if (it.kind === "fda_potential_signal" && m.quarter) return { sql: `SELECT quarter, term, fda_action, as_of FROM aprime_files.aems WHERE quarter = ${lit(m.quarter)} AND term = ${lit(m.term ?? "")}`,
      // one quarter can list the same term for several products, each with its own action: any of them may be the one cited,
      // and the Skeptic model is shown only that one (another product's action is not evidence about this drug)
      pick: (r) => r.filter((x) => norm(it.text).includes(norm(String(x.fda_action)).slice(0, 60))),
      check: (r) => !r.length ? "the FDA list row is not on that quarter's page" : !r.some((x) => norm(it.text).includes(norm(String(x.fda_action)).slice(0, 60))) ? "FDA's stated action differs" : null };
    if (it.kind === "sentinel_study") return { sql: `SELECT study_id, status, snapshot FROM aprime_files.sentinel WHERE study_id = ${lit(it.eid)}`,
      check: (r) => !r.length ? "the Sentinel study is not in the table" : !it.text.includes(String(r[0].status)) ? `the Sentinel status is now ${r[0].status}` : null };
    if (it.kind === "search_without_result" && it.source === "fda_potential_signal_lists") // a different net: the drug alone, any reaction
      return { sql: `SELECT quarter, term FROM aprime_files.aems WHERE lower(products) LIKE ${lit("%" + this.q.substance.toLowerCase() + "%")}`,
        check: (r) => { const hit = r.filter((x) => this.terms.concat(this.broad).some((t) => String(x.term).toLowerCase().includes(t))); return hit.length ? `an FDA row for ${this.q.substance} does mention it (${hit[0].quarter}: ${hit[0].term})` : null; } };
    if (it.kind === "search_without_result" && it.source === "mhra_drug_safety_updates") // a different net: any UK record on the drug or its class, any wording
      return { sql: `SELECT p.passage_id, d.title, p.text FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id WHERE d.regulator = 'UK' AND (${[this.q.substance.toLowerCase(), ...this.classTerms].filter((x) => x.length >= 4).map((n) => `lower(d.substances) LIKE ${lit("%" + n + "%")}`).join(" OR ")})`,
        check: (r) => { const hit = r.filter((x) => this.terms.concat(this.broad).some((t) => String(x.text).toLowerCase().includes(t))); return hit.length ? `an MHRA record on ${this.q.substance} does mention it (${hit[0].passage_id})` : null; } };
    if (it.kind === "spl_versions") return { sql: `SELECT sum(CASE WHEN ${"(" + this.terms.map((t) => `lower(text) LIKE ${lit("%" + t + "%")}`).join(" OR ") + ")"} THEN 1 ELSE 0 END) AS n FROM aprime_lab.spl_section WHERE inn = ${lit(this.q.substance.toLowerCase())} AND purpose IN ('hero', 'score')`, // the later 2026 versions kept for the replay are not part of the search
      check: (r) => { const n = Number(r[0]?.n ?? 0), said = Number(it.text.match(/Sections matching: (\d+)/)?.[1] ?? 0); return n !== said ? `a separate count over the same label versions finds ${n} matching section(s), the search said ${said}` : null; } };
    return undefined;
  }

  /** Second source for the U.S. label column: openFDA's copy of each label (api.fda.gov, registered in Zetaris as the REST
   *  table aprime_openfda.label), joined to our label table by SPL set id in one federated query. A quoted label section
   *  must appear in openFDA's text of the same section of the same version; a "no label mentions it" search must not be
   *  contradicted by openFDA's full text. A different version is not compared (counted as "other version"). */
  private async openFdaCheck(targets: Item[], verified: string[], contradicted: string[], fetched: Map<string, string>, qids: string[], round: number) {
    const out = { checked: 0, verified: 0, contradicted: 0, notComparable: 0, unavailable: false };
    const labels = targets.filter((i) => i.meta?.product && /^label_/.test(i.kind)), searched = targets.filter((i) => i.kind === "spl_versions");
    if (!labels.length && !searched.length) return out;
    const products = [...new Set(labels.map((i) => i.meta!.product))];
    const FIELDS: [RegExp, string][] = [[/boxed/i, "bw"], [/^5 |warnings and precautions/i, "wc"], [/^4 |contraindication/i, "ci"], [/^6 |adverse reactions/i, "ar"], [/^17 |patient counseling/i, "pi"], [/medication guide/i, "mg"]];
    const sql = `SELECT s.product, s.inn, s.version AS ours, o.version AS openfda_version, o.effective_time, o.bw, o.wc, o.ci, o.ar, o.pi, o.mg, o.alltext
FROM (SELECT DISTINCT setid, product, inn, version FROM aprime_lab.spl_section WHERE purpose IN ('hero', 'score') AND (inn = ${lit(this.q.substance.toLowerCase())}${products.length ? ` OR product IN (${products.map(lit).join(", ")})` : ""})) s
JOIN (SELECT r.set_id AS set_id, r.version AS version, r.effective_time AS effective_time, concat_ws(' ', r.boxed_warning) AS bw, concat_ws(' ', r.warnings_and_cautions) AS wc,
  concat_ws(' ', r.contraindications) AS ci, concat_ws(' ', r.adverse_reactions) AS ar, concat_ws(' ', r.information_for_patients) AS pi, concat_ws(' ', r.spl_medguide) AS mg,
  concat_ws(' ', r.boxed_warning, r.warnings_and_cautions, r.contraindications, r.adverse_reactions, r.information_for_patients, r.spl_medguide, r.use_in_specific_populations, r.recent_major_changes) AS alltext
  FROM aprime_openfda.label LATERAL VIEW explode(results) t AS r) o ON o.set_id = s.setid`;
    const r = await this.sql.run(sql, "Skeptic: the same labels from a second source (openFDA REST table), joined by SPL set id", "skeptic");
    qids.push(r.receipt.qid);
    if (!r.ok) { out.unavailable = true; return out; }
    const rows = asObjects(r.result);
    const norm = (x: string) => x.toLowerCase().replace(/…/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
    const flag = (it: Item, why: string | null) => {
      out.checked++;
      if (why) { out.contradicted++; contradicted.push(`${it.eid}: ${why}`); void this.cs.contradicted(it.eid, why, round); const k = verified.indexOf(it.eid); if (k >= 0) verified.splice(k, 1); }
      else out.verified++;
    };
    for (const it of labels) {
      const row = rows.find((x) => x.product === it.meta!.product);
      if (!row) continue;
      if (Number(row.openfda_version) !== Number(it.meta!.version)) { out.notComparable++; fetched.set(it.eid, `${fetched.get(it.eid) ?? ""} | openFDA has v${row.openfda_version}, not v${it.meta!.version}`); continue; }
      const field = FIELDS.find(([re]) => re.test((it.meta!.path ?? "").split(" > ")[0]))?.[1];
      const quote = norm(it.text.split(" … ")[0]).split(" ").slice(0, 14).join(" ");
      const ok = !quote || norm(String(row[field ?? "alltext"] ?? "")).includes(quote) || norm(String(row.alltext ?? "")).includes(quote);
      // a section we do not fetch from openFDA (dosage, indications, ...) cannot contradict: it is counted as not compared
      if (!ok && !field) { out.notComparable++; fetched.set(it.eid, `${fetched.get(it.eid) ?? ""} | openFDA: section not fetched`); continue; }
      flag(it, ok ? null : `openFDA's copy of ${it.meta!.product} v${row.openfda_version} does not have the quoted words in that section`);
      fetched.set(it.eid, `${fetched.get(it.eid) ?? ""} | openFDA v${row.openfda_version}: ${ok ? "same words found" : "words not found"}`);
    }
    for (const it of searched) {
      const said = Number(it.text.match(/Sections matching: (\d+)/)?.[1] ?? 0);
      const mine = rows.filter((x) => x.inn === this.q.substance.toLowerCase()), own = mine.filter((x) => Number(x.openfda_version) === Number(x.ours));
      out.notComparable += mine.length - own.length;
      if (!own.length) continue;
      const hits = own.flatMap((x) => this.terms.filter((t) => norm(String(x.alltext ?? "")).includes(norm(t))).map((t) => `${x.product} v${x.ours}: "${t}"`));
      flag(it, said === 0 && hits.length ? `openFDA's copy of the label does mention it (${hits.slice(0, 2).join("; ")})` : said > 0 && !hits.length ? "openFDA's copy of the same label versions mentions none of the search terms" : null);
    }
    return out;
  }

  /** Skeptic, after each draft: try to break it. 1) fetch every record that props up a finding or a "holds" verdict a
   *  second, independent way and compare; 2) a Nemotron pass asks of each claim whether its records support it. */
  async falsify(d: Draft, round: number) {
    const claimCites = [...COLS.flatMap((c) => d.cells[c].cites), ...d.hypotheses.filter((h) => h.verdict !== "open").flatMap((h) => [...h.for, ...h.against])];
    const targets = [...new Set([...this.cs.holdingRecords(), ...claimCites])].map((id) => this.items.find((i) => i.eid === id)).filter((x): x is Item => !!x).slice(0, 14);
    const verified: string[] = [], contradicted: string[] = [], unchecked: string[] = [], fetched = new Map<string, string>(), qids: string[] = [];
    // a record as Research returned it: who said it, when, where, and its words (never the words alone)
    const whole = (it: Item) => [it.title, it.date, it.section].filter(Boolean).join(" | ") + `: ${it.text}`;
    for (const it of targets) {
      const q = this.idQuery(it);
      if (!q) { unchecked.push(it.eid); continue; }
      const r = await this.sql.run(q.sql, `Skeptic: fetch ${it.eid} independently`, "skeptic");
      qids.push(r.receipt.qid);
      const rows = asObjects(r.result);
      const why = r.ok ? q.check(rows) : `query failed: ${r.receipt.error}`;
      if (why) { contradicted.push(`${it.eid}: ${why}`); await this.cs.contradicted(it.eid, why, round); } else verified.push(it.eid);
      const shown = q.pick?.(rows).length ? q.pick(rows) : rows;
      // a row with a text column is shown around the quoted words; a structured row (an FDA list entry, a Sentinel study,
      // a PRAC catalogue row, a count) is shown whole, as Research returned it, with the fields fetched again by key
      fetched.set(it.eid, shown.some((x) => x.text) ? shown.map((x) => `${Object.entries(x).filter(([k]) => k !== "text").map(([k, v]) => `${k} ${v}`).join(", ")}: ${recordView(String(x.text), it.text, this.terms)}`).join(" | ")
        : `${whole(it)} (fetched again by its own key: ${shown.map((x) => Object.entries(x).map(([k, v]) => `${k} ${v}`).join(", ")).join(" | ") || "no row"})`);
    }
    const second = await this.openFdaCheck(targets, verified, contradicted, fetched, qids, round);
    // claims vs records, judged by the model
    type Claim = { what: string; cites: string[]; hid?: string; main?: boolean; holds?: boolean; verdict?: string; for?: string[]; against?: string[] };
    const claims: Claim[] = [...COLS.map((c) => ({ what: `${COLUMN_NAME[c]}: ${d.cells[c].finding}`, cites: d.cells[c].cites })),
      ...d.hypotheses.filter((h) => h.verdict !== "open").map((h) => ({ what: `Explanation ${h.id} ${h.name}: ${h.why} (the draft judges it ${h.verdict}${h.verdict === "holds" && /^main/i.test(h.role ?? "") ? ", the main cause" : ""}; filed for: ${h.for.join(", ") || "none"}; filed against: ${h.against.join(", ") || "none"})`, cites: [...h.for, ...h.against],
        hid: h.id, main: h.verdict === "holds" && /^main/i.test(h.role ?? ""), holds: h.verdict === "holds", verdict: h.verdict, for: h.for, against: h.against }))].filter((c) => c.what.length > 20);
    // the explanations themselves, stated as the Planner framed them (not the draft's verdict or its reasoning), so the
    // Skeptic says what each record shows about the explanation, not whether the record is accurate
    const expl = d.hypotheses.filter((h) => h.verdict !== "open").map((h) => { const plan = this.hypotheses.find((p) => p.id === h.id && p.name === h.name);
      return { h, text: `${h.id} "${h.name.replace(/_/g, " ")}"${plan?.test ? ` (what would confirm or rule it out: ${plan.test})` : ""}`, ids: [...new Set([...h.for, ...h.against])] }; });
    const rec0 = (x: string) => `  [${x}] ${fetched.get(x) ?? ((it) => it ? whole(it) : "(no record)")(this.items.find((it) => it.eid === x))}`;
    const system = `You are the Skeptic. Try to break the draft using only the records shown (fetched again, independently of the draft).
PART 1. For each claim: does it follow from the records under it ("supports"), does a record contradict it ("contradicts"), or is there not enough ("not_enough")? For an explanation, the claim is the draft's verdict on it.
${claims.map((c, i) => `#${i + 1} ${c.what}\n${c.cites.map(rec0).join("\n") || "  (no record cited)"}`).join("\n")}
PART 2. Each explanation below is a possible reason why the regulators' positions differ. For every record listed under it, say what the record shows about that explanation: "shows_true" (the record shows the explanation, or its own side of it, is the case: an explanation that compares two regulators is shown by a record of each), "shows_false" (the record shows the explanation, or its side of it, is not the case), or "silent" (the record says nothing that decides it). This is not whether the record is accurate and not whether the draft's verdict is right: only what the record says about the explanation. A record that only does not mention something is silent. A search that found nothing is silent.
${expl.map((e) => `${e.text}\n${e.ids.map(rec0).join("\n") || "  (no record cited)"}`).join("\n") || "(no explanation judged)"}
For each explanation also say whether it is a cause of the difference or only restates the difference itself ("restates": true).
Name any cited record that does not bear on its claim at all ("irrelevant", in PART 1).
Reply with one JSON object only: {"claims":[{"n":1,"judgement":"supports|contradicts|not_enough","irrelevant":["id"],"why":"short"}],"explanations":[{"h":"H1","records":{"record id":"shows_true|shows_false|silent"},"restates":false,"why":"short"}]}`;
    const j = await this.model("fast", "skeptic", `falsify:${this.q.id}:r${round}`, system, () => JSON.stringify({ claims: claims.map((_, i) => ({ n: i + 1, judgement: "not_enough", why: "offline stub" })) }), round, 10000);
    // a reply the Skeptic could not finish leaves the claims unjudged: say so, so nobody approves on a check that did not run
    const unjudged = !(Array.isArray(j.claims) && (j.claims as { why?: string }[]).some((x) => x.why !== "offline stub"));
    type J = { n: number; judgement: string; why: string; irrelevant?: unknown };
    type E = { h: string; records?: Record<string, unknown>; restates?: unknown; why?: string };
    const judged = (Array.isArray(j.claims) ? j.claims : []) as J[];
    const read = (Array.isArray(j.explanations) ? j.explanations : []) as E[];
    const at = (x: J) => claims[Number(x.n) - 1];
    const claimOf = (hid: string) => judged.find((x) => at(x)?.hid === hid);
    const readOf = (hid: string) => read.find((x) => String(x.h) === hid && x.records && typeof x.records === "object" && Object.keys(x.records).length);
    const stance = (hid: string, id: string) => String(readOf(hid)?.records?.[id] ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const claimContra = judged.filter((x) => x.judgement === "contradicts").map((x) => `claim ${x.n} (${clip(at(x)?.what ?? "", 80)}): ${x.why}`);
    // records filed the wrong way round, from the Skeptic's reading of each record (a coverage check: the Evaluator
    // model may overrule it); moving a record also means the verdict must follow it
    const reversed = expl.filter((e) => claimOf(e.h.id)?.judgement !== "contradicts").flatMap((e) => [
      ...e.h.for.filter((id) => stance(e.h.id, id) === "shows_false").map((id) => `${e.h.id}: ${id} is filed for it but shows it is not the case`),
      ...e.h.against.filter((id) => stance(e.h.id, id) === "shows_true").map((id) => `${e.h.id}: ${id} is filed against it but shows it is the case`)]);
    const irrelevant = judged.flatMap((x) => (Array.isArray(x.irrelevant) ? x.irrelevant.map(String) : []).filter((id) => at(x)?.cites.includes(id)).map((id) => `${id} for claim ${x.n} (${clip(at(x)?.what ?? "", 60)})`));
    const holds = expl.filter((e) => e.h.verdict === "holds"), out = expl.filter((e) => e.h.verdict === "ruled_out");
    const restatesIds = holds.filter((e) => String(read.find((x) => String(x.h) === e.h.id)?.restates) === "true").map((e) => e.h.id);
    const restates = restatesIds.map((hid) => `${hid} (${clip(expl.find((e) => e.h.id === hid)!.text, 60)})`);
    const whyOf = (hid: string) => read.find((x) => String(x.h) === hid)?.why ?? claimOf(hid)?.why ?? "";
    // every explanation that holds needs a record that shows it (an inference no record states is not a finding), and
    // every ruled-out one a record that shows it is not the case (silence is not a record against it); without the
    // Skeptic's reading of the records, its judgement of the verdict decides
    const unsupportedIds = holds.filter((e) => readOf(e.h.id) ? !e.h.for.some((id) => stance(e.h.id, id) === "shows_true") : claimOf(e.h.id)?.judgement === "not_enough").map((e) => e.h.id);
    const isMain = (hid: string) => /^main/i.test(d.hypotheses.find((h) => h.id === hid)?.role ?? "");
    const unsupported = unsupportedIds.map((hid) => `${hid}${isMain(hid) ? " (main cause)" : ""}: ${whyOf(hid)}`);
    const mainUnsupported = unsupportedIds.filter(isMain).map((hid) => `${hid}: ${whyOf(hid)}`);
    const outUnsupportedIds = out.filter((e) => claimOf(e.h.id)?.judgement !== "contradicts" && (readOf(e.h.id) ? !e.h.against.some((id) => stance(e.h.id, id) === "shows_false") : claimOf(e.h.id)?.judgement === "not_enough")).map((e) => e.h.id);
    const outUnsupported = outUnsupportedIds.map((hid) => `${hid}: ${whyOf(hid)}`);
    const causes = skepticCauses(j, d);
    const rec = { round, records: targets.length, verified: verified.length, contradicted: [...contradicted, ...claimContra], reversed, unjudged, irrelevant, restates, restatesIds, mainUnsupported, unsupported, unsupportedIds, outUnsupported, outUnsupportedIds, causes, unchecked: unchecked.length,
      claims: claims.length, claimsSupported: judged.filter((x) => x.judgement === "supports").length, claimsNotEnough: judged.filter((x) => x.judgement === "not_enough").length, second };
    this.falsifications.push(rec);
    this.trace.emit({ agent: "skeptic", kind: rec.contradicted.length ? "reject" : "check", round, receipts: qids, detail: { falsification: rec },
      summary: `Skeptic tried to break the draft: ${targets.length} records fetched again by their own keys, ${verified.length} verified · ${contradicted.length} contradicted; ${second.unavailable ? "openFDA not reachable" : `U.S. label against openFDA's copy: ${second.verified} agree · ${second.contradicted} contradict · ${second.notComparable} other version`}; ${claims.length} claims judged: ${rec.claimsSupported} supported · ${claimContra.length} contradicted · ${rec.claimsNotEnough} not enough${rec.contradicted.length ? ` — ${clip(rec.contradicted.join("; "), 200)}` : ""}` });
    return rec;
  }

  async evaluate(d: Draft, round: number): Promise<{ v: Verdict; gaps: Gap[] }> {
    await this.falsify(d, round);
    const gaps = this.rubric(d);
    const hard = gaps.filter((g) => g.hard), soft = gaps.filter((g) => !g.hard);
    const list = (gs: Gap[]) => gs.map((g, i) => `${i + 1}. ${g.column}: ${g.problem}`).join(" | ") || "none";
    const system = `You are the Evaluator. Check a draft "why" chain against the evidence items it may cite. For each column decide whether the cited records support the finding and whether the kind of record is strong enough (a press release is not the regulator's own conclusion; absence from a U.S. label is not evidence that the FDA has not acted; a list entry about a whole drug class is not a conclusion about one drug).
Also check each competing explanation the draft judged (holds / ruled_out / open): do its records for and against really decide it? Say which explanation stands and why the others fall. A why of type "undetermined" (the public records show where each regulator stands but not why) is a valid conclusion when no record shows a cause: judge it on whether the cells are right and no cause is claimed.
${this.disputes.some((x) => x.round === round && x.accepted) ? `The drafting agent disputed some findings, with a record and its exact words (these are the drafting agent's claims, not evidence; check them against the evidence items): ${this.disputes.filter((x) => x.round === round && x.accepted).map((x) => `"${x.item}" — ${x.reason} [${x.record_ids.join(", ")}: "${x.quote}"]`).join(" | ")}\n` : ""}Rules the code enforces whatever you say (do not ask for anything they forbid): a search that found nothing neither holds nor rules out an explanation (it stays open) and is not a reason; "holds" needs a record that shows it and "ruled_out" a record that shows it false; every date comes from a record the same sentence cites; when no explanation holds, the why is undetermined.
Checks computed by code that must hold: ${list(hard)}
Coverage checks computed by code (advice, not rules: weigh each against the evidence yourself): ${list(soft)}
${this.cs.enabled ? `Case state (World Model), with each verdict's history:\n${this.cs.describe()}\n` : ""}DRAFT:
${JSON.stringify(d)}
EVIDENCE ITEMS:
${this.pack()}
Reply with one JSON object only: {"verdict":"approve|revise","columns":{"EU":{"supported":true,"note":"short"},"UK":{...},"US_label":{...},"US_regulator":{...}},"hypotheses":{"H1":{"supported":true,"note":"short"}},"feedback":"one or two short sentences to the Planner, naming what is missing"}`;
    const stub = () => JSON.stringify({ verdict: gaps.length ? "revise" : "approve", feedback: gaps.map((g) => g.problem).join(" ") || "Offline stub: no check failed." });
    const v = (await this.model("deep", "evaluator", `eval:${this.q.id}:r${round}`, system, stub, round, 9000)) as unknown as Verdict; // the deep lane reasons before it answers: 4000 cut replies short
    const raw = v as unknown as Record<string, unknown>;
    const columns = (v.columns ?? Object.fromEntries(COLS.filter((c) => raw[c]).map((c) => [c, raw[c]]))) as Record<string, { supported: boolean | string; note: string }>;
    const allSupported = COLS.every((c) => columns[c] && String(columns[c].supported) === "true");
    let modelSays = v.verdict === "approve" || v.verdict === "revise" ? v.verdict : allSupported ? "approve" : "revise";
    // an approval that itself names something missing is read as a send-back (the model said what is missing)
    if (modelSays === "approve" && /\b(missing|not documented|no evidence cited|gaps?|should add|add an? |consider (?:adding|searching)|not (?:included|searched|checked))\b/i.test(String(v.feedback ?? "").replace(/\b(?:no|nothing|without|none)\b[^.;]*/gi, "").replace(/[^.;]*\b(?:not required|optional(?:ly)?|if available|nice to have)\b[^.;]*/gi, ""))) modelSays = "revise"; // a negated clause ("no gaps identified") is not a gap
    const modelFeedback = String(v.feedback ?? "") || COLS.filter((c) => columns[c] && String(columns[c].supported) !== "true").map((c) => `${COLUMN_NAME[c]}: ${columns[c].note}`).join(" ");
    let final: "approve" | "revise", decidedBy: string, reply: { n: number; accept: boolean; reason: string }[] | undefined;
    if (hard.length) { final = "revise"; decidedBy = modelSays === "revise" ? "model and checks" : "checks (must-hold)"; }
    else if (modelSays === "revise") { final = "revise"; decidedBy = soft.length ? "model and checks" : "model"; }
    else if (soft.length) {
      // the model approved but code raised coverage checks: the model answers each once, then the call is made
      const rs = `You approved this draft, with this note: "${modelFeedback}". Code raised these coverage checks: ${list(soft)}
For each check decide, on the evidence, one of two (both are normal outcomes):
- "send_back": what the check asks for could change a finding, a verdict or the recommendation. The draft goes back to the Planner for one more round.
- "overrule": the evidence items already settle it, or what it asks for could not change any finding, verdict or recommendation. Say which.
DRAFT:
${JSON.stringify(d)}
EVIDENCE ITEMS:
${this.pack()}
Reply with one JSON object only: {"replies":[{"n":1,"decision":"send_back|overrule","reason":"short"}]}`;
      const r = await this.model("deep", "evaluator", `rebut:${this.q.id}:r${round}`, rs, () => JSON.stringify({ replies: soft.map((_, i) => ({ n: i + 1, decision: "send_back", reason: "offline stub" })) }), round, 6000);
      // a reply without a readable decision leaves that check standing (it is shown as "no answer")
      reply = (Array.isArray(r.replies) ? r.replies : []).map((x: Record<string, unknown>) => ({ n: Number(x.n), accept: String(x.decision ?? "") !== "overrule", reason: String(x.reason ?? "") }));
      const accepted = soft.filter((_, i) => reply!.find((x) => x.n === i + 1)?.accept !== false);
      if (accepted.length) { final = "revise"; decidedBy = "checks (model accepted after replying)"; } else { final = "approve"; decidedBy = "model (overruled the coverage checks with reasons)"; }
    } else { final = "approve"; decidedBy = "model"; }
    const verdict: Verdict = { verdict: final, columns: columns as Verdict["columns"], feedback: modelFeedback };
    const f = this.falsifications.at(-1), uniq = (xs: string[]) => [...new Set(xs)];
    const ri = soft.findIndex((g) => g.problem.startsWith("Explanations that only restate"));
    const restatesOverruled = ri >= 0 && reply?.find((x) => x.n === ri + 1)?.accept === false;
    this.carry = final === "approve" ? undefined : { round, hyps: Object.fromEntries(d.hypotheses.map((h) => [h.id, { verdict: h.verdict, for: h.for, against: h.against }])),
      restates: uniq([...(restatesOverruled ? [] : f?.restatesIds ?? []), ...this.unanswered.restates]),
      unsupported: uniq([...(f?.unsupportedIds ?? []), ...this.unanswered.unsupported]), outUnsupported: uniq([...(f?.outUnsupportedIds ?? []), ...this.unanswered.outUnsupported]) };
    const why = final === "approve" ? `Approved: ${clip(modelFeedback || "every column is backed by the right kind of record", 200)}`
      : `Sent back: ${clip([...hard, ...soft.filter((_, i) => reply?.find((x) => x.n === i + 1)?.accept !== false)].map((g) => g.problem).join(" ") || modelFeedback, 420)}`;
    this.trace.emit({ agent: "evaluator", kind: final === "approve" ? "approve" : "reject", round, summary: `${why} [decided by: ${decidedBy}]`,
      detail: { gaps, hard, soft, model: v, modelSays, modelFeedback, decidedBy, reply } });
    return { v: { ...verdict, decidedBy } as Verdict, gaps: final === "approve" ? [] : gaps };
  }

  // ---------- Planner (replan) ----------
  async replan(gaps: Gap[], v: Verdict, round: number) {
    const untried = SOURCES.filter((s) => !this.tried.has(s.id));
    const system = `You are the Planner. The Evaluator sent the draft back.
Evaluator feedback: ${v.feedback}
Checks raised: ${gaps.map((g) => `${g.column} (${g.hard ? "must hold" : "coverage"}): ${g.problem}`).join(" | ") || "none"}
${this.cs.enabled ? `Case state (World Model):\n${this.cs.describe()}\n` : ""}Sources not tried yet:
${untried.map((s) => `- ${s.id} [${COLUMN_NAME[s.column]}]: ${s.describe}`).join("\n")}
Choose the sources Research should query next, if any would change the answer. You may choose none if the problem is in the draft, not in the evidence.
Reply with one JSON object only: {"add_sources":["source_id"],"reason":"one sentence"}`;
    const p = await this.model("fast", "planner", `replan:${this.q.id}:r${round}`, system, () => JSON.stringify({ add_sources: [...new Set(gaps.flatMap((g) => g.want))], reason: "offline stub" }), round);
    const chosen = [...new Set(cleanIds(p.add_sources).filter((x) => untried.some((s) => s.id === x)))];
    this.trace.emit({ agent: "planner", kind: "replan", round, summary: `New plan: ${chosen.join(", ") || "no new source; the Writer revises from the same records"}${p.reason ? ` — ${clip(String(p.reason), 160)}` : ""}`, detail: { chosen, reason: p.reason } });
    return chosen;
  }

  // ---------- Skeptic, before the draft: look where the draft will not ----------
  async skeptic(round: number) {
    const kept: string[] = [], dropped: string[] = [];
    const notes: string[] = [];
    // 1) broad words in every U.S. label section: is the reaction written somewhere under another name?
    if (this.broad.length && this.tried.has("us_label_sections") && !this.swept) {
      const { result, receipt } = await this.sql.run(skepticSql.labelSweep(this.q, this.broad), `Skeptic: broad words (${this.broad.join(", ")}) anywhere in the U.S. labels`, "skeptic");
      const hits = asObjects(result).map((x, i) => ({ n: i + 1, where: `${x.product} v${x.version} — ${x.path}`, text: around(x.text ?? "", this.broad, 360), eid: splEid(x), x }));
      this.swept = true;
      this.trace.emit({ agent: "skeptic", kind: "sql", round, receipts: [receipt.qid], summary: `Broad-word sweep of every U.S. label section: ${asObjects(result).length} section(s) mention ${this.broad.join(" / ")}` });
      // every hit is read (in batches of 12, warning sections first), not only the first few
      const related: string[] = [];
      for (let b = 0; b < hits.length; b += 12) {
        const part = hits.slice(b, b + 12);
        const system = `You are the Skeptic. Before anyone concludes that the U.S. label does not describe "${this.q.reaction}", check these label passages that contain broad words. For each, is it:
- "same": the same adverse reaction (a synonym or a description of it, with any qualifier the question names),
- "related": a broader or narrower form of it (for example the reaction without the qualifier the question names), not the same,
- "different": something else.
${part.map((h) => `#${h.n} ${h.where}\n${h.text}`).join("\n\n")}
Reply with one JSON object only: {"judgements":[{"n":${part[0].n},"match":"same|related|different","why":"short"}]}`;
        const j = await this.model("fast", "skeptic", `skeptic:${this.q.id}:b${b / 12 + 1}`, system, () => JSON.stringify({ judgements: part.map((h) => ({ n: h.n, match: "different", why: "offline stub: not judged" })) }), round, 2500);
        for (const h of part) {
          const jj = ((j.judgements ?? []) as { n: number; match?: string; same_reaction?: boolean; why: string }[]).find((x) => Number(x.n) === h.n);
          const m = String(jj?.match ?? (jj?.same_reaction ? "same" : "different"));
          if (m === "same" || m === "related") {
            this.collect("us_label_sections", [h.x], receipt);
            const it = this.items.find((i) => i.eid === h.eid);
            if (it && m === "related") it.note = `Skeptic: related to the reaction but not the same: ${jj?.why ?? ""}`;
            if (m === "same") this.sameReaction.add(h.eid);
            (m === "same" ? kept : related).push(`${h.where}: ${jj?.why ?? ""}`);
          } else dropped.push(`${h.where}: ${jj?.why ?? "not judged"}`);
        }
      }
      if (hits.length) {
        notes.push(`Skeptic label sweep (all ${hits.length} passages read): ${kept.length} the same reaction, ${related.length} a related but not the same form${related.length ? ` (${related.slice(0, 3).join("; ")})` : ""}, ${dropped.length} different.`);
        this.trace.emit({ agent: "skeptic", kind: "check", round, summary: `Read all ${hits.length} passages. Same reaction under another name: ${kept.length ? clip(kept.join("; "), 160) : "none"}. Related, not the same: ${related.length ? clip(related.join("; "), 200) : "none"}. Different: ${dropped.length}` });
      }
    }
    // 2) FDA rows that match the reaction word but not this drug or its class (once)
    if (round === 1) {
      const { result, receipt } = await this.sql.run(skepticSql.termOnlyFda(this.terms), `Skeptic: FDA list rows matching the reaction words, any drug`, "skeptic");
      const sub = [this.q.substance.toLowerCase(), ...this.classTerms];
      const other = asObjects(result).filter((x) => !sub.some((t) => (x.products ?? "").toLowerCase().includes(t)));
      if (other.length) {
        const names = other.map((x) => `${clip(x.products ?? "", 70)} (${x.quarter}: ${x.term})`);
        notes.push(`FDA list rows that match the words but name other drugs (NOT evidence for ${this.q.substance}): ${names.join("; ")}.`);
        dropped.push(...names);
      }
      this.trace.emit({ agent: "skeptic", kind: "check", round, receipts: [receipt.qid], summary: other.length ? `Blocked ${other.length} FDA row(s) that match the words but name other drugs: ${clip(other.map((x) => clip(x.products ?? "", 50)).join("; "), 200)}` : `No FDA rows match the words for other drugs` });
    }
    return { kept, dropped, notes: notes.join("\n") };
  }

  /** hospital exposure: one SQL across the three systems, aggregate only (the agent role cannot see patient ids). Run
   *  before the first draft, so the recommendation is written knowing how many patients here take the drug. */
  async exposureQuery() {
    const sql = federatedSql(this.q, this.terms, this.classTerms);
    const f = await this.sql.run(sql, `This hospital's drugs (MySQL) joined on the drug to EU records, U.S. label sections (Postgres) and FDA list rows (S3)`, "research");
    this.exposure = asObjects(f.result)[0];
    const ex = this.exposure ?? {};
    this.trace.emit({ agent: "research", kind: "sql", round: 1, receipts: [f.receipt.qid],
      summary: this.exposure ? `One join across ${f.receipt.systems.length} systems on ${this.q.substance}: ${ex.patients ?? 0} patients here; EU records naming it ${ex.eu_records_naming_it ?? 0}; U.S. label sections ${ex.us_label_sections_naming_it ?? 0}; FDA list rows ${ex.fda_list_rows_naming_it ?? 0}`
        : `One join across ${f.receipt.systems.length} systems: ${this.q.substance} is not dispensed in this hospital, so the join (keyed on the hospital's drugs) returns no row` });
    return { sql, qid: f.receipt.qid };
  }
  patientsHere() { return Number(this.exposure?.patients ?? 0); }

  // ---------- the loop ----------
  async run(): Promise<Outcome> {
    const verdicts: Verdict[] = [], allGaps: Gap[][] = [];
    this.trace.emit({ agent: "system", kind: "info", summary: `Question: ${this.q.label}` });
    await this.research(await this.plan(), 1);
    await this.chronology(1);
    let sk = await this.skeptic(1);
    const fx = await this.exposureQuery();
    let draft = await this.write(1, sk.notes);
    let { v, gaps } = await this.evaluate(draft, 1);
    verdicts.push(v); allGaps.push(gaps);
    let round = 1;
    const skAll = { kept: [...sk.kept], dropped: [...sk.dropped] };
    const remember = () => { this.prevCells = Object.fromEntries(COLS.map((c) => [c, String((c === "US_label" ? draft.cells[c].status : draft.cells[c].stage) ?? "")])); this.prevOption = draft.recommendation.option; this.prevCites = new Set([...COLS.flatMap((c) => draft.cells[c].cites), ...draft.hypotheses.flatMap((h) => [...h.for, ...h.against])]);
      this.askedText = [...gaps.map((g) => g.problem), v.feedback ?? ""].join(" "); };
    remember();
    // two rounds of search and drafting, then up to three repair drafts that answer every finding (no new search)
    while (v.verdict !== "approve" && round < 5) {
      round++;
      if (round <= 2) {
        await this.research(await this.replan(gaps, v, round), round);
        sk = await this.skeptic(round);
        skAll.kept.push(...sk.kept); skAll.dropped.push(...sk.dropped);
      } else {
        this.curRound = round; sk = { kept: [], dropped: [], notes: "" }; this.repairs++;
        this.trace.emit({ agent: "evaluator", kind: "info", round, summary: `Round ${round}, repair ${round - 2} of 3: ${gaps.length + (v.feedback ? 1 : 0)} finding(s) to answer (${gaps.filter((g) => g.hard).length} must-hold); the Writer revises from the same records (no new search).` });
      }
      const added = this.items.filter((i) => i.round === round && i.kind !== "search_without_result").map((i) => `${i.eid} (${i.title}; ${i.section})`);
      const must = gaps.filter((g) => g.hard).map((g, i) => `${i + 1}. ${g.problem}`);
      const asked = `${must.length ? `MUST FIX in this draft (checks that must hold; if any still fails, the draft goes to a person):\n${must.join("\n")}\n` : ""}The Evaluator sent draft ${round - 1} back: ${[...gaps.filter((g) => !g.hard).map((g) => g.problem), v.feedback].filter(Boolean).join(" ")}\nRecords Research added for this round: ${added.join("; ") || "none"}.`;
      draft = round >= 3 ? await this.repair(draft, this.findings(gaps, v), round) : await this.write(round, [asked, sk.notes].filter(Boolean).join("\n"));
      ({ v, gaps } = await this.evaluate(draft, round));
      verdicts.push(v); allGaps.push(gaps);
      remember();
    }
    const status = v.verdict === "approve" ? "approved" : "needs-person";
    if (status !== "approved") this.trace.emit({ agent: "evaluator", kind: "escalate", round, summary: `${round > 2 ? `Two rounds and ${round - 2} repair draft(s)` : "Two rounds"} used. Marked for a person to review; the chain is shown with its open gaps and the drafting agent's replies.` });
    const sk2 = skAll;
    const out: Outcome = { question: this.q, status, rounds: round, draft, verdicts, gaps: allGaps, items: this.items, terms: this.terms, classTerms: this.classTerms, skeptic: { kept: sk2.kept, dropped: sk2.dropped }, hypotheses: this.hypotheses, falsification: this.falsifications, worldModel: this.cs.summary(), disputes: this.disputes };
    const fq = fx.sql;
    out.exposure = this.exposure; out.federatedQid = fx.qid;
    const ex = out.exposure ?? {};
    // cross-check the joined counts against the direct queries Research already ran (a mismatch is flagged, not hidden)
    if (out.exposure && this.tried.has("us_label_sections") && Number(ex.us_label_sections_naming_it ?? 0) !== (this.rowsBy["us_label_sections"] ?? 0))
      this.trace.emit({ agent: "evaluator", kind: "error", summary: `Cross-check: the joined query counts ${ex.us_label_sections_naming_it} U.S. label sections, the direct label query returned ${this.rowsBy["us_label_sections"]}. Shown as a data-layer discrepancy.` });
    const e = await this.sql.run("EXPLAIN QUERY AS " + fq, "Zetaris query plan for the joined query (administrator only)", "research", "admin");
    if (e.ok) {
      out.explain = e.result.data.map((r) => r.join(" ")).join("\n");
      out.pushdown = pushdownSummary(out.explain);
    }
    const bySys = (sys: string) => (out.pushdown ?? []).filter((p) => p.system === sys);
    // read straight from the physical plan: which tables got a filter pushed down, and which were read whole
    const real = (p: { pushed: string }) => p.pushed && !/^IsNotNull\(\w+\)$/.test(p.pushed);
    const say = (sys: string) => { const xs = bySys(sys); if (!xs.length) return `${sys}: not in plan`;
      const pushed = xs.filter(real), whole = xs.filter((p) => !real(p));
      return `${sys}: ${pushed.length ? `${[...new Set(pushed.map((p) => p.table))].join(", ")} filtered at the source (${clip(pushed[0].pushed, 70)})` : "no filter pushed down"}${whole.length ? `; ${[...new Set(whole.map((p) => p.table))].join(", ")} read and filtered in Zetaris` : ""}`; };
    this.trace.emit({ agent: "research", kind: "sql", receipts: [e.receipt.qid], summary: e.ok ? `Zetaris plan: ${["MySQL", "Postgres", "S3"].map(say).join("; ")}` : `Query plan not available (${clip(e.receipt.error ?? "", 120)})` });
    return out;
  }
}

const cleanIds = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => String(x).trim()).filter((x) => byId(x));

// ---------- after the vote ----------
const PATIENT_SECTION = /package leaflet|patient information|medication guide|patient counsel|to (?:give|provide to) patients|advice to give patients|for patients|information for patients/i;
export async function counsel(o: Outcome, models: Models, trace: Trace, runDir?: string, sql?: SqlTool) {
  const patientFacing = o.items.filter((i) => PATIENT_SECTION.test(i.section) && !/^advice for healthcare professionals$/i.test(i.section.trim()));
  if (sql) { // the drug's own patient passages, even when the search terms did not reach them
    const names = [o.question.substance.toLowerCase(), ...o.classTerms].filter((x) => x.length >= 4);
    const r = await sql.run(`SELECT p.passage_id, d.body, d.title, p.section, p.text FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id
WHERE (${names.map((n) => `lower(d.substances) LIKE ${lit("%" + n + "%")}`).join(" OR ")}) AND (${["leaflet", "patient"].map((w) => `lower(p.section) LIKE ${lit("%" + w + "%")}`).join(" OR ")})`, `Regulator texts written for patients on ${o.question.substance}`, "counsel");
    for (const x of asObjects(r.result)) if (PATIENT_SECTION.test(String(x.section)) && !patientFacing.some((i) => i.eid === x.passage_id))
      patientFacing.push({ eid: String(x.passage_id), column: "UK", source: "patient_texts", authority: "primary", kind: "patient_text", title: `${x.body}: ${x.title}`, date: "", section: String(x.section), text: String(x.text), qid: r.receipt.qid });
  }
  if (!patientFacing.length) { // nothing written for patients by a regulator in the evidence: do not let a model invent it
    trace.emit({ agent: "counsel", kind: "info", summary: "No regulator text written for patients is in the evidence for this drug; counseling points are left to the pharmacist." });
    return { report: [], action: "No regulator text written for patients was found for this drug. The pharmacist writes the counseling points.", cites: [] };
  }
  const system = `Write counseling points for a hospital pharmacist after the P&T committee voted to add an in-house reminder about "${o.question.reaction}" with ${o.question.substance}.
The concern is exactly this one, for the people it names; use only texts about it. If none of the texts below is about it, reply with an empty report.
Use ONLY these regulator texts written for patients:
${patientFacing.map((i) => `[${i.eid}] ${i.title} — ${i.section}\n${i.text}`).join("\n\n") || "(none)"}
Rules: plain words; list the symptoms a patient should report and what to do, and any other step these texts ask the pharmacist or patient to take (for example telling every prescriber about the medicine); never say the patient has this risk; never advise stopping, switching or changing the dose yourself (that is the prescriber's call).
Reply with one JSON object only: {"report":["symptom to report, max 12 words"],"action":"what to do if it happens, one sentence","cites":["id"]}`;
  const stub = () => JSON.stringify({ report: ["Offline stub: open the cited leaflet text"], action: "Contact the prescriber or pharmacist without delay.", cites: patientFacing.slice(0, 2).map((i) => i.eid) });
  const r = await models.chat("fast", system, { tag: `counsel:${o.question.id}`, stub, runDir, valid: (t) => !!jsonWith(t, ["report"]) });
  trace.emit({ agent: "counsel", kind: "model", summary: `Counseling points drafted from the regulators' patient texts (${r.source === "offline-stub" ? "offline stub" : r.served})`,
    model: { lane: "fast", requested: r.requested, served: r.served, source: r.source, latencyMs: r.latencyMs, tokens: r.tokens } });
  const j = jsonWith<{ report: string[]; action: string; cites: string[] }>(r.text, ["report"]) ?? JSON.parse(stub());
  const known = new Set(o.items.map((i) => i.eid));
  const list = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []).map(String); // a single point may come back as a string
  return { report: list(j.report).slice(0, 5), action: String(j.action ?? ""), cites: list(j.cites).filter((c) => known.has(c)) };
}
