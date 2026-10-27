"""A' gate A5: score the scan ledgers on the registered cross-class questions; paired bootstrap Markovian vs opponent.
Answer key: out/answer_key_v2_independent.json (independent relabel; its 31 cross_class_questions have the same rows and
answer ids as the registered out/register_cross_class.json, only some U.S. statuses differ). The old rule-based register
is still accepted (a file with "questions") but is not the key of record.
Per question (row X):
  link hit   = X's ledger line lists >= 1 answer row (by row id, or by a substance name of that row).
  status hit = a listed answer row also carries the answer key's U.S. status.
Paired bootstrap: resample the questions with replacement 10,000 times (seed 20261023), difference of means M - opponent,
2.5th percentile = lower bound. Gate (V8 3.8): lower bound > 0 on link recall vs opponent C over all 31 questions.
Also reports false links (cross entries naming a row that is not an answer for X) per system.
Batch size is read from the ledgers (both must use the same one); "same batch" and opponent C's batch-level retrieval
(prior rows sharing an ingredient or ATC level 3 with ANY row of the batch, last 30) are recomputed for that size,
exactly as engine/scan.ts does it.
Usage: .venv/Scripts/python -I scripts/a6_score.py out/answer_key_v2_independent.json out/ledger_M.json out/ledger_C.json [out/ledger_R.json] > out/score.json"""
import json, sys, io, random
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
key = json.load(open(sys.argv[1], encoding='utf-8'))
L = {}
for p in sys.argv[2:]:
    d = json.load(open(p, encoding='utf-8')); L[d['system']] = d
norm = lambda s: (s or '').lower().strip()
rows = json.load(open('out/rows.json', encoding='utf-8')); atc = json.load(open('out/atc.json', encoding='utf-8'))['rows']
R = {r['id']: r for r in rows}; idx = {r['id']: i for i, r in enumerate(rows)}

if 'cross_class_questions' in key:  # v2 key
    questions = [dict(qid=q['qid'], row=q['row'], reaction=q['reaction'],
                      answer=[dict(id=a['id'], us_status=a['us_status_v2'], substances=[s.lower() for s in R[a['id']]['substances']]) for a in q['answer']])
                 for q in key['cross_class_questions']]
    key_name = key.get('name', sys.argv[1])
else:
    questions = key['questions']; key_name = sys.argv[1]

batch_sizes = {k: v.get('batch', 8) for k, v in L.items()}
assert len(set(batch_sizes.values())) == 1, f'systems used different batch sizes: {batch_sizes}'
B = next(iter(batch_sizes.values()))


def score(led):
    link, stat, false_links, missing = [], [], 0, 0
    for q in questions:
        e = led['ledger'].get(q['row'])
        if not e: missing += 1; link.append(0); stat.append(0); continue
        cr = e.get('cross') or []
        ok_l = ok_s = 0
        for c in cr:
            if not isinstance(c, dict): false_links += 1; continue
            rid = str(c.get('row', '')).upper(); sub = norm(c.get('substance'))
            match = next((a for a in q['answer'] if a['id'] == rid or (sub and any(sub in s or s in sub for s in a['substances'] if len(s) > 3))), None)
            if match:
                ok_l = 1
                if norm(c.get('us')) == match['us_status']: ok_s = 1
            else:
                false_links += 1
        link.append(ok_l); stat.append(ok_s)
    return dict(link=link, status=stat, link_recall=sum(link) / len(link), status_recall=sum(stat) / len(stat),
                link_hits=sum(link), status_hits=sum(stat), false_links=false_links, missing_lines=missing, ledger_rows=len(led['ledger']))


def boot(a, b, n=10000, seed=20261023):
    rnd = random.Random(seed); k = len(a); ds = []
    if not k: return dict(n=0)
    for _ in range(n):
        ix = [rnd.randrange(k) for _ in range(k)]
        ds.append(sum(a[i] - b[i] for i in ix) / k)
    ds.sort()
    return dict(n=k, diff=sum(x - y for x, y in zip(a, b)) / k, lo=ds[int(0.025 * n)], hi=ds[int(0.975 * n) - 1])


same_batch = lambda q: any(idx[a['id']] // B == idx[q['row']] // B for a in q['answer'])
def c_retrieved(xid):
    b = idx[xid] // B; batch = rows[b * B:(b + 1) * B]; prior = rows[:b * B]
    hit = [p for p in prior if any(set(atc[p['id']]) & set(atc[x['id']]) or set(p['substances']) & set(x['substances']) for x in batch)]
    return {p['id'] for p in hit[-30:]}
reach = [same_batch(q) or any(a['id'] in c_retrieved(q['row']) for a in q['answer']) for q in questions]

S = {k: score(v) for k, v in L.items()}
res = dict(answer_key=key_name, answer_key_file=sys.argv[1], batch_rows=B, n_questions=len(questions),
           systems={k: {kk: vv for kk, vv in v.items() if kk not in ('link', 'status')} for k, v in S.items()},
           per_question={q['qid']: {k: [S[k]['link'][i], S[k]['status'][i]] for k in S} for i, q in enumerate(questions)})
if 'M' in S:
    for opp in [k for k in S if k != 'M']:
        res[f'M_vs_{opp}_link'] = boot(S['M']['link'], S[opp]['link'])
        res[f'M_vs_{opp}_status'] = boot(S['M']['status'], S[opp]['status'])
    keep = [i for i, q in enumerate(questions) if not same_batch(q)]
    res['subset_no_same_batch_n'] = len(keep)
    for opp in [k for k in S if k != 'M']:
        res[f'M_vs_{opp}_link_no_same_batch'] = boot([S['M']['link'][i] for i in keep], [S[opp]['link'][i] for i in keep])
unr = [i for i, r in enumerate(reach) if not r]
res['unreachable_subset'] = dict(n=len(unr), qids=[questions[i]['qid'] for i in unr],
                                 recall={k: sum(S[k]['link'][i] for i in unr) / max(1, len(unr)) for k in S})
if 'M' in S:
    for opp in [k for k in S if k != 'M']:
        res[f'M_vs_{opp}_link_unreachable'] = boot([S['M']['link'][i] for i in unr], [S[opp]['link'][i] for i in unr])
    if 'C' in S:
        lo = res['M_vs_C_link']['lo']
        res['gate'] = dict(rule='V8 3.8: paired bootstrap 95% lower bound of M - C link recall over all 31 questions > 0 -> keep Markovian, else switch to Scout Intent',
                           lower_bound=lo, engine='Markovian' if lo > 0 else 'Scout Intent')
print(json.dumps(res, ensure_ascii=False, indent=1))
