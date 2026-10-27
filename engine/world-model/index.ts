// A-prime World Model: the Meterless World Model spec (engines/world-model, commit 1742dec), implemented for our L1 entry during this hackathon and reused here (same team, same development period).
// Based on: Meterless/Meterless engines/world-model (commit 1742dec, 2026-10-19) AGENTS.md,
// docs/stable-ids.md, docs/ingest-pipeline.md, docs/concurrency-and-queues.md and conformance/runner.ts.
// Written from scratch, not copied from the reference implementation. Exports required by conformance: WorldModel, entityIdFromName, normalizeName, decide.
//
// Spec points (all covered here):
//   - Append-only event log; state is a fold of events; every change writes audit (seq strictly increasing).
//   - Content-derived IDs: external key `type:system:id`; otherwise ent_<first 16 hex of sha256(type:normalizeName(name))>.
//   - Every write needs provenance (kind + at), else rejected. Timestamps come from observation time, not wall clock -> reruns are identical.
//   - Re-ingesting the same batch: no new events, changed=false, canonical state unchanged.
//   - Name similarity (normalized Levenshtein) bands: >= autoMergeAt auto-merge; [reviewLower, autoMergeAt) to operator queue; else new entity.
//     Defaults 0.85 / 0.82 (conformance boundaries). The L1 app sets autoMergeAt = Infinity, reviewLower = 0.85:
//     >= 0.85 only proposes a merge; a human must approve.
//   - Aliases: approval writes an alias event; the old ID still resolves to the primary ID; unapproved proposals affect no reads.
//   - Bitemporal edges: a new edge of the same type closes the old one (validTo), never deletes; supports point-in-time queries.
//   - One FIFO write queue per world (single writer).
// Added by L1 beyond the spec: proposeMerge (propose a merge from non-name evidence, e.g. renumbered site with same EIN + zip + street number).
// Not done: split, retraction propagation, dependency graph (out of scope per spec).

import { createHash } from "node:crypto";

export type Provenance = { kind: string; at: string | Date; by?: string; url?: string; runId?: string };
type Prov = Omit<Provenance, "at"> & { at: string };
export type Entity = {
  id: string; type: string; name?: string; aliases: string[]; attrs: Record<string, unknown>;
  source: Prov; createdAt: string; updatedAt: string;
};
export type Edge = {
  id: string; from: string; type: string; to: string; validFrom?: string; validTo?: string;
  attrs?: Record<string, unknown>; source: Prov; supersededBy?: string;
};
export type MergeProposal = {
  id: string; leftId: string; rightId: string; leftName: string; rightName: string; similarity: number;
  reason: string; status: "pending" | "approved" | "rejected"; proposedAt: string; resolvedAt?: string; resolvedBy?: string;
};
export type WorldEvent = { id: string; seq: number; kind: string; at: string; payload: unknown };
export type AuditEntry = { seq: number; at: string; kind: string; actor: string; summary: string };
export type Observation = {
  externalId: string; type?: string; title: string; text?: string; at: string; source: Provenance;
  entities?: { type: string; name: string }[];
};
export type Options = {
  namespace: string; storage?: "memory"; clock?: () => Date;
  resolver?: { autoMergeAt?: number; reviewLower?: number };
};

// ------------------------------------------------------------ stable ids

export function normalizeName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[​-‍﻿]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export function entityIdFromName(type: string, name: string): string {
  return "ent_" + sha(`${type}:${normalizeName(name)}`).slice(0, 16);
}
export const externalId = (type: string, system: string, id: string) => `${type}:${system}:${id}`;
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

// ------------------------------------------------------------ resolution

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function nameSimilarity(x: string, y: string): number {
  const a = normalizeName(x), b = normalizeName(y);
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}
export function decide(sim: number, autoMergeAt = 0.85, reviewLower = 0.82): "auto-merge" | "review" | "new" {
  if (sim >= autoMergeAt) return "auto-merge";
  if (sim >= reviewLower) return "review";
  return "new";
}

// ------------------------------------------------------------ world

