"""A' gate A5 audit (no model calls): reads the replay caches of both systems and checks
  1. same call settings (stream, tier-split off, iso scope) and same batch size on every cached answer;
  2. opponent C never saw Markovian material: no Markovian markers in any C task, and every "ledger: {...}" embedded in a
     C task is C's own ledger line for that row (or empty);
  3. which models actually answered, latency, tries, skipped batches, estimated prompt size per call.
Usage: .venv/Scripts/python -I scripts/a5_audit.py runs/scan_M_b3 runs/scan_C_b3 out/ledger_M.json out/ledger_C.json > out/a5_audit.json"""
import json, sys, io, glob, os, re, statistics
from collections import Counter
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
dM, dC, lM, lC = sys.argv[1:5]
LM = json.load(open(lM, encoding='utf-8')); LC = json.load(open(lC, encoding='utf-8'))


def recs(d):
    out = []
    for f in sorted(glob.glob(os.path.join(d, '*.json'))):
        b = os.path.basename(f)
        if 'invalid' in b or b.startswith('_'): continue
        out.append((b, json.load(open(f, encoding='utf-8'))))
    return out


def summary(rs, led):
    lat = [r['latency'] for _, r in rs if r.get('latency')]
    return dict(answers=len(rs), served=dict(Counter(r.get('served') for _, r in rs)),
                calls=dict(Counter(json.dumps(r.get('call'), sort_keys=True) for _, r in rs)),
                tries=dict(Counter(r.get('tries') for _, r in rs)),
                latency_s=dict(median=statistics.median(lat), max=max(lat)) if lat else None,
                prompt_tokens_estimated=dict(median=statistics.median([r['promptTokensEstimated'] for _, r in rs]), max=max(r['promptTokensEstimated'] for _, r in rs)),
                batch=led.get('batch'), skipped=led.get('skipped', []), ledger_rows=len(led['ledger']))


RM, RC = recs(dM), recs(dC)
marker = re.compile(r'\[CARRYOVER STATE\]|\[STATE_CHECKPOINT\]|MEMORY FROM PREVIOUS NIGHT JOB|CONTEXT:')
leak_markers = [b for b, r in RC if marker.search(r.get('task', ''))]
mismatch = []
for b, r in RC:
    for m in re.finditer(r'^(R\d{3}) \|[^\n]*\| ledger: (\{.*\})$', r.get('task', ''), re.M):
        rid, emb = m.group(1), json.loads(m.group(2))
        if emb and emb != LC['ledger'].get(rid): mismatch.append((b, rid))
same_as_M = []  # any embedded ledger line that equals Markovian's line but not C's own
for b, r in RC:
    for m in re.finditer(r'^(R\d{3}) \|[^\n]*\| ledger: (\{.*\})$', r.get('task', ''), re.M):
        rid, emb = m.group(1), json.loads(m.group(2))
        if emb and emb == LM['ledger'].get(rid) and emb != LC['ledger'].get(rid): same_as_M.append((b, rid))
print(json.dumps(dict(M=summary(RM, LM), C=summary(RC, LC),
                      same_settings=summary(RM, LM)['calls'].keys() == summary(RC, LC)['calls'].keys() and LM.get('batch') == LC.get('batch'),
                      C_tasks_with_markovian_markers=leak_markers, C_embedded_lines_not_its_own=mismatch,
                      C_embedded_lines_equal_to_M_only=same_as_M), ensure_ascii=False, indent=1))
