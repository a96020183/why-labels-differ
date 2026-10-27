"""A loop run stopped before its 10 questions writes no result file (app/scoreloop.ts writes it at the end), but it keeps
each finished question's trace. This rebuilds the result of the finished questions from those traces, marked incomplete.
Usage: python -I scripts/loop_partial.py <label>   (reads out/set1a_loop_<label>_traces/, writes out/set1a_loop_<label>_partial.json)"""
import json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
label = sys.argv[1]
tdir = os.path.join(ROOT, 'out', f'set1a_loop_{label}_traces')
out = os.path.join(ROOT, 'out', f'set1a_loop_{label}_partial.json')
if os.path.exists(out):
    raise SystemExit(f'{out} exists: never overwritten')
qs = json.load(open(os.path.join(ROOT, 'sample', 'scoreboard', 'set1a_questions.json'), encoding='utf-8'))['questions']
ids = [q['id'] for q in qs if q.get('product')][:10]
status = lambda s: 'written' if re.match(r'written', s, re.I) else 'partial' if re.match(r'partial', s, re.I) else 'not found' if re.match(r'related.?only|not.?found', s, re.I) else 'no answer'
answers = []
for i in ids:
    p = os.path.join(tdir, f'{i}.jsonl')
    if not os.path.exists(p):
        continue
    ev = [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
    draft = [e for e in ev if e.get('agent') == 'writer' and e.get('kind') == 'draft'][-1]['detail']
    last = [e for e in ev if e.get('agent') == 'evaluator' and e.get('kind') in ('approve', 'reject')][-1]
    cell = draft['cells']['US_label']
    read = any(re.match(r'^SPL-|^US-LABELS-SEARCHED$', c) for c in cell.get('cites', []))
    answers.append(dict(id=i, us_status=status(str(cell.get('status') or '')) if read else 'no answer', read_label=read, raw_status=cell.get('status'), finding=cell.get('finding'), cites=cell.get('cites'),
                        outcome='approved' if last['kind'] == 'approve' else 'needs-person', rounds=last.get('round'), modelCalls=sum(1 for e in ev if e.get('kind') == 'model')))
json.dump(dict(arm='Full multi-agent loop (Planner, Research, chronology, Skeptic, Writer, Evaluator; up to two rounds of search, then up to three repair drafts)', ids=ids, label=label,
               selection='the first 10 set-1a questions with a named U.S. product, in file order, fixed before any run', complete=False,
               note=f'stopped before all 10 questions finished; {len(answers)} finished, rebuilt from their traces by scripts/loop_partial.py', traces=f'out/set1a_loop_{label}_traces/',
               run_at='2026-10-27', answers=answers), open(out, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print(out, len(answers), 'finished')
