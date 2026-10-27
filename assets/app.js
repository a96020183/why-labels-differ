"use strict";
const AGENT = { planner: "Planner", research: "Research", writer: "Writer", evaluator: "Evaluator", skeptic: "Skeptic", counsel: "Counsel", watcher: "Watcher", committee: "Committee", system: "System" };
const COLS = [
  { key: "EU", name: "European Union", sub: "EMA · PRAC" },
  { key: "UK", name: "United Kingdom", sub: "MHRA" },
  { key: "US_regulator", name: "U.S. regulator", sub: "FDA" },
  { key: "US_label", name: "U.S. label", sub: "DailyMed" },
];
const STEPS = ["No public step", "Under evaluation", "Concluded", "In the label"];
const STAGE_TEXT = { concluded: "Concluded", agreed_with_noted_conflict: "Agreed, noting conflicting evidence", under_evaluation: "Under evaluation",
  no_public_action_found: "No public step found", related_only: "A related form only, not this reaction", not_found_in_sources: "Nothing found in these sources", written: "Written in a warning section", partial: "Mentioned outside the warnings", "not found": "Not in the label" };
const WHY_TEXT = { different_stage: "Different stage", different_evidence: "Different evidence", different_scope: "Different scope", us_earlier: "U.S. wrote it first", same_position: "Same position", undetermined: "Cause not shown by the public records", unclear: "Not settled",
  wording_or_section: "The U.S. label says it in other words or another section", different_threshold: "Same evidence, different judgement" };


/** counted from the trace itself, as it plays */
function renderStats() {
  const ev = played, hyp = ev.find((e) => e.agent === "planner" && Array.isArray(e.detail));
  const fal = ev.map((e) => e.detail && e.detail.falsification).filter(Boolean);
  const rej = ev.filter((e) => e.agent === "evaluator" && e.kind === "reject").map((e) => String((e.detail && e.detail.decidedBy) || ""));
  const n = { "model calls": ev.filter((e) => e.kind === "model").length,
    "sent back by the model": rej.filter((d) => d === "model").length, "by code checks": rej.filter((d) => /^checks/.test(d)).length, "by both": rej.filter((d) => /^model and checks/.test(d)).length,
    "checks overruled by the model": ev.filter((e) => e.agent === "evaluator" && e.kind === "approve" && /overruled/.test(String((e.detail && e.detail.decidedBy) || ""))).length,
    "plan revisions": ev.filter((e) => e.kind === "replan").length, "escalations": ev.filter((e) => e.kind === "escalate").length,
    "hypotheses considered": hyp ? hyp.detail.length : 0,
    "records verified by the Skeptic": fal.reduce((a, f) => a + f.verified, 0), "records contradicted": fal.reduce((a, f) => a + f.contradicted.filter((c) => !c.startsWith("claim ")).length, 0),
    "claims contradicted": fal.reduce((a, f) => a + f.contradicted.filter((c) => c.startsWith("claim ")).length, 0),
    "label quotes openFDA agrees with": fal.reduce((a, f) => a + ((f.second && f.second.verified) || 0), 0), "openFDA contradicts": fal.reduce((a, f) => a + ((f.second && f.second.contradicted) || 0), 0) };
  $("#tstats").innerHTML = Object.entries(n).map(([k, v]) => `<div><strong>${v}</strong><span>${k}</span></div>`).join("") +
    `<p class="small muted">Counted from the events shown so far${ev.some((e) => e.kind === "vote") ? ", including the steps after the vote (counseling, reopen checks)" : " (the investigation, before the vote)"}.</p>`;
}


const lastDraft = () => [...played].reverse().find((x) => x.kind === "draft")?.detail;
const itemsNow = () => state.items || state.outcome?.items || [];
const itemOf = (eid) => itemsNow().find((i) => i.eid === eid);

/** a short human label for a record (never a raw id) */
function labelOf(eid) {
  const it = itemOf(eid);
  if (!it) return eid;
  const sec = (it.section || "").replace(/^\d+(\.\d+)?\s*/, "");
  switch (it.kind) {
    case "prac_signal": return `PRAC signal catalogue, ${it.date.replace(" PRAC meeting minutes", "")}`;
    case "label_warning_section": case "label_other_section": return `${it.source === "us_label_class_members" ? "Other drug (class comparison): " : ""}${it.title.replace(/ \(effective.*$/, "").replace(" U.S. label", " label")}, ${(it.section.split(" > ").pop() || "").slice(0, 34)}`;
    case "spl_versions": return "U.S. labels searched";
    case "fda_potential_signal": return `FDA potential-signal list, ${it.title.match(/Q\d \d{4}/)?.[0] || ""}`;
    case "sentinel_study": return "FDA Sentinel study";
    case "search_without_result": return it.source === "fda_sentinel" ? "Sentinel searched: nothing" : "FDA lists searched: nothing";
    default: return `${it.title.split(":")[0]}, ${sec.slice(0, 40)}`;
  }
}
const chips = (ids) => `<div class="cites">${(ids || []).map((x) => `<button class="cite" data-eid="${esc(x)}">${esc(labelOf(x))}</button>`).join("")}</div>`;
const quoteOf = (eid, n = 220) => { const t = (itemOf(eid)?.text || "").replace(/[�]/g, "").replace(/\s+/g, " "); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + " …" : t; };