export class WorldModel {
  private events: WorldEvent[] = [];
  private auditLog: AuditEntry[] = [];
  private entities = new Map<string, Entity>();
  private edges = new Map<string, Edge>();
  private alias = new Map<string, string>(); // aliasId -> primaryId (approved only)
  private obs = new Map<string, string>(); // externalId -> checksum
  private queue: MergeProposal[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private clock: () => Date;
  private auto: number;
  private reviewLower: number;

  private opts: Options;
  constructor(opts: Options) {
    this.opts = opts;
    if (!opts?.namespace) throw new Error("WorldModel: namespace is required");
    this.clock = opts.clock ?? (() => new Date());
    this.auto = opts.resolver?.autoMergeAt ?? 0.85;
    this.reviewLower = opts.resolver?.reviewLower ?? 0.82;
  }

  // ---- internals
  private run<T>(fn: () => T): Promise<T> {
    const p = this.lock.then(fn);
    this.lock = p.catch(() => undefined);
    return p;
  }
  private prov(s: Provenance | undefined): Prov {
    if (!s || !s.kind || s.at === undefined || s.at === null) throw new Error("World Model: no provenance, no write");
    return { ...s, at: s.at instanceof Date ? s.at.toISOString() : String(s.at) };
  }
  private append(kind: string, payload: unknown, at: string, actor: string, summary: string): void {
    const seq = ++this.seq;
    this.events.push({ id: `evt_${sha(this.opts.namespace + "|" + seq + "|" + canonical(payload)).slice(0, 16)}`, seq, kind, at, payload: structuredClone(payload) });
    this.auditLog.push({ seq, at, kind, actor, summary });
  }
  resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 64 && this.alias.has(cur); i++) cur = this.alias.get(cur)!;
    return cur;
  }
  private foldEntity(id: string, type: string, name: string | undefined, attrs: Record<string, unknown>, source: Prov, extraAliases: string[] = []): Entity {
    const pid = this.resolve(id);
    const prev = this.entities.get(pid);
    const names = new Set([...(prev?.aliases ?? []), ...(name ? [name] : []), ...extraAliases]);
    const next: Entity = {
      id: pid, type, name: prev?.name ?? name, aliases: [...names].sort(),
      attrs: { ...(prev?.attrs ?? {}), ...attrs }, source: prev?.source ?? source,
      createdAt: prev?.createdAt ?? source.at, updatedAt: prev ? (canonicalSame(prev, attrs, names) ? prev.updatedAt : source.at) : source.at,
    };
    if (prev && canonical(stripTimes(prev)) === canonical(stripTimes(next))) return prev; // no-op: no event
    this.entities.set(pid, next);
    this.append("upsertEntity", next, source.at, source.by ?? source.kind, `${type} ${name ?? pid}`);
    return next;
  }
  private queueProposal(leftId: string, rightId: string, leftName: string, rightName: string, sim: number, reason: string, at: string): MergeProposal | undefined {
    const [l, r] = [this.resolve(leftId), this.resolve(rightId)];
    if (l === r) return undefined;
    const dup = this.queue.find((p) => p.status !== "rejected" && ((p.leftId === l && p.rightId === r) || (p.leftId === r && p.rightId === l)));
    if (dup) return dup;
    const p: MergeProposal = { id: `merge_${sha(l + "|" + r).slice(0, 12)}`, leftId: l, rightId: r, leftName, rightName,
      similarity: Math.round(sim * 1000) / 1000, reason, status: "pending", proposedAt: at };
    this.queue.push(p);
    this.append("merge-proposed", p, at, "resolver", `${leftName} ~ ${rightName}: ${reason}`);
    return p;
  }

  // ---- writes (five primitives used here: upsertEntity, relate; plus ingest)
  upsertEntity(input: { type: string; externalKey?: { system: string; id: string }; name?: string; aliases?: string[];
    attrs?: Record<string, unknown>; source: Provenance }): Promise<Entity> {
    return this.run(() => {
      const source = this.prov(input.source);
      const name = input.name ?? (input.attrs?.name as string | undefined);
      if (!input.externalKey && !name) throw new Error("World Model: entity needs an external key or a name");
      const id = input.externalKey ? externalId(input.type, input.externalKey.system, input.externalKey.id) : entityIdFromName(input.type, name!);
      if (!input.externalKey && name && !this.entities.has(this.resolve(id))) {
        for (const o of [...this.entities.values()]) {
          if (o.type !== input.type || !o.name || o.id === id) continue;
          const sim = nameSimilarity(name, o.name);
          const d = decide(sim, this.auto, this.reviewLower);
          if (d === "auto-merge") {
            this.alias.set(id, o.id);
            this.append("alias", { aliasId: id, primaryId: o.id, by: "resolver", reason: `similarity ${sim.toFixed(3)}` }, source.at, "resolver", `${name} -> ${o.name}`);
            return this.foldEntity(o.id, input.type, undefined, input.attrs ?? {}, source, [name, ...(input.aliases ?? [])]);
          }
          if (d === "review") this.queueProposal(id, o.id, name, o.name, sim, `name similarity ${sim.toFixed(3)} in review band`, source.at);
        }
      }
      return this.foldEntity(id, input.type, name, input.attrs ?? {}, source, input.aliases ?? []);
    });
  }

  relate(input: { from: string; type: string; to: string; validFrom?: string; validTo?: string; attrs?: Record<string, unknown>; source: Provenance }): Promise<Edge> {
    return this.run(() => {
      const source = this.prov(input.source);
      const id = "rel_" + sha(`${input.from}|${input.type}|${input.to}|${input.validFrom ?? ""}`).slice(0, 16);
      const have = this.edges.get(id);
      if (have) return have; // same edge twice = no-op
      for (const e of this.edges.values()) {
        if (e.from === input.from && e.type === input.type && e.validTo === undefined && e.to !== input.to && input.validFrom) {
          const closed = { ...e, validTo: input.validFrom, supersededBy: id };
          this.edges.set(e.id, closed);
          this.append("relate", closed, source.at, source.by ?? source.kind, `close ${e.from} -${e.type}-> ${e.to}`);
        }
      }
      const edge: Edge = { id, from: input.from, type: input.type, to: input.to, validFrom: input.validFrom, validTo: input.validTo, attrs: input.attrs, source };
      this.edges.set(id, edge);
      this.append("relate", edge, source.at, source.by ?? source.kind, `${input.from} -${input.type}-> ${input.to}`);
      return edge;
    });
  }

  async ingest(observations: Observation[]): Promise<{ processed: number; skippedUnchanged: number; eventsAppended: number; changed: boolean }> {
    const before = this.seq;
    let skipped = 0;
    for (const o of [...observations].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
      const ck = sha(canonical({ ...o, source: { ...o.source, runId: undefined } }));
      if (this.obs.get(o.externalId) === ck) { skipped++; continue; }
      await this.run(() => {
        this.obs.set(o.externalId, ck);
        this.append("observation", { externalId: o.externalId, checksum: ck }, o.at, o.source.kind, `observe ${o.externalId}`);
      });
      const type = o.type ?? "item";
      const item = await this.upsertEntity({ type, externalKey: { system: "ingest", id: o.externalId }, name: o.title,
        attrs: { title: o.title, text: o.text }, source: { ...o.source, at: o.at } });
      for (const m of o.entities ?? []) {
        const ent = await this.upsertEntity({ type: m.type, name: m.name, source: { ...o.source, at: o.at } });
        await this.relate({ from: item.id, type: "mentions", to: ent.id, source: { ...o.source, at: o.at } });
      }
    }
    const appended = this.seq - before;
    return { processed: observations.length, skippedUnchanged: skipped, eventsAppended: appended, changed: appended > 0 };
  }

  // ---- operator queue
  proposeMerge(leftId: string, rightId: string, reason: string, source: Provenance, similarity = 1): Promise<MergeProposal | undefined> {
    return this.run(() => {
      const s = this.prov(source);
      const l = this.entities.get(this.resolve(leftId)), r = this.entities.get(this.resolve(rightId));
      if (!l || !r) throw new Error("World Model: proposeMerge needs two existing entities");
      return this.queueProposal(l.id, r.id, l.name ?? l.id, r.name ?? r.id, similarity, reason, s.at);
    });
  }
  mergeQueue(): readonly MergeProposal[] { return this.queue; }
  approveMerge(id: string, by: string): Promise<void> {
    return this.run(() => {
      const p = this.queue.find((q) => q.id === id && q.status === "pending");
      if (!p) throw new Error(`World Model: no pending proposal ${id}`);
      const at = this.clock().toISOString();
      Object.assign(p, { status: "approved", resolvedAt: at, resolvedBy: by });
      const left = this.entities.get(p.leftId)!, right = this.entities.get(p.rightId)!;
      this.alias.set(p.leftId, p.rightId);
      this.append("alias", { aliasId: p.leftId, primaryId: p.rightId, by, reason: p.reason }, at, by, `${p.leftName} -> ${p.rightName}`);
      const merged: Entity = { ...right, aliases: [...new Set([...right.aliases, ...left.aliases])].sort(),
        attrs: { ...left.attrs, ...right.attrs, mergedIds: [...new Set([...((right.attrs.mergedIds as string[]) ?? []), p.leftId])].sort() }, updatedAt: at };
      this.entities.set(right.id, merged);
      this.entities.delete(left.id); // the alias pointer keeps the old id resolvable; the log keeps both
      this.append("upsertEntity", merged, at, by, `merge into ${right.id}`);
    });
  }
  rejectMerge(id: string, by: string): Promise<void> {
    return this.run(() => {
      const p = this.queue.find((q) => q.id === id && q.status === "pending");
      if (!p) throw new Error(`World Model: no pending proposal ${id}`);
      const at = this.clock().toISOString();
      Object.assign(p, { status: "rejected", resolvedAt: at, resolvedBy: by });
      this.append("merge-rejected", { id }, at, by, `${p.leftName} stays separate from ${p.rightName}`);
    });
  }

  // ---- reads
  entity(id: string): Entity | undefined { return this.entities.get(this.resolve(id)); }
  query(type?: string): Entity[] { return [...this.entities.values()].filter((e) => !type || e.type === type).sort((a, b) => a.id.localeCompare(b.id)); }
  /** All edges pointing at this entity (including approved aliases); unapproved proposals do not count. */
  incoming(id: string, via?: string): Edge[] {
    const pid = this.resolve(id);
    return [...this.edges.values()].filter((e) => this.resolve(e.to) === pid && (!via || e.type === via) && e.validTo === undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  view(name: "graph") {
    if (name !== "graph") throw new Error(`unknown view ${name}`);
    return {
      neighborsOf: (id: string, o: { via?: string; at?: string } = {}) => {
        const pid = this.resolve(id);
        return [...this.edges.values()].filter((e) => this.resolve(e.from) === pid && (!o.via || e.type === o.via) &&
          (o.at ? (!e.validFrom || e.validFrom <= o.at) && (!e.validTo || o.at < e.validTo) : e.validTo === undefined))
          .map((e) => this.entities.get(this.resolve(e.to))!).filter(Boolean);
      },
    };
  }
  audit(): readonly AuditEntry[] { return this.auditLog; }
  log(): readonly WorldEvent[] { return this.events; }
  stateShape() {
    return {
      entities: this.query().map((e) => ({ ...e })),
      edges: [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      aliases: [...this.alias.entries()].sort(),
      observations: [...this.obs.entries()].sort(),
      queue: this.queue.map((p) => ({ id: p.id, status: p.status })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  stateShapeCanonical(): string { return canonical(this.stateShape()); }
}

function stripTimes(e: Entity) { return { ...e, updatedAt: undefined }; }
function canonicalSame(prev: Entity, attrs: Record<string, unknown>, names: Set<string>) {
  return canonical({ ...prev.attrs, ...attrs }) === canonical(prev.attrs) && canonical([...names].sort()) === canonical(prev.aliases);
}
