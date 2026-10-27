// A' Markovian engine: a minimal implementation of the Meterless Markovian spec
// (github.com/Meterless/Meterless engines/markovian/AGENTS.md, repo HEAD 1742dec5, fetched 2026-10-23).
// Written for this project; the official reference was read for the contract, not copied.
// Covers: ChunkConfig bounds + typed validation (2.1), ChunkInfo/run record with mandatory config snapshot (2.2-2.3),
// cumulative stats (2.4), marker protocol + cleaner (3), compression cascade marker -> LLM -> heuristic -> truncation (4.3),
// prompt builder with [CARRYOVER STATE] and [OVERLAP] (4.4, 2.1), orchestrator with abort checks (4.5, 11),
// progress phases (4.6), JSON history (4.7), memoryContext into chunk 1 (5), efficiency math (6, docs/efficiency-model.md),
// reflection that never fails the run (7), measured-vs-estimated token labels (14).
// Our additions (not in the spec, named so): `stepInput(step)` feeds a host-side work batch into each chunk, the way a
// [NEEDS_TOOL] result would be injected; per-chunk measured input/output tokens and cascade level are recorded.

import fs from "node:fs";
import path from "node:path";

export interface ChunkConfig { chunkSize: number; maxChunks: number; carryoverTokens: number; overlapTokens: number }
export const DEFAULT_CONFIG: ChunkConfig = { chunkSize: 8000, maxChunks: 24, carryoverTokens: 800, overlapTokens: 0 };
export const BOUNDS = {
  chunkSize: { min: 1000, max: 128000 },
  maxChunks: { min: 1, max: 32 },
  carryoverTokens: { min: 128, max: 32768 },
  overlapTokens: { min: 0, max: 4096 },
};
export const FRAMING_TOKENS = 400;
export const OUTPUT_BUDGET = 1200;
export const estimateTokens = (t: string): number => Math.ceil((t ?? "").length / 4);

export class ConfigValidationError extends Error {
  constructor(msg: string) { super(`Markovian config: ${msg}`); this.name = "ConfigValidationError"; }
}

export function resolveConfig(partial?: Partial<ChunkConfig>, contextWindow?: number): ChunkConfig {
  const cfg: ChunkConfig = { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  for (const k of Object.keys(BOUNDS) as (keyof ChunkConfig)[]) {
    const v = cfg[k], b = BOUNDS[k];
    if (!Number.isFinite(v)) throw new ConfigValidationError(`${k} must be a number`);
    if (v < b.min || v > b.max) throw new ConfigValidationError(`${k}=${v} outside [${b.min}, ${b.max}]`);
  }
  if (cfg.carryoverTokens <= 0) throw new ConfigValidationError("carryoverTokens must be > 0");
  if (cfg.chunkSize < FRAMING_TOKENS + cfg.carryoverTokens + OUTPUT_BUDGET)
    throw new ConfigValidationError(`chunkSize=${cfg.chunkSize} < framing ${FRAMING_TOKENS} + carryover ${cfg.carryoverTokens} + output ${OUTPUT_BUDGET}`);
  if (contextWindow && cfg.chunkSize > contextWindow) throw new ConfigValidationError(`chunkSize=${cfg.chunkSize} exceeds model context ${contextWindow}`);
  // overlapTokens > 0 is IMPLEMENTED (an [OVERLAP] block), never accepted-and-ignored.
  return cfg;
}

export interface ChunkInfo {
  id: number; tokens: number; carryover: string; content: string;
  inputTokens?: number; outputTokens?: number; promptTokensEstimated?: number; cascade?: string; model?: string;
}
export type RunStatus = "completed" | "max-chunks" | "errored" | "aborted";
export type Mode = "ARCHITECT" | "RESEARCH";
export interface MarkovianRun {
  id: string; timestamp: number; prompt: string; mode: Mode; chunkConfig: ChunkConfig; chunks: ChunkInfo[];
  totalTokensUsed: number; totalTokensSaved: number; efficiencyPercent: number; durationMs: number; status: RunStatus;
  tokenLabel: "estimated" | "measured"; output: string; finalCarryover: string; reflection?: string; error?: string;
}
export interface GenResult { text: string; metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } }
export type Generator = (prompt: string, attachments: { name: string; content: string }[], systemPrompt?: string,
  onStream?: (d: string) => void, abortSignal?: AbortSignal) => Promise<GenResult>;

