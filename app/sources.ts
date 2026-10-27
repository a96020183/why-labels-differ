// The evidence registry: every source the agents may use, which Zetaris table holds it, and how Research queries it.
// Agents choose sources by id; Research turns the choice into SQL. Nothing reaches an agent except through run_sql.
import { lit } from "./zetaris.ts";

export type Column = "EU" | "UK" | "US_label" | "US_regulator";
export type Question = { id: string; substance: string; reaction: string; label: string; classTerms?: string[]; note?: string };
export type Source = { id: string; column: Column; system: string; describe: string; authority: "primary" | "secondary"; sql: (q: Question, terms: string[], classTerms: string[], members: string[]) => string };

export const cleanTerms = (xs: unknown, max = 10) =>
  [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x).toLowerCase().replace(/[^a-z0-9 \-]/g, " ").replace(/\s+/g, " ").trim()).filter((x) => x.length >= 3))].slice(0, max);
const likeAny = (col: string, terms: string[]) => terms.length ? "(" + terms.map((t) => `lower(${col}) LIKE ${lit("%" + t + "%")}`).join(" OR ") + ")" : "1=1";
const subst = (col: string, q: Question, cls: string[]) => likeAny(col, [q.substance.toLowerCase(), ...cls]);

const regDoc = (where: string, q: Question, terms: string[], cls: string[]) => `SELECT p.passage_id, d.regulator, d.body, d.doc_type, d.authority, d.title, d.published, d.url, d.scope, d.substances, p.section, p.text
FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id
WHERE ${where} AND ${subst("d.substances", q, cls)} AND (${likeAny("p.text", terms)} OR ${likeAny("p.section", terms)})
ORDER BY d.published DESC, p.passage_id`;

export const SOURCES: Source[] = [
  { id: "ema_announcements", column: "EU", system: "Postgres", authority: "secondary", describe: "EMA news and PRAC meeting highlights (press communications)",
    sql: (q, t, c) => regDoc("d.regulator = 'EU' AND d.doc_type = 'press_release'", q, t, c) },
  { id: "prac_signal_catalogue", column: "EU", system: "Postgres", authority: "primary", describe: "EMA catalogue of PRAC signal recommendations that updated EU product information (2019-2026)",
    sql: (q, t) => `SELECT s.row_id, s.signal, s.meeting, ps.substance FROM aprime_lab.prac_signal s JOIN aprime_lab.prac_substance ps ON ps.row_id = s.row_id
WHERE s.row_id IN (SELECT row_id FROM aprime_lab.prac_substance WHERE lower(substance) LIKE ${lit("%" + q.substance.toLowerCase() + "%")}) AND ${likeAny("s.signal", t)} ORDER BY s.yr, s.mo, ps.substance` },
  { id: "eu_procedure_records", column: "EU", system: "Postgres", authority: "primary", describe: "EMA procedure records: PRAC recommendation texts, EPAR procedural steps (PSUSA / LEG / variations)",
    sql: (q, t, c) => regDoc("d.regulator = 'EU' AND d.doc_type IN ('procedural_record', 'prac_recommendation')", q, t, c) },
  { id: "eu_product_information", column: "EU", system: "Postgres", authority: "primary", describe: "EU product information (SmPC sections 4.4 / 4.8 and package leaflet) from the EPAR",
    sql: (q, t, c) => regDoc("d.regulator = 'EU' AND d.doc_type = 'smpc'", q, t, c) },
  { id: "mhra_drug_safety_updates", column: "UK", system: "Postgres", authority: "primary", describe: "MHRA Drug Safety Update articles",
    sql: (q, t, c) => regDoc("d.regulator = 'UK'", q, t, c) },
  { id: "us_label_sections", column: "US_label", system: "Postgres", authority: "primary", describe: "Current U.S. prescribing information (DailyMed SPL), split by section",
    sql: (q, t) => `SELECT product, version, effective, sec_code, sec_title, path, text FROM aprime_lab.spl_section
WHERE inn = ${lit(q.substance.toLowerCase())} AND purpose IN ('hero', 'score') AND ${likeAny("text", t)} ORDER BY product, sec_code` },
  { id: "us_label_class_members", column: "US_label", system: "Postgres", authority: "primary", describe: "U.S. labels of the OTHER drugs that the EU record names in the same class (connects one regulator's class decision to each U.S. product)",
    sql: (q, t, _c, m) => `SELECT product, inn, version, effective, sec_code, sec_title, path, text FROM aprime_lab.spl_section
WHERE inn IN (${(m.length ? m : ["-"]).map(lit).join(", ")}) AND purpose IN ('hero', 'score') AND ${likeAny("text", t)}
ORDER BY CASE WHEN sec_code IN ('34066-1', '43685-7', '34071-1', '34070-3') THEN 0 WHEN sec_code = '34084-4' THEN 1 ELSE 2 END, inn, path` },
  { id: "fda_potential_signal_lists", column: "US_regulator", system: "S3", authority: "primary", describe: "FDA AEMS (formerly FAERS) quarterly lists of potential signals of serious risks, 2023 Q1 - 2026 Q2",
    sql: (q, t, c) => `SELECT quarter, as_of, products, term, fda_action, page FROM aprime_files.aems WHERE ${subst("products", q, c)} AND ${likeAny("term", t)} ORDER BY quarter` },
  { id: "fda_sentinel", column: "US_regulator", system: "S3", authority: "primary", describe: "FDA Sentinel Initiative drug safety studies (status page snapshot)",
    sql: (q, t, c) => `SELECT study_id, title, product_scope, outcome, date_posted, status, protocol_note, description, snapshot, url FROM aprime_files.sentinel
WHERE (${subst("product_scope", q, c)} OR ${subst("title", q, c)}) AND (${likeAny("outcome", t)} OR ${likeAny("title", t)})` },
];
export const byId = (id: string) => SOURCES.find((s) => s.id === id);

