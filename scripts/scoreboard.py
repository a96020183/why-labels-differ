"""Scoreboard (out/scoreboard.json): set 1a (39 recent PRAC signals) and the 31 pre-registered cross-class questions.
Answer key: out/answer_key_v2_independent.json (independent AI relabel from full label text; NOT a pharmacist).
Arms on set 1a: our agents (out/set1a_ours.json), S' = OpenAI reasoning model + web search (out/sprime_answers.json, offline
comparison only), keyword rule (out/uslabel.json, the pre-screen). Cross-class: Markovian vs fair opponent C (out/score.json).
Wilson 95% intervals; paired bootstrap (10,000 resamples, seed 20261024) for differences.
Usage: python -I scripts/scoreboard.py"""
import csv, json, math, os, random, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda p: json.load(open(os.path.join(ROOT, p), encoding='utf-8'))
key = J('out/answer_key_v2_independent.json')
ids = key['sets']['set_1a_39']
gold = {r: key['rows'][r]['status_current'] for r in ids}
qs = {q['id']: q for q in J('sample/scoreboard/set1a_questions.json')['questions']}
named = [r for r in ids if qs[r]['product']]
ours = {a['id']: a for a in J('out/set1a_ours.json')['answers']}
sp = {a['id']: a for a in J('out/sprime_answers.json')['answers']}
kw = J('out/uslabel.json')['rows']
CLS = {'written', 'partial', 'not found', 'not marketed'}
norm_s = lambda s: (s or '').strip().lower()
pred = {
    'ours': {r: norm_s(ours.get(r, {}).get('us_status')) for r in ids},
    'sprime': {r: norm_s((sp.get(r, {}).get('answer') or {}).get('us_status')) for r in ids},
    'keyword': {r: norm_s(kw.get(r, {}).get('status')) for r in ids},
}


def wilson(k, n, z=1.96):
    if not n: return 0, 0
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def boot(a, b, n=10000, seed=20261024):
    rnd = random.Random(seed); m = len(a); ds = []
    for _ in range(n):
        idx = [rnd.randrange(m) for _ in range(m)]
        ds.append(sum(a[i] - b[i] for i in idx) / m)
    ds.sort(); return sum(x - y for x, y in zip(a, b)) / m, ds[int(.025 * n)], ds[int(.975 * n)]


def arm(name, k, rows, ours_flag=False):
    hits = [1 if pred[k][r] == gold[r] else 0 for r in rows]
    lo, hi = wilson(sum(hits), len(rows))
    return dict(name=name, key=k, correct=sum(hits), n=len(rows), acc=sum(hits) / len(rows), lo=lo, hi=hi, ours=ours_flag), hits


out = {}
arms, hits = [], {}
for name, k, f in [('Same evidence path, one Nemotron classification per question (not the full agent loop)', 'ours', True), ("S': OpenAI reasoning model with web search", 'sprime', False), ('Keyword rule', 'keyword', False)]:
    a, h = arm(name, k, named, f); arms.append(a); hits[k] = h
d1 = boot(hits['ours'], hits['sprime']); d2 = boot(hits['ours'], hits['keyword'])
all39 = {k: sum(1 for r in ids if pred[k][r] == gold[r]) for k in pred}

# citation support: can the quoted U.S. label sentence be found in the current label text?
spl = {}
for r in csv.DictReader(open(os.path.join(ROOT, 'sample', 'evidence', 'spl_section_score.csv'), encoding='utf-8')):
    spl.setdefault(r['product'], []).append(r['text'])
nz = lambda s: re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()
def supported(product, quote):
    q = nz(quote)[:160]
    return bool(q) and any(q in nz(t) for t in spl.get(product, []))
sup = {'ours': [0, 0], 'sprime': [0, 0]}
for r in named:
    for k, quote in (('ours', ours.get(r, {}).get('quote')), ('sprime', (sp.get(r, {}).get('answer') or {}).get('quote'))):
        if pred[k][r] in ('written', 'partial'):
            sup[k][1] += 1; sup[k][0] += 1 if supported(qs[r]['product'], quote) else 0

conf = {}
for k in pred:
    m = {}
    for r in named:
        m.setdefault(gold[r], {}).setdefault(pred[k][r] or 'no answer', 0); m[gold[r]][pred[k][r] or 'no answer'] += 1
    conf[k] = m

out['set1a'] = dict(n=len(named), n_all=len(ids), arms=arms, all39=all39,
    paired=f"Paired bootstrap, ours minus S': {d1[0]*100:+.1f} points (95% CI {d1[1]*100:+.1f} to {d1[2]*100:+.1f}); ours minus keyword rule: {d2[0]*100:+.1f} points ({d2[1]*100:+.1f} to {d2[2]*100:+.1f}). "
           f"All 39 including the 4 with no U.S. product named: ours {all39['ours']}, S' {all39['sprime']}, keyword {all39['keyword']}.",
    support=f"Quoted U.S. label sentence found word for word in the DailyMed text captured on 2026-10-24 (sample/evidence/spl_section_score.csv) (answers of written or partial): ours {sup['ours'][0]} of {sup['ours'][1]}, S' {sup['sprime'][0]} of {sup['sprime'][1]}.",
    confusion=conf, per_question={r: dict(gold=gold[r], **{k: pred[k][r] for k in pred}) for r in ids})