function stepOf(col, cell, items) {
  const st = cell.stage || ""; const us = cell.status || "";
  if (col === "US_label") return us === "written" ? [3, "full"] : us === "partial" ? [3, "hollow"] : us === "not_assessed" ? [0, "unknown"] : [0, "hollow"]; // related_only: not in the label
  if (/concluded|agreed/.test(st)) return col === "EU" && items.some((i) => i.column === "EU" && i.kind === "smpc") ? [3, "full"] : [2, "full"];
  if (/under_evaluation/.test(st)) return [1, "full"];
  if (/no_public/.test(st)) return [0, "full"];
  return [0, "unknown"];
}

function renderChain(d, mode, ev) {
  if (!d || !d.cells) return;
  const items = itemsNow();
  // 1. the reasons, each with the record sentence it rests on
  const reasons = d.why?.reasons?.length ? d.why.reasons : [{ type: d.why?.type, claim: d.why?.sentence, cites: d.why?.cites || [] }];
  const status = mode === "sent-back" ? `<p class="denied">Draft ${ev.round} sent back by the Evaluator: ${esc(ev.summary.replace(/^Sent back: /, ""))}</p>`
    : mode === "draft" ? `<p class="muted small">Draft ${ev.round}, waiting for the Evaluator.</p>` : "";
  const VERDICT = { holds: "Holds", ruled_out: "Ruled out", open: "Open", not_a_cause: "True, not a cause" };
  const order = (h) => h.verdict === "holds" ? (/^main/i.test(h.role || "") ? 0 : 1 + (h.rank || 9) / 100) : 2 + ["ruled_out", "open", "not_a_cause"].indexOf(h.verdict);
  const hyps = (d.hypotheses || []).slice().sort((a, b) => order(a) - order(b));
  const nm = (h) => WHY_TEXT[h.name] || h.name.replace(/_/g, " ");
  const main = hyps.find((h) => h.verdict === "holds" && /^main/i.test(h.role || "")), second = hyps.filter((h) => h.verdict === "holds" && h !== main), out = hyps.filter((h) => h.verdict === "ruled_out");
  const verdictLine = !main && d.why?.type === "undetermined" ? `<p class="verdict-line">${mode === "final-open" ? "<span class=\"muted\">Last draft, not approved:</span> " : ""}<b>Cause: cannot be determined from the public records.</b> ${esc(d.why.sentence || "")}</p>` : main ? `<p class="verdict-line"><b>Main reason: ${esc(nm(main))}</b>, because ${esc((main.why || "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()))}${second.length ? ` <span class="muted">Secondary: ${esc(second.map(nm).join("; "))}.</span>` : ""}${out.length ? ` <span class="muted">Ruled out: ${esc(out.map((h) => `${nm(h)} (${h.why})`).join("; "))}</span>` : ""}</p>` : "";
  const ver = (state.outcome?.falsification || []).at(-1);
  const quote = (x, cls) => `<blockquote class="q ${cls}"><span>${esc(quoteOf(x))}</span><button class="cite" data-eid="${esc(x)}">${esc(labelOf(x))}</button></blockquote>`;
  const evid = (d.evidence?.note ? `<p class="evidence"><b>Evidence:</b> ${esc(d.evidence.note)}</p>${chips(d.evidence.cites)}` : "")
    + (ver && mode !== "draft" ? `<p class="small muted verify">Skeptic, trying to break the final draft: ${ver.records} cited records fetched again by their own keys, <b>${ver.verified} verified · ${ver.contradicted.length} contradicted</b>; ${ver.claims} claims judged, ${ver.claimsSupported} supported${meta.sampleMode ? " (replayed from the recorded run)" : ""}.</p>` : "");
  $("#why").innerHTML = status + (hyps.length
    ? `<h2 class="why-h">Why they differ: the explanations the agents tested</h2>` + verdictLine + hyps.map((h) => `<div class="hyp ${esc(h.verdict)}${h === main ? " main" : ""}">
        <div class="hyp-head"><span class="verdict">${esc(h === main ? "Main reason" : h.verdict === "holds" ? `Secondary${h.rank ? " #" + h.rank : ""}` : VERDICT[h.verdict] || h.verdict)}</span><span class="hname">${esc(nm(h))}</span></div>
        <p class="claim">${esc(h.why)}</p>
        ${h.for.filter(itemOf).slice(0, 2).map((x) => quote(x, "for")).join("")}${h.against.filter(itemOf).slice(0, 1).map((x) => quote(x, "against")).join("")}</div>`).join("")
    : `<h2 class="why-h">Why they differ</h2>` + reasons.map((r) => `<div class="reason">
      <span class="type">${esc(String(r.type || "").split("+").map((t) => WHY_TEXT[t.trim()] || t.trim().replace(/_/g, " ")).join(" · "))}</span>
      <p class="claim">${esc(r.claim)}</p>${(r.cites || []).filter(itemOf).slice(0, 2).map((x) => quote(x, "")).join("")}</div>`).join("")) + evid;
  wireCites($("#why"));
  // 2. where each regulator stands
  const head = `<div class="head"><span></span>${STEPS.map((s) => `<span>${s}</span>`).join("")}</div>`;
  const rows = COLS.map((c) => {
    const cell = d.cells[c.key] || { finding: "", cites: [] };
    const [step, kind] = stepOf(c.key, cell, items);
    const stage = STAGE_TEXT[cell.stage] || STAGE_TEXT[cell.status] || (cell.stage || cell.status || "").replace(/_/g, " ");
    return `<div class="row"><div class="who">${c.name}<small>${c.sub}</small></div>
      <div class="track"><div class="fill" style="width:${kind === "full" && step ? step * 25 : 0}%"></div><div class="mark ${kind}" style="left:${12.5 + step * 25}%"></div></div></div>
      <div class="row"><div></div><div class="finding"><p>${esc(cell.finding)}</p><span class="stage">${esc(stage)}</span>${chips(cell.cites)}${c.key === "UK" && /no_public|not_found/.test(cell.stage || "") ? `<p class="small muted">Only the MHRA Drug Safety Updates loaded here (three) were searched; this is not a full search of MHRA's publications.</p>` : ""}</div></div>`;
  }).join("");
  $("#ladder").innerHTML = `<h2 class="ladder-h">Where each regulator stands</h2>` + head + rows;
  wireCites($("#ladder"));
}