// ---- efficiency math (AGENTS.md 6.3, docs/efficiency-model.md) ----
export function runEfficiency(chunks: ChunkInfo[], cfg: ChunkConfig) {
  const totalTokensUsed = chunks.reduce((s, c) => s + c.tokens, 0);
  let standardCost = 0, prefix = 0;
  for (const c of chunks) { standardCost += prefix + c.tokens; prefix += c.tokens; }
  const markovianCost = chunks.length * cfg.carryoverTokens + totalTokensUsed;
  const tokensSaved = Math.max(0, standardCost - markovianCost);
  return { totalTokensUsed, standardCost, markovianCost, tokensSaved, efficiencyPercent: standardCost > 0 ? (tokensSaved / standardCost) * 100 : 0 };
}
export const DOC_DEFAULTS = { F: 400, G: 200, S: 300, O: 1200, C: 800 };
export function modelTotals(N: number, k = DOC_DEFAULTS) {
  const naiveTotal = N * (k.F + k.G + k.S) + (k.O * N * (N - 1)) / 2;
  const markovianTotal = N * (k.F + k.G + k.C + k.S);
  return { naiveTotal, markovianTotal, savings: naiveTotal - markovianTotal, efficiency: (naiveTotal - markovianTotal) / naiveTotal };
}
export function projectionCurve(cfg: ChunkConfig, steps = 10) {
  return Array.from({ length: steps }, (_, i) => ({ step: i + 1, standard: i * cfg.chunkSize + cfg.chunkSize, markovian: cfg.carryoverTokens + cfg.chunkSize }));
}

// ---- marker protocol (AGENTS.md 3, docs/marker-protocol.md) ----
const STATE_TAILS = [/\[STATE_CHECKPOINT\]\s*([\s\S]*)$/, /@@@STATE@@@\s*([\s\S]*)$/, /(?:^|\n)\[STATE\]\s*([\s\S]*)$/, /---STATE---\s*([\s\S]*)$/];
const FINAL = [/\[TASK_COMPLETE\]/, /@@@FINAL@@@/, /(?:^|\n)\[FINAL\]/, /---FINAL---/];
export function parseMarkers(raw: string) {
  let state: string | undefined;
  for (const re of STATE_TAILS) { const m = raw.match(re); if (m) { state = m[1].replace(/\[TASK_COMPLETE\]/g, "").trim(); break; } }
  const t = raw.match(/\[NEEDS_TOOL\s+tool="([^"]+)"\s+input="([^"]*)"\]/);
  const c = raw.match(/\[NEEDS_CLARIFICATION\]\s*([^\n]*)/);
  return { state, done: FINAL.some((re) => re.test(raw)), needsTool: t ? { tool: t[1], input: t[2] } : undefined,
    needsClarification: c ? c[1].trim() : undefined, cleaned: cleanMarkers(raw) };
}
export function cleanMarkers(raw: string): string {
  let o = raw;
  o = o.replace(/\[NEEDS_TOOL[^\]]*\]/g, "").replace(/\[NEEDS_CLARIFICATION\][^\n]*/g, "");
  o = o.replace(/\[STATE_CHECKPOINT\][\s\S]*$/, "").replace(/@@@STATE@@@[\s\S]*$/, "").replace(/---STATE---[\s\S]*$/, "").replace(/\n\[STATE\][\s\S]*$/, "");
  for (const re of [/\[TASK_COMPLETE\]/g, /@@@FINAL@@@/g, /---FINAL---/g]) o = o.replace(re, "");
  o = o.replace(/\n\[FINAL\][\s\S]*$/, "");
  return o.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- compression cascade (AGENTS.md 4.3) ----
