"""Load the sample into the three local systems and register them in the local Zetaris, with governance.

  MySQL    aprime-mysql  pharmacy.patient, pharmacy.dispense          (sample/pharmacy, Synthea + overlay, synthetic)
  Postgres aprime-pg     labels.prac_signal / prac_substance / us_label  (PRAC catalogue rows + keyword pre-screen)
                         labels.reg_doc / reg_passage / spl_section / spl_version  (sample/evidence)
                         labels.pt_decision / reopen_condition       (written by the committee through the app)
  S3       aprime-s3     s3a://aprime/evidence/aems.csv, sentinel.csv  (SeaweedFS, S3-compatible)
Zetaris:
  datasources aprime_rx (MySQL), aprime_lab (Postgres); lightning database aprime_files (filestore tables aems, sentinel)
  schemastore container aprime_views: view rx_counts (aggregate only), view patient_list (joins the committee decision)
  role APRIME_AGENT  (user agent@aprime.local):      evidence tables + rx_counts; pharmacy tables with patient columns MASKED;
                                                      no grant on patient_list
  role APRIME_PHARMACIST (user pharmacist@aprime.local): patient_list, pharmacy tables unmasked, evidence tables
  API keys for both users -> data/private/*_PRIVATE.txt (never printed)
Usage: .venv/Scripts/python -I scripts/setup_zetaris.py [--skip-load] [--check]"""
import csv, datetime, json, secrets, sys, io, urllib.request, urllib.error
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from zhelp import ROOT, PRIV, E, DBPW, S3SK, step, zrun, api, mysql, psql, q, pq, secret_file, scrub
import importlib.util

SAMPLE = ROOT / 'sample'
AGENT, PHARM = 'agent@aprime.local', 'pharmacist@aprime.local'
RA, RP = 'APRIME_AGENT', 'APRIME_PHARMACIST'


def rows(p):
    return list(csv.DictReader(open(p, encoding='utf-8')))


def load_mysql():
    pts, disp = rows(SAMPLE / 'pharmacy' / 'patient.csv'), rows(SAMPLE / 'pharmacy' / 'dispense.csv')
    sql = ["DROP TABLE IF EXISTS dispense; DROP TABLE IF EXISTS patient;",
           "CREATE TABLE patient (patient_id VARCHAR(40) PRIMARY KEY, mrn VARCHAR(16), display_name VARCHAR(80), birth_year INT, sex CHAR(1), synthetic TINYINT);",
           "CREATE TABLE dispense (dispense_id INT PRIMARY KEY, patient_id VARCHAR(40), inn VARCHAR(60), product VARCHAR(90), rxnorm VARCHAR(16), dept VARCHAR(40), "
           "last_fill DATE, next_fill DATE, origin VARCHAR(12), INDEX(inn));"]
    sql.append('INSERT INTO patient VALUES ' + ','.join(f"({q(p['patient_id'])},{q(p['mrn'])},{q(p['display_name'])},{int(p['birth_year'])},{q(p['sex'])},1)" for p in pts) + ';')
    sql.append('INSERT INTO dispense VALUES ' + ','.join(
        f"({d['dispense_id']},{q(d['patient_id'])},{q(d['inn'])},{q(d['product'])},{q(d['rxnorm'])},{q(d['dept'])},{q(d['last_fill'])},{q(d['next_fill'])},{q(d['origin'])})" for d in disp) + ';')
    mysql('\n'.join(sql))
    mysql("CREATE OR REPLACE VIEW rx_patients AS SELECT inn, dept, count(DISTINCT patient_id) AS patients, min(next_fill) AS earliest_next_fill FROM dispense GROUP BY inn, dept;")  # people, counted inside MySQL so the agent role's mask on patient_id cannot touch it
    print('mysql: patient', len(pts), 'dispense', len(disp))


