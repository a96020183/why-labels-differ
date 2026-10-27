// The case state every agent reads and writes, kept in the Meterless World Model (engine/world-model, conformance 8/8).
// Entities: the case, each competing hypothesis, each evidence record, each verdict value. Edges: hypothesis -verdict->
// value (bitemporal: a later round's verdict closes the earlier edge instead of overwriting it), hypothesis
// -supported_by / refuted_by-> record, record -found_in-> round. Every write carries provenance (agent, round).
// What the loop uses it for (and loses without it, see test/app.test.ts):
//   - the Writer and the Planner see each hypothesis's verdict history and evidence, not only the last draft
//   - the Skeptic attacks the records that currently hold up a "holds" verdict
//   - the Evaluator sees a verdict that flipped between rounds with no new record behind the flip
// APRIME_WORLD_MODEL=off turns it into a no-op (the ablation the test runs).
import { WorldModel } from "../engine/world-model/index.ts";

export type HypState = { id: string; name: string; status: string; history: { round: number; status: string }[]; for: string[]; against: string[] };
const at = (round: number) => `2026-10-24T00:00:0${round}.000Z`; // logical time per round: replays give identical state

export class CaseState {
  wm?: WorldModel;
  private caseId = "";
  constructor(caseKey: string, enabled = process.env.APRIME_WORLD_MODEL !== "off") {
    if (!enabled) return;
    this.wm = new WorldModel({ namespace: `aprime:${caseKey}`, resolver: { autoMergeAt: Infinity, reviewLower: Infinity } });
    this.caseId = `case:aprime:${caseKey}`;
  }
  get enabled() { return !!this.wm; }
  private src(agent: string, round: number) { return { kind: "agent", by: agent, at: at(round) }; }

  async hypotheses(hs: { id: string; name: string; test: string }[], round: number) {
    if (!this.wm) return;
    await this.wm.upsertEntity({ type: "case", externalKey: { system: "aprime", id: this.caseId }, name: this.caseId, source: this.src("planner", round) });
    for (const h of hs) {
      const e = await this.wm.upsertEntity({ type: "hypothesis", externalKey: { system: "case", id: h.id }, name: h.name, attrs: { test: h.test }, source: this.src("planner", round) });
      await this.wm.relate({ from: e.id, type: "verdict", to: await this.value("open", round), validFrom: `r${round}a`, source: this.src("planner", round) });
    }
  }
  private async value(v: string, round: number) {
    return (await this.wm!.upsertEntity({ type: "verdict", externalKey: { system: "case", id: v }, name: v, source: this.src("system", round) })).id;
  }
  async evidence(items: { eid: string; source: string; round?: number }[], round: number) {
    if (!this.wm) return;
    for (const it of items) await this.wm.upsertEntity({ type: "record", externalKey: { system: "zetaris", id: it.eid }, name: it.eid, attrs: { source: it.source, round: it.round ?? round }, source: this.src("research", round) });
  }
  async verdicts(hs: { id: string; name: string; verdict: string; for: string[]; against: string[] }[], round: number) {
    if (!this.wm) return;
    for (const h of hs) {
      const e = await this.wm.upsertEntity({ type: "hypothesis", externalKey: { system: "case", id: h.id }, name: h.name, source: this.src("writer", round) });
      await this.wm.relate({ from: e.id, type: "verdict", to: await this.value(h.verdict, round), validFrom: `r${round}b`, source: this.src("writer", round) });
      for (const [type, ids] of [["supported_by", h.for], ["refuted_by", h.against]] as const)
        for (const r of ids) await this.wm.relate({ from: e.id, type, to: `record:zetaris:${r}`, source: this.src("writer", round) }); // many-valued: no validFrom, so nothing is closed
    }
  }
  async contradicted(eid: string, by: string, round: number) {
    if (!this.wm) return;
    await this.wm.upsertEntity({ type: "record", externalKey: { system: "zetaris", id: eid }, name: eid, attrs: { contradicted: by }, source: this.src("skeptic", round) });
  }

  /** each hypothesis with its verdict history (from the closed and open verdict edges) and current evidence */
  state(): HypState[] {
    if (!this.wm) return [];
    const shape = this.wm.stateShape();
    const name = (id: string) => shape.entities.find((e) => e.id === id)?.name ?? id;
    return shape.entities.filter((e) => e.type === "hypothesis").map((h) => {
      const vs = shape.edges.filter((x) => x.from === h.id && x.type === "verdict").sort((a, b) => String(a.validFrom).localeCompare(String(b.validFrom)));
      const cur = (t: string) => shape.edges.filter((x) => x.from === h.id && x.type === t).map((x) => x.to.replace("record:zetaris:", ""));
      return { id: h.id.replace("hypothesis:case:", ""), name: h.name ?? "", status: name(vs.at(-1)?.to ?? ""), for: [...new Set(cur("supported_by"))], against: [...new Set(cur("refuted_by"))],
        history: vs.map((x) => ({ round: Number(String(x.validFrom).slice(1, 2)), status: name(x.to) })) };
    });
  }
  /** records that currently hold up a "holds" verdict: what the Skeptic tries to break first */
  holdingRecords(): string[] { return [...new Set(this.state().filter((h) => h.status === "holds").flatMap((h) => h.for))]; }
  /** a verdict that changed between rounds while no record found in the later round is cited for it */
  flipFlops(newRecords: Set<string>, asked: Set<string> = new Set()): string[] {
    return this.state().flatMap((h) => {
      const judged = h.history.filter((x) => x.status !== "open");
      if (judged.length < 2) return [];
      const [a, b] = judged.slice(-2);
      if (a.status === b.status || a.round === b.round || asked.has(h.id)) return []; // a change a check or the Evaluator asked for is a correction
      return [...h.for, ...h.against].some((r) => newRecords.has(r)) ? [] : [`${h.id} ${h.name.replace(/_/g, " ")} went from ${a.status.replace("_", " ")} to ${b.status.replace("_", " ")} with no new record behind it`];
    });
  }
  /** what the Writer and the Planner are shown */
  describe(): string {
    const s = this.state();
    if (!s.length) return "";
    return s.map((h) => `- ${h.id} ${h.name}: now ${h.status}; history ${h.history.map((x) => `r${x.round} ${x.status}`).join(" -> ")}; for [${h.for.join(", ")}]; against [${h.against.join(", ")}]`).join("\n");
  }
  summary() {
    if (!this.wm) return { enabled: false };
    const sh = this.wm.stateShape();
    return { enabled: true, entities: sh.entities.length, edges: sh.edges.length, supersededVerdicts: sh.edges.filter((e) => e.type === "verdict" && e.validTo).length, events: this.wm.log().length, hypotheses: this.state() };
  }
}
