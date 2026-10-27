// Local web app for the hospital pharmacist / P&T committee: `npm start` -> http://127.0.0.1:8750
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, ROOT, scrub } from "./config.ts";
import { Session, QUESTIONS, REPLAY, runReplay, COMMITTEE } from "./run.ts";
import { Trace } from "./trace.ts";
import { SqlTool } from "./zetaris.ts";
import { Models } from "./llm.ts";
import { boardData, ledgerTop, nightScan } from "./board.ts";

let session: Session | undefined;
let replay: { trace: Trace; results?: Record<string, unknown>[]; running: boolean; sql: SqlTool } | undefined;
let scan: ReturnType<typeof nightScan> | undefined;
const UI = path.join(ROOT, "ui");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? scrub(JSON.stringify(body)) : (body as string | Buffer));
};
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((ok) => {
  let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } });
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) {
      const f = url.pathname === "/" ? path.join(UI, "index.html") : path.join(UI, path.normalize(url.pathname.slice(4)).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(UI) || !existsSync(f)) return send(res, 404, { error: "not found" });
      return send(res, 200, readFileSync(f), TYPES[path.extname(f)] ?? "text/plain");
    }
    if (url.pathname === "/api/meta") return send(res, 200, { sampleMode: config.sampleMode, questions: QUESTIONS, replay: REPLAY, decisionDate: process.env.APRIME_DECISION_DATE });
    if (url.pathname === "/api/state") return send(res, 200, session ? session.state() : { phase: "idle" });
    if (url.pathname === "/api/trace") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const src = url.searchParams.get("of") === "replay" ? replay?.trace : session?.trace;
      return send(res, 200, src ? src.events.filter((e) => e.seq > since) : []);
    }
    if (url.pathname === "/api/receipt") {
      const qid = String(url.searchParams.get("qid"));
      const r = [...(session?.sql.receipts ?? []), ...(replay?.sql.receipts ?? [])].find((x) => x.qid === qid);
      return r ? send(res, 200, r) : send(res, 404, { error: "no such query" });
    }
    if (url.pathname === "/api/board") return send(res, 200, boardData());
    if (url.pathname === "/api/ledger") return send(res, 200, await ledgerTop());
    if (req.method === "GET" && url.pathname === "/api/scan") return send(res, 200, scan ? scan.state() : { running: false, chunks: [] });
    if (req.method === "POST" && url.pathname === "/api/scan") { if (!scan?.state().running) scan = nightScan(); return send(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const b = await body(req);
      const q = QUESTIONS.find((x) => x.id === b.question) ?? (b.custom as typeof QUESTIONS[0] | undefined);
      if (!q) return send(res, 400, { error: "unknown question" });
      session = new Session(q);
      void session.start();
      return send(res, 200, { id: session.id });
    }
    if (req.method === "POST" && url.pathname === "/api/vote") {
      if (!session || session.phase !== "awaiting-vote") return send(res, 409, { error: "nothing to vote on" });
      const b = await body(req);
      const opt = String(b.option);
      if (!["propose", "wait", "no_action", "already_covered"].includes(opt)) return send(res, 400, { error: "bad option" });
      return send(res, 200, await session.castVote(opt as "propose", COMMITTEE));
    }
    if (req.method === "POST" && url.pathname === "/api/replay") {
      const tr = new Trace("replay"), sql = new SqlTool({ prefix: "R" });
      replay = { trace: tr, running: true, sql };
      void runReplay(tr, sql, new Models()).then((r) => { replay!.results = r; replay!.running = false; }).catch((e) => { tr.emit({ agent: "system", kind: "error", summary: scrub(String(e)) }); replay!.running = false; });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/replay") return send(res, 200, replay ? { running: replay.running, results: replay.results } : { running: false });
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: scrub(String((e as Error).message ?? e)) });
  }
}).on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${config.port} is in use. Start on another port with PORT=8752 npm start (or stop the other server).` : scrub(String(e)));
  process.exit(1);
}).listen(config.port, "127.0.0.1", () => {
  console.log(`Why Labels Differ · http://127.0.0.1:${config.port} · ${config.sampleMode ? "SAMPLE_MODE (recorded Zetaris + Nightshift answers)" : "live Zetaris + Nightshift"}`);
});
