// Night scan (Meterless Markovian, the hard Engine), the divergence ledger and the scoreboard.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.ts";
import { SqlTool, asObjects } from "./zetaris.ts";

const readJson = (rel: string) => { const f = path.join(ROOT, rel); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };

/** scoreboard numbers: computed offline by scripts/scoreboard.py into out/scoreboard.json */
export function boardData() {
  const board = readJson("out/scoreboard.json");
  // the product scan (name index + Markovian) when it has been run, otherwise Markovian alone
  const product = existsSync(path.join(ROOT, "out", "ledger_MN.json"));
  const m = readJson(product ? "out/ledger_MN.json" : "out/ledger_M.json"), fr = readJson("out/ledger_FR.json"), full = readJson("out/fullreread_tokens.json");
  const chunks = (m?.report ?? []).flatMap((j: { job: number; chunks: { id: number; promptTokensEstimated: number; carryoverTokensIn: number; cascade: string; model: string }[] }) =>
    j.chunks.map((c) => ({ job: j.job, id: c.id, prompt: c.promptTokensEstimated, carry: c.carryoverTokensIn, cascade: c.cascade, model: c.model })));
  // re-read arm: measured prompts when that arm was run with the model, else the estimate
  const measured = (fr?.report ?? []).filter((r: { promptTokensEstimated?: number }) => r.promptTokensEstimated).map((r: { promptTokensEstimated: number }) => r.promptTokensEstimated);
  return { board, scan: { product, chunks, fullReread: measured.length ? measured : full?.perBatchPromptTokens ?? [], fullRereadRun: measured.length > 0, models: count(chunks.map((c: { model: string }) => c.model)) } };
}
const count = (xs: string[]) => xs.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {} as Record<string, number>);

/** the divergence ledger, ranked by how many of this hospital's patients take the drug: one federated query */
export const LEDGER_SQL = `SELECT s.row_id, s.signal, s.meeting, ps.substance, u.us_status AS us_prescreen, r.patients, count(a.term) AS fda_list_rows
FROM aprime_lab.prac_signal s
JOIN aprime_lab.prac_substance ps ON ps.row_id = s.row_id
JOIN aprime_lab.us_label u ON u.row_id = s.row_id
JOIN (SELECT inn, sum(patients) AS patients FROM aprime_views.rx_counts GROUP BY inn) r ON r.inn = lower(ps.substance)
LEFT JOIN aprime_files.aems a ON lower(a.products) LIKE concat('%', lower(ps.substance), '%')
WHERE u.us_status IN ('not found', 'partial')
GROUP BY s.row_id, s.signal, s.meeting, ps.substance, u.us_status, r.patients
ORDER BY r.patients DESC, s.row_id DESC LIMIT 12`;
let ledgerCache: unknown;
export async function ledgerTop() {
  if (ledgerCache) return ledgerCache;
  const sql = new SqlTool({ prefix: "L" });
  const r = await sql.run(LEDGER_SQL, "Divergence ledger × hospital exposure × FDA lists (one query, three systems)", "planner");
  const m = readJson("out/ledger_MN.json")?.ledger ?? readJson("out/ledger_M.json")?.ledger ?? {}; // the product scan (name index + Markovian)
  ledgerCache = { receipt: r.receipt, rows: asObjects(r.result).map((x) => ({ ...x, cross: (m[x.row_id as string]?.cross ?? []) })) };
  return ledgerCache;
}

/** Re-run the Markovian night scan from its recorded chunks: the real engine runs, every chunk reply comes from the
 *  recording (APRIME_SCAN_REPLAY_ONLY), nothing is sent to a model. */
export function nightScan() {
  const chunks: Record<string, unknown>[] = []; let running = true, done = "", err = "";
  const which = existsSync(path.join(ROOT, "out", "ledger_MN.json")) ? "MN" : "M";
  const p = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "engine", "scan.ts"), which], {
    cwd: ROOT, env: { ...process.env, APRIME_SCAN_REPLAY_ONLY: "1", APRIME_SCAN_PROGRESS: "1", APRIME_SCAN_OUT: path.join(config.runsDir, "scan_replay"), APRIME_BATCH: "3" } });
  let buf = "";
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith("CHUNK ")) chunks.push(JSON.parse(l.slice(6))); else if (/done:/.test(l)) done = l.trim(); } });
  p.stderr.on("data", (d) => { err += String(d).slice(0, 400); });
  p.on("close", (code) => { running = false; if (code) err ||= `exit ${code}`; });
  return { state: () => ({ running, chunks, done, error: err }) };
}
