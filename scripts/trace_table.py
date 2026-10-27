"""Rebuild the trace-statistics table in README.md from docs/traces/*.stats.json (written by
`APRIME_TRACE_OUT=docs/traces node app/cli.ts <question> propose`). Usage: python -I scripts/trace_table.py"""
import json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QS = ['semaglutide-naion', 'sertraline-pssd', 'darolutamide-angioedema', 'gemcitabine-dress', 'valproate-paternal']
rows = []
for q in QS:
    x = json.load(open(os.path.join(ROOT, 'docs', 'traces', q + '.stats.json'), encoding='utf-8'))
    rows.append(f"| {q} | {x['status']} after {x['rounds']} | {x['modelCalls']} | {x['rejectionsByModel']} | {x['rejectionsByChecks']} | {x['rejectionsByBoth']} | {x['checksOverruledByModel']} | {x['planRevisions']} | {x.get('repairs', 0)} ({x.get('disputesVerified', 0)} disputes verified, {x.get('disputesRefused', 0)} refused) | {x['escalations']} | {x['hypothesesConsidered']} | {x['skepticVerified']} of {x['skepticRecordsChecked']} re-fetched records held ({x.get('skepticUnchecked', 0)} had no independent query) · {x['skepticContradicted']} records and {x['skepticClaimsContradicted']} claims contradicted | {x['openFdaAgree']} agree · {x['openFdaContradict']} contradict · {x['openFdaOtherVersion']} other version | {x.get('sqlBeforeVote', '?')} / {x['sqlQueries']} |")
table = ('<!-- trace-stats -->\n| Question | Outcome | Model calls | Sent back by the model only | by code checks only | by both | Checks overruled by the model | Plan revisions | Repair drafts | Escalations | Hypotheses | Skeptic (own tables + Nemotron) | Label vs openFDA | SQL queries (before the vote / whole trace) |\n'
         '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n' + '\n'.join(rows) + '\n<!-- /trace-stats -->')
# why each question ended where it did, from its own trace (the last Evaluator decision and its open items)
def short(t, n=300):
    # whole sentences where they fit, never a cut in the middle of a word
    t = str(t).replace(chr(10), ' ')
    if len(t) <= n: return t
    k = t.rfind('. ', 0, n)
    return t[:k + 1] + ' …' if k > n // 3 else t[:t.rfind(' ', 0, n)] + ' …'
why_rows = []
for q in QS:
    evs = [json.loads(l) for l in open(os.path.join(ROOT, 'docs', 'traces', q + '.jsonl'), encoding='utf-8')]
    last = [e for e in evs if e.get('agent') == 'evaluator' and e.get('kind') in ('approve', 'reject')][-1]
    d = last.get('detail') or {}
    if last['kind'] == 'approve':
        over = [r.get('reason', '') for r in (d.get('reply') or []) if not r.get('accept')]
        txt = f"approved in round {last['round']} (decided by: {d.get('decidedBy')})" + (f"; coverage checks overruled with a reason: {' | '.join(short(o, 200) for o in over)}" if over else '')
    else:
        items = [('must hold: ' if g.get('hard') else 'coverage: ') + short(g['problem']) for g in (d.get('hard') or []) + (d.get('soft') or [])]
        txt = f"handed to a person after round {last['round']} (decided by: {d.get('decidedBy')}). Open items: " + ' | '.join(items) + (f" | Evaluator: {short(d.get('modelFeedback',''))}" if d.get('modelFeedback') else '')
    why_rows.append(f"- **{q}**: {txt.replace(chr(10), ' ')}")
why = '<!-- outcome-reasons -->\n' + '\n'.join(why_rows) + '\n<!-- /outcome-reasons -->'
p = os.path.join(ROOT, 'README.md'); s = open(p, encoding='utf-8').read()
s = re.sub(r'<!-- outcome-reasons -->.*?<!-- /outcome-reasons -->', lambda m: why, s, flags=re.S)
s = re.sub(r'<!-- trace-stats -->.*?<!-- /trace-stats -->', lambda m: table, s, flags=re.S)
open(p, 'w', encoding='utf-8').write(s)
print(table)
