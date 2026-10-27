// Screenshots of the app (headless Chrome over the DevTools protocol, no dependencies).
// Usage: node scripts/ui_shots.mjs http://127.0.0.1:8750 docs/screens [width] [height]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
const [base = "http://127.0.0.1:8750", outDir = "docs/screens", W = 1440, H = 900] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync);
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "ap-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const metrics = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 500 });
const shot = async (name, full = true) => {
  if (full) { const m = await send("Page.getLayoutMetrics"); await metrics(W, Math.min(Math.ceil(m.result.cssContentSize.height), 5000)); }
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(s.result.data, "base64")); await metrics(W, H); console.log("shot", name);
};
const waitFor = async (expr, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(500); } return false; };
try {
  let t; for (let i = 0; i < 40 && !t; i++) { await sleep(250); try { t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { } }
  ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
  await send("Page.enable"); await metrics(W, H);
  await send("Page.navigate", { url: base + "/" }); await sleep(1500);
  await ev(`document.querySelector('#speed').value='0'; document.querySelector('#speed').dispatchEvent(new Event('change'))`);
  console.log("chain ready", await waitFor("!document.querySelector('#vote').hidden"));
  await sleep(800); await shot("1_evidence_chain");
  await ev(`document.querySelector('[data-vote=propose]').click()`); console.log("after vote", await waitFor("!document.querySelector('#after').hidden && document.querySelector('#after').innerText.length > 200", 60000));
  await sleep(1500); await shot("2_after_vote");
  await ev(`document.querySelector('nav [data-view=trace]').click()`); await sleep(800); await shot("3_trace");
  await ev(`document.querySelector('nav [data-view=scan]').click()`); await sleep(2500); await shot("4_night_scan");
  await ev(`document.querySelector('nav [data-view=reopen]').click(); document.querySelector('#replay').click()`); await waitFor("!document.querySelector('#replay').disabled", 60000); await sleep(800); await shot("5_reopen");
  await ev(`document.querySelector('nav [data-view=board]').click()`); await sleep(1500); await shot("6_scoreboard");
  await ev(`document.querySelector('nav [data-view=chain]').click()`); await metrics(390, 844); await sleep(800); await shot("7_mobile", false);
} finally { proc.kill(); process.exit(0); }
