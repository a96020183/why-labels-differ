// Model calls. Meterless Nightshift is the only provider (OpenAI-compatible, local). Rules learned on 2026-10-23
// (our notes from testing Nightshift with long prompts): stream: true; header meterless-tier-split: off; everything long goes in the system message
// and the user message is one short instruction (a long user message is routed to a lane that never answers); one request
// in flight. Scope: the product sends the Power contract's meterless-scope: user. Only a recording or an evaluation run
// (APRIME_RECORD=true, or METERLESS_SCOPE=iso) sends a fresh iso-<uuid> per request, because with "user" Nightshift puts
// earlier answers into the prompt and a recording must not depend on what ran before it (README, Sponsor technology).
// Every request's headers, as sent, are logged at the HTTP client (runs/sent_headers.jsonl; the token is masked).
// The served model is recorded on every call. SAMPLE_MODE replays recorded replies (sample/cassettes/models.jsonl);
// on a miss with no token the agent's deterministic fallback answers and is labelled "offline-stub", never Nemotron.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, scrub, sleep, ROOT } from "./config.ts";
/** the Power contract's "user", except when recording or evaluating (a fresh iso scope per request; README explains why) */
export const isoScopes = () => process.env.METERLESS_SCOPE === "iso" || (config.record && process.env.METERLESS_SCOPE !== "user");
const scopeHeader = () => (isoScopes() ? "iso-" + randomUUID() : "user");
/** the HTTP client: logs the headers exactly as sent, with the bearer token masked, then sends */
export function sendLogged(url: string, init: RequestInit & { headers: Record<string, string> }, tag: string) {
  const shown = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k, /^authorization$/i.test(k) ? v.replace(/^(Bearer\s+).*/i, "$1<masked>") : v]));
  const log = process.env.APRIME_HEADER_LOG || path.join(ROOT, "runs", "sent_headers.jsonl");
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, scrub(JSON.stringify({ at: new Date().toISOString(), tag, method: init.method ?? "GET", path: new URL(url).pathname, headers: shown })) + "\n");
  return fetch(url, init);
}

export type Lane = "fast" | "deep";
export type ModelReply = { text: string; served: string; requested: string; lane: Lane; source: "live" | "replay" | "offline-stub"; latencyMs: number; tokens?: number; rejudged?: boolean };
export class ModelUnavailable extends Error {}
/** a re-judged replay reached a step the recording never made (today's checks sent back a draft the recording approved) */
export class NotRecorded extends Error {}

export const ASK = "Answer now: follow the instructions above for the input given there. Reply only in the format the instructions ask for.";
export const callKey = (lane: Lane, system: string) => createHash("sha256").update(lane + "|" + system).digest("hex").slice(0, 24);

export function stripReasoning(t: string): string {
  let s = (t ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  if (s.includes("</think>")) s = s.slice(s.lastIndexOf("</think>") + 8);
  return s.trim();
}
/** the LAST well-formed JSON object in a reply (models sometimes draft before the final answer) */
export function lastJson<T = Record<string, unknown>>(t: string): T | undefined {
  const s = stripReasoning(t).replace(/```(?:json)?/g, "");
  for (let end = s.lastIndexOf("}"); end > 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (s[i] === "}") depth++;
      else if (s[i] === "{" && --depth === 0) { try { return JSON.parse(s.slice(i, end + 1)) as T; } catch { break; } }
    }
  }
  return undefined;
}

/** the last JSON object that has at least one of the expected keys (skips inner objects of a reply cut short) */
export function jsonWith<T = Record<string, unknown>>(t: string, keys: string[]): T | undefined {
  const s = stripReasoning(t).replace(/```(?:json)?/g, "");
  for (let end = s.lastIndexOf("}"); end > 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (s[i] === "}") depth++;
      else if (s[i] === "{" && --depth === 0) {
        try { const o = JSON.parse(s.slice(i, end + 1)); if (o && typeof o === "object" && keys.some((k) => k in o)) return o as T; } catch { /* not JSON */ }
        break;
      }
    }
  }
  return undefined;
}

async function readStream(res: Response): Promise<{ text: string; served?: string }> {
  if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
    const out = JSON.parse(await res.text());
    return { text: out.choices?.[0]?.message?.content ?? "", served: out.model };
  }
  let text = "", served: string | undefined, buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { text, served };
      let j: { error?: unknown; model?: string; meterless?: { routed_model?: string }; choices?: { delta?: { content?: string } }[] };
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error("stream error: " + JSON.stringify(j.error).slice(0, 200));
      served = j.meterless?.routed_model ?? j.model ?? served;
      text += j.choices?.[0]?.delta?.content ?? "";
    }
  }
  return { text, served };
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

type Cassette = { text: string; served: string; tokens?: number; at?: string };
let cassette: Map<string, Cassette> | undefined, byTag: Map<string, Cassette[]> | undefined;
function load() {
  if (cassette) return cassette;
  cassette = new Map(); byTag = new Map();
  const f = path.join(config.cassetteDir, "models.jsonl");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); cassette.set(r.key, r); byTag.get(r.tag)?.push(r) ?? byTag.set(r.tag, [r]); }
  return cassette;
}
/** steps whose prompt lists the code checks' findings; when only the checks changed after a recording, the recorded
 *  reply of the same step (same question, same round) is re-judged with today's checks instead of asking a model again */
const REJUDGE_STEPS = /^(eval|rebut|repair|replan|write):/;

