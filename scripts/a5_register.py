"""A' gate A4: register the cross-class question set with answers and evidence, BEFORE any scan output is scored.
Each question: while processing row X, which EARLIER rows in a different ATC level-3 class carry the same reaction,
and what does each of their U.S. labels say (four classes) + any FDA AEMS listing for the reaction (2023 Q1-2026 Q2).
Writes out/register_cross_class.json and prints its SHA-256.
Usage: .venv/Scripts/python -I scripts/a5_register.py out/groups.json out/uslabel.json out/register_cross_class.json"""
import json, sys, io, hashlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = json.load(open(sys.argv[1], encoding='utf-8'))
U = json.load(open(sys.argv[2], encoding='utf-8'))
BATCH = 8
# hand overrides after reading the snippet (annotator note kept in the register)
OVERRIDE = {'R148': ('not found', 'only hit is high-altitude pulmonary edema as a disease context, not a drug-induced reaction')}
for rid, (st, why) in OVERRIDE.items():
    U['rows'][rid]['status'] = st; U['rows'][rid]['note'] = 'override: ' + why
qs = []
for q in G['questions']:
    xi = int(q['row'][1:]) - 1
    cross = []
    for c in q['cross_rows']:
        u = U['rows'][c['id']]
        ev = [dict(search=l['search'], setid=l.get('setid'), title=l.get('title'), published=l.get('published'), status=l['status'],
                   section=(l.get('hits') or [{}])[0].get('section'), snippet=(l.get('hits') or [{}])[0].get('snippet'), note=l.get('note'))
              for l in u.get('labels', [])]
        cross.append(dict(id=c['id'], substances=c['substances'][:6], atc3=c['atc3'], sig=c['sig'], us_status=u['status'],
                          note=u.get('note', ''), evidence=ev, same_batch=(int(c['id'][1:]) - 1) // BATCH == xi // BATCH))
    qs.append(dict(qid=q['qid'], row=q['row'], reaction=q['reaction'], sig=q['sig'], inn=q['inn'], atc3=q['atc3'],
                   answer=cross, aems=U['aems'].get(q['reaction'], [])[:6],
                   all_cross_in_same_batch=all(c['same_batch'] for c in cross)))
reg = dict(created='2026-10-23', rule='X counts if >=1 earlier row in the same reaction group shares no ATC level-3 code and no substance with X',
           n_questions=len(qs), n_groups=len({q['reaction'] for q in qs}),
           annotator='not a pharmacist; label status = DailyMed keyword hit + section title, hand-chosen labels', questions=qs)
b = json.dumps(reg, ensure_ascii=False, indent=1).encode('utf-8')
open(sys.argv[3], 'wb').write(b)
print('questions', len(qs), 'groups', reg['n_groups'], 'sha256', hashlib.sha256(b).hexdigest())
import collections
print('answer status counts (per cross row):', collections.Counter(c['us_status'] for q in qs for c in q['answer']))
print('questions whose cross rows are all in the same batch:', [q['qid'] for q in qs if q['all_cross_in_same_batch']])
for q in qs:
    print(q['qid'], q['row'], q['reaction'], '|', '; '.join(f"{c['id']} {c['substances'][0]} {c['us_status']} [{(c['evidence'] or [{}])[0].get('section') or c['note']}]" for c in q['answer']))