const KEY_PHRASE = /(?:^|\n|\.\s+)((?:Therefore|Key insight|Status|Decision|Decided|Next|Remaining|Completed|CONTEXT)[^.\n]*)/gi;
export async function nextCarryover(a: { markerState?: string; previous: string; chunkText: string; cfg: ChunkConfig;
  compressorFn?: (p: string, s: string) => Promise<string> }): Promise<{ carryover: string; level: string }> {
  const budget = a.cfg.carryoverTokens;
  if (a.markerState !== undefined) {
    const s = a.markerState.replace(/[<>[\]@-]{3,}/g, "").trim();
    if (s.length >= 24 && estimateTokens(s) <= budget) return { carryover: s, level: "marker" };
  }
  if (a.compressorFn) {
    try {
      const src = a.markerState && a.markerState.length >= 24 ? a.markerState : a.chunkText.slice(-2000);
      const prompt = `Previous state:\n${a.previous || "(none)"}\n\nLatest chunk state (to compress):\n${src}\n\n` +
        `Compress into 3-5 critical points as a labeled block, at most ${budget * 4} characters in total:\nCOMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...`;
      const out = (await a.compressorFn(prompt, "You compress reasoning state. Be terse and lossless on decisions.")).trim();
      if (out.length >= 24 && estimateTokens(out) <= budget) return { carryover: out, level: "llm" };
    } catch { /* fall through */ }
  }
  const phrases = [...a.chunkText.matchAll(KEY_PHRASE)].map((m) => m[1].trim()).slice(0, 5);
  if (phrases.length) { const s = phrases.join("; "); if (estimateTokens(s) <= budget) return { carryover: s, level: "heuristic" }; }
  const words = (a.markerState || a.chunkText || a.previous).split(/\s+/).filter(Boolean);
  let tail = "";
  for (let i = words.length - 1; i >= 0; i--) { const c = words[i] + (tail ? " " + tail : ""); if (estimateTokens(c) > budget) break; tail = c; }
  return { carryover: tail, level: "truncation" };
}

// ---- prompt builder (AGENTS.md 4.4, 5, 2.1) ----
const MARKER_RULES = "End every non-final chunk with [STATE_CHECKPOINT] followed by a concise state block:\n" +
  "COMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...\nEnd the final chunk with [TASK_COMPLETE]. Exactly one marker per chunk. Never narrate the markers.";
export function buildPrompt(a: { mode: Mode; goal: string; step: number; carryover: string; overlapText: string; memoryContext?: string;
  attachments: { name: string; content: string }[]; stepInput?: string }): string {
  const p: string[] = [];
  if (a.step === 1) {
    if (a.memoryContext) p.push(a.memoryContext.trim(), "");
    p.push(a.mode === "ARCHITECT" ? "You are executing a long build task in bounded chunks. Analyze the goal, produce a plan, and start implementation."
      : "You are executing recursive research in bounded chunks. Log every action as '>> action'. Keep a research-tree state snapshot.");
    p.push("", `User Request: ${a.goal}`);
    for (const at of a.attachments) p.push("", `[ATTACHMENT ${at.name}]\n${at.content}`);
  } else {
    p.push(`Continuing a chunked ${a.mode.toLowerCase()} run. Goal (truncated): ${a.goal.slice(0, 200)}`, "", `[CARRYOVER STATE]\n${a.carryover}`);
    if (a.overlapText) p.push("", `[OVERLAP]\n${a.overlapText}`);
    p.push("", "Continue exactly where the state leaves off. Do not repeat completed work.");
  }
  if (a.stepInput) p.push("", a.stepInput);
  p.push("", MARKER_RULES);
  return p.join("\n");
}
export const overlapSlice = (prev: string, cfg: ChunkConfig) => (cfg.overlapTokens > 0 && prev ? prev.slice(-cfg.overlapTokens * 4) : "");

