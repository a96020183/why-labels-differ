// Set 1a: the agents answer "where does the current U.S. label stand?" for the 39 PRAC signals of 2025-01..2026-09.
// Same inputs as every other arm (sample/scoreboard/set1a_questions.json). Evidence only through Zetaris (run_sql).
//   Planner (fast lane)   search terms for each reaction (batched, 13 questions per call)
//   Research (SQL)        every section of the named U.S. product's current label that mentions a term
//   Evaluator (deep lane) classifies: written / partial / not found, and quotes the sentence it relies on
//   Skeptic (code)        the quote must be in a returned passage and the section must fit the class; one retry if not
// A question whose product has no U.S. label in Zetaris is answered "not marketed" without a model call.
// Output: out/set1a_ours.json. Usage: node app/score1a.ts   (SAMPLE_MODE replays the recorded run)
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.ts";
import { Models, lastJson, jsonWith } from "./llm.ts";
import { SqlTool, asObjects, lit } from "./zetaris.ts";
import { cleanTerms } from "./sources.ts";

type Q = { id: string; inn: string; signal: string; prac_meeting: string; product: string | null };
const qs: Q[] = JSON.parse(readFileSync(path.join(config.sampleDir, "scoreboard", "set1a_questions.json"), "utf8")).questions;
const WARN = new Set(["34066-1", "43685-7", "34071-1", "34070-3"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const models = new Models(), sql = new SqlTool({ prefix: "S" });

const terms: Record<string, string[]> = {};
for (let i = 0; i < qs.length; i += 13) {
  const part = qs.slice(i, i + 13);
  const system = `For each adverse reaction below, give the search terms a U.S. drug label might use for it: the name, US and British spellings, abbreviations, close synonyms and descriptive phrases (max 8 per item, lower case, each at least 4 characters).
${part.map((q) => `${q.id}: ${q.signal} (drug: ${q.inn})`).join("\n")}
Reply with one JSON object only: {"R###":["term", "..."], ...}`;
  const r = await models.chat("fast", system, { tag: `set1a:terms:${i}`, valid: (t) => !!lastJson(t), stub: () => JSON.stringify(Object.fromEntries(part.map((q) => [q.id, [q.signal.toLowerCase()]]))) });
  const j = lastJson<Record<string, string[]>>(r.text) ?? {};
  for (const q of part) terms[q.id] = cleanTerms(j[q.id] ?? [q.signal], 8);
  console.log("terms", part[0].id, "-", part.at(-1)!.id, "served by", r.served);
}

const answers: Record<string, unknown>[] = [];
for (const q of qs) {
  const t = terms[q.id].length ? terms[q.id] : cleanTerms([q.signal]);
  if (!q.product) { answers.push({ id: q.id, us_status: "not marketed", why: "no U.S. product named for this question; no U.S. label in Zetaris", calls: 0 }); continue; }
  const v = await sql.run(`SELECT product, version, effective, count(*) AS sections FROM aprime_lab.spl_section WHERE product = ${lit(q.product)} AND purpose = 'score' GROUP BY product, version, effective`, `U.S. label in Zetaris for ${q.product}`, "research");
  if (!v.result.data.length) { answers.push({ id: q.id, us_status: "not marketed", why: "no U.S. label in Zetaris", qids: [v.receipt.qid], calls: 0 }); continue; }
  const like = "(" + t.map((x) => `lower(text) LIKE ${lit("%" + x + "%")}`).join(" OR ") + ")";
  const h = await sql.run(`SELECT sec_code, sec_title, path, text FROM aprime_lab.spl_section WHERE product = ${lit(q.product)} AND purpose = 'score' AND ${like}`, `${q.product}: label sections that mention ${q.signal}`, "research");
  const rows = asObjects(h.result);
  const passages = rows.slice(0, 10).map((r, k) => {
    const lo = (r.text ?? "").toLowerCase(); const at = Math.min(...t.map((x) => lo.indexOf(x)).filter((x) => x >= 0), Infinity);
    const a = Number.isFinite(at) ? Math.max(0, at - 300) : 0;
    return { n: k + 1, code: r.sec_code ?? "", warn: WARN.has(r.sec_code ?? ""), path: r.path ?? "", text: (r.text ?? "").slice(a, a + 900) };
  });
  const base = `Classify where the CURRENT U.S. label of ${q.product} (${v.result.data[0][1] ? "version " + v.result.data[0][1] : ""}) stands on this adverse reaction: "${q.signal}" (EU PRAC signal, ${q.prac_meeting}).
written = described in Boxed Warning, Warnings and Precautions, Warnings, Precautions or Contraindications
partial = described only in Adverse Reactions / Postmarketing, dosage tables, Use in Specific Populations or patient information
not found = not described (also when it appears only as a symptom of a different syndrome, as a pre-existing condition, or for a different population/exposure than the signal)
Label passages that contain a search term (${t.join(", ")}); passages marked WARNING SECTION are in a warning section:
${passages.map((p) => `#${p.n} ${p.warn ? "WARNING SECTION" : "other section"} | ${p.path}\n${p.text}`).join("\n\n") || "(no passage mentions any search term)"}
Reply with one JSON object only: {"us_status":"written|partial|not found","passage":0,"quote":"the exact sentence from that passage, or empty","reason":"one short sentence"}`;
  let calls = 0, ans: { us_status: string; passage: number; quote: string; reason: string } | undefined, note = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const system = base + (note ? `\nYour previous answer failed a check: ${note} Answer again.` : "");
    const r = await models.chat("deep", system, { tag: `set1a:${q.id}:${attempt}`, maxTokens: 3000, valid: (x) => !!jsonWith(x, ["us_status"]),
      stub: () => JSON.stringify({ us_status: passages.some((p) => p.warn) ? "written" : passages.length ? "partial" : "not found", passage: passages[0]?.n ?? 0, quote: "", reason: "offline stub" }) });
    calls++;
    ans = jsonWith(r.text, ["us_status"]) ?? { us_status: "not found", passage: 0, quote: "", reason: "unparsable" };
    const p = passages.find((x) => x.n === Number(ans!.passage));
    note = "";
    if (ans.us_status !== "not found") {
      if (!p) note = "You must name the passage number you rely on.";
      else if (ans.quote && !norm(p.text).includes(norm(ans.quote).slice(0, 120))) note = `Your quote is not in passage #${p.n}.`;
      else if (ans.us_status === "written" && !p.warn) note = `Passage #${p.n} is not in a warning section, so it cannot support "written".`;
    }
    if (!note) break;
  }
  answers.push({ id: q.id, ...ans, section: passages.find((x) => x.n === Number(ans?.passage))?.path ?? "", terms: t, qids: [v.receipt.qid, h.receipt.qid], calls, skeptic_note: note || undefined });
  console.log(q.id, q.product, "->", ans?.us_status, note ? "(check still failing: " + note + ")" : "");
}
const served = models.calls.reduce((a, c) => ((a[c.served] = (a[c.served] ?? 0) + 1), a), {} as Record<string, number>);
writeFileSync(path.join(ROOT, "out", "set1a_ours.json"), JSON.stringify({ arm: "Why Labels Differ agents (Nemotron via Nightshift, evidence via Zetaris)", run_at: new Date().toISOString().slice(0, 10),
  sampleMode: config.sampleMode, models_served: served, model_sources: models.calls.reduce((a, c) => ((a[c.source] = (a[c.source] ?? 0) + 1), a), {} as Record<string, number>),
  zetaris_backends: sql.receipts.reduce((a, r) => ((a[r.backend] = (a[r.backend] ?? 0) + 1), a), {} as Record<string, number>), answers }, null, 1));
console.log("done", answers.length, served);
