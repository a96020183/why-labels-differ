"""Which model actually answered each live call, by the lane the app asked for (runs/app_calls.jsonl), and which scope
header each was sent with. Writes the sentence between <!-- lanes --> markers in README.md.
Usage: python -I -X utf8 scripts/lane_counts.py"""
import collections, json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
calls = [json.loads(l) for l in open(os.path.join(ROOT, 'runs', 'app_calls.jsonl'), encoding='utf-8') if l.strip()]
by = collections.Counter((c['lane'], c['served'].split('/')[-1]) for c in calls)
served = collections.Counter(c['served'].split('/')[-1] for c in calls)
top, n = served.most_common(1)[0]
lanes = '; '.join(f"{lane} lane asked {sum(v for (l, _), v in by.items() if l == lane)}: " + ', '.join(f"{m} {v}" for (l, m), v in by.most_common() if l == lane) for lane in ('fast', 'deep'))
# before 2026-10-27 the log wrote the scope setting ("iso-<uuid>" literally, or "user"); since then it writes the header sent
sent = [c for c in calls if c.get('scope') and c['scope'] != 'iso-<uuid>' and c['at'] >= '2026-10-27T00:40']
scopes = collections.Counter('user' if c['scope'] == 'user' else 'iso-<uuid>' for c in sent)
text = (f"<!-- lanes -->Of the {len(calls)} live calls logged in `runs/app_calls.jsonl`, {n} were answered by {top}, whichever lane was asked ({lanes}). "
        f"The lanes are what the app requests; Nightshift routes, so in practice nearly every step was answered by the same model, and the trace records which one answered each step. "
        f"Scope header as sent, for the {len(sent)} calls logged since 2026-10-27 (earlier lines record the setting, not the header): {', '.join(f'{k} {v}' for k, v in scopes.most_common())}.<!-- /lanes -->")
p = os.path.join(ROOT, 'README.md'); s = open(p, encoding='utf-8').read()
if '<!-- lanes -->' not in s:
    raise SystemExit('README.md has no <!-- lanes --> marker')
open(p, 'w', encoding='utf-8').write(re.sub(r'<!-- lanes -->.*?<!-- /lanes -->', lambda m: text, s, flags=re.S))
print(text)
