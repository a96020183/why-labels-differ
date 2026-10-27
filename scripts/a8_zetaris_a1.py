"""A' gate A1 on the local Zetaris (REST /sql-editor/sqls/run): one SQL across three systems.
  aprime_rx   : MySQL 8.4 container aprime-mysql (pharmacy.dispense, 200 synthetic patients)      -> C3
  aprime_lab  : Postgres 16 container aprime-pg (labels.prac_signal / prac_substance / us_label)  -> C2
  aprime_files: S3-compatible store (SeaweedFS container aprime-s3 with -s3.domainName=aprime-s3 and DNS alias aprime.aprime-s3,
                because Zetaris reaches the bucket virtual-host style; MinIO images could not be pulled on 2026-10-23),
                s3a://aprime/aems/aems.csv as a Lightning FILESTORE table                           -> C4
Then the A1 query and EXPLAIN QUERY (C8). Secrets come from ../.env and data/private/; every logged SQL/response is scrubbed.
Output: out/zetaris_a1.json; SQL log runs/zetaris_sql.jsonl.  Usage: .venv/Scripts/python -I scripts/a8_zetaris_a1.py"""
import json, time, uuid, pathlib, urllib.request, urllib.error, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parents[1]
E = {}
for ln in open(ROOT.parent / '.env', encoding='utf-8'):
    ln = ln.strip()
    if ln and not ln.startswith('#') and '=' in ln:
        k, v = ln.split('=', 1); E[k.strip()] = v.strip().strip('"').strip("'")
PW = (ROOT / 'data' / 'private' / 'db_password_PRIVATE.txt').read_text().strip()
S3SK = (ROOT / 'data' / 'private' / 's3_secret_PRIVATE.txt').read_text().strip()
SECRETS = [v for k, v in E.items() if any(t in k for t in ('KEY', 'TOKEN', 'PASSWORD')) and v] + [PW, S3SK]
LOG = ROOT / 'runs' / 'zetaris_sql.jsonl'


def scrub(s):
    s = str(s)
    for v in SECRETS: s = s.replace(v, '<redacted>')
    return s


