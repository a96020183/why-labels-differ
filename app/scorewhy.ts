// Set 1a, the "why" columns: for each of the 39 PRAC signals, where do the EU, the UK (MHRA) and the U.S. FDA stand?
// Same evidence path as the product: Research queries Zetaris (PRAC catalogue, MHRA articles, FDA AEMS lists, Sentinel),
// then one Nemotron deep-lane call classifies each column from those records only, citing them.
// Search terms are the ones the Planner produced for the U.S.-status run (out/set1a_ours.json), so no new term call.
// Scored against out/why_key_independent_v2.json (v2: rows whose U.S. label added the reaction after PRAC count as an FDA action) (labelled by a separate AI reviewer, Claude, not a pharmacist; it never saw
// these outputs). Output: out/why_ours.json. Usage: node app/scorewhy.ts (SAMPLE_MODE replays the recorded run)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.ts";
import { Models, jsonWith } from "./llm.ts";
import { SqlTool, asObjects, lit } from "./zetaris.ts";

type Q = { id: string; inn: string; signal: string; prac_meeting: string; product: string | null };
const qs: Q[] = JSON.parse(readFileSync(path.join(config.sampleDir, "scoreboard", "set1a_questions.json"), "utf8")).questions;
const prior = Object.fromEntries((JSON.parse(readFileSync(path.join(ROOT, "out", "set1a_ours.json"), "utf8")).answers as { id: string; terms?: string[] }[]).map((a) => [a.id, a.terms ?? []]));
const models = new Models(), sql = new SqlTool({ prefix: "W" });
const likeAny = (col: string, t: string[]) => "(" + t.map((x) => `lower(${col}) LIKE ${lit("%" + x + "%")}`).join(" OR ") + ")";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