# ---------------- set 1a, the full multi-agent loop on 10 questions (out/set1a_loop.json), next to the other arms on the same 10 ----------------
import glob as _g
# the newest complete loop, re-judged offline with the final checks (scripts/rejudge.ts outcomes); the live recording it
# comes from is named in the file. A loop stopped before all 10 questions is shown in the README, not here.
_full = lambda p: (lambda j: j.get('complete', len(j.get('answers', [])) == len(j.get('ids', [])) > 0))(json.load(open(p, encoding='utf-8')))
_loops = sorted(p for p in _g.glob(os.path.join(ROOT, 'out', 'set1a_loop_v*_rejudged_final.json')) if _full(p))
if _loops:
    lp = J(os.path.relpath(_loops[-1], ROOT).replace('\\', '/')); ten = lp['ids']
    # an answer counts only if the draft cites a label record it read (a run that found no label and wrote "not found" is no answer)
    loop = {a['id']: (norm_s(a['us_status']) if any(str(c).startswith(('SPL-', 'US-LABELS-SEARCHED')) for c in (a.get('cites') or [])) else 'no answer') for a in lp['answers']}
    row = lambda name, p: (lambda k: dict(name=name, correct=k, n=len(ten), lo=wilson(k, len(ten))[0], hi=wilson(k, len(ten))[1]))(sum(1 for r in ten if p.get(r) == gold[r]))
    out['set1a_loop'] = dict(ids=ten, selection=lp['selection'], arm=lp['arm'], traces=lp.get('traces', ''), arms=[
        row('Full multi-agent loop (this app)', loop), row('One Nemotron classification per question', pred['ours']),
        row("S': OpenAI reasoning model with web search", pred['sprime']), row('Keyword rule', pred['keyword'])],
        per_question={r: dict(gold=gold[r], loop=loop.get(r), single=pred['ours'][r], sprime=pred['sprime'][r]) for r in ten},
        outcomes={a['id']: f"{a['outcome']} after {a['rounds']}" for a in lp['answers']}, run=f"{lp.get('run_at')} and re-judged offline with the final checks ({os.path.basename(_loops[-1])})")
    appr = [a for a in lp['answers'] if a['outcome'] == 'approved']; hand = [a for a in lp['answers'] if a['outcome'] != 'approved']
    k = sum(1 for a in appr if loop.get(a['id']) == gold[a['id']])
    out['set1a_loop']['approved'] = dict(correct=k, n=len(appr), lo=wilson(k, len(appr))[0] if appr else 0, hi=wilson(k, len(appr))[1] if appr else 0, ids=[a['id'] for a in appr])
    out['set1a_loop']['handoff'] = dict(n=len(hand), draftCorrect=sum(1 for a in hand if loop.get(a['id']) == gold[a['id']]), ids=[a['id'] for a in hand])


# ---------------- cross-class: every ledger that exists, scored with the same scorer ----------------
import glob, subprocess
ledgers = [p for p in ('out/ledger_MN.json', 'out/ledger_M.json', 'out/ledger_FR.json', 'out/ledger_N.json', 'out/ledger_C.json') if os.path.exists(os.path.join(ROOT, p))]
sc = json.loads(subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'scripts', 'a6_score.py'), 'out/answer_key_v2_independent.json', *ledgers],
                               cwd=ROOT, capture_output=True, text=True, encoding='utf-8').stdout)
NAMES = {'MN': 'Product: reaction-name index (code) + Markovian scan (model)', 'M': 'Markovian scan alone (model, carried index)',
         'FR': 'Re-read the whole ledger every step (model)', 'N': 'Reaction-name matching alone (code, no model)',
         'C': 'Retrieval by ingredient or ATC class (cannot reach another class by design)'}


def cost(sysname):
    """prompt tokens (estimated, characters / 4) and model wall time, from the recorded steps of that arm"""
    d = {'MN': 'runs/scan_MN_b3', 'M': 'runs/scan_M_b3', 'FR': 'runs/scan_FR_b3', 'C': 'runs/scan_C_b3'}.get(sysname)
    if not d or not os.path.isdir(os.path.join(ROOT, d)):
        return None
    recs = [json.load(open(f, encoding='utf-8')) for f in glob.glob(os.path.join(ROOT, d, '*_*.json')) if 'invalid' not in f and '_pending' not in f]
    recs = [r for r in recs if 'promptTokensEstimated' in r]
    if not recs:
        return None
    toks = [r['promptTokensEstimated'] for r in recs]; lat = [r.get('latency') or 0 for r in recs]
    return dict(calls=len(recs), prompt_tokens_total=sum(toks), prompt_tokens_max=max(toks), model_seconds=round(sum(lat)), served=sorted({r.get('served') for r in recs if r.get('served')}))