/** the send-back and what it brought in, kept on the finished screen */
function renderTrail(o) {
  // one line per round, read from the trace: who decided, what was found, what the Writer answered, what was overruled
  const evs = played.filter((e) => e.agent === "evaluator" && (e.kind === "approve" || e.kind === "reject"));
  if (!evs.length) { $("#trail").innerHTML = ""; return; }
  const used = new Set(Object.values(o.draft.cells).flatMap((c) => c.cites).concat(o.draft.why?.cites || []));
  const disputes = o.disputes || [];
  const rows = evs.map((e) => {
    const d = e.detail || {}, r = e.round;
    const added = r === 2 ? (o.items || []).filter((i) => i.round === 2 && i.kind !== "search_without_result") : [];
    const mine = disputes.filter((x) => x.round === r);
    const overruled = (d.reply || []).filter((x) => !x.accept).map((x) => `${(d.soft || [])[x.n - 1]?.problem || "a coverage check"} — the model: ${x.reason}`);
    const what = r <= 2 ? `Draft ${r}` : `Draft ${r} (repair ${r - 2} of 3)`;
    return `<p><b>${what}: ${e.kind === "approve" ? "approved" : "sent back"}</b> (decided by: ${esc(d.decidedBy || "")}).
      ${e.kind === "reject" ? esc((d.hard || []).concat(d.soft || []).map((g) => g.problem).join(" ") || d.modelFeedback || "") : ""}
      ${overruled.length ? `<br>Overruled with a reason: ${esc(overruled.join(" | "))}` : ""}
      ${mine.length ? `<br>The Writer disputed ${mine.length} finding(s): ${esc(mine.map((x) => `${x.accepted ? "record and quote verified" : "refused (" + x.why + ")"}: ${x.reason}`).join(" | "))}` : ""}</p>
      ${added.length ? `<p class="small">Round 2 added ${added.filter((i) => used.has(i.eid)).length} of ${added.length} new records the final chain cites:</p>${chips(added.filter((i) => used.has(i.eid)).map((i) => i.eid).slice(0, 8))}` : ""}`;
  }).join("");
  const end = o.status === "approved" ? "" : `<p><b>Handed to a person</b> after ${o.rounds > 2 ? `two rounds and ${o.rounds - 2} repair draft(s)` : "two rounds"}: the open items above are what was not settled.</p>`;
  $("#trail").innerHTML = `<h2 class="trail-h">How the agents got here</h2>` + rows + end;
  wireCites($("#trail"));
}


function receiptHtml(r) {
  return `<h3>Query receipt ${esc(r.qid)}</h3><dl><dt>Purpose</dt><dd>${esc(r.purpose)}</dd><dt>Asked by</dt><dd>${esc(r.agent)} as ${esc(r.as)}</dd><dt>Systems</dt><dd>${esc(r.systems.join(", ") || "Zetaris")}</dd>
    <dt>Answered by</dt><dd>${esc(r.backend === "replay" ? "recorded Zetaris answer" : r.backend === "emulator" ? "local emulator (no recording)" : "live Zetaris")}</dd><dt>Rows</dt><dd>${r.rows}</dd><dt>Result hash</dt><dd>${esc(r.resultSha)}</dd>
    ${r.error ? `<dt>Refused</dt><dd class="denied">${esc(r.error)}</dd>` : ""}</dl><pre>${esc(r.sql)}</pre>`;
}