def load_pg():
    ev = SAMPLE / 'evidence'
    sql = ["DROP TABLE IF EXISTS reg_doc, reg_passage, spl_section, spl_version, pt_decision, reopen_condition;",
           "CREATE TABLE reg_doc (doc_id text PRIMARY KEY, regulator text, body text, doc_type text, authority text, title text, published text, retrieved text, url text, scope text, substances text, reaction_key text);",
           "CREATE TABLE reg_passage (passage_id text PRIMARY KEY, doc_id text, section text, text text);",
           "CREATE TABLE spl_section (setid text, product text, inn text, purpose text, version int, effective text, published text, sec_code text, sec_title text, path text, text text);",
           "CREATE TABLE spl_version (setid text, product text, inn text, version int, published text);",
           "CREATE TABLE pt_decision (decision_id text PRIMARY KEY, substance text, reaction text, decision text, decided_by text, decided_at text, rationale text, evidence_run text);",
           "CREATE TABLE reopen_condition (cond_id text PRIMARY KEY, decision_id text, kind text, description text, watch_sql text, status text, checked_at text, fired_at text);"]
    for r in rows(ev / 'reg_doc.csv'):
        sql.append(f"INSERT INTO reg_doc VALUES ({','.join(pq(r[k]) for k in ('doc_id', 'regulator', 'body', 'doc_type', 'authority', 'title', 'published', 'retrieved', 'url', 'scope', 'substances', 'reaction_key'))});")
    for r in rows(ev / 'reg_passage.csv'):
        sql.append(f"INSERT INTO reg_passage VALUES ({pq(r['passage_id'])},{pq(r['doc_id'])},{pq(r['section'])},{pq(r['text'])});")
    secs = rows(ev / 'spl_section.csv') + (rows(ev / 'spl_section_score.csv') if (ev / 'spl_section_score.csv').exists() else [])
    for r in secs:
        sql.append(f"INSERT INTO spl_section VALUES ({pq(r['setid'])},{pq(r['product'])},{pq(r['inn'])},{pq(r['purpose'])},{int(r['version'])},{pq(r['effective'])},{pq(r['published'])},"
                   f"{pq(r['sec_code'])},{pq(r['sec_title'])},{pq(r['path'])},{pq(r['text'])});")
    for r in rows(ev / 'spl_version.csv'):
        sql.append(f"INSERT INTO spl_version VALUES ({pq(r['setid'])},{pq(r['product'])},{pq(r['inn'])},{int(r['version'])},{pq(r['published'])});")
    psql('\n'.join(sql))
    print('postgres: reg_doc/reg_passage/spl_section/spl_version loaded;', len(secs), 'label sections')


def load_s3():
    spec = importlib.util.spec_from_file_location('s3', str(ROOT / 'scripts' / 's3lib.py'))
    s3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(s3)
    for name in ('aems.csv', 'sentinel.csv'):
        print('s3', name, s3.put('http://127.0.0.1:58333', 'aprime', 'evidence/' + name, (SAMPLE / 'evidence' / name).read_bytes()))


def register():
    for x in ['DROP SCHEMASTORE VIEW rx_counts FROM aprime_views', 'DROP SCHEMASTORE VIEW patient_list FROM aprime_views',
              'DROP DATASOURCE aprime_rx', 'DROP DATASOURCE aprime_lab', 'DROP LIGHTNING DATABASE TABLE aprime_files.aems',
              'DROP LIGHTNING DATABASE TABLE aprime_files.sentinel', 'DROP LIGHTNING DATABASE aprime_files']:
        zrun(x, 'cleanup')
    step(f'''CREATE DATASOURCE aprime_rx DESCRIBE BY "Hospital_pharmacy_system,MySQL,synthetic_patients_Synthea" OPTIONS (
  jdbcdriver "com.mysql.cj.jdbc.Driver", jdbcurl "jdbc:mysql://aprime-mysql:3306/pharmacy", username "aprime", password "{DBPW}", fetchsize "1000")''', 'datasource aprime_rx (MySQL)', must=True)
    step('REGISTER DATASOURCE TABLES FROM aprime_rx', 'register MySQL tables', must=True)
    step(f'''CREATE DATASOURCE aprime_lab DESCRIBE BY "EU,UK,US_regulatory_records_and_label_sections,Postgres" OPTIONS (
  jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://aprime-pg:5432/labels", username "aprime", password "{DBPW}", fetchsize "1000")''', 'datasource aprime_lab (Postgres)', must=True)
    step('REGISTER DATASOURCE TABLES FROM aprime_lab', 'register Postgres tables', must=True)
    step('CREATE LIGHTNING DATABASE aprime_files DESCRIBE BY "FDA_AEMS_potential-signal_lists,Sentinel_study_status,S3"', 'lightning database aprime_files', must=True)
    for t in ('aems', 'sentinel'):
        step(f'''CREATE LIGHTNING FILESTORE TABLE {t} FROM aprime_files FORMAT CSV OPTIONS (
  path "s3a://aprime/evidence/{t}.csv", awsAccessKeyId "aprimekey", awsSecretAccessKey "{S3SK}", s3Endpoint "http://aprime-s3:8333",
  header "true", delimiter ",", quote '"', escape '"', multiLine "true")''', f'filestore table {t} (S3)', must=True)
    step('CREATE SCHEMASTORE CONTAINER aprime_views', 'schemastore container aprime_views')
    step('''CREATE SCHEMASTORE VIEW rx_counts WITH CONTAINER aprime_views AS
SELECT inn, dept, patients, earliest_next_fill FROM aprime_rx.rx_patients''', 'view rx_counts (aggregate only)', must=True)
    step('''CREATE SCHEMASTORE VIEW patient_list WITH CONTAINER aprime_views AS
SELECT p.mrn, p.display_name, d.dept, d.inn, d.product, d.next_fill, c.decision_id, c.reaction
FROM aprime_rx.dispense d JOIN aprime_rx.patient p ON p.patient_id = d.patient_id
JOIN aprime_lab.pt_decision c ON c.substance = d.inn AND c.decision = 'propose' ''', 'view patient_list (joins the committee decision)', must=True)