const answers: Record<string, unknown>[] = [];
// APRIME_WHY_ONLY=R192,... re-runs only those rows (after their evidence changed) and keeps every other recorded answer
const only = (process.env.APRIME_WHY_ONLY ?? "").split(",").filter(Boolean);
for (const q of qs.filter((x) => !only.length || only.includes(x.id))) {
  const terms = (prior[q.id]?.length ? prior[q.id] : [q.signal.toLowerCase()]).slice(0, 8);
  // drug names: the PRAC row's substances (from Zetaris), so class rows search every member
  const s = await sql.run(`SELECT s.row_id, s.signal, s.meeting, ps.substance FROM aprime_lab.prac_signal s JOIN aprime_lab.prac_substance ps ON ps.row_id = s.row_id WHERE s.row_id = ${lit(q.id)}`, `PRAC catalogue row ${q.id}`, "research");
  const subs = [...new Set(asObjects(s.result).map((r) => String(r.substance).replace(/^.*:\s*/, "").toLowerCase()).filter((x) => x.length >= 4))].slice(0, 12);
  const names = subs.length ? subs : [q.inn.toLowerCase()];
  const uk = await sql.run(`SELECT p.passage_id, d.title, d.published, p.section, p.text FROM aprime_lab.reg_doc d JOIN aprime_lab.reg_passage p ON p.doc_id = d.doc_id
WHERE d.regulator = 'UK' AND ${likeAny("d.substances", [...names, "antidepressant"])} AND ${likeAny("p.text", terms)}`, `MHRA articles on ${q.id}`, "research");
  const fda = await sql.run(`SELECT quarter, as_of, products, term, fda_action FROM aprime_files.aems WHERE ${likeAny("products", names)}`, `FDA potential-signal rows naming the drug (${q.id})`, "research");
  const sen = await sql.run(`SELECT study_id, title, status FROM aprime_files.sentinel WHERE ${likeAny("title", names)} OR ${likeAny("product_scope", names)}`, `FDA Sentinel studies naming the drug (${q.id})`, "research");
  const eu = asObjects(s.result)[0];
  const ev = [
    eu ? `[EU-${q.id}] EMA PRAC signal catalogue: "${eu.signal}" (${subs.join(", ")}), ${eu.meeting}: PRAC recommended an update of the EU product information.` : `[EU-${q.id}] no PRAC catalogue row`,
    ...asObjects(uk.result).slice(0, 4).map((r) => `[${r.passage_id}] MHRA Drug Safety Update, ${r.published}, ${r.title} — ${r.section}: ${clip(String(r.text), 400)}`),
    ...asObjects(fda.result).slice(0, 10).map((r, i) => `[FDA-${q.id}-${i + 1}] FDA AEMS potential-signal list ${r.quarter} (as of ${r.as_of}): products ${clip(String(r.products), 160)}; signal "${r.term}"; FDA: ${clip(String(r.fda_action), 220)}`),
    ...asObjects(sen.result).map((r) => `[${r.study_id}] FDA Sentinel study: ${clip(String(r.title), 160)}; status ${r.status}`),
  ];
  const system = `Where do three regulators stand on this drug-reaction pair? Use ONLY the records below (the MHRA article table and FDA lists were searched in full for these drug names; anything not listed was not found there).
Drug(s): ${names.join(", ")}. Reaction: "${q.signal}" (EU PRAC signal ${q.prac_meeting}).
Labels:
eu: concluded | under_evaluation | not_found
uk: drug_safety_update (an MHRA safety communication about this drug or its class and this reaction) | no_public_communication_found
us_regulator: under_evaluation (an FDA potential-signal entry on this reaction, FDA evaluating) | concluded_label_updated | concluded_no_action | drug_safety_communication | no_public_action_found
An FDA row only counts if its signal is the same reaction (by meaning) for this drug or a class containing it.
RECORDS:
${ev.join("\n")}
Reply with one JSON object only: {"eu":{"label":"...","cites":["id"]},"uk":{"label":"...","cites":[]},"us_regulator":{"label":"...","cites":[]},"reason":"one short sentence"}`;
  const r = await models.chat("deep", system, { tag: `why:${q.id}`, maxTokens: 3000, valid: (t) => !!jsonWith(t, ["us_regulator"]),
    stub: () => JSON.stringify({ eu: { label: eu ? "concluded" : "not_found" }, uk: { label: "no_public_communication_found" }, us_regulator: { label: "no_public_action_found" }, reason: "offline stub" }) });
  const j = jsonWith<Record<string, { label: string; cites?: string[] }>>(r.text, ["us_regulator"]) ?? {};
  answers.push({ id: q.id, eu: j.eu?.label, uk: j.uk?.label, us_regulator: j.us_regulator?.label, cites: { eu: j.eu?.cites, uk: j.uk?.cites, us_regulator: j.us_regulator?.cites },
    reason: (j as unknown as { reason?: string }).reason, served: r.served, source: r.source, qids: [s.receipt.qid, uk.receipt.qid, fda.receipt.qid, sen.receipt.qid] });
  console.log(q.id, "->", j.eu?.label, "|", j.uk?.label, "|", j.us_regulator?.label, `(${r.served})`);
}
const outPath = path.join(ROOT, "out", "why_ours.json");
if (only.length) {
  const old = JSON.parse(readFileSync(outPath, "utf8"));
  old.answers = old.answers.map((a: { id: string }) => answers.find((x) => x.id === a.id) ?? a);
  old.reruns = [...(old.reruns ?? []), { ids: only, at: new Date().toISOString().slice(0, 10), why: process.env.APRIME_WHY_REASON ?? "evidence changed" }];
  writeFileSync(outPath, JSON.stringify(old, null, 1)); console.log("merged", only.join(", ")); process.exit(0);
}
writeFileSync(outPath, JSON.stringify({ arm: "Why Labels Differ agents: EU / UK / U.S. FDA stage from Zetaris records, Nemotron deep lane", run_at: new Date().toISOString().slice(0, 10), sampleMode: config.sampleMode,
  models_served: models.calls.reduce((a, c) => ((a[c.served] = (a[c.served] ?? 0) + 1), a), {} as Record<string, number>), answers }, null, 1));
console.log("done", answers.length);
