"""A' day-one step 3 (gate A4): cross-class question set.
Reaction groups: the same adverse reaction recorded for different rows (strict synonyms only, listed below; no
broader/narrower merges such as 'vasculitis' vs 'cutaneous vasculitis').
A question = a row X that has at least one EARLIER row Y (scan order) in the same reaction group whose ATC level-3
set does not overlap X's and whose substances do not overlap X's. Such a Y cannot be reached by retrieval keyed on
ingredient or ATC level 3 -- that is checked here, not assumed.
Usage: .venv/Scripts/python -I scripts/a3_groups.py out/rows.json out/atc.json out/groups.json"""
import json, sys, io, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
rows = json.load(open(sys.argv[1], encoding='utf-8'))
atc = json.load(open(sys.argv[2], encoding='utf-8'))
for d in rows: d['atc3'] = atc['rows'][d['id']]

# key -> regex on the PRAC signal text (strict synonyms only)
KEYS = [
    ('DRESS', r'drug reaction with eosinophilia'),
    ('HLH', r'haemophagocytic lymphohistiocytosis'),
    ('anaphylaxis', r'^anaphylactic reaction$'),
    ('erythema multiforme', r'^erythema multiforme$'),
    ('PML', r'^progressive multifocal leukoencephalopathy'),
    ('sarcoidosis', r'^sarcoidosis$'),
    ('myasthenia gravis', r'^myasthenia gravis$'),
    ('cutaneous vasculitis', r'^cutaneous vasculitis$'),
    ('capillary leak syndrome', r'^capillary leak syndrome'),
    ('microscopic colitis', r'^(colitis microscopic|microscopic colitis)$'),
    ('colitis', r'^colitis$'),
    ('hyperammonaemia', r'^hyperammonaemia'),
    ('choroidal effusion', r'^choroidal effusion'),
    ('thrombotic microangiopathy', r'thrombotic microangiopathy$'),
    ('toxic epidermal necrolysis', r'^toxic epidermal necrolysis'),
    ('suppressed lactation', r'suppressed lactation$'),
    ('pulmonary oedema', r'^pulmonary oedema'),
    ('QT prolongation', r'qt prolongation'),
    ('tumour lysis syndrome', r'^tumour lysis syndrome'),
    ('meningioma', r'^meningioma$'),
    ('myocarditis/pericarditis', r'^myocarditis and pericarditis$'),
    ('embolic and thrombotic events', r'^embolic and thrombotic events$'),
    ('heavy menstrual bleeding', r'^heavy menstrual bleeding$'),
]
for d in rows:
    d['rkey'] = next((k for k, rx in KEYS if re.search(rx, d['sig'].lower())), None)
groups = collections.defaultdict(list)
for d in rows:
    if d['rkey']: groups[d['rkey']].append(d)
groups = {k: v for k, v in groups.items() if len(v) >= 2}

order = {d['id']: i for i, d in enumerate(rows)}
questions = []
for k, g in groups.items():
    for x in g:
        earlier = [y for y in g if order[y['id']] < order[x['id']]]
        cross = [y for y in earlier if not set(y['atc3']) & set(x['atc3']) and not set(y['substances']) & set(x['substances'])]
        same = [y for y in earlier if y not in cross]
        if cross:
            # retrieval check: rows an ingredient/ATC3 retriever would return for X (all earlier rows sharing either key)
            retr = {r['id'] for r in rows[:order[x['id']]] if set(r['atc3']) & set(x['atc3']) or set(r['substances']) & set(x['substances'])}
            assert not retr & {y['id'] for y in cross}
            questions.append(dict(qid=f"Q{len(questions) + 1:02d}", row=x['id'], reaction=k, sig=x['sig'], inn=x['inn'][:90], atc3=x['atc3'],
                                  cross_rows=[dict(id=y['id'], inn=y['inn'][:90], substances=y['substances'], atc3=y['atc3'], sig=y['sig'], yr=y['yr'], mo=y['mo']) for y in cross],
                                  same_class_earlier=[y['id'] for y in same]))
json.dump(dict(groups={k: [d['id'] for d in v] for k, v in groups.items()}, questions=questions,
               row_rkey={d['id']: d['rkey'] for d in rows}), open(sys.argv[3], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for k, g in groups.items():
    print(f'[{k}]', ' | '.join(f"{d['id']} {d['inn'][:28]} {','.join(d['atc3'][:4])}" for d in g))
print()
for q in questions:
    print(q['qid'], q['row'], q['reaction'], q['atc3'][:3], '<-', [(c['id'], c['atc3'][:3]) for c in q['cross_rows']])
print(len(questions), 'questions in', len({q['reaction'] for q in questions}), 'reaction groups')
