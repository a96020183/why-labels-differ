"""Compare each recorded question's final draft with the answer keys (U.S. label: out/answer_key_v2_independent.json;
EU, UK, FDA: out/why_key_independent_v2.json) and write the table into README.md between <!-- key-check --> markers.
A question whose PRAC row is not in the keys says so; a stage or status outside the allowed values counts as wrong. Usage (from a_prime): python -I scripts/key_check.py"""
import json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda p: json.load(open(os.path.join(ROOT, p), encoding='utf-8'))
qs = J('sample/questions.json')['questions']
lab = J('out/answer_key_v2_independent.json')['rows']
why = J('out/why_key_independent_v2.json')['rows']

STAGES = {'concluded', 'agreed_with_noted_conflict', 'under_evaluation', 'no_public_action_found', 'not_found_in_sources'}
STATUSES = {'written', 'partial', 'related_only', 'not found'}

def ours(col, v):
    v = (v or '').lower()
    # a value outside the allowed lists is not an answer: it never matches the key
    if v not in (STATUSES if col == 'us_label' else STAGES):
        return f'invalid value "{v}"'
    if col == 'us_label':
        return 'written' if v.startswith('written') else 'partial' if v.startswith('partial') else 'not found'  # related_only = not found
    if col == 'eu':
        return 'concluded' if re.match(r'concluded|agreed', v) else 'under_evaluation' if 'evaluation' in v else 'not_found'
    if col == 'uk':
        return 'drug_safety_update' if re.match(r'concluded|agreed|under', v) else 'no_public_communication_found'
    return 'concluded_label_updated' if v.startswith('concluded') else 'under_evaluation' if 'evaluation' in v else 'no_public_action_found'

rows = []
for q in qs:
    tr = [json.loads(l) for l in open(os.path.join(ROOT, 'docs', 'traces', q['id'] + '.jsonl'), encoding='utf-8')]
    d = [e for e in tr if e.get('kind') == 'draft'][-1]['detail']
    status = [e for e in tr if e.get('agent') == 'evaluator' and e.get('kind') in ('approve', 'escalate')][-1]['kind']
    r = q.get('prac_row')
    if not r or r not in lab or r not in why:
        rows.append(f"| {q['id']} | {'approved' if status == 'approve' else 'handed to a person'} | not in the keys (the keys cover the 39 PRAC signals of 2025-01 to 2026-09) | | | | {d['recommendation']['option']} |")
        continue
    cells = {'eu': d['cells']['EU'].get('stage'), 'uk': d['cells']['UK'].get('stage'), 'us_regulator': d['cells']['US_regulator'].get('stage'), 'us_label': d['cells']['US_label'].get('status')}
    key = {'eu': why[r]['eu']['label'], 'uk': why[r]['uk']['label'], 'us_regulator': why[r]['us_regulator']['label'], 'us_label': lab[r]['status_current']}
    mark = lambda c: f"{ours(c, cells[c])} {'✓' if ours(c, cells[c]) == key[c] else '✗ (key: ' + key[c] + ')'}"
    rows.append(f"| {q['id']} ({r}) | {'approved' if status == 'approve' else 'handed to a person'} | {mark('eu')} | {mark('uk')} | {mark('us_regulator')} | {mark('us_label')} | {d['recommendation']['option']} |")
table = ('<!-- key-check -->\n| Question | Outcome | EU | UK | U.S. FDA | U.S. label | Recommendation (not in the keys) |\n|---|---|---|---|---|---|---|\n'
         + '\n'.join(rows) + '\n<!-- /key-check -->')
p = os.path.join(ROOT, 'README.md'); s = open(p, encoding='utf-8').read()
s = re.sub(r'<!-- key-check -->.*?<!-- /key-check -->', lambda m: table, s, flags=re.S)
open(p, 'w', encoding='utf-8').write(s)
import sys; sys.stdout.reconfigure(encoding='utf-8'); print(table)