arms_c = []
for k in ['MN', 'M', 'FR', 'N', 'C']:
    if k not in sc['systems']:
        continue
    v = sc['systems'][k]; lo, hi = wilson(v['link_hits'], sc['n_questions'])
    arms_c.append(dict(name=NAMES[k], key=k, correct=v['link_hits'], n=sc['n_questions'], acc=v['link_recall'], lo=lo, hi=hi, false_links=v['false_links'],
                       ours=(k == ('MN' if 'MN' in sc['systems'] else 'M')), cost=cost(k)))
per = sc['per_question']
def pair(a, b):
    if a not in sc['systems'] or b not in sc['systems']:
        return None
    x = [per[q][a][0] for q in per]; y = [per[q][b][0] for q in per]
    d, lo, hi = boot(x, y); return f"{NAMES[a].split(':')[0].split(' (')[0]} minus {NAMES[b].split(' (')[0]}: {d*100:+.1f} points (95% CI {lo*100:+.1f} to {hi*100:+.1f})"
pairs = [p for p in (pair('MN', 'N'), pair('MN', 'FR'), pair('M', 'N'), pair('M', 'FR')) if p]
out['crossClass'] = dict(n=sc['n_questions'], arms=arms_c, paired='; '.join(pairs) + '.' if pairs else '',
                         M=dict(hits=sc['systems'].get('M', {}).get('link_hits')), N=dict(hits=sc['systems'].get('N', {}).get('link_hits')))

# ---------------- why columns (EU / UK / U.S. FDA stage) against the separate reviewer's key ----------------
wk_p, wo_p = os.path.join(ROOT, 'out', 'why_key_independent_v2.json'), os.path.join(ROOT, 'out', 'why_ours.json')
if os.path.exists(wk_p) and os.path.exists(wo_p):
    wk, wo = J('out/why_key_independent_v2.json')['rows'], {a['id']: a for a in J('out/why_ours.json')['answers']}
    cols = {}
    for col in ('eu', 'uk', 'us_regulator'):
        h = [1 if norm_s(wo.get(r, {}).get(col)) == norm_s(wk[r][col]['label']) else 0 for r in ids]
        lo, hi = wilson(sum(h), len(h)); cols[col] = dict(correct=sum(h), n=len(h), lo=lo, hi=hi)
    # the full "why" row: all three regulator columns right, and the U.S. label status right
    allc = [1 if all(norm_s(wo.get(r, {}).get(c)) == norm_s(wk[r][c]['label']) for c in ('eu', 'uk', 'us_regulator')) and pred['ours'][r] == gold[r] else 0 for r in ids]
    lo, hi = wilson(sum(allc), len(allc))
    miss = [f"{r} {c}: ours {wo.get(r, {}).get(c)}, key {wk[r][c]['label']}" for r in ids for c in ('uk', 'us_regulator') if norm_s(wo.get(r, {}).get(c)) != norm_s(wk[r][c]['label'])]
    out['why'] = dict(n=len(ids), columns=cols, all_four=dict(correct=sum(allc), n=len(allc), lo=lo, hi=hi), misses=miss,
                      key_labels={c: {lab: sum(1 for r in ids if wk[r][c]['label'] == lab) for lab in sorted({wk[r][c]['label'] for r in ids})} for c in ('uk', 'us_regulator')})

so, ss = J('out/set1a_ours.json'), J('out/sprime_answers.json')
out['notes'] = [
    'Both answer keys were labelled by a separate AI reviewer (Claude, in its own session, without seeing the system outputs), not a pharmacist. 6 rows of the U.S.-status key are low-confidence.',
    f"Main set-1a number: the {len(named)} questions that name a U.S. product. The other 4 are 'not marketed' in the key; every arm was told no U.S. product was named, which gives the answer away, so they are reported separately.",
    "Our agents: models that answered " + ", ".join(f"{k.split('/')[-1]} x{v}" for k, v in (so.get('models_served') or {}).items()) + "; " + ", ".join(f"{v} queries answered by {k}" for k, v in (so.get('zetaris_backends') or {}).items()) + ". One run, temperature 0.",
    f"S' ran once on {ss.get('run_at')} ({ss.get('model_requested')} with web search, OpenAI). It is an offline comparison only and is not used anywhere in the product.",
    'Our MHRA table holds three Drug Safety Updates and no FDA Drug Safety Communications, so UK and FDA answers can only be as complete as those tables; the misses are listed.',
    'Small samples: read the intervals, not the point estimates.',
    'Cross-class questions were registered (SHA-256 recorded, committed) before any scan ran. Every arm sees the same 197 rows in the same 3-row steps with the same model settings.',
]
json.dump(out, open(os.path.join(ROOT, 'out', 'scoreboard.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for a in arms: print(a['name'], a['correct'], '/', a['n'])
for a in arms_c: print(a['key'], a['correct'], '/', a['n'], a['cost'])
print(out['set1a']['paired']); print(out['crossClass']['paired']); print(out.get('why', {}).get('columns'), out.get('why', {}).get('all_four'))
