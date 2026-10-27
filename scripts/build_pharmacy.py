"""Hospital pharmacy sample (MySQL 'pharmacy'): SYNTHETIC patients from Synthea, plus a documented prescription overlay.

Synthea (github.com/synthetichealth/synthea, master-branch-latest jar) was run with:
  java -jar synthea-with-dependencies.jar -s 20261024 -cs 20261024 -p 1000 --exporter.csv.export=true \
       --exporter.fhir.export=false --exporter.years_of_history=3 Massachusetts
Synthea's diabetes and mental-health modules predate GLP-1 receptor agonists, so the drugs this demo is about are added
by a seeded overlay rule (origin = 'overlay'). Drugs Synthea itself prescribed keep origin = 'synthea'.
Overlay rule (seed 20261024), applied to living adults only:
  semaglutide   active type 2 diabetes (any T2D condition)   40%;  obesity (BMI 30+) without T2D   8%
  sertraline    active severe anxiety, stress or social isolation finding   12%
  other demo drugs (the PRAC ledger's top rows)   2% of all living adults each, department picked from the drug
No real patient data is used anywhere. Names and ids are Synthea's synthetic ones.
Output: sample/pharmacy/patient.csv, sample/pharmacy/dispense.csv
Usage: python -I scripts/build_pharmacy.py SYNTHEA_CSV_DIR"""
import csv, datetime, os, random, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1]
OUT = os.path.join(ROOT, 'sample', 'pharmacy'); os.makedirs(OUT, exist_ok=True)
rnd = random.Random(20261024)
TODAY = datetime.date(2026, 10, 24)

pats = [r for r in csv.DictReader(open(os.path.join(SRC, 'patients.csv'), encoding='utf-8'))
        if not r['DEATHDATE'] and r['BIRTHDATE'] <= '2008-10-24']
alive = {p['Id'] for p in pats}
active = {}
for r in csv.DictReader(open(os.path.join(SRC, 'conditions.csv'), encoding='utf-8')):
    if r['PATIENT'] in alive and not r['STOP']:
        active.setdefault(r['PATIENT'], set()).add(r['DESCRIPTION'].lower())

# drugs Synthea itself prescribed (active, i.e. no STOP) that are on the PRAC list
PRAC_INN = {'sertraline', 'fluoxetine', 'metformin', 'insulin', 'pantoprazole', 'citalopram', 'escitalopram', 'paroxetine', 'gemcitabine',
            'capecitabine', 'methotrexate', 'prednisone', 'clopidogrel', 'atorvastatin', 'simvastatin', 'amlodipine', 'hydrochlorothiazide'}
rows = []
for r in csv.DictReader(open(os.path.join(SRC, 'medications.csv'), encoding='utf-8')):
    if r['PATIENT'] not in alive or r['STOP']:
        continue
    desc = r['DESCRIPTION'].lower()
    inn = next((d for d in PRAC_INN if d in desc), None)
    if inn:
        rows.append((r['PATIENT'], inn, r['DESCRIPTION'][:80], r['CODE'], 'synthea'))

def has(pid, *words):
    return any(any(w in c for w in words) for c in active.get(pid, ()))

OTHER = [('pantoprazole', 'gastroenterology'), ('pirfenidone', 'pulmonology'), ('sulfamethoxazole', 'infectious diseases'),
         ('acetazolamide', 'neurology'), ('mirtazapine', 'psychiatry'), ('abiraterone', 'oncology'), ('donepezil', 'neurology'),
         ('regorafenib', 'oncology'), ('gemcitabine', 'oncology'), ('enzalutamide', 'oncology'), ('pregabalin', 'pain clinic'),
         ('darolutamide', 'oncology'), ('osimertinib', 'oncology'), ('vortioxetine', 'psychiatry'), ('clozapine', 'psychiatry')]
DEPT = {'semaglutide': 'endocrinology', 'sertraline': 'psychiatry', 'fluoxetine': 'psychiatry', 'metformin': 'endocrinology', 'insulin': 'endocrinology'}
for p in pats:
    pid = p['Id']
    if has(pid, 'diabetes mellitus type 2', 'type 2 diabetes'):
        if rnd.random() < 0.40: rows.append((pid, 'semaglutide', 'Ozempic (semaglutide) injection', '1991302', 'overlay'))
    elif has(pid, 'body mass index 30+'):
        if rnd.random() < 0.08: rows.append((pid, 'semaglutide', 'Wegovy (semaglutide) injection', '2553501', 'overlay'))
    if has(pid, 'severe anxiety', 'stress (finding)', 'social isolation') and rnd.random() < 0.12:
        rows.append((pid, 'sertraline', 'Zoloft (sertraline) tablet', '312940', 'overlay'))
    for inn, _ in OTHER:
        if rnd.random() < 0.02:
            rows.append((pid, inn, inn, '', 'overlay'))

seen, disp = set(), []
for pid, inn, product, code, origin in rows:
    if (pid, inn) in seen:
        continue
    seen.add((pid, inn))
    last = TODAY - datetime.timedelta(days=rnd.randint(1, 27))
    days = 28 if inn in ('semaglutide',) else 30
    dept = DEPT.get(inn) or dict(OTHER).get(inn) or 'internal medicine'
    disp.append(dict(dispense_id=len(disp) + 1, patient_id=pid, inn=inn, product=product, rxnorm=code, dept=dept,
                     last_fill=last.isoformat(), next_fill=(last + datetime.timedelta(days=days)).isoformat(), origin=origin))

ids = {d['patient_id'] for d in disp}
with open(os.path.join(OUT, 'patient.csv'), 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f); w.writerow(['patient_id', 'mrn', 'display_name', 'birth_year', 'sex', 'synthetic'])
    for i, p in enumerate(sorted(pats, key=lambda p: p['Id'])):
        if p['Id'] in ids:
            w.writerow([p['Id'], f'SYN-{100000 + i}', f"{p['FIRST']} {p['LAST']}", p['BIRTHDATE'][:4], p['GENDER'], 1])
with open(os.path.join(OUT, 'dispense.csv'), 'w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(disp[0].keys())); w.writeheader(); w.writerows(disp)
from collections import Counter
c = Counter(d['inn'] for d in disp)
print('patients with a dispense:', len(ids), 'dispense rows:', len(disp))
print({k: c[k] for k in ('semaglutide', 'sertraline', 'darolutamide', 'pantoprazole', 'metformin')})