function drawScan(s) {
  const W = 960, H = 280, P = 46, n = Math.max(s.chunks.length, s.fullReread.length), max = 13500;
  const x = (i) => P + (i / Math.max(1, n - 1)) * (W - P - 20), y = (v) => H - 30 - (v / max) * (H - 60);
  const line = (vals, cls) => `<polyline fill="none" stroke="${cls}" stroke-width="2" points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Prompt tokens per step">
    ${line(s.fullReread, "var(--muted)")}${line(s.chunks.map((c) => c.prompt), "#1c2a33")}
    <text x="${x(n - 1) - 4}" y="${y(s.fullReread.at(-1) || 0) - 8}" font-size="12" text-anchor="end" fill="#5f6e77">re-read the whole ledger every step${s.fullRereadRun ? "" : " (estimated)"}</text>
    <text x="${x(n - 1) - 4}" y="${y(s.chunks.at(-1)?.prompt || 0) - 8}" font-size="12" text-anchor="end" fill="#1c2a33">${s.product ? "name index + Markovian (the product)" : "Markovian: carry a small index"}</text>
    <text x="${P}" y="${H - 8}" font-size="12" fill="#5f6e77">step 1</text><text x="${W - 20}" y="${H - 8}" font-size="12" text-anchor="end" fill="#5f6e77">step ${n} (197 entries, 3 per step)</text>
    <text x="8" y="${y(max) + 4}" font-size="12" fill="#5f6e77">${max.toLocaleString()}</text><text x="8" y="${y(0)}" font-size="12" fill="#5f6e77">0</text></svg>`;
  $("#scan-chart").innerHTML = svg + `<p class="muted small">Prompt tokens per step (estimated as characters ÷ 4). Models that answered: ${Object.entries(s.models).map(([k, v]) => `${esc(k)} ×${v}`).join(", ")}.</p>`;
}

async function renderBoardOriginal() {
  const { board } = await api("/api/board");
  if (!board) { $("#board").innerHTML = `<p class="muted">Scores are computed by <code>npm run score</code> (python -I scripts/scoreboard.py).</p>`; return; }
  const bar = (a, cls = "") => `<div class="bar ${cls}"><span>${esc(a.name)}</span><div class="rail"><div class="val" style="width:${(a.acc * 100).toFixed(1)}%"></div>
    <div class="ci" style="left:${(a.lo * 100).toFixed(1)}%;width:${((a.hi - a.lo) * 100).toFixed(1)}%"></div></div><span>${a.correct} of ${a.n} (${Math.round(a.acc * 100)}%; 95% CI ${Math.round(a.lo * 100)}–${Math.round(a.hi * 100)}%)</span></div>`;
  const s = board.set1a, c = board.crossClass;
  $("#board").innerHTML = `<div class="board-grid">
    <div><h2>Where does the U.S. label stand today? ${s.n} recent EU signals</h2>
      <p class="note">PRAC signals that updated EU product information, January 2025 to September 2026. Four classes: written in a warning section, mentioned elsewhere, not found, not marketed in the U.S.</p>
      <div class="bars">${s.arms.map((a) => bar(a, a.ours ? "ours" : "")).join("")}</div>
      <p class="note">${esc(s.paired || "")}</p>
      ${s.support ? `<p class="note">${esc(s.support)}</p>` : ""}</div>
    ${board.set1a_loop ? `<div><h2>The full agent loop on ${board.set1a_loop.ids.length} of those questions</h2>
      <p class="note">${esc(board.set1a_loop.arm || "The full agent loop")}; recorded live on ${esc(board.set1a_loop.run)}. ${esc(board.set1a_loop.selection)}. The loop may hand a question to a person instead of answering; the other arms must answer every question.</p>
      <table class="mini cost"><tr><th>Full loop</th><th>Result</th></tr>
        <tr><td>Approved by the loop and right</td><td><b>${board.set1a_loop.approved.correct} of ${board.set1a_loop.approved.n}</b> (95% CI ${Math.round(board.set1a_loop.approved.lo * 100)}–${Math.round(board.set1a_loop.approved.hi * 100)}%)</td></tr>
        <tr><td>Handed to a person</td><td>${board.set1a_loop.handoff.n} of ${board.set1a_loop.ids.length}</td></tr>
        <tr><td>Drafts of the hand-offs that match the key (reference only, not answers)</td><td>${board.set1a_loop.handoff.draftCorrect} of ${board.set1a_loop.handoff.n}</td></tr></table>
      <div class="bars">${board.set1a_loop.arms.slice(1).map((x) => bar({ ...x, acc: x.correct / x.n, name: x.name + " (must answer)" })).join("")}</div>
      <p class="note">Outcomes of the loop: ${esc(Object.entries(board.set1a_loop.outcomes).map(([k, v]) => `${k} ${v}`).join("; "))}.</p></div>` : ""}
    <div><h2>Connecting findings across drug classes: ${c.n} pre-registered questions</h2>
      <p class="note">While scanning entry X, did the agents name the earlier entry with the same reaction in a different drug class? Registered before any scan ran.</p>
      <div class="bars">${c.arms.map((a) => bar(a, a.ours ? "ours" : "")).join("")}</div>
      <p class="note">${esc(c.paired || "")}</p>
      <table class="mini cost"><tr><th>Arm</th><th>Wrong links</th><th>Model calls</th><th>Prompt tokens, all steps</th><th>Largest step</th><th>Model time</th></tr>
      ${c.arms.map((a) => `<tr><td>${esc(a.name)}</td><td>${a.false_links ?? ""}</td><td>${a.cost ? a.cost.calls : "0 (code)"}</td><td>${a.cost ? a.cost.prompt_tokens_total.toLocaleString() : "—"}</td><td>${a.cost ? a.cost.prompt_tokens_max.toLocaleString() : "—"}</td><td>${a.cost ? Math.round(a.cost.model_seconds / 60) + " min" : "—"}</td></tr>`).join("")}</table>
      <p class="note">Tokens are estimated (characters ÷ 4); model time is the sum of the recorded Nightshift calls, one at a time on a shared free tier.</p></div>
    ${board.why ? `<div><h2>Where do the EU, the UK and the FDA stand? The same ${board.why.n} signals</h2>
      <p class="note">Scored against a key labelled by a separate AI reviewer (Claude) from public EMA, MHRA and FDA pages, not by a pharmacist.</p>
      <table class="mini cost"><tr><th>Column</th><th>Correct</th><th>95% interval</th></tr>
      ${Object.entries(board.why.columns).map(([k, v]) => `<tr><td>${esc({ eu: "EU (PRAC)", uk: "UK (MHRA)", us_regulator: "U.S. FDA" }[k] || k)}</td><td>${v.correct} of ${v.n}</td><td>${Math.round(v.lo * 100)}–${Math.round(v.hi * 100)}%</td></tr>`).join("")}
      <tr><td><b>All four right</b> (EU, UK, FDA and U.S. label)</td><td><b>${board.why.all_four.correct} of ${board.why.all_four.n}</b></td><td>${Math.round(board.why.all_four.lo * 100)}–${Math.round(board.why.all_four.hi * 100)}%</td></tr></table>
      ${board.why.misses?.length ? `<p class="note">Misses: ${esc(board.why.misses.join("; ").replace(/_/g, " "))}.</p>` : ""}</div>` : ""}
    <div><h2>Read this before quoting a number</h2>${(board.notes || []).map((n) => `<p class="note">${esc(n)}</p>`).join("")}</div></div>`;
}


