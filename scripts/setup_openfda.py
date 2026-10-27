"""Register openFDA's drug label API as a Zetaris Lightning REST table, so the Skeptic can check the U.S. label column
against a second source (openFDA's own copy of each label) with a different query, through the same governed Zetaris door.
Table: aprime_openfda.label  (one REST call: the labels of the products the five questions read, by SPL set id)
Usage (from a_prime, Zetaris running): .venv/Scripts/python -I -X utf8 scripts/setup_openfda.py"""
import csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zhelp import step, zrun

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RA, RP = 'APRIME_AGENT', 'APRIME_PHARMACIST'
INNS = {'semaglutide', 'sertraline', 'fluoxetine', 'darolutamide', 'gemcitabine', 'valproate'}
setids = set()
for f in ('spl_section.csv', 'spl_section_score.csv'):
    for r in csv.DictReader(open(os.path.join(ROOT, 'sample', 'evidence', f), encoding='utf-8')):
        if r['inn'] in INNS and r['purpose'] in ('hero', 'score'):
            setids.add(r['setid'])
search = '+'.join(f'set_id:%22{s}%22' for s in sorted(setids))
url = f'https://api.fda.gov/drug/label.json?search={search}&limit=20'

step('DROP LIGHTNING DATABASE TABLE aprime_openfda.label', 'cleanup')
step('CREATE LIGHTNING DATABASE aprime_openfda DESCRIBE BY "openFDA_drug_label_API,REST"', 'lightning database aprime_openfda', must=True)
step(f'''CREATE LIGHTNING REST TABLE label FROM aprime_openfda REQUEST (
  endpoint "{url}", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER () BODY ()''', 'REST table aprime_openfda.label', must=True)
step('CACHE TABLE aprime_openfda.label', 'cache the REST response (one call)')
for role in (RA, RP):
    step(f"ASSIGN LIGHTNING DATABASE aprime_openfda TO ROLE '{role}'", f'lightning db aprime_openfda -> {role}')
    step(f"GRANT SELECT ON LIGHTNING DATABASE TABLE aprime_openfda.label TO ROLE '{role}'", f'grant aprime_openfda.label -> {role}')
ok, out, rec = zrun('SELECT r.set_id, r.version, r.effective_time, r.openfda.brand_name FROM aprime_openfda.label LATERAL VIEW explode(results) t AS r', 'check')
print(len(setids), 'set ids;', 'rows:', (out or {}).get('data') if ok else rec['error'])
