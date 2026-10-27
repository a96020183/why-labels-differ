"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (p, o) => { const r = await fetch(p, o); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); };
const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });

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

let meta, state = {}, since = 0, queue = [], played = [], timer, speed = 140, finished = false, runId = "", polling = false;

// ---------- views ----------
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
function show(v) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v));
  window.scrollTo(0, 0);
  if (v === "scan") loadScan();
  if (v === "board") loadBoard();
}
$("#speed").addEventListener("change", (e) => { speed = Number(e.target.value); });

// ---------- investigation ----------
async function init() {
  meta = await api("/api/meta");
  $("#mode").textContent = meta.sampleMode ? "Sample mode: recorded Zetaris and Nightshift answers" : "Live: Zetaris and Nightshift";
  $("#q").innerHTML = meta.questions.map((q) => `<option value="${esc(q.id)}">${esc(q.label)}</option>`).join("");
  $("#go").addEventListener("click", () => start($("#q").value));
  document.querySelectorAll("[data-vote]").forEach((b) => b.addEventListener("click", () => vote(b.dataset.vote)));
  const s = await api("/api/state");
  if (s.phase && s.phase !== "idle") {
    state = s; since = 0; finished = false; runId = s.id;
    if (s.question) { if (![...$("#q").options].some((o) => o.value === s.question.id)) $("#q").insertAdjacentHTML("beforeend", `<option value="${esc(s.question.id)}">${esc(s.question.label)}</option>`);
      $("#q").value = s.question.id; $("#title").textContent = s.question.label; }
    poll();
  }
  else start(meta.questions[0].id);
}

async function start(id, custom) {
  const q = meta.questions.find((x) => x.id === id) || custom;
  if (custom && ![...$("#q").options].some((o) => o.value === id)) $("#q").insertAdjacentHTML("beforeend", `<option value="${esc(id)}">${esc(q.label)}</option>`);
  $("#q").value = id; $("#go").disabled = true;
  document.querySelectorAll("[data-vote]").forEach((b) => (b.disabled = false));
  $("#title").textContent = q.label;
  $("#lede").textContent = (q.hook ? q.hook + " " : "") + "The agents are tracing where each regulator stands; every sentence will carry the record it came from.";
  $("#ladder").innerHTML = `<div class="pending">Starting the investigation…</div>`;
  $("#why").innerHTML = ""; $("#trail").innerHTML = ""; $("#exposure").innerHTML = ""; $("#vote").hidden = true; $("#after").hidden = true; $("#after").innerHTML = "";
  $("#timeline").innerHTML = ""; queue = []; played = []; since = 0; finished = false; state = {}; lastRound = 0;
  runId = (await post("/api/run", custom ? { custom } : { question: id })).id;
  poll();
}

// one polling loop for the whole page; events of an earlier run are dropped
async function poll() {
  if (polling) return;
  polling = true;
  for (;;) {
    try {
      const evs = await api("/api/trace?since=" + since);
      for (const e of evs) { since = Math.max(since, e.seq); if (!runId || e.run === runId) queue.push(e); }
    } catch { /* server restarting */ }
    if (!timer) play();
    await new Promise((r) => setTimeout(r, 500));
  }
}

function play() {
  const e = queue.shift();
  if (!e) { timer = null; return; }
  timer = setTimeout(async () => { await apply(e); play(); }, speed);
}

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