// ---- progress + history (AGENTS.md 4.6, 4.7, 2.4) ----
export type Phase = "initializing" | "generating" | "compressing" | "reflecting" | "complete" | "error";
export class ProgressService {
  state: { isActive: boolean; phase: Phase; phaseDetail: string; currentChunk: number; logs: string[]; completedChunks: ChunkInfo[] };
  private subs: ((s: any) => void)[] = [];
  constructor() { this.state = { isActive: false, phase: "initializing", phaseDetail: "", currentChunk: 0, logs: [], completedChunks: [] }; }
  subscribe(fn: (s: any) => void) { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn); }; }
  phase(p: Phase, detail = "") {
    this.state.phase = p; this.state.phaseDetail = detail; this.state.isActive = !(p === "complete" || p === "error");
    this.state.logs = [...this.state.logs, `${p} ${detail}`].slice(-15); this.subs.forEach((f) => f(this.state));
  }
  chunkDone(c: ChunkInfo) { this.state.currentChunk = c.id; this.state.completedChunks.push(c); this.subs.forEach((f) => f(this.state)); }
}
export class HistoryService {
  runs: MarkovianRun[] = [];
  private dir?: string;
  constructor(dir?: string) {
    this.dir = dir;
    if (dir) { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, "history.json"); if (fs.existsSync(f)) this.runs = JSON.parse(fs.readFileSync(f, "utf8")); }
  }
  record(r: MarkovianRun) { this.runs.push(r); if (this.dir) fs.writeFileSync(path.join(this.dir, "history.json"), JSON.stringify(this.runs, null, 1)); }
  stats() {
    const rs = this.runs;
    return { totalRuns: rs.length, completedRuns: rs.filter((r) => r.status === "completed").length,
      totalTokensUsed: rs.reduce((s, r) => s + r.totalTokensUsed, 0), totalTokensSaved: rs.reduce((s, r) => s + r.totalTokensSaved, 0),
      averageEfficiency: rs.length ? rs.reduce((s, r) => s + r.efficiencyPercent, 0) / rs.length : 0,
      totalChunksProcessed: rs.reduce((s, r) => s + r.chunks.length, 0), lastRunTimestamp: rs.at(-1)?.timestamp ?? 0,
      efficiencyHistory: rs.map((r) => ({ timestamp: r.timestamp, efficiency: r.efficiencyPercent, tokensSaved: r.totalTokensSaved })) };
  }
}

