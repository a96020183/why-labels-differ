"""Assemble answer_key_v2_independent.json from the hand judgments + label metadata, then compare with the original key.
Usage: build.py A_PRIME_DIR"""
import json, sys, os, re, hashlib, collections
sys.stdout.reconfigure(encoding='utf-8')
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = sys.argv[1]; OUT = os.path.join(AP, 'out')
J = json.load(open(os.path.join(BASE, 'judgments.json'), encoding='utf-8'))
M = json.load(open(os.path.join(BASE, 'map.json'), encoding='utf-8'))
P = json.load(open(os.path.join(BASE, 'plan.json'), encoding='utf-8'))
rows = {r['id']: r for r in json.load(open(os.path.join(OUT, 'rows.json'), encoding='utf-8'))}
reg = json.load(open(os.path.join(OUT, 'register_cross_class.json'), encoding='utf-8'))
orig = json.load(open(os.path.join(OUT, 'uslabel.json'), encoding='utf-8'))['rows']


def meta(path):
    x = open(path, encoding='utf-8', errors='ignore').read(20000)
    eff = re.search(r'<effectiveTime value="(\d{8})', x).group(1)
    ver = re.search(r'<versionNumber value="(\d+)"', x).group(1)
    return f'{eff[:4]}-{eff[4:6]}-{eff[6:]}', int(ver)


OVERRIDE = {'R104': ('Lyrica (Viatris)', 'd4734e7d-5079-455e-8ff5-8f4539c998a9', os.path.join(BASE, 'dl', 'd4734e7d-5079-455e-8ff5-8f4539c998a9_cur.xml'))}
set1a = sorted(r for r in J if rows[r]['yr'] >= 2025)
ys = sorted({a['id'] for q in reg['questions'] for a in q['answer']})
out_rows = {}
for rid in sorted(J):
    j = J[rid]; r = rows[rid]
    e = dict(id=rid, inn=r['inn'], signal=r['sig'], prac_meeting=f"{r['yr']}-{r['mo']:02d}",
             in_set=[s for s, ok in (('1a_39', rid in set1a), ('cross_class_answer', rid in ys)) if ok],
             status_current=j['cur'], status_at_prac=j['asof'], confidence=j['conf'], reason=j['why'],
             pharmacist_review=bool(j.get('pharm')) or j['conf'] == 'low')
    if 'nm' in M[rid]:
        e.update(section='-', excerpt='', label=None, not_marketed_basis=M[rid]['nm'])
    else:
        prods = P[rid]['products']; ev = prods[j.get('ev', 0)]
        name, sid, cur = ev['name'], ev['setid'], ev['cur']
        if rid in OVERRIDE: name, sid, cur = OVERRIDE[rid]
        eff, ver = meta(cur)
        e['label'] = dict(product=name, setid=sid, version=ver, effective=eff)
        if ev.get('asof'):
            aeff, aver = meta(ev['asof'])
            e['label_at_prac'] = dict(setid=ev['setid'], version=aver, effective=aeff, published=ev.get('asof_published'))
        else:
            e['label_at_prac'] = dict(setid=ev['setid'], note='no version of this set id published before the PRAC month', first_published=ev.get('first_published'))
        e['other_products_checked'] = [dict(product=p['name'], setid=p['setid']) for k, p in enumerate(prods) if p['setid'] != sid]
        e.update(section=j['sec'], excerpt=j['ex'])
    out_rows[rid] = e

q2 = []
for q in reg['questions']:
    qq = dict(qid=q['qid'], row=q['row'], reaction=q['reaction'],
              answer=[dict(id=a['id'], us_status_v2=out_rows[a['id']]['status_current'], us_status_v1=a['us_status']) for a in q['answer']])
    q2.append(qq)

key = dict(
    name='A-prime answer key v2 (independent relabel)',
    created='2026-10-23',
    annotator='Independent AI reviewer (Claude), NOT a pharmacist. Not reviewed by a pharmacist.',
    method=['For each row, the representative U.S. label is the innovator/NDA-BLA holder SPL (no repackagers); class signals use the first PRAC-listed substance with a U.S. label, other U.S. products were also read and noted.',
            'Current SPL XML (DailyMed v2 /spls/{setid}.xml) and the version in effect on the 1st of the PRAC meeting month (DailyMed history + versioned zip) were parsed into LOINC sections; every passage mentioning the reaction or its synonyms/hypernyms/descriptions was read by the reviewer and judged.',
            'Four classes: written = Boxed Warning / Warnings and Precautions / Warnings / Precautions / Contraindications; partial = only Adverse Reactions, Postmarketing, Dosage tables, Use in Specific Populations (s8) or patient information; not found = not mentioned (or only as a symptom of another syndrome / pre-existing condition); not marketed = product not approved or not available in the U.S.',
            'The original keyword-rule program and the agent/model outputs were NOT used or read while labeling.'],
    sets=dict(set_1a_39=set1a, cross_class_answer_rows=ys),
    rows=out_rows, cross_class_questions=q2)
p = os.path.join(OUT, 'answer_key_v2_independent.json')
json.dump(key, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('sha256', hashlib.sha256(open(p, 'rb').read()).hexdigest())

# register file in the v1 schema with v2 statuses, for re-scoring with the existing a6_score.py
reg2 = json.loads(json.dumps(reg))
for q in reg2['questions']:
    for a in q['answer']:
        a['us_status'] = out_rows[a['id']]['status_current']
reg2['annotator'] = 'v2 independent AI reviewer (not a pharmacist); see answer_key_v2_independent.json'
json.dump(reg2, open(os.path.join(BASE, 'register_v2.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# comparisons
def cmp(ids, get_old):
    agree = [i for i in ids if get_old(i) == out_rows[i]['status_current']]
    diff = [(i, get_old(i), out_rows[i]['status_current']) for i in ids if get_old(i) != out_rows[i]['status_current']]
    return agree, diff
a1, d1 = cmp(set1a, lambda i: orig[i]['status'])
print(f'set 1a: {len(a1)}/{len(set1a)} agree')
for d in d1: print('  1a', d, out_rows[d[0]]['confidence'])
ay, dy = cmp(ys, lambda i: orig[i]['status'])
print(f'Y rows: {len(ay)}/{len(ys)} agree')
for d in dy: print('  Y', d, out_rows[d[0]]['confidence'])
cells = [(q['qid'], a) for q in reg['questions'] for a in q['answer']]
ok = sum(a['us_status'] == out_rows[a['id']]['status_current'] for _, a in cells)
print(f'register cells: {ok}/{len(cells)} agree')
print('v2 1a dist', collections.Counter(out_rows[i]['status_current'] for i in set1a))
print('v2 cells dist', collections.Counter(out_rows[a['id']]['status_current'] for _, a in cells))
print('v1 1a dist', collections.Counter(orig[i]['status'] for i in set1a))
