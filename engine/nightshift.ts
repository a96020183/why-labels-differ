// Nightshift (Meterless Runtime) client for A'. OpenAI-compatible. URL and token come from ../../.env only;
// they are never printed or written anywhere. Every call is logged (no secrets) to runs/calls.jsonl with the
// requested model, the model the runtime actually served, measured usage, latency and retries.
// Concurrency: one in-flight request from this process (the NVIDIA free tier allows 2 in total and the Revisit
// gate shares it). Failures back off and retry (exponential, up to `retries` attempts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");               // a_prime
const ENV = path.resolve(ROOT, "..", ".env");        // dev folder .env
const LOG = path.join(ROOT, "runs", "calls.jsonl");

function loadEnv(): Record<string, string> {
  const d: Record<string, string> = {};
  if (!fs.existsSync(ENV)) return d; // no keys: replaying the recorded night scan still works
  for (const ln of fs.readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const s = ln.trim(); if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("="); d[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return d;
}
const E = loadEnv();
const BASE = (E.METERLESS_BASE_URL || "http://127.0.0.1:8088/v1").replace(/\/+$/, "");
const TOKEN = E.METERLESS_RUNTIME_TOKEN || "";
const scrub = (s: string) => (TOKEN ? s.split(TOKEN).join("<redacted>") : s).replace(/(bearer\s+)\S+/gi, "$1<redacted>");

let inflight = 0; const MAXC = 1; const waiters: (() => void)[] = [];
async function acquire() { if (inflight < MAXC) { inflight++; return; } await new Promise<void>((r) => waiters.push(r)); inflight++; }
function release() { inflight--; const w = waiters.shift(); if (w) w(); }

export function stripReasoning(t: string): string {
  if (!t) return "";
  let o = t.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (o.includes("</think>")) o = o.slice(o.lastIndexOf("</think>") + "</think>".length);
  return o.trim();
}
function log(rec: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, scrub(JSON.stringify(rec)) + "\n");
}

export interface ChatOut { text: string; served: string; usage: { prompt_tokens?: number; completion_tokens?: number }; latency: number; hadThink: boolean; attempts: number }
export interface ChatOpts {
  model: string; maxTokens?: number; tag?: string; timeoutMs?: number; retries?: number; headers?: Record<string, string>; extraBody?: Record<string, unknown>;
  // Long-prompt settings (from our tests of Nightshift with long prompts). Nightshift aborts a provider call that has not returned
  // headers within 45 s (providers.js CLOUD_FETCH_DEADLINE_MS) and then falls through to dead models (404/410).
  // stream: true makes the upstream answer headers at once; tier-split off keeps the request on one lane.
  stream?: boolean;     // SSE, assembled here; reasoning deltas are dropped
  tierSplit?: boolean;  // false -> header meterless-tier-split: off
  isoScope?: boolean;   // true -> when recording or evaluating (APRIME_RECORD=true or METERLESS_SCOPE=iso), a fresh
                        // meterless-scope iso-<uuid> per attempt (no H-MEM recall between requests); otherwise "user"
}

// Read an OpenAI-style SSE body into one completion: content deltas joined, reasoning deltas only noted.
async function readSSE(r: Response): Promise<{ raw: string; served?: string; usage?: any; hadReasoning: boolean }> {
  const dec = new TextDecoder(); let buf = "", raw = "", served: string | undefined, usage: any, hadReasoning = false;
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim(); if (!d || d === "[DONE]") return;
    let j: any; try { j = JSON.parse(d); } catch { return; }
    if (j.error) throw new Error(`stream error ${JSON.stringify(j.error).slice(0, 200)}`);
    if (j.model) served = j.meterless?.routed_model || j.model;
    if (j.usage) usage = j.usage;
    const delta = j.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string") raw += delta.content;
    if (delta.reasoning_content || delta.reasoning) hadReasoning = true;
  };
  for await (const part of r.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(part, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
  }
  take(buf.trim());
  return { raw, served, usage, hadReasoning };
}

export async function chat(messages: { role: string; content: string }[], o: ChatOpts): Promise<ChatOut> {
  const body = JSON.stringify({ model: o.model, messages, max_tokens: o.maxTokens ?? 4000, temperature: 0, ...(o.stream ? { stream: true } : {}), ...(o.extraBody ?? {}) });
  const tries = o.retries ?? 40;
  let last = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    const t0 = Date.now();
    // the product sends the Power contract's "user"; only a recording or an evaluation run isolates each request
    const iso = process.env.METERLESS_SCOPE === "iso" || (["1", "true", "yes"].includes(String(process.env.APRIME_RECORD ?? "").toLowerCase()) && process.env.METERLESS_SCOPE !== "user");
    const scope = o.isoScope && iso ? "iso-" + crypto.randomUUID() : undefined;
    await acquire();
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), o.timeoutMs ?? 300_000);
      const headers: Record<string, string> = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json", "meterless-app": "aprime", "meterless-scope": "user", ...(o.headers ?? {}) };
      if (scope) headers["meterless-scope"] = scope;
      if (o.tierSplit === false) headers["meterless-tier-split"] = "off";
      let raw: string, served: string, usage: any, hadReasoning = false;
      try {
        // the headers exactly as sent, token masked (runs/sent_headers.jsonl, the same log the app writes)
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        fs.appendFileSync(path.join(path.dirname(LOG), "sent_headers.jsonl"), scrub(JSON.stringify({ at: new Date().toISOString(), tag: o.tag, method: "POST", path: new URL(BASE + "/chat/completions").pathname,
          headers: { ...headers, Authorization: "Bearer <masked>" } })) + "\n");
        const r = await fetch(BASE + "/chat/completions", { method: "POST", body, signal: ctl.signal, headers });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        if (o.stream && (r.headers.get("content-type") || "").includes("text/event-stream")) {
          const s = await readSSE(r); raw = s.raw; served = s.served ?? "?"; usage = s.usage ?? {}; hadReasoning = s.hadReasoning;
        } else {
          const j = JSON.parse(await r.text()); const msg = j.choices?.[0]?.message ?? {};
          raw = typeof msg.content === "string" ? msg.content : (msg.content ?? []).map((p: any) => p.text ?? "").join("");
          served = j.model; usage = j.usage ?? {}; hadReasoning = !!msg.reasoning_content;
        }
      } finally { clearTimeout(to); }
      const out: ChatOut = { text: stripReasoning(raw), served, usage, latency: (Date.now() - t0) / 1000,
        hadThink: raw.includes("</think>") || hadReasoning, attempts: attempt + 1 };
      log({ ts: new Date().toISOString(), tag: o.tag, requested: o.model, served, usage, latency: out.latency, attempt, hadThink: out.hadThink,
        stream: !!o.stream, tierSplit: o.tierSplit !== false, iso: !!scope, rawChars: raw.length });
      if (!out.text) throw new Error("empty answer after stripping reasoning");
      return out;
    } catch (e) {
      last = scrub(String((e as Error).message ?? e));
      log({ ts: new Date().toISOString(), tag: o.tag, requested: o.model, error: last.slice(0, 300), attempt, stream: !!o.stream, tierSplit: o.tierSplit !== false });
    } finally { release(); }
    if (attempt + 1 >= tries) break;
    // Back off: 15 s, 30 s, 60 s, 120 s, ... (cap 180 s). One request in flight at a time either way.
    await new Promise((r) => setTimeout(r, Math.min(180_000, 15_000 * 2 ** attempt)));
  }
  throw new Error(last);
}