async function apply(e) {
  played.push(e);
  addTimeline(e);
  renderStats();
  $("#activity").innerHTML = `<b>${AGENT[e.agent] || e.agent}</b> ${esc(e.summary)}`;
  if (e.kind === "draft" || e.kind === "reject" || e.kind === "approve") {
    state = await api("/api/state");
    const d = e.kind === "draft" ? e.detail : (state.outcome?.draft || lastDraft());
    renderChain(d, e.kind === "approve" ? "approved" : e.kind === "reject" ? "sent-back" : "draft", e);
  }
  if (e.agent === "system" && /was not recorded/.test(e.summary)) {
    $("#ladder").innerHTML = `<div class="pending">${esc(e.summary)}</div>`; $("#go").disabled = false;
  }
  if (e.agent === "committee" && e.kind === "info" && /Waiting for the P&T committee/.test(e.summary)) {
    state = await api("/api/state");
    finish();
  }
  if (e.kind === "vote" || e.kind === "fired" || e.kind === "held") { state = await api("/api/state"); if (state.afterVote) renderAfter(state.afterVote); }
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

function finish() {
  finished = true; $("#go").disabled = false;
  const o = state.outcome; if (!o) return;
  renderChain(o.draft, o.status === "approved" ? "approved" : "final-open", { round: o.rounds, summary: "" });
  renderTrail(o);
  const hook = o.question.hook ? o.question.hook + " " : "";
  $("#lede").textContent = hook + (o.status === "approved"
    ? `Approved by the Evaluator after ${o.rounds} round${o.rounds > 1 ? "s" : ""}, from ${state.receipts.length} queries through Zetaris (the investigation, before the vote; the trace view also counts the vote, counseling and reopen queries).`
    : `Not settled after ${o.rounds > 2 ? `two rounds and ${o.rounds - 2} repair draft(s)` : "two rounds"}: shown with its open gaps for a person to review.`);
  const ex = o.exposure || {};
  $("#exposure").innerHTML = `<div class="ex-main"><strong>${esc(ex.patients ?? "0")}</strong><span>patients in this hospital take ${esc(o.question.substance)}. A count: the agents cannot see who.</span></div>
    <p class="small muted">${o.exposure ? `Same joined query, on ${esc(o.question.substance)}, counting hits of the round-1 search words (not the records the chain cites): EU records naming the reaction ${esc(ex.eu_records_naming_it ?? 0)}, U.S. label sections ${esc(ex.us_label_sections_naming_it ?? 0)}, FDA list rows ${esc(ex.fda_list_rows_naming_it ?? 0)}.` : `${esc(o.question.substance)} is not dispensed here, so the joined query (keyed on the hospital's drugs) returns no row.`}
    ${(o.pushdown || []).length ? "Zetaris plan: " + esc(["MySQL", "Postgres", "S3"].map((sy) => { const xs = o.pushdown.filter((p) => p.system === sy); const real = xs.filter((p) => p.pushed && !/^IsNotNull\(\w+\)$/.test(p.pushed)); return `${sy} ${real.length ? "filtered at the source" : "read whole, filtered in Zetaris"}`; }).join("; ")) + "." : ""}
    <button class="qid" data-qid="${esc(o.federatedQid)}">${esc(o.federatedQid)}</button></p>`;
  wireCites($("#exposure"));
  const opt = o.draft.recommendation.option;
  const settled = o.status === "approved";
  $("#rec").textContent = !settled ? `Handed to a person: the agents did not settle this in two rounds, so they make no suggestion. The pharmacist decides from the chain above and its open gaps.`
    : opt === "none" || !VOTE_TEXT[opt] ? `The agents make no suggestion. ${o.draft.recommendation.reason}` : `The agents suggest: ${VOTE_TEXT[opt]}. ${o.draft.recommendation.reason}`;
  // the highlighted button is the agents' approved suggestion; a hand-off highlights nothing
  document.querySelectorAll("#vote [data-vote]").forEach((b) => b.classList.toggle("primary", settled && b.dataset.vote === opt));
  // nobody here takes the drug: an in-house reminder would reach no one
  const pb = document.querySelector('#vote [data-vote="propose"]'); if (pb) { pb.disabled = !Number(o.exposure?.patients || 0); pb.title = pb.disabled ? "No patient in this hospital takes this drug" : ""; }
  $("#vote").hidden = !!state.vote;
  if (state.afterVote) renderAfter(state.afterVote);
}
const VOTE_TEXT = { propose: "propose an in-house reminder", wait: "wait for the U.S. and reopen on a condition", no_action: "no action", already_covered: "already covered" };

async function vote(option) {
  document.querySelectorAll("[data-vote]").forEach((b) => (b.disabled = true));
  $("#activity").innerHTML = "<b>Committee</b> recording the vote through the pharmacist's Zetaris identity…";
  try { await post("/api/vote", { option }); } catch (e) { $("#activity").textContent = String(e.message); }
  state = await api("/api/state");
  $("#vote").hidden = true;
  renderAfter(state.afterVote);
}

function table(rows, cols) {
  if (!rows || !rows.length) return `<p class="muted small">No rows.</p>`;
  cols = cols || Object.keys(rows[0]);
  return `<table class="mini"><tr>${cols.map((c) => `<th>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</table>`;
}

function renderAfter(a) {
  if (!a) return;
  const el = $("#after"); el.hidden = false;
  const reopen = `<div class="box wide"><h3>Reopen this decision when</h3><ul>${(a.conditions || []).map((k) => `<li class="${k.fired ? "ok" : "waiting"}">${esc(k.description)}: ${k.fired ? "already true" : "waiting"}${k.note && k.rows ? ` <span class="muted small">(${esc(k.note)})</span>` : ""} <button class="qid" data-qid="${esc(k.qid)}">${esc(k.qid)}</button></li>`).join("")}</ul>
      <p class="muted small">The Writer named these conditions. Each is a stored Zetaris query the night run re-checks; when rows come back, Nemotron judges whether they are what the committee is waiting for. See Reopen for a replay of real 2026 label changes.</p></div>`;
  if (a.option === "wait") { el.innerHTML = `<div class="box wide"><h3>Recorded: wait for the U.S.</h3><p class="muted">No reminder and no patient list yet. The decision comes back to the committee when one of these conditions comes true.</p></div>` + reopen; wireCites(el); return; }
  if (a.option !== "propose") { el.innerHTML = `<div class="box wide"><h3>Recorded: ${esc(VOTE_TEXT[a.option] || a.option)}</h3><p class="muted">No counseling points and no patient list. They appear only when the committee proposes an in-house reminder.</p></div>`; return; }
  const c = a.counsel || {}, id = a.identities || {};
  el.innerHTML = `
    <div class="box"><h3>Counseling points</h3><ul>${(c.report || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul><p>${esc(c.action)}</p>
      ${chips(c.cites)}
      <p class="muted small">The in-house reminder: these points are given at the patient's next dispensing. Drafted only from the regulators' own texts; never "you have this risk"; no advice to stop or switch.</p></div>
    <div class="box"><h3>Patients by department</h3>${table(a.byDept, ["dept", "patients", "next_fill"])}<p class="muted small">Aggregate view, agent role.</p></div>
    <div class="box wide"><h3>Same query, two identities</h3><div class="ident">
      <div><p class="small"><b>Agent role</b> asks for the patient list</p><p class="denied">${esc(id.list?.agent?.error || "refused")}</p>
        <p class="small"><b>Agent role</b>, pharmacy rows</p>${table(id.rows?.agent?.rows)}</div>
      <div><p class="small"><b>Pharmacist role</b>, first ${(id.list?.pharmacist?.rows || []).length} of ${esc(state.outcome?.exposure?.patients ?? "0 (not dispensed here)")} patients by next fill (synthetic; 8 shown)</p>${table((id.list?.pharmacist?.rows || []).slice(0, 8), ["mrn", "display_name", "dept", "next_fill"])}
        <p class="small"><b>Pharmacist role</b>, pharmacy rows</p>${table(id.rows?.pharmacist?.rows)}</div></div>
      <p class="muted small">Masking and refusal come from Zetaris column policies and grants, not from the app. Queries ${esc([id.list?.agent?.qid, id.list?.pharmacist?.qid, id.rows?.agent?.qid, id.rows?.pharmacist?.qid].join(", "))}.</p></div>
    ` + reopen;
  wireCites(el);
}

// ---------- drawer ----------
function wireCites(root) {
  root.querySelectorAll("[data-eid]").forEach((b) => b.addEventListener("click", () => openItem(b.dataset.eid)));
  root.querySelectorAll("[data-qid]").forEach((b) => b.addEventListener("click", () => openReceipt(b.dataset.qid)));
}
async function openItem(eid) {
  let it = itemOf(eid);
  if (!it) { state = await api("/api/state"); it = itemOf(eid); }
  if (!it) return drawer(`<p>${esc(eid)} is not among the records Research returned.</p>`);
  const r = await api("/api/receipt?qid=" + it.qid).catch(() => null);
  drawer(`<h2>${esc(it.title)}</h2><p class="muted">${esc(it.section)}${it.date ? " · " + esc(it.date) : ""}</p><blockquote>${esc(it.text.replace(/\uFFFD/g, "'"))}</blockquote>
    <dl><dt>Record</dt><dd>${esc(it.eid)}</dd><dt>Kind</dt><dd>${esc(it.kind)} (${esc(it.authority)})</dd>${it.url ? `<dt>Source</dt><dd><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.url.slice(0, 70))}</a></dd>` : ""}</dl>
    ${r ? receiptHtml(r) : ""}`);
}
async function openReceipt(qid) { const r = await api("/api/receipt?qid=" + qid).catch(() => null); drawer(r ? receiptHtml(r) : `<p>No receipt ${esc(qid)}.</p>`); }
function receiptHtml(r) {
  return `<h3>Query receipt ${esc(r.qid)}</h3><dl><dt>Purpose</dt><dd>${esc(r.purpose)}</dd><dt>Asked by</dt><dd>${esc(r.agent)} as ${esc(r.as)}</dd><dt>Systems</dt><dd>${esc(r.systems.join(", ") || "Zetaris")}</dd>
    <dt>Answered by</dt><dd>${esc(r.backend === "replay" ? "recorded Zetaris answer" : r.backend === "emulator" ? "local emulator (no recording)" : "live Zetaris")}</dd><dt>Rows</dt><dd>${r.rows}</dd><dt>Result hash</dt><dd>${esc(r.resultSha)}</dd>
    ${r.error ? `<dt>Refused</dt><dd class="denied">${esc(r.error)}</dd>` : ""}</dl><pre>${esc(r.sql)}</pre>`;
}
function drawer(html) { $("#drawer-body").innerHTML = html; $("#drawer").hidden = false; $("#drawer-close").focus(); }
$("#drawer-close").addEventListener("click", () => ($("#drawer").hidden = true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#drawer").hidden = true; });

// ---------- timeline ----------
let lastRound = 0;
function addTimeline(e) {
  const ol = $("#timeline");
  if (e.round && e.round !== lastRound) { lastRound = e.round; ol.insertAdjacentHTML("beforeend", `<li class="round">Round ${e.round}</li>`); }
  if (e.kind === "model" && e.model) {
    ol.insertAdjacentHTML("beforeend", `<li class="model"><div class="model">${AGENT[e.agent] || e.agent} called Nemotron (${esc(e.model.lane)} lane): asked ${esc(e.model.requested)}, answered by ${esc(e.model.served)}${e.model.source === "replay" ? ", recorded" : e.model.source === "live" ? ", live" : ""}</div></li>`);
    return;
  }
  const fb = e.agent === "evaluator" && (e.kind === "reject" || e.kind === "approve") && e.detail ? `<div class="ev-note">Decided by: <b>${esc(e.detail.decidedBy || "")}</b>. Evaluator model said ${esc(e.detail.modelSays || "")}${e.detail.modelFeedback ? `: ${esc(e.detail.modelFeedback)}` : ""}${(e.detail.reply || []).length ? ` · Its reply to the coverage checks: ${esc(e.detail.reply.map((r) => `${r.accept ? "accepted" : "rejected"} #${r.n} (${r.reason})`).join("; "))}` : ""}</div>` : "";
  const m = fb;
  const q = (e.receipts || []).map((x) => `<button class="qid" data-qid="${esc(x)}">${esc(x)}</button>`).join("");
  const say = e.kind === "reject" ? `<div class="say">${esc(e.summary.replace(/^Sent back: /, ""))}</div>` : `<span>${esc(e.summary)}</span>`;
  ol.insertAdjacentHTML("beforeend", `<li class="${esc(e.kind)}"><span class="who">${AGENT[e.agent] || e.agent}</span>${say} ${q}${m}</li>`);
  wireCites(ol.lastElementChild);
}

// ---------- night scan ----------
let scanLoaded = false;
async function loadScan() {
  if (scanLoaded) return; scanLoaded = true;
  const b = await api("/api/board");
  drawScan(b.scan);
  const l = await api("/api/ledger");
  $("#ledger").innerHTML = `<tr><th>PRAC signal</th><th>Drug</th><th>U.S. pre-screen</th><th class="num">Patients here</th><th class="num">FDA list rows naming the drug</th><th></th></tr>` +
    l.rows.map((r) => `<tr><td>${esc(r.signal)}<div class="muted small">${esc(r.meeting.replace(" PRAC meeting minutes", ""))} · ${esc(r.row_id)}</div></td><td>${esc(r.substance)}</td><td>${esc(r.us_prescreen)}</td>
      <td class="num">${esc(r.patients)}</td><td class="num">${esc(r.fda_list_rows)}</td><td><button class="small" data-pick="${esc(r.row_id)}">Investigate</button></td></tr>`).join("") +
    `<tr><td colspan="6" class="muted small">Query <button class="qid" data-qid="${esc(l.receipt.qid)}">${esc(l.receipt.qid)}</button> (${esc(l.receipt.backend)})</td></tr>`;
  wireCites($("#ledger"));
  $("#ledger").querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", () => {
    const r = l.rows.find((x) => x.row_id === btn.dataset.pick);
    const known = meta.questions.find((q) => q.prac_row === r.row_id);
    show("chain");
    if (known) start(known.id);
    else start("pick-" + r.row_id, { id: "pick-" + r.row_id, substance: String(r.substance).toLowerCase(), reaction: r.signal, label: `${r.substance} and ${String(r.signal).toLowerCase()}` });
  }));
  const ex = l.rows.filter((r) => r.cross && r.cross.length).slice(0, 4);
  $("#cross").innerHTML = (ex.length ? ex.map((r) => `<p>${esc(r.substance)}, ${esc(String(r.signal).toLowerCase())}: the index already held ${r.cross.map((c) => `${esc(c.substance)} (${esc(c.row)}, U.S. ${esc(c.us)})`).join(", ")}.</p>`).join("") : "") +
    `<p class="muted small">How links across drug classes are found: a reaction-name index (code) proposes earlier rows with a similar reaction name; the Markovian scan judges them and keeps its own small index for the synonyms the names miss. Scores and costs for each part alone are on the Scoreboard.</p>`;
}
function drawScan(s) {
  const W = 960, H = 280, P = 46, n = Math.max(s.chunks.length, s.fullReread.length), max = 13500;
  const x = (i) => P + (i / Math.max(1, n - 1)) * (W - P - 20), y = (v) => H - 30 - (v / max) * (H - 60);
  const line = (vals, cls) => `<polyline fill="none" stroke="${cls}" stroke-width="2" points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Prompt tokens per step">
    ${line(s.fullReread, "#9aa7ad")}${line(s.chunks.map((c) => c.prompt), "#1c2a33")}
    <text x="${x(n - 1) - 4}" y="${y(s.fullReread.at(-1) || 0) - 8}" font-size="12" text-anchor="end" fill="#5f6e77">re-read the whole ledger every step${s.fullRereadRun ? "" : " (estimated)"}</text>
    <text x="${x(n - 1) - 4}" y="${y(s.chunks.at(-1)?.prompt || 0) - 8}" font-size="12" text-anchor="end" fill="#1c2a33">${s.product ? "name index + Markovian (the product)" : "Markovian: carry a small index"}</text>
    <text x="${P}" y="${H - 8}" font-size="12" fill="#5f6e77">step 1</text><text x="${W - 20}" y="${H - 8}" font-size="12" text-anchor="end" fill="#5f6e77">step ${n} (197 entries, 3 per step)</text>
    <text x="8" y="${y(max) + 4}" font-size="12" fill="#5f6e77">${max.toLocaleString()}</text><text x="8" y="${y(0)}" font-size="12" fill="#5f6e77">0</text></svg>`;
  $("#scan-chart").innerHTML = svg + `<p class="muted small">Prompt tokens per step (estimated as characters ÷ 4). Models that answered: ${Object.entries(s.models).map(([k, v]) => `${esc(k)} ×${v}`).join(", ")}.</p>`;
}
$("#rescan").addEventListener("click", async () => {
  $("#rescan").disabled = true; await post("/api/scan");
  const tick = async () => {
    const s = await api("/api/scan");
    const last = s.chunks.at(-1);
    $("#scan-status").textContent = s.error ? "Stopped: " + s.error : s.running ? `Job ${last?.job ?? 1}, step ${last?.chunk ?? 0} of ${last?.of ?? "?"}: rows ${last?.rows?.join(", ") ?? ""}, carrying ${last?.carryTokens ?? 0} tokens` : `${s.done || "Finished"}. ${s.chunks.length} steps replayed through the engine; no model was called.`;
    if (last) $("#activity").innerHTML = `<b>Night scan</b> job ${last.job}, step ${last.chunk}: ${last.rows.join(", ")}`;
    if (s.running) setTimeout(tick, 150); else $("#rescan").disabled = false;
  };
  tick();
});

// ---------- reopen replay ----------
$("#replay").addEventListener("click", async () => {
  $("#replay").disabled = true; $("#replay-out").innerHTML = "";
  await post("/api/replay"); let seen = 0;
  const cases = {};
  const tick = async () => {
    const evs = await api("/api/trace?of=replay&since=" + seen);
    for (const e of evs) {
      seen = e.seq; $("#activity").innerHTML = `<b>${AGENT[e.agent] || e.agent}</b> ${esc(e.summary)}`;
      const name = (e.summary.match(/^(Yescarta|Nubeqa)/) || e.summary.match(/(Yescarta|Nubeqa)/) || [])[1];
      if (!name) continue;
      if (!cases[name]) { cases[name] = document.createElement("div"); cases[name].className = "case"; cases[name].innerHTML = `<h3>${name}</h3><ol></ol>`; $("#replay-out").append(cases[name]); }
      if (e.kind === "sql" && /decision on hold/.test(e.summary)) { cases[name].querySelector("h3").insertAdjacentHTML("afterend", `<p class="muted">${esc(e.summary.replace(/^\w+: /, ""))}</p>`); continue; }
      if (e.kind === "model") continue;
      cases[name].querySelector("ol").insertAdjacentHTML("beforeend", `<li class="${e.kind === "fired" ? "ok" : "waiting"}">${esc(e.summary)} ${(e.receipts || []).map((q) => `<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join("")}</li>`);
      wireCites(cases[name]);
    }
    const st = await api("/api/replay");
    if (st.running) setTimeout(tick, 400); else $("#replay").disabled = false;
  };
  tick();
});

// ---------- scoreboard ----------
async function loadBoard() {
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

init();
