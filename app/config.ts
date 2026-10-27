// Runtime configuration. Secrets come from .env (this folder, then the parent folder) or data/private/*_PRIVATE.txt.
// They are never printed, logged or written. With no keys at all the app runs in SAMPLE_MODE from the recorded
// Zetaris and Nightshift responses in sample/cassettes/.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(p: string): Record<string, string> {
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}
const fileEnv = { ...readEnvFile(path.join(ROOT, "..", ".env")), ...readEnvFile(path.join(ROOT, ".env")) };
const env = (k: string, d = "") => process.env[k] || fileEnv[k] || d;
const flag = (k: string, d: boolean) => ["1", "true", "yes"].includes(env(k, d ? "true" : "false").toLowerCase());
const priv = (f: string) => { const p = path.join(ROOT, "data", "private", f); return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; };

export const config = {
  sampleMode: flag("SAMPLE_MODE", true),
  record: flag("APRIME_RECORD", false), // live runs append to the cassettes (used to make SAMPLE_MODE)
  sampleDir: path.join(ROOT, "sample"),
  cassetteDir: path.join(ROOT, "sample", "cassettes"),
  runsDir: env("APRIME_RUNS_DIR", path.join(ROOT, "runs", "app")),
  port: Number(env("PORT", "8750")),
  paceMs: Number(env("APRIME_PACE_MS", "0")),
  zetaris: {
    url: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    keys: {
      agent: env("ZETARIS_AGENT_API_KEY") || priv("zetaris_agent_key_PRIVATE.txt"),
      pharmacist: env("ZETARIS_PHARMACIST_API_KEY") || priv("zetaris_pharmacist_key_PRIVATE.txt"),
      admin: env("ZETARIS_API_KEY"), // only for EXPLAIN (Zetaris allows it to administrators only)
    },
  },
  nightshift: {
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: "aprime-why-labels-differ",
    fast: env("APRIME_MODEL_FAST", "nvidia/nemotron-3.5-lightning-30b-a3b"),
    deep: env("APRIME_MODEL_DEEP", "nvidia/nemotron-3.5-super-vl-120b-a12b"),
    timeoutMs: Number(env("APRIME_MODEL_TIMEOUT_MS", "300000")),
    retries: Number(env("APRIME_MODEL_RETRIES", "6")),
    offline: flag("APRIME_MODEL_OFFLINE", false),
  },
};

export const secretValues = (): string[] =>
  [config.zetaris.keys.agent, config.zetaris.keys.pharmacist, config.zetaris.keys.admin, config.nightshift.token,
    ...Object.entries(fileEnv).filter(([k]) => /KEY|TOKEN|PASSWORD|SECRET/.test(k)).map(([, v]) => v)].filter((v) => v && v.length >= 8);

export function scrub(s: unknown): string {
  let t = typeof s === "string" ? s : JSON.stringify(s);
  for (const v of secretValues()) t = t.split(v).join("<redacted>");
  return t.replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>").replace(/(password\s+")[^"]+/gi, "$1<redacted>").replace(/((?:awsSecretAccessKey|awsAccessKeyId)\s+\\?")[^"\\]+/gi, "$1<redacted>");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