const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DATA = window.RECORDED_REPLAY;
let meta = DATA.meta, state = {}, played = [], selectedId = '', traceEvents = [], cursor = 0, timer = null, running = false, lastFocus;
const VOTE_TEXT = { propose:'propose an in-house reminder', wait:'wait for the U.S. and reopen on a condition', no_action:'no action', already_covered:'already covered' };
const api = async p => {
  if (p === '/api/board') return DATA.board;
  if (p === '/api/state') return state;
  if (p.startsWith('/api/receipt?')) {
    const qid = new URLSearchParams(p.split('?')[1]).get('qid');
    const r = [...(state.receipts || []), ...(DATA.cases[selectedId]?.committee?.receipts || []), DATA.ledger.receipt, ...DATA.reopen.receipts].find(r => r.qid === qid);
    if (r) return r;
    throw new Error('Receipt was not included in this export');
  }
  throw new Error('This static replay has no live API');
};

function show(v) {
  document.querySelectorAll('nav button').forEach(b => {b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-pressed', String(b.dataset.view === v));});
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'view-' + v));
  if (v !== 'trace') pauseTrace();
  if (v === 'scan') loadScan();
  if (v === 'board') renderBoardOriginal();
  const names = {chain:'Evidence chain',trace:'Saved agent events',scan:'Recorded scan results',reopen:'Recorded label changes · illustrative committee decisions',board:'Recorded results · final offline checks',about:'Replay scope and limitations'};
  setActivity(names[v] + (v === 'chain' ? ' · ' + state.question.substance + ' · ' + (state.outcome.status === 'approved' ? 'draft approved; pharmacist sign-off required' : 'handed to a person') : '') + ' · no live requests');
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

function setActivity(text) { $('#activity').textContent = text; }
function loadCase(id) {
  pauseTrace();
  const c = DATA.cases[id];
  if (!c) return;
  selectedId = id; state = c.state; traceEvents = c.trace;
  $('#q').value = id;
  const o = state.outcome, approved = o.status === 'approved';
  $('#title').textContent = state.question.label;
  $('#lede').textContent = state.question.hook || '';
  $('#case-outcome').className = 'outcome ' + (approved ? 'approved' : 'handoff');
  $('#case-outcome').textContent = approved ? 'Draft approved · sign-off required' : 'Handed to a person · not approved';
  const why = o.draft.why || {};
  $('#decision-summary').innerHTML = `<h2>${approved ? 'The reviewed draft' : 'Last draft — unresolved'}</h2><p>${esc(why.sentence || '')}</p><p class="small">${approved ? 'The agent loop approved this draft' : 'The agent loop did not settle this draft'} after ${o.rounds} rounds. Recorded replies; final checks applied offline. ${approved ? 'This is not a pharmacist’s sign-off.' : 'The wording below is retained for human review, not released as an answer.'}</p>`;
  $('#case-limitation').hidden = id !== 'darolutamide-angioedema';
  $('#case-limitation').innerHTML = id === 'darolutamide-angioedema' ? '<p><b>Known limitation in this approved draft.</b> The README notes that EU 4.8 and U.S. 6.2 list angioedema at the same level, so “same position” would describe it better than the draft’s “undetermined” cause. The recorded approval does not resolve this limitation; a pharmacist must review it.</p>' : '';
  played = traceEvents.slice(); cursor = played.length;
  renderChain(o.draft, approved ? 'approved' : 'final-open', {round:o.rounds,summary:''});
  renderTrail(o);
  const reviews = traceEvents.filter(e => e.agent === 'evaluator' && ['reject','approve'].includes(e.kind));
  $('#review-path').innerHTML = reviews.map(e => `<button data-event="${e.seq}" class="${e.kind === 'approve' ? 'approved' : ''}">Draft ${e.round}: ${e.kind === 'approve' ? 'approved' : 'returned'}</button>`).join('');
  wireEvents($('#review-path'));
  const ex = o.exposure || {};
  $('#exposure').innerHTML = `<div class="ex-main"><strong>${esc(ex.patients ?? 0)}</strong><span>synthetic patients here take ${esc(state.question.substance)}. Agents see an aggregate count.</span></div><p class="small muted">Count computed inside the pharmacy system; no patient list is included. <button class="qid" data-qid="${esc(o.federatedQid)}">Joined-query receipt ${esc(o.federatedQid)}</button></p>`;
  wireCites($('#exposure'));
  $('#rec').textContent = approved ? `Recorded draft recommendation: ${VOTE_TEXT[o.draft.recommendation.option] || o.draft.recommendation.option}. ${o.draft.recommendation.reason}` : 'No approved suggestion. A pharmacist must review the unresolved findings and decide.';
  $('#after').hidden = true;
  $('#recorded-vote').innerHTML = c.committee ? '<button id="inspect-vote">Inspect the recorded committee outcome</button><p class="note">A saved demonstration, not a new vote or sign-off.</p>' : '<p class="note">This hand-off has no approved committee outcome to release in this replay.</p>';
  if (c.committee) $('#inspect-vote').addEventListener('click', () => {
    const v = c.committee.vote;
    $('#after').hidden = false;
    $('#after').innerHTML = `<div class="box"><h3>Recorded committee choice: ${esc(VOTE_TEXT[v.option] || v.option)}</h3><p>Saved demonstration dated ${esc(v.at)}. No reminder, counseling points or patient list was released.</p><p>Agent and pharmacist decision-write receipts:</p>${traceEvents.filter(e => ['denied','vote'].includes(e.kind)).map(e => `<p>${esc(e.summary)} ${(e.receipts || []).map(q=>`<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join('')}</p>`).join('')}</div>`;
    wireCites($('#after'));
    $('#after').scrollIntoView({block:'nearest'});
  });
  $('#trace-case-name').textContent = state.question.label;
  renderTimeline();
  setActivity('Recorded case loaded: ' + state.question.substance + ' · ' + (approved ? 'draft approved; pharmacist sign-off required' : 'handed to a person'));
}

function wireCites(root) {
  root.querySelectorAll('[data-eid]').forEach(b => b.addEventListener('click', () => openItem(b.dataset.eid)));
  root.querySelectorAll('[data-qid]').forEach(b => b.addEventListener('click', () => openReceipt(b.dataset.qid)));
}
function wireEvents(root) {root.querySelectorAll('[data-event]').forEach(b => b.addEventListener('click', () => openEvent(Number(b.dataset.event))));}
async function openItem(eid) {
  const it = itemOf(eid);
  if (!it) return drawer('<p>This record was not included in the exported investigation.</p>', 'Record unavailable');
  const r = await api('/api/receipt?qid=' + encodeURIComponent(it.qid)).catch(() => null);
  drawer(`<h2>${esc(it.title)}</h2><p class="muted">${esc(it.section)} · ${esc(it.date)}</p><p class="note">Saved regulatory excerpt. Names marked [name omitted] have been redacted; the remaining wording is preserved.</p><blockquote>${esc(it.text)}</blockquote><dl><dt>Record</dt><dd>${esc(it.eid)}</dd><dt>Kind</dt><dd>${esc(it.kind)} (${esc(it.authority)})</dd>${it.url ? `<dt>Source URL</dt><dd class="source-reference">${esc(it.url)}</dd>` : ''}</dl>${r ? receiptHtml(r) : '<p>No query receipt is included for this record.</p>'}`, 'Evidence and query receipt');
}
async function openReceipt(qid) {
  const r = await api('/api/receipt?qid=' + encodeURIComponent(qid)).catch(() => null);
  drawer(r ? receiptHtml(r) + '<p class="note">Saved receipt. SQL and names are redacted display excerpts; no query runs in your browser. The result hash identifies the original replay result. Receipt time belongs to the offline export.</p>' : '<p>This receipt was not included in the exported data.</p>', 'Query receipt');
}
function openEvent(seq) {
  const e = traceEvents.find(e=>e.seq === seq);
  if (!e) return;
  drawer(`<p class="note">${esc(AGENT[e.agent] || e.agent)} · ${esc(e.kind)}${e.round ? ' · round ' + e.round : ''} · saved event ${e.seq}</p><h2>${esc(e.summary)}</h2>${(e.receipts || []).map(q=>`<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join('')}${e.model ? `<h3>Requested and served model</h3><pre>${esc(JSON.stringify(e.model,null,2))}</pre>` : ''}${e.detail ? `<h3>Recorded structured response</h3><p class="note">This can include a returned draft, a model judgement, code checks, or the Writer’s response to each finding. Name redactions are marked.</p><pre class="event-detail">${esc(JSON.stringify(e.detail,null,2))}</pre>` : '<p class="note">This event has no additional structured response.</p>'}`, 'Recorded agent step');
}
function drawer(html, title = 'Recorded trace') {
  const d = $('#drawer');
  if (!d.open) lastFocus = document.activeElement;
  $('#drawer-title').textContent = title; $('#drawer-body').innerHTML = html;
  wireCites($('#drawer-body')); wireEvents($('#drawer-body'));
  if (!d.open) d.showModal();
  d.scrollTop = 0; $('#drawer-close').focus();
}
$('#drawer-close').addEventListener('click', () => $('#drawer').close());
$('#drawer').addEventListener('close', () => { if(lastFocus?.isConnected) lastFocus.focus(); });
$('#open-trace').addEventListener('click', () => {
  const events = traceEvents.filter(e => ['reject','approve','escalate'].includes(e.kind) || (e.agent === 'writer' && e.kind === 'check'));
  drawer(`<h2>Drafts returned and repaired</h2><p class="note">${esc(state.question.label)}. Recorded decisions under the final offline checks.</p>${events.map(e=>`<div class="trace-decision"><h3>${esc(AGENT[e.agent])}${e.round ? ' · draft '+e.round : ''}: ${e.kind === 'reject' ? 'returned for revision' : e.kind === 'approve' ? 'approved' : e.kind === 'escalate' ? 'handed to a person' : 'quote and response check'}</h3>${e.detail?.decidedBy ? `<p>Decision made by: ${esc(e.detail.decidedBy)}.</p>` : ''}<details><summary>Read the recorded finding</summary><p>${esc(e.summary)}</p></details><button data-event="${e.seq}">Inspect recorded response</button></div>`).join('')}<button id="full-trace" class="primary">Open full agent trace</button>`, 'Agent trace drawer');
  $('#full-trace').addEventListener('click',()=>{$('#drawer').close(); show('trace'); $('[data-view="trace"]').focus();});
});

function renderTimeline() {
  $('#timeline').innerHTML = ''; let round = 0;
  for (const e of played) {
    if (e.round && e.round !== round) {round=e.round; $('#timeline').insertAdjacentHTML('beforeend', `<li class="round">Round ${round}</li>`);}
    const model = e.model ? `<div class="model">Requested ${esc(e.model.requested)} · served ${esc(e.model.served)} · ${esc(e.model.lane)} lane${e.model.rejudged ? ' · re-judged offline' : ''}</div>` : '';
    const decide = e.detail?.decidedBy ? `<div class="ev-note">Decided by: <b>${esc(e.detail.decidedBy)}</b>. ${esc(e.detail.modelFeedback || '')}</div>` : '';
    $('#timeline').insertAdjacentHTML('beforeend', `<li class="${esc(e.kind)}"><span class="who">${esc(AGENT[e.agent] || e.agent)}</span><span class="say">${esc(e.summary)}</span>${model}${decide}${(e.receipts || []).map(q=>`<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join('')}${e.detail || e.model ? `<button class="event-open" data-event="${e.seq}">Inspect ${e.kind === 'draft' ? 'Writer draft' : 'recorded response'}</button>` : ''}</li>`);
  }
  wireCites($('#timeline')); wireEvents($('#timeline')); renderStats();
  $('#trace-progress').textContent = played.length + ' of ' + traceEvents.length + ' saved events';
  $('#next-event').disabled = cursor >= traceEvents.length;
}
function pauseTrace() {running=false; clearTimeout(timer); timer=null; $('#pause-trace').disabled=true;}
function advance() {
  if(cursor < traceEvents.length) {played.push(traceEvents[cursor++]); renderTimeline(); setActivity((AGENT[played.at(-1).agent] || played.at(-1).agent) + ': ' + played.at(-1).summary);}
  if(cursor >= traceEvents.length) {pauseTrace();setActivity('Recorded trace complete. No model or query was called.');}
}
function schedule() {if(!running)return; const pace=Number($('#speed').value); if(pace===0){played=traceEvents.slice();cursor=traceEvents.length;renderTimeline();pauseTrace();setActivity('Recorded trace complete. No model or query was called.');return;} timer=setTimeout(()=>{advance();schedule();},pace);}
$('#restart-trace').addEventListener('click',()=>{pauseTrace();played=[];cursor=0;renderTimeline();running=true;$('#pause-trace').disabled=false;schedule();});
$('#pause-trace').addEventListener('click',pauseTrace);
$('#next-event').addEventListener('click',()=>{pauseTrace();advance();});
$('#speed').addEventListener('change',()=>{if(running){clearTimeout(timer);schedule();}});

let scanLoaded = false;
function loadScan() {
  if(scanLoaded)return;scanLoaded=true;
  const s=DATA.board.scan,l=DATA.ledger;
  drawScan(s);
  $('#scan-step-table').innerHTML = '<table class="mini"><tr><th>Job</th><th>Step</th><th>Prompt tokens (estimated)</th><th>Carry-over tokens</th><th>Served model</th></tr>'+s.chunks.map(c=>`<tr><td>${c.job}</td><td>${c.id}</td><td>${c.prompt}</td><td>${c.carry}</td><td>${esc(c.model)}</td></tr>`).join('')+'</table>';
  $('#ledger').innerHTML='<tr><th>PRAC signal</th><th>Drug</th><th>U.S. pre-screen</th><th>Patients here</th><th>FDA list rows</th><th>Recorded case</th></tr>'+l.rows.map(r=>{
    const q=meta.questions.find(q=>q.prac_row===r.row_id || (q.substance===String(r.substance).toLowerCase() && r.signal.toLowerCase().includes('naion')));
    return `<tr><td>${esc(r.signal)}<div class="muted small">${esc(r.meeting)} · ${esc(r.row_id)}</div></td><td>${esc(r.substance)}</td><td>${esc(r.us_prescreen)}</td><td class="num">${esc(r.patients)}</td><td class="num">${esc(r.fda_list_rows)}</td><td>${q ? `<button class="small" data-case="${esc(q.id)}">Open recorded case</button>` : '<span class="small muted">No recorded investigation</span>'}</td></tr>`;
  }).join('')+`<tr><td colspan="6"><button class="qid" data-qid="${esc(l.receipt.qid)}">Federated-query receipt ${esc(l.receipt.qid)}</button> · ${esc(l.receipt.backend)}</td></tr>`;
  wireCites($('#ledger'));
  $('#ledger').querySelectorAll('[data-case]').forEach(b=>b.addEventListener('click',()=>{loadCase(b.dataset.case);show('chain');$('#q').focus();}));
  $('#cross').innerHTML=l.rows.filter(r=>r.cross?.length).slice(0,4).map(r=>`<p>${esc(r.substance)}, ${esc(r.signal)}: earlier entries ${r.cross.map(c=>`${esc(c.substance)} (${esc(c.row)}, U.S. ${esc(c.us)})`).join(', ')}.</p>`).join('')+'<p class="note">A name index proposes candidates; Markovian steps judge the links. The scan alone was weaker than name matching alone; see the Scoreboard.</p>';
}

$('#replay').addEventListener('click',()=>{
  $('#replay-out').innerHTML=DATA.reopen.results.map(d=>`<article class="case"><h2>${esc(d.product)} · ${esc(d.inn)}</h2><p>${esc(d.reaction)}</p><p class="note">Illustrative committee decision ${esc(d.decided)}: waiting for ${esc(d.waitingFor)}.</p><ol>${d.timeline.map(n=>`<li><b>Version ${esc(n.version)} · posted ${esc(n.published)}: ${esc(n.state === 'recall' ? 'recall to committee' : n.state === 'half' ? 'changed, condition not met' : 'condition not met')}</b><p>${esc(n.note || 'No matching change was found in this label version.')}</p><button class="qid" data-qid="${esc(n.strictQid)}">Warning-section receipt ${esc(n.strictQid)}</button><button class="qid" data-qid="${esc(n.looseQid)}">All-section receipt ${esc(n.looseQid)}</button></li>`).join('')}</ol></article>`).join('');
  wireCites($('#replay-out'));setActivity('Recorded label changes shown. Committee decisions are illustrative.');
});
$('#repo-link').addEventListener('click',e=>{
  if(e.currentTarget.getAttribute('href').includes('{{')) {e.preventDefault();drawer('<h2>GitHub README link pending</h2><p>The coordinator will replace the repository URL placeholder before publication. This local demo contains all replay data and works offline.</p>','Repository link');}
});
$('#case-form').addEventListener('submit',e=>{e.preventDefault();loadCase($('#q').value);});
$('#source-commit').textContent='Source commit: '+DATA.provenance.commit;
$('#q').innerHTML=meta.questions.map(q=>`<option value="${esc(q.id)}">${esc(q.label)}</option>`).join('');
loadCase('gemcitabine-dress');