def user(email, role, desc, pwfile, keyfile, keyname):
    pwf = PRIV / pwfile
    if not pwf.exists():
        pwf.write_text('Aa1!' + ''.join(secrets.choice('abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(20)))
    pw = pwf.read_text().strip()
    step(f"CREATE ROLE '{role}' DESCRIBE BY '{desc}'", f'role {role}')
    st, out = api('POST', '/users', {'email': email, 'name': desc, 'level': 'GENERAL', 'password': pw, 'isLdap': False, 'status': 'Active'})
    print('user', email, st, '' if st < 300 or 'exist' in str(out).lower() else str(out)[:200])
    step(f"ASSIGN USER '{email}' TO ROLE '{role}'", f'assign {email}')
    step(f"ASSIGN DATASOURCE aprime_rx, aprime_lab TO ROLE '{role}'", f'datasources to {role}')
    step(f"ASSIGN LIGHTNING DATABASE aprime_files TO ROLE '{role}'", f'lightning db to {role}')
    kf = PRIV / keyfile
    if not kf.exists():
        req = urllib.request.Request('http://localhost:3000/api/auth/login', data=json.dumps({'username': email, 'password': pw}).encode(), method='POST',
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                tok = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            tok = {'_error': e.code}
        token = next((tok[k] for k in ('idToken', 'token', 'accessToken', 'access_token') if isinstance(tok.get(k), str)), None)
        if token:
            exp = (datetime.datetime.utcnow() + datetime.timedelta(days=30)).replace(microsecond=0).isoformat() + '.000Z'
            st, k = api('POST', '/auth/api-key', {'name': keyname, 'expiryDate': exp}, token=token)
            key = next((k[x] for x in ('apiKey', 'key', 'token', 'value') if isinstance(k, dict) and isinstance(k.get(x), str)), None)
            if key:
                kf.write_text(key); print('api key for', email, 'saved')
            else:
                print('api key FAIL', st)
        else:
            print('login FAIL', sorted(tok.keys()))


def field(name, regex=None):
    meta = {'filter': '', 'options': [{'key': 'regex', 'value': regex}] if regex else [], 'policy': 'masked' if regex else 'grant', 'policy_source': 'user_defined'}
    return {'name': name, 'isNullable': True, 'dataType': {'json': '"string"', 'simpleString': 'string', 'typeName': 'string'}, 'metadata': meta}


def governance():
    user(AGENT, RA, 'A-prime_agents,patient_columns_masked', 'zetaris_agent_password_PRIVATE.txt', 'zetaris_agent_key_PRIVATE.txt', 'aprime-agents')
    user(PHARM, RP, 'A-prime_pharmacist,full_patient_access', 'zetaris_pharmacist_password_PRIVATE.txt', 'zetaris_pharmacist_key_PRIVATE.txt', 'aprime-pharmacist')
    evidence = ['aprime_lab.prac_signal', 'aprime_lab.prac_substance', 'aprime_lab.us_label', 'aprime_lab.reg_doc', 'aprime_lab.reg_passage',
                'aprime_lab.spl_section', 'aprime_lab.spl_version', 'aprime_lab.pt_decision', 'aprime_lab.reopen_condition']
    for role in (RA, RP):
        for t in evidence + ['aprime_rx.dispense', 'aprime_rx.patient', 'aprime_rx.rx_patients']:
            step(f"GRANT SELECT ON DATASOURCE TABLE {t} TO ROLE '{role}'", f'grant {t} -> {role}')
        for t in ('aprime_files.aems', 'aprime_files.sentinel'):
            step(f"GRANT SELECT ON LIGHTNING DATABASE TABLE {t} TO ROLE '{role}'", f'grant {t} -> {role}')
    step(f"GRANT SELECT ON VIEW TABLE aprime_views.rx_counts TO ROLE '{RA}'", 'grant rx_counts -> agent')
    step(f"GRANT SELECT ON VIEW TABLE aprime_views.rx_counts TO ROLE '{RP}'", 'grant rx_counts -> pharmacist')
    step(f"GRANT SELECT ON VIEW TABLE aprime_views.patient_list TO ROLE '{RP}'", 'grant patient_list -> pharmacist ONLY')
    for t in ('aprime_lab.pt_decision', 'aprime_lab.reopen_condition'):
        step(f"GRANT INSERT ON DATASOURCE TABLE {t} TO ROLE '{RP}'", f'grant INSERT {t} -> pharmacist ONLY (the committee writes decisions; agents cannot)')
    # column policy: the agents' role sees patient identifiers masked by Zetaris itself
    MASK = '[A-Za-z0-9]'
    for table, masked in {'dispense': {'patient_id': MASK}, 'patient': {'patient_id': MASK, 'mrn': MASK, 'display_name': MASK}}.items():
        ok, out = zrun(f'DESCRIBE DATASOURCE TABLE aprime_rx.{table}', 'describe')[:2]
        cols = [r[0] for r in (out or {}).get('data', [])]
        st, cur = api('GET', f'/access-control/cbac/generic/datasource/aprime_rx/{table}')
        base = cur if isinstance(cur, dict) else {}
        body = {**base, 'id': f'aprime_rx.{table}', 'partitionColumns': base.get('partitionColumns', []), 'version': base.get('version', 0),
                'users': [{'username': AGENT, 'roleSelected': RA.lower(), 'userLevelPolicy': 'patient_ids_masked'}],
                'roles': [{'roleName': RA.lower(), 'policy': 'patient_ids_masked'}],
                'policies': [{'policyName': 'patient_ids_masked', 'filter': '', 'fields': [field(c, masked.get(c)) for c in cols]}]}
        st, out = api('POST', f'/access-control/cbac/generic/datasource/aprime_rx/{table}', body)
        print('column policy aprime_rx.' + table, st, '' if st < 300 else out)


def check():
    ka, kp = secret_file('zetaris_agent_key_PRIVATE.txt'), secret_file('zetaris_pharmacist_key_PRIVATE.txt')
    res = {}
    tests = [('agent: pharmacy rows', ka, "SELECT patient_id, inn, dept, next_fill FROM aprime_rx.dispense WHERE inn = 'semaglutide' ORDER BY next_fill LIMIT 3"),
             ('pharmacist: pharmacy rows', kp, "SELECT patient_id, inn, dept, next_fill FROM aprime_rx.dispense WHERE inn = 'semaglutide' ORDER BY next_fill LIMIT 3"),
             ('agent: aggregate view', ka, "SELECT inn, sum(patients) AS patients FROM aprime_views.rx_counts WHERE inn IN ('semaglutide','sertraline') GROUP BY inn"),
             ('agent: patient list view', ka, 'SELECT count(*) FROM aprime_views.patient_list'),
             ('pharmacist: patient list view', kp, 'SELECT count(*) FROM aprime_views.patient_list'),
             ('agent: S3 sentinel', ka, 'SELECT study_id, status, snapshot FROM aprime_files.sentinel'),
             ('agent: S3 aems', ka, "SELECT quarter, term FROM aprime_files.aems WHERE lower(products) LIKE '%semaglutide%'")]
    for name, key, sql in tests:
        ok, out, rec = zrun(sql, 'check ' + name, key=key)
        res[name] = (out or {}).get('data') if ok else 'ERROR ' + (rec['error'] or '')[:200]
        print(name, '->', str(res[name])[:300])
    json.dump(res, open(ROOT / 'out' / 'zetaris_governance_check.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    if '--check' not in sys.argv:
        if '--skip-load' not in sys.argv:
            load_mysql(); load_pg(); load_s3()
        register(); governance()
    check()
