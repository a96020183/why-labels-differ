"""U.S. label sections for the set-1a scoreboard (sample/evidence/spl_section_score.csv, purpose = 'score').
One representative U.S. label per question: the same product the question text names (sample/scoreboard/set1a_questions.json).
Rows whose product is not marketed in the U.S. get no label rows, so the agents find nothing for them in Zetaris.
Source: DailyMed current SPL XML (cached by the v2 relabel download in the folder given as argv[1], or downloaded).
Only the set id per product is taken from scripts/v2_relabel/map.json; its search terms are NOT used.
Usage: python -I scripts/build_score_labels.py SPL_CACHE_DIR"""
import csv, json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('be', os.path.join(ROOT, 'scripts', 'spl_parse.py')); be = importlib.util.module_from_spec(spec); spec.loader.exec_module(be)
CACHE = sys.argv[1]
qs = json.load(open(os.path.join(ROOT, 'sample', 'scoreboard', 'set1a_questions.json'), encoding='utf-8'))['questions']
M = json.load(open(os.path.join(ROOT, 'scripts', 'v2_relabel', 'map.json'), encoding='utf-8'))
out, seen = [], set()
for q in qs:
    for name, setid in M.get(q['id'], {}).get('p', [])[:1]:
        if setid in seen:
            continue
        seen.add(setid)
        p = os.path.join(CACHE, f'{setid}_cur.xml')
        if not os.path.exists(p):
            open(p, 'wb').write(urllib.request.urlopen(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{setid}.xml', timeout=180).read())
        ver, eff, secs = be.spl_sections(p)
        for s in secs:
            out.append(dict(setid=setid, product=name, inn=q['inn'].split(';')[0].split(',')[0].replace(' and related substances', '').strip().lower(), purpose='score', version=ver,
                            effective=eff, published='', **s))
        print(q['id'], name, 'v' + ver, len(secs))
with open(os.path.join(ROOT, 'sample', 'evidence', 'spl_section_score.csv'), 'w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print('rows', len(out))