export class Models {
  calls: ModelReply[] = [];
  /** a replay of a recorded investigation (Session, the loop) may re-judge recorded replies; a scripted test may not */
  rejudge: boolean; endAtMiss: boolean;
  /** when this run's recording started: its first exact replay (a re-judged step uses a reply of the same recording only) */
  private since = "";
  constructor(o: { rejudge?: boolean; endAtMiss?: boolean } = {}) { this.rejudge = !!o.rejudge; this.endAtMiss = !!o.endAtMiss; }
  requested(lane: Lane) { return lane === "deep" ? config.nightshift.deep : config.nightshift.fast; }

  private async live(lane: Lane, system: string, maxTokens: number, retries: number, tag: string) {
    let last = "";
    for (let attempt = 0; attempt < retries; attempt++) {
      const t0 = Date.now();
      const scope = scopeHeader();
      try {
        const res = await sendLogged(config.nightshift.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + config.nightshift.token, "Content-Type": "application/json", "meterless-app": config.nightshift.app,
            "meterless-scope": scope, "meterless-tier-split": "off" },
          body: JSON.stringify({ model: this.requested(lane), messages: [{ role: "system", content: system }, { role: "user", content: ASK }],
            max_tokens: maxTokens, temperature: 0, stream: true }),
          signal: AbortSignal.timeout(config.nightshift.timeoutMs),
        }, tag);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        const { text, served } = await readStream(res);
        const clean = stripReasoning(text);
        if (!clean) throw new Error("empty reply");
        return { text: clean, served: served ?? "unknown", tokens: Math.round((system.length + ASK.length + text.length) / 4), latencyMs: Date.now() - t0, scope };
      } catch (e) {
        last = scrub(String((e as Error).message ?? e));
        if (attempt < retries - 1) await sleep([15_000, 30_000, 60_000, 120_000, 180_000][Math.min(attempt, 4)]);
      }
    }
    throw new ModelUnavailable(`Nightshift unavailable after ${retries} tries: ${last}`);
  }

  /** valid(): a reply that fails it is asked again (counts as a try); stub(): deterministic offline answer */
  async chat(lane: Lane, system: string, o: { tag: string; maxTokens?: number; stub: () => string; valid?: (t: string) => boolean; runDir?: string }): Promise<ModelReply> {
    const key = callKey(lane, system);
    const requested = this.requested(lane);
    const exact = load().get(key);
    if (exact?.at && (!this.since || exact.at < this.since)) this.since = exact.at;
    const again = !exact && this.rejudge && REJUDGE_STEPS.test(o.tag) && this.since ? (byTag!.get(o.tag) ?? []).filter((x) => (x.at ?? "") >= this.since).at(-1) : undefined;
    const hit = exact ?? again;
    const canLive = !config.nightshift.offline && !!config.nightshift.token;
    let reply: ModelReply, sentScope = "";
    const replay = (): ModelReply => hit
      ? { text: hit.text, served: hit.served, requested, lane, source: "replay", latencyMs: 0, tokens: hit.tokens, ...(again ? { rejudged: true } : {}) }
      : { text: o.stub(), served: "offline-stub", requested, lane, source: "offline-stub", latencyMs: 0 };
    if (config.sampleMode || !canLive) {
      if (!hit && this.endAtMiss) throw new NotRecorded(`${o.tag} is not in the recording`);
      if (hit && config.paceMs) await sleep(config.paceMs * 4);
      reply = replay();
    } else {
      try {
        let r = await serial(() => this.live(lane, system, o.maxTokens ?? 2500, config.nightshift.retries, o.tag));
        for (let k = 0; o.valid && !o.valid(r.text) && k < 2; k++) r = await serial(() => this.live(lane, system, o.maxTokens ?? 2500, config.nightshift.retries, o.tag));
        sentScope = r.scope;
        reply = { text: r.text, served: r.served, tokens: r.tokens, latencyMs: r.latencyMs, requested, lane, source: "live" };
        if (config.record && (!o.valid || o.valid(r.text))) {
          mkdirSync(config.cassetteDir, { recursive: true });
          appendFileSync(path.join(config.cassetteDir, "models.jsonl"), JSON.stringify({ key, tag: o.tag, lane, requested, served: r.served, tokens: r.tokens, latencyMs: r.latencyMs, text: r.text, at: new Date().toISOString() }) + "\n");
          load().set(key, { text: r.text, served: r.served, tokens: r.tokens });
        }
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) throw e;
        reply = replay(); // Nightshift down: recorded answer if we have one, else the labelled offline stub
      }
    }
    this.calls.push(reply);
    // every live call is logged without its content: when, which step, the scope header it was sent with (the
    // answered attempt; every attempt's headers are in runs/sent_headers.jsonl), which model answered
    if (reply.source === "live") {
      mkdirSync(path.join(ROOT, "runs"), { recursive: true });
      appendFileSync(path.join(ROOT, "runs", "app_calls.jsonl"), scrub(JSON.stringify({ at: new Date().toISOString(), tag: o.tag, lane, scope: sentScope, requested, served: reply.served, latencyMs: reply.latencyMs, tokens: reply.tokens, recorded: config.record })) + "\n");
    }
    if (o.runDir) {
      mkdirSync(o.runDir, { recursive: true });
      appendFileSync(path.join(o.runDir, "model_calls.jsonl"), scrub(JSON.stringify({ tag: o.tag, key, lane, requested, served: reply.served, source: reply.source, latencyMs: reply.latencyMs, tokens: reply.tokens })) + "\n");
    }
    return reply;
  }
}
