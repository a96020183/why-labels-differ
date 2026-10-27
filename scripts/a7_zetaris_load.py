"""A' gate A1 data: writes the three source files for the federated join (no secrets in them).
  data/zetaris_load/pharmacy.sql  -> MySQL 'pharmacy' (plays the hospital pharmacy system). 200 SYNTHETIC patients,
                                     generated here with a fixed seed (Synthea is not installed yet; labelled synthetic).
  data/zetaris_load/labels.sql    -> Postgres 'labels': PRAC rows (EU side) + per-row U.S. label status (from out/uslabel.json).
  data/zetaris_load/aems.csv      -> S3-compatible object store: FDA AEMS quarterly rows parsed from the saved pages.
Usage: .venv/Scripts/python -I scripts/a7_zetaris_load.py out/rows.json out/uslabel.json out/groups.json AEMS_DIR data/zetaris_load"""
import json, sys, os, random, re, glob, html, csv, datetime
ROWS, US, GR, AEMSD, OUT = sys.argv[1:6]
os.makedirs(OUT, exist_ok=True)
rows = json.load(open(ROWS, encoding='utf-8')); us = json.load(open(US, encoding='utf-8'))['rows']
rkey = json.load(open(GR, encoding='utf-8'))['row_rkey']
q = lambda s: "'" + str(s).replace("\\", "\\\\").replace("'", "''") + "'"

# 1. pharmacy (MySQL)
rnd = random.Random(20261023)
DRUGS = ['semaglutide', 'sertraline', 'paroxetine', 'mirtazapine', 'pantoprazole', 'gemcitabine', 'capecitabine', 'pirfenidone',
         'sulfamethoxazole', 'acetazolamide', 'labetalol', 'donepezil', 'pregabalin', 'bumetanide', 'methotrexate', 'regorafenib',
         'azacitidine', 'bosutinib', 'enzalutamide', 'abiraterone', 'oxacillin', 'cefotaxime', 'ethambutol', 'lisdexamfetamine']
DEPTS = ['endocrinology', 'psychiatry', 'oncology', 'infectious diseases', 'cardiology', 'neurology', 'pulmonology']
FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn']
LAST = ['Lee', 'Chen', 'Wang', 'Lin', 'Huang', 'Smith', 'Garcia', 'Kim', 'Patel', 'Nguyen']
base = datetime.date(2026, 10, 23)
lines = ["CREATE TABLE IF NOT EXISTS dispense (patient_id VARCHAR(12), patient_name VARCHAR(60), dept VARCHAR(40), inn VARCHAR(60), "
         "last_fill DATE, next_fill DATE, synthetic TINYINT);", "DELETE FROM dispense;"]
vals = []
for i in range(1, 201):
    pid = f'SYN{i:05d}'; name = f'{rnd.choice(FIRST)} {rnd.choice(LAST)} (synthetic)'
    for d in rnd.sample(DRUGS, rnd.choice([1, 1, 2, 3])):
        lf = base - datetime.timedelta(days=rnd.randint(1, 60))
        vals.append(f"({q(pid)},{q(name)},{q(rnd.choice(DEPTS))},{q(d)},'{lf}','{lf + datetime.timedelta(days=28)}',1)")
lines.append("INSERT INTO dispense VALUES\n" + ",\n".join(vals) + ";")
open(os.path.join(OUT, 'pharmacy.sql'), 'w', encoding='utf-8').write("\n".join(lines) + "\n")

# 2. labels (Postgres)
L = ["DROP TABLE IF EXISTS prac_signal, prac_substance, us_label;",
     "CREATE TABLE prac_signal (row_id text PRIMARY KEY, signal text, meeting text, yr int, mo int, reaction_group text);",
     "CREATE TABLE prac_substance (row_id text, substance text);",
     "CREATE TABLE us_label (row_id text, us_status text, label_name text, setid text, effective text, section text, auto_checked boolean);"]
for r in rows:
    L.append(f"INSERT INTO prac_signal VALUES ({q(r['id'])},{q(r['sig'])},{q(r['meeting'])},{r['yr']},{r['mo']},{q(rkey.get(r['id']) or '')});")
    for s in r['substances']: L.append(f"INSERT INTO prac_substance VALUES ({q(r['id'])},{q(s)});")
    u = us[r['id']]; lb = next((x for x in u.get('labels', []) if x['status'] == u['status']), {})
    L.append(f"INSERT INTO us_label VALUES ({q(r['id'])},{q(u['status'])},{q(lb.get('search', ''))},{q(lb.get('setid') or '')},"
             f"{q(lb.get('published') or '')},{q((lb.get('hits') or [{}])[0].get('section') or '')},{'true' if u.get('auto') else 'false'});")
open(os.path.join(OUT, 'labels.sql'), 'w', encoding='utf-8').write("\n".join(L) + "\n")

# 3. AEMS CSV (object store)
with open(os.path.join(OUT, 'aems.csv'), 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f); w.writerow(['quarter_page', 'products', 'term', 'row_text'])
    for p in sorted(glob.glob(os.path.join(AEMSD, '*.html'))):
        t = open(p, encoding='utf-8', errors='replace').read()
        for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', t, re.S | re.I):
            cells = [' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', c)).split()) for c in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S | re.I)]
            if len(cells) >= 2: w.writerow([os.path.basename(p)[:40], cells[0][:200], cells[1][:300], ' | '.join(cells)[:600]])
print('dispense rows', len(vals))
