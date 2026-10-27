"""Bring Postgres in line with sample/evidence without dropping tables (the Zetaris registrations stay): reg_doc and
reg_passage are upserted, spl_version is replaced.
Usage (from a_prime): .venv/Scripts/python -I -X utf8 scripts/load_new_evidence.py"""
import csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zhelp import psql
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = os.path.join(ROOT, 'sample', 'evidence')
pq = lambda v: "'" + str(v).replace("'", "''") + "'"
rows = lambda n: list(csv.DictReader(open(os.path.join(ev, n), encoding='utf-8')))
sql = []
for r in rows('reg_doc.csv'):
    sql.append(f"INSERT INTO reg_doc VALUES ({','.join(pq(r[k]) for k in ('doc_id', 'regulator', 'body', 'doc_type', 'authority', 'title', 'published', 'retrieved', 'url', 'scope', 'substances', 'reaction_key'))}) ON CONFLICT (doc_id) DO NOTHING;")
for r in rows('reg_passage.csv'):
    sql.append(f"INSERT INTO reg_passage VALUES ({pq(r['passage_id'])},{pq(r['doc_id'])},{pq(r['section'])},{pq(r['text'])}) ON CONFLICT (passage_id) DO UPDATE SET doc_id = EXCLUDED.doc_id, section = EXCLUDED.section, text = EXCLUDED.text;")
sql.append("DELETE FROM spl_version;")
for r in rows('spl_version.csv'):
    sql.append(f"INSERT INTO spl_version VALUES ({pq(r['setid'])},{pq(r['product'])},{pq(r['inn'])},{int(r['version'])},{pq(r['published'])});")
sql.append("SELECT count(*) FROM reg_doc; SELECT count(*) FROM reg_passage; SELECT count(*) FROM spl_version;")
print(psql('\n'.join(sql)))
