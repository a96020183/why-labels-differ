// SAMPLE_MODE fallback for run_sql, used only when a statement is not in the recorded Zetaris cassette (for example a
// judge picks a drug nobody recorded). It answers from the same CSVs that were loaded into MySQL / Postgres / S3, with
// node:sqlite, and mimics the Zetaris governance the agents meet: patient columns masked for the agent role, the
// patient_list view and INSERT denied to the agent role. Every receipt it produces says backend "emulator".
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type SqlResult = { headers: string[]; data: (string | null)[][] };
export type Identity = "agent" | "pharmacist" | "admin";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const TABLES: [string, string, string][] = [
  ["aprime_rx", "patient", "pharmacy/patient.csv"], ["aprime_rx", "dispense", "pharmacy/dispense.csv"],
  ["aprime_lab", "prac_signal", "evidence/prac_signal.csv"], ["aprime_lab", "prac_substance", "evidence/prac_substance.csv"],
  ["aprime_lab", "us_label", "evidence/us_label.csv"], ["aprime_lab", "reg_doc", "evidence/reg_doc.csv"],
  ["aprime_lab", "reg_passage", "evidence/reg_passage.csv"], ["aprime_lab", "spl_section", "evidence/spl_section.csv"],
  ["aprime_lab", "spl_version", "evidence/spl_version.csv"], ["aprime_lab", "spl_section", "evidence/spl_section_score.csv"],
  ["aprime_files", "aems", "evidence/aems.csv"], ["aprime_files", "sentinel", "evidence/sentinel.csv"],
];
const MASKED: Record<string, string[]> = { dispense: ["patient_id"], patient: ["patient_id", "mrn", "display_name"] };
const VIEWS: Record<string, string> = {
  // the MySQL view counts people before any mask applies, so it always reads the unmasked table
  rx_counts: "(SELECT inn, dept, count(DISTINCT patient_id) AS patients, min(next_fill) AS earliest_next_fill FROM aprime_rx_unmasked.dispense GROUP BY inn, dept)",
  rx_patients: "(SELECT inn, dept, count(DISTINCT patient_id) AS patients, min(next_fill) AS earliest_next_fill FROM aprime_rx_unmasked.dispense GROUP BY inn, dept)",
  patient_list: "(SELECT p.mrn, p.display_name, d.dept, d.inn, d.product, d.next_fill, c.decision_id, c.reaction FROM {rx}.dispense d " +
    "JOIN {rx}.patient p ON p.patient_id = d.patient_id JOIN aprime_lab.pt_decision c ON c.substance = d.inn AND c.decision = 'propose')",
};

export class ZetarisEmulator {
  private db = new DatabaseSync(":memory:");
  private loaded = new Set<string>();
  constructor(dir: string) {
    for (const s of ["aprime_rx", "aprime_rx_masked", "aprime_lab", "aprime_files"]) this.db.exec(`ATTACH DATABASE ':memory:' AS ${s}`);
    for (const [schema, table, rel] of TABLES) {
      const f = path.join(dir, rel);
      if (!existsSync(f)) continue;
      const rows = parseCsv(readFileSync(f, "utf8").replace(/^﻿/, ""));
      this.load(schema, table, rows);
      if (schema === "aprime_rx") {
        const cols = rows[0], masked = MASKED[table] ?? [];
        this.load("aprime_rx_masked", table, [cols, ...rows.slice(1).map((r) => r.map((v, i) => (masked.includes(cols[i]) ? v.replace(/[A-Za-z0-9]/g, "*") : v)))]);
      }
    }
    this.db.exec(`CREATE TABLE aprime_lab.pt_decision (decision_id, substance, reaction, decision, decided_by, decided_at, rationale, evidence_run)`);
    this.db.exec(`CREATE TABLE aprime_lab.reopen_condition (cond_id, decision_id, kind, description, watch_sql, status, checked_at, fired_at)`);
  }
  private load(schema: string, table: string, rows: string[][]) {
    const cols = rows[0];
    if (this.loaded.has(`${schema}.${table}`)) return this.append(schema, table, rows);
    this.loaded.add(`${schema}.${table}`);
    const numeric = new Set(["version", "yr", "mo", "dispense_id", "birth_year"]);
    this.db.exec(`CREATE TABLE ${schema}."${table}" (${cols.map((c) => `"${c}" ${numeric.has(c) ? "INTEGER" : "TEXT"}`).join(", ")})`);
    const ins = this.db.prepare(`INSERT INTO ${schema}."${table}" VALUES (${cols.map(() => "?").join(",")})`);
    this.db.exec("BEGIN");
    for (const r of rows.slice(1)) ins.run(...cols.map((c, i) => (numeric.has(c) && r[i] !== "" ? Number(r[i]) : r[i] ?? null)));
    this.db.exec("COMMIT");
  }

  private append(schema: string, table: string, rows: string[][]) {
    const cols = rows[0];
    const ins = this.db.prepare(`INSERT INTO ${schema}."${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(",")})`);
    this.db.exec("BEGIN");
    for (const r of rows.slice(1)) ins.run(...cols.map((c, i) => (c === "version" && r[i] !== "" ? Number(r[i]) : r[i] ?? null)));
    this.db.exec("COMMIT");
  }

  run(sqlIn: string, who: Identity): SqlResult {
    const sql = sqlIn.trim().replace(/;\s*$/, "");
    if (/^EXPLAIN /i.test(sql)) throw new Error("EXPLAIN needs a live Zetaris (the emulator has no physical plan)");
    if (/^INSERT INTO aprime_lab\.(pt_decision|reopen_condition)/i.test(sql)) {
      if (who === "agent") throw new Error(`User 'AGENT@APRIME.LOCAL' does not have privileges to execute 'INSERT' on: \`APRIME_LAB\`.\`${sql.match(/aprime_lab\.(\w+)/i)![1]}\``);
      this.db.exec(sql);
      return { headers: ["Result"], data: [] };
    }
    if (!/^(SELECT|WITH)\b/i.test(sql)) throw new Error(`emulator does not support: ${sql.slice(0, 40)}`);
    if (who === "agent" && /aprime_views\.patient_list/i.test(sql))
      throw new Error("User 'AGENT@APRIME.LOCAL' does not have privileges to execute 'SELECT' on: `aprime_views`.`patient_list`");
    const rx = who === "agent" ? "aprime_rx_masked" : "aprime_rx";
    const text = sql.replace(/aprime_views\.(rx_counts|patient_list)|aprime_rx\.(rx_patients)/gi, (_, v, w) => VIEWS[(v ?? w).toLowerCase()].replaceAll("{rx}", "{RX}"))
      .replace(/\baprime_rx\./gi, rx + ".").replaceAll("{RX}", rx).replaceAll("aprime_rx_unmasked.", "aprime_rx.");
    const st = this.db.prepare(text);
    const rows = st.all() as Record<string, unknown>[];
    const headers = st.columns().map((c) => c.name);
    return { headers, data: rows.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? null : String(r[h])))) };
  }
}
