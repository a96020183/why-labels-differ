"""A' gate A5 interim score (while the scans still run): rebuilds both ledgers from the replay caches, keeps only the
registered questions whose row X has already been scanned by BOTH systems, and scores that subset with a6_score.py
(same V8 rule, same bootstrap). The sample size is in the output; this is not the final result.
Usage: .venv/Scripts/python -I scripts/a6_interim.py > out/score_interim.json"""
import json, glob, os, re, subprocess, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
B = int(os.environ.get('APRIME_BATCH', 3)); os.makedirs('out/interim', exist_ok=True)


def ledger(d):
    led = {}
    for f in sorted(glob.glob(f'runs/{d}/*.json')):
        b = os.path.basename(f)
        if 'invalid' in b or b.startswith('_') or 'compress' in b: continue
        for line in json.load(open(f, encoding='utf-8'))['text'].splitlines():
            if line.startswith('{"id"'):
                try: o = json.loads(line); led[o['id']] = o
                except ValueError: pass
    return led


LM, LC = ledger(f'scan_M_b{B}'), ledger(f'scan_C_b{B}')
for s, l in (('M', LM), ('C', LC)):
    json.dump(dict(system=s, batch=B, interim=True, ledger=l), open(f'out/interim/ledger_{s}.json', 'w', encoding='utf-8'))
key = json.load(open('out/answer_key_v2_independent.json', encoding='utf-8'))
both = [q for q in key['cross_class_questions'] if q['row'] in LM and q['row'] in LC]
key = dict(key, name=key['name'] + f' - interim subset, {len(both)} of {len(key["cross_class_questions"])} questions scanned by both', cross_class_questions=both)
json.dump(key, open('out/interim/answer_key_subset.json', 'w', encoding='utf-8'), ensure_ascii=False)
if not both:
    print(json.dumps(dict(interim=dict(rows_scanned_M=len(LM), rows_scanned_C=len(LC), questions_scored=0, questions_total=31)))); sys.exit()
out = subprocess.run([sys.executable, '-I', 'scripts/a6_score.py', 'out/interim/answer_key_subset.json', 'out/interim/ledger_M.json', 'out/interim/ledger_C.json'],
                     capture_output=True, text=True, encoding='utf-8', errors='replace')
if out.returncode: sys.exit(out.stderr)
res = json.loads(out.stdout)
res['interim'] = dict(rows_scanned_M=len(LM), rows_scanned_C=len(LC), questions_scored=len(both), questions_total=31)
print(json.dumps(res, ensure_ascii=False, indent=1))