// ---- orchestrator (AGENTS.md 4.5, 7, 11) ----
let seq = 0;
export interface RunOptions {
  goal?: string; prompt?: string; mode?: Mode; generator?: Generator; memoryContext?: string;
  attachments?: { name: string; content: string }[]; abortSignal?: AbortSignal; reflect?: boolean;
  stepInput?: (step: number) => string | undefined; // our addition: host work batch per chunk
  systemPrompt?: string;
}
export class Markovian {
  readonly config: ChunkConfig; readonly history: HistoryService; readonly progress = new ProgressService();
  private clock: () => number; private gen?: Generator; private compressorFn?: (p: string, s: string) => Promise<string>;
  constructor(o: { chunkConfig?: Partial<ChunkConfig>; clock?: () => number; generator?: Generator; contextWindow?: number;
    compressorFn?: (p: string, s: string) => Promise<string>; historyDir?: string } = {}) {
    this.config = resolveConfig(o.chunkConfig, o.contextWindow);
    this.clock = o.clock ?? Date.now; this.gen = o.generator; this.compressorFn = o.compressorFn;
    this.history = new HistoryService(o.historyDir);
  }
  async run(opt: RunOptions): Promise<MarkovianRun> {
    const goal = opt.goal ?? opt.prompt; if (!goal) throw new Error("Markovian: run needs a goal or prompt");
    const gen = opt.generator ?? this.gen; if (!gen) throw new Error("Markovian: provide a generator");
    const cfg = this.config, mode = opt.mode ?? "RESEARCH", start = this.clock();
    const run: MarkovianRun = { id: `run-${++seq}-${start}`, timestamp: start, prompt: goal.slice(0, 500), mode, chunkConfig: { ...cfg },
      chunks: [], totalTokensUsed: 0, totalTokensSaved: 0, efficiencyPercent: 0, durationMs: 0, status: "completed",
      tokenLabel: "estimated", output: "", finalCarryover: "" };
    const parts: string[] = []; let carry = "", prev = "", done = false, measured = true;
    this.progress.phase("initializing", `${mode} chain, maxChunks=${cfg.maxChunks}`);
    try {
      while (run.chunks.length < cfg.maxChunks && !done) {
        if (opt.abortSignal?.aborted) { run.status = "aborted"; break; }
        const step = run.chunks.length + 1;
        this.progress.phase("generating", `chunk ${step}`);
        const atts = step === 1 ? opt.attachments ?? [] : [];
        const prompt = buildPrompt({ mode, goal, step, carryover: carry, overlapText: overlapSlice(prev, cfg), memoryContext: opt.memoryContext,
          attachments: atts, stepInput: opt.stepInput?.(step) });
        const res = await gen(prompt, atts, opt.systemPrompt, undefined, opt.abortSignal);
        const parsed = parseMarkers(res.text);
        const u = res.metadata?.usage;
        if (!u?.prompt_tokens) measured = false;
        const chunk: ChunkInfo = { id: step, tokens: estimateTokens(parsed.cleaned), carryover: carry, content: parsed.cleaned,
          inputTokens: u?.prompt_tokens, outputTokens: u?.completion_tokens, promptTokensEstimated: estimateTokens(prompt), model: res.metadata?.model };
        run.chunks.push(chunk); parts.push(parsed.cleaned); prev = parsed.cleaned; this.progress.chunkDone(chunk);
        if (opt.abortSignal?.aborted) { run.status = "aborted"; break; }
        this.progress.phase("compressing", `chunk ${step}`);
        const nx = await nextCarryover({ markerState: parsed.state, previous: carry, chunkText: res.text, cfg, compressorFn: this.compressorFn });
        carry = nx.carryover; chunk.cascade = nx.level;
        if (parsed.done) done = true;
      }
      if (!done && run.status === "completed" && run.chunks.length >= cfg.maxChunks) run.status = "max-chunks";
    } catch (e) { run.status = "errored"; run.error = (e as Error).message; this.progress.phase("error", run.error); }
    run.output = parts.join("\n\n"); run.finalCarryover = carry;
    run.tokenLabel = measured && run.chunks.length > 0 ? "measured" : "estimated";
    const eff = runEfficiency(run.chunks, run.chunkConfig);
    run.totalTokensUsed = eff.totalTokensUsed; run.totalTokensSaved = eff.tokensSaved; run.efficiencyPercent = eff.efficiencyPercent;
    if (opt.reflect !== false && run.status === "completed" && run.chunks.length > 0) {
      this.progress.phase("reflecting");
      try {
        const r = await gen(`Reflect on this completed run.\nGoal: ${goal.slice(0, 200)}\nFinal state: ${carry}\nOutput (truncated): ${run.output.slice(0, 4000)}\n` +
          `Verdict: ratify if the goal is met, refine with concrete gaps otherwise.`, [], "You are the reflection pass. Be brief and concrete.");
        run.reflection = cleanMarkers(r.text);
      } catch (e) { run.reflection = undefined; run.error = `reflection failed (run preserved): ${(e as Error).message}`; }
    }
    run.durationMs = this.clock() - start;
    this.progress.phase(run.status === "errored" ? "error" : "complete", run.status);
    this.history.record(run);
    return run;
  }
}
