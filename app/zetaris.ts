// run_sql: the ONLY way an agent gets evidence. Every call returns a receipt (query id, SQL, identity, backend,
// systems touched, row count, result hash, time). Backends:
//   zetaris  - the live local Zetaris REST API (POST /sql-editor/sqls/run), with the identity's own API key
//   replay   - the recorded Zetaris answer to the exact same SQL for the same identity (SAMPLE_MODE)
//   emulator - node:sqlite over the same CSVs, only on a replay miss or when Zetaris is unreachable
// Identities: agent (role APRIME_AGENT: patient columns masked, no patient list), pharmacist (APRIME_PHARMACIST),
// admin (EXPLAIN only).
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, scrub, sleep } from "./config.ts";
import { ZetarisEmulator, type Identity, type SqlResult } from "./emulator.ts";

export type Backend = "zetaris" | "replay" | "emulator";
export type Receipt = {
  qid: string; sql: string; purpose: string; agent: string; as: Identity; backend: Backend; systems: string[];
  rows: number; resultSha: string; at: string; ms: number; error?: string;
};
export type { SqlResult, Identity };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
export const sqlKey = (who: Identity, sql: string) => createHash("sha256").update(who + "|" + norm(sql)).digest("hex").slice(0, 24);
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
export function systemsOf(sql: string): string[] {
  const s = new Set<string>();
  if (/aprime_rx\.|aprime_views\./i.test(sql)) s.add("MySQL · pharmacy");
  if (/aprime_lab\./i.test(sql)) s.add("Postgres · regulatory records");
  if (/aprime_files\./i.test(sql)) s.add("S3 · FDA lists");
  return [...s];
}

let cassette: Map<string, SqlResult> | undefined;
function loadCassette() {
  if (cassette) return cassette;
  cassette = new Map();
  const f = path.join(config.cassetteDir, "zetaris.jsonl");
  if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); cassette.set(r.key, r.result); }
  return cassette;
}
let emulator: ZetarisEmulator | undefined;
const emu = () => (emulator ??= new ZetarisEmulator(config.sampleDir));

export class SqlTool {
  receipts: Receipt[] = [];
  mode: "live" | "sample";
  private prefix: string;
  constructor(opts: { mode?: "live" | "sample"; prefix?: string } = {}) {
    this.mode = opts.mode ?? (config.sampleMode ? "sample" : "live");
    this.prefix = opts.prefix ?? "Q";
  }

  private async live(sql: string, who: Identity): Promise<SqlResult> {
    const key = config.zetaris.keys[who];
    if (!key) throw new Error(`no Zetaris key for identity ${who} (not set)`);
    const res = await fetch(config.zetaris.url.replace(/\/$/, "") + "/sql-editor/sqls/run", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "X-Org-ID": config.zetaris.orgId, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
      body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 5000 }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text; try { msg = JSON.parse(text).msg ?? text; } catch { /* raw */ }
      throw new Error(`Zetaris: ${scrub(msg).slice(0, 500)}`);
    }
    const out = JSON.parse(text);
    return { headers: out.headers ?? [], data: out.data ?? [] };
  }

  async run(sql: string, purpose: string, agent: string, who: Identity = "agent"): Promise<{ ok: boolean; result: SqlResult; receipt: Receipt }> {
    const t0 = Date.now();
    const key = sqlKey(who, sql);
    let backend: Backend = "zetaris", result: SqlResult = { headers: [], data: [] }, error: string | undefined;
    const cas = loadCassette();
    try {
      if (this.mode === "sample") {
        if (config.paceMs) await sleep(config.paceMs);
        const hit = cas.get(key);
        if (hit) { result = hit; backend = "replay"; if ((hit as SqlResult & { error?: string }).error) error = (hit as SqlResult & { error?: string }).error; }
        else { backend = "emulator"; result = emu().run(sql, who); }
      } else {
        try { result = await this.live(sql, who); }
        catch (e) {
          const msg = String((e as Error).message);
          if (/^Zetaris:/.test(msg)) { // a real answer from Zetaris (a permission error is evidence too): record it
            error = msg;
            if (config.record) { appendFileSync(this.file(), JSON.stringify({ key, as: who, sql: scrub(sql), result: { headers: [], data: [], error: msg }, at: new Date().toISOString() }) + "\n"); cas.set(key, { headers: [], data: [], error: msg } as SqlResult); }
          } else {
            const hit = cas.get(key);
            if (hit) { result = hit; backend = "replay"; } else { result = emu().run(sql, who); backend = "emulator"; }
            error = undefined;
          }
        }
        if (backend === "zetaris" && !error && config.record) {
          appendFileSync(this.file(), JSON.stringify({ key, as: who, sql: scrub(sql), result, at: new Date().toISOString() }) + "\n");
          cas.set(key, result);
        }
      }
    } catch (e) {
      error = scrub(String((e as Error).message ?? e));
    }
    const receipt: Receipt = {
      qid: `${this.prefix}-${String(this.receipts.length + 1).padStart(3, "0")}`, sql: scrub(norm(sql)), purpose, agent, as: who, backend,
      systems: systemsOf(sql), rows: result.data.length, resultSha: sha(result), at: new Date().toISOString(), ms: Date.now() - t0,
      ...(error ? { error } : {}),
    };
    this.receipts.push(receipt);
    return { ok: !error, result, receipt };
  }
  private file() { mkdirSync(config.cassetteDir, { recursive: true }); return path.join(config.cassetteDir, "zetaris.jsonl"); }
}

export const asObjects = (r: SqlResult) => r.data.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])) as Record<string, string | null>);
export const lit = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