def run(sql, tag, timeout=240):
    body = {'queryId': str(uuid.uuid4()), 'sql': sql, 'source': 'SqlEditor', 'limit': 1000}
    req = urllib.request.Request(E['ZETARIS_REST_URL'].rstrip('/') + '/sql-editor/sqls/run', data=json.dumps(body).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + E['ZETARIS_API_KEY'], 'X-Org-ID': E.get('ZETARIS_ORG_ID', '1'),
                                          'X-Request-ID': str(uuid.uuid4()), 'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: out = json.loads(r.read().decode('utf-8')); err = None
    except urllib.error.HTTPError as e:
        out, err = None, f'HTTP {e.code} ' + e.read().decode('utf-8', 'replace')[:1200]
    except Exception as e:
        out, err = None, f'{type(e).__name__}: {e}'
    rec = dict(ts=time.strftime('%Y-%m-%dT%H:%M:%S'), tag=tag, sql=scrub(sql), ok=err is None, secs=round(time.time() - t0, 1),
               error=scrub(err) if err else None, preview=scrub(json.dumps(out, ensure_ascii=False)[:1500]) if out else None)
    LOG.parent.mkdir(exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f: f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    print(('OK   ' if rec['ok'] else 'FAIL ') + tag, '' if rec['ok'] else (rec['error'] or '')[:300])
    return rec['ok'], out, rec


steps = []
def step(tag, sql, check=None):
    ok, out, rec = run(sql, tag)
    good = ok and (check(out) if check else True)
    steps.append(dict(step=tag, ok=bool(good), error=rec['error'], sql=rec['sql'][:900], data=(out or {}).get('data', [])[:12] if isinstance(out, dict) else None,
                      headers=(out or {}).get('headers') if isinstance(out, dict) else None, secs=rec['secs']))
    return good, out


for qq in ['DROP DATASOURCE aprime_rx', 'DROP DATASOURCE aprime_lab', 'DROP LIGHTNING DATABASE TABLE aprime_files.aems', 'DROP LIGHTNING DATABASE aprime_files']:
    run(qq, 'cleanup')

step('C3 CREATE DATASOURCE MySQL', f'''CREATE DATASOURCE aprime_rx DESCRIBE BY "A-prime hospital pharmacy system, MySQL, synthetic" OPTIONS (
  jdbcdriver "com.mysql.cj.jdbc.Driver", jdbcurl "jdbc:mysql://aprime-mysql:3306/pharmacy", username "aprime", password "{PW}", fetchsize "1000")''')
step('C3 REGISTER DATASOURCE TABLES MySQL', 'REGISTER DATASOURCE TABLES FROM aprime_rx')
step('C3 SELECT MySQL', 'SELECT count(*) AS n, count(DISTINCT patient_id) AS patients FROM aprime_rx.dispense', lambda o: str(o['data'][0][0]) == '346')
step('C2 CREATE DATASOURCE Postgres', f'''CREATE DATASOURCE aprime_lab DESCRIBE BY "A-prime EU and US label status, Postgres" OPTIONS (
  jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://aprime-pg:5432/labels", username "aprime", password "{PW}", fetchsize "1000")''')
step('C2 REGISTER DATASOURCE TABLES Postgres', 'REGISTER DATASOURCE TABLES FROM aprime_lab')
step('C2 SELECT Postgres', 'SELECT count(*) AS n FROM aprime_lab.prac_signal', lambda o: str(o['data'][0][0]) == '197')
step('C3 JOIN MySQL x Postgres', '''SELECT ps.substance, count(DISTINCT d.patient_id) AS patients
FROM aprime_rx.dispense d JOIN aprime_lab.prac_substance ps ON d.inn = ps.substance GROUP BY ps.substance ORDER BY patients DESC''',
     lambda o: len(o.get('data', [])) > 0)

step('C4 CREATE LIGHTNING DATABASE', 'CREATE LIGHTNING DATABASE aprime_files DESCRIBE BY "A-prime object-store files"')
VARIANTS = [
    ('s3Endpoint', '  s3Endpoint "http://aprime-s3:8333",'),
    ('endpoint + path.style.access', '  endpoint "http://aprime-s3:8333",\n  path.style.access "true",'),
    ('endpoint', '  endpoint "http://aprime-s3:8333",\n  pathStyleAccess "true",'),
    ('fs.s3a.endpoint', '  `fs.s3a.endpoint` "http://aprime-s3:8333",\n  `fs.s3a.path.style.access` "true",\n  `fs.s3a.connection.ssl.enabled` "false",'),
    ('awsEndpoint', '  awsEndpoint "http://aprime-s3:8333",\n  pathStyleAccess "true",'),
]
c4 = None
for name, extra in VARIANTS:
    run('DROP LIGHTNING DATABASE TABLE aprime_files.aems', 'cleanup')
    ok, _ = step(f'C4 CREATE FILESTORE TABLE ({name})', f'''CREATE LIGHTNING FILESTORE TABLE aems FROM aprime_files FORMAT CSV OPTIONS (
  path "s3a://aprime/aems/aems.csv",
  awsAccessKeyId "aprimekey",
  awsSecretAccessKey "{S3SK}",
{extra}
  header "true",
  delimiter ","
)''')
    if ok:
        ok2, _ = step(f'C4 SELECT FILESTORE ({name})', 'SELECT count(*) AS n FROM aprime_files.aems', lambda o: int(o['data'][0][0]) > 200)
        if ok2: c4 = name; break

A1 = '''SELECT s.row_id, s.signal, ps.substance, u.us_status, u.label_name,
       count(DISTINCT d.patient_id) AS patients_on_drug,
       count(DISTINCT a.row_text) AS fda_aems_rows_naming_drug
FROM aprime_rx.dispense d
JOIN aprime_lab.prac_substance ps ON d.inn = ps.substance
JOIN aprime_lab.prac_signal s ON s.row_id = ps.row_id
JOIN aprime_lab.us_label u ON u.row_id = s.row_id
LEFT JOIN aprime_files.aems a ON lower(a.products) LIKE concat('%', ps.substance, '%')
WHERE u.us_status IN ('not found', 'partial') AND u.auto_checked = false
GROUP BY s.row_id, s.signal, ps.substance, u.us_status, u.label_name
ORDER BY patients_on_drug DESC'''
if c4:
    step('A1 federated join MySQL x Postgres x object store', A1, lambda o: len(o.get('data', [])) > 0)
    step('C8 EXPLAIN QUERY', 'EXPLAIN QUERY AS ' + A1, lambda o: len(o.get('data', [])) > 0)
else:
    A1b = A1.replace("LEFT JOIN aprime_files.aems a ON lower(a.products) LIKE concat('%', ps.substance, '%')\n", '').replace(
        "count(DISTINCT a.row_text) AS fda_aems_rows_naming_drug", "0 AS fda_aems_rows_not_joined")
    step('A1 fallback: MySQL x Postgres only (object store not registered)', A1b, lambda o: len(o.get('data', [])) > 0)
    step('C8 EXPLAIN QUERY (fallback query)', 'EXPLAIN QUERY AS ' + A1b, lambda o: len(o.get('data', [])) > 0)
json.dump(dict(c4_variant=c4, steps=steps), open(ROOT / 'out' / 'zetaris_a1.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('done; object-store variant:', c4)