/** Skeptic queries: deliberately broad, to try to break the draft */
export const skepticSql = {
  labelSweep: (q: Question, broad: string[]) => `SELECT product, version, effective, sec_code, sec_title, path, text FROM aprime_lab.spl_section
WHERE inn = ${lit(q.substance.toLowerCase())} AND purpose IN ('hero', 'score') AND ${likeAny("text", broad)}
ORDER BY CASE WHEN sec_code IN ('34066-1', '43685-7', '34071-1', '34070-3') THEN 0 WHEN sec_code IN ('34084-4', '42229-5', '34076-0', '42231-1', '59845-8') THEN 1 ELSE 2 END, product, path`,
  termOnlyFda: (terms: string[]) => `SELECT quarter, products, term, fda_action FROM aprime_files.aems WHERE ${likeAny("term", terms)} ORDER BY quarter`,
  labelVersions: (q: Question) => `SELECT product, max(version) AS version, max(published) AS latest_published FROM aprime_lab.spl_version WHERE inn = ${lit(q.substance.toLowerCase())} GROUP BY product`,
};

/** the one federated SQL: every source joined on the drug. The hospital's drugs (MySQL view) are the key; the EU records
 *  and U.S. label sections (Postgres) and FDA list rows (S3) are aggregated per drug and joined to it. Counts are
 *  sum(CASE ...) rather than count(*) WHERE ...: Zetaris pushed a bare count(*) down to Postgres without its filter. */
export const federatedSql = (q: Question, terms: string[], cls: string[]) => {
  const inn = lit(q.substance.toLowerCase());
  const hit = (col: string) => `CASE WHEN ${likeAny(col, terms)} THEN 1 ELSE 0 END`;
  return `SELECT r.inn, r.patients, coalesce(eu.eu_records, 0) AS eu_records_naming_it, coalesce(us.us_sections, 0) AS us_label_sections_naming_it,
  coalesce(fda.fda_rows, 0) AS fda_list_rows_naming_it
FROM (SELECT inn, sum(patients) AS patients FROM aprime_rx.rx_patients GROUP BY inn) r
LEFT JOIN (SELECT x.inn, sum(${hit("p.text")}) AS eu_records FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id
  JOIN (SELECT DISTINCT inn FROM aprime_rx.rx_patients) x ON lower(d.substances) LIKE concat('%', x.inn, '%') WHERE d.regulator = 'EU' AND d.authority = 'primary' GROUP BY x.inn) eu ON eu.inn = r.inn
LEFT JOIN (SELECT inn, sum(${hit("text")}) AS us_sections FROM aprime_lab.spl_section WHERE purpose IN ('hero', 'score') GROUP BY inn) us ON us.inn = r.inn
LEFT JOIN (SELECT x.inn, sum(${hit("a.term")}) AS fda_rows FROM aprime_files.aems a
  JOIN (SELECT DISTINCT inn FROM aprime_rx.rx_patients) x ON lower(a.products) LIKE concat('%', x.inn, '%') GROUP BY x.inn) fda ON fda.inn = r.inn
WHERE r.inn = ${inn}`;
};

/** Zetaris EXPLAIN output -> what each source system was actually asked to filter (read from the physical plan) */
export function pushdownSummary(plan: string) {
  const phys = plan.includes("== Physical Plan ==") ? plan.slice(plan.indexOf("== Physical Plan ==")) : plan;
  const out: { system: string; table: string; pushed: string }[] = [];
  for (const line of phys.split(/\r?\n/)) {
    if (!/\bScan\b|FileScan/.test(line)) continue;
    const m = line.match(/(APRIME_\w+)\.(\w+)\[/) ?? line.match(/Some\((APRIME_\w+)\),(\w+),/);
    if (!m) continue;
    // Spark abbreviates long filter lists with "..." and may drop the closing bracket
    const pf = line.match(/PushedFilters: \[(.*?)\]?, ReadSchema/) ?? line.match(/PushedFilters: \[(.*?)\]/);
    const pushed = (pf ? pf[1] : "").replace(/,?\s*\.\.\.$/, "").trim();
    out.push({ system: m[1] === "APRIME_RX" ? "MySQL" : m[1] === "APRIME_FILES" ? "S3" : "Postgres", table: m[2].toLowerCase(), pushed });
  }
  return out;
}
