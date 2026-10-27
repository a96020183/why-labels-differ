// Structured trace: one event per agent step. The UI replays it (with pacing), the README quotes it.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { scrub } from "./config.ts";

export type Agent = "planner" | "research" | "evaluator" | "skeptic" | "writer" | "counsel" | "watcher" | "committee" | "system";
export type Kind = "plan" | "replan" | "sql" | "model" | "draft" | "reject" | "approve" | "escalate" | "check" | "verdict" | "vote" | "fired" | "held" | "info" | "error" | "denied";

export type ModelInfo = { lane: string; requested: string; served: string; source: "live" | "replay" | "offline-stub"; latencyMs?: number; tokens?: number; rejudged?: boolean };
export type TraceEvent = {
  seq: number; t: string; run: string; round?: number; agent: Agent; kind: Kind; summary: string;
  receipts?: string[]; model?: ModelInfo; detail?: unknown;
};
type Listener = (e: TraceEvent) => void;

export class Trace {
  run: string;
  events: TraceEvent[] = [];
  private listeners = new Set<Listener>();
  private file?: string;
  constructor(run: string, dir?: string) {
    this.run = run;
    if (dir) { mkdirSync(dir, { recursive: true }); this.file = path.join(dir, "trace.jsonl"); }
  }
  emit(e: Omit<TraceEvent, "seq" | "t" | "run">): TraceEvent {
    const ev: TraceEvent = { seq: this.events.length + 1, t: new Date().toISOString(), run: this.run, ...e };
    this.events.push(ev);
    if (this.file) appendFileSync(this.file, scrub(JSON.stringify(ev)) + "\n");
    for (const l of this.listeners) l(ev);
    return ev;
  }
  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

/** numbers computed from the trace itself (shown at the top of the trace view) */
export function traceStats(events: TraceEvent[]) {
  const hyp = events.find((e) => e.agent === "planner" && Array.isArray(e.detail));
  type F = { records: number; verified: number; unchecked?: number; contradicted: string[]; claims: number; claimsSupported: number; second?: { checked: number; verified: number; contradicted: number; notComparable: number } };
  const fal = events.map((e) => (e.detail as { falsification?: F })?.falsification).filter((x): x is F => !!x);
  const rej = events.filter((e) => e.agent === "evaluator" && e.kind === "reject").map((e) => String((e.detail as { decidedBy?: string })?.decidedBy ?? ""));
  return {
    modelCalls: events.filter((e) => e.kind === "model").length,
    rejections: rej.length,
    rejectionsByModel: rej.filter((d) => d === "model").length, // the three are exclusive: model only, checks only, both
    rejectionsByChecks: rej.filter((d) => /^checks/.test(d)).length,
    rejectionsByBoth: rej.filter((d) => /^model and checks/.test(d)).length,
    checksOverruledByModel: events.filter((e) => e.agent === "evaluator" && e.kind === "approve" && /overruled/.test(String((e.detail as { decidedBy?: string })?.decidedBy ?? ""))).length,
    planRevisions: events.filter((e) => e.kind === "replan").length,
    escalations: events.filter((e) => e.kind === "escalate").length,
    hypothesesConsidered: Array.isArray(hyp?.detail) ? (hyp!.detail as unknown[]).length : 0,
    skepticRecordsChecked: fal.reduce((a, f) => a + f.records - (f.unchecked ?? 0), 0), // records the Skeptic could fetch again by key
    skepticUnchecked: fal.reduce((a, f) => a + (f.unchecked ?? 0), 0), // cited records with no independent query (not counted as held)
    repairs: events.filter((e) => e.agent === "writer" && e.kind === "draft" && /\(repair /.test(e.summary)).length,
    disputesVerified: events.flatMap((e) => (e.agent === "writer" && e.kind === "draft" ? ((e.detail as { disputes?: { accepted: boolean }[] })?.disputes ?? []) : [])).filter((x) => x.accepted).length,
    disputesRefused: events.flatMap((e) => (e.agent === "writer" && e.kind === "draft" ? ((e.detail as { disputes?: { accepted: boolean }[] })?.disputes ?? []) : [])).filter((x) => !x.accepted).length,
    skepticVerified: fal.reduce((a, f) => a + f.verified, 0),
    skepticContradicted: fal.reduce((a, f) => a + f.contradicted.filter((c) => !c.startsWith("claim ")).length, 0), // records the independent fetch did not back (code)
    skepticClaimsContradicted: fal.reduce((a, f) => a + f.contradicted.filter((c) => c.startsWith("claim ")).length, 0), // claims Nemotron found its records do not back
    openFdaChecked: fal.reduce((a, f) => a + (f.second?.checked ?? 0), 0), // the U.S. label column against openFDA's copy (second source)
    openFdaAgree: fal.reduce((a, f) => a + (f.second?.verified ?? 0), 0),
    openFdaContradict: fal.reduce((a, f) => a + (f.second?.contradicted ?? 0), 0),
    openFdaOtherVersion: fal.reduce((a, f) => a + (f.second?.notComparable ?? 0), 0),
    skepticClaimsJudged: fal.reduce((a, f) => a + f.claims, 0),
    skepticClaimsSupported: fal.reduce((a, f) => a + f.claimsSupported, 0),
    sqlQueries: events.reduce((a, e) => a + (e.receipts?.length ?? 0), 0),
    // the investigation's queries (Planner to Evaluator) are the ones before the vote; the total adds the vote, counseling and reopen checks
    sqlBeforeVote: events.slice(0, ((i) => (i < 0 ? events.length : i))(events.findIndex((e) => e.kind === "vote" || e.agent === "committee"))).reduce((a, e) => a + (e.receipts?.length ?? 0), 0),
  };
}
