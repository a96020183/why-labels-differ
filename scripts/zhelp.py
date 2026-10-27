"""Shared helpers for the setup scripts: .env loading, secret scrubbing, Zetaris REST calls (admin or another key),
the Zetaris UI/admin API, and docker-exec loaders for the local MySQL / Postgres containers. Nothing here prints a secret."""
import json, os, pathlib, subprocess, time, urllib.error, urllib.request, uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
PRIV = ROOT / 'data' / 'private'


def load_env():
    e = {}
    for p in (ROOT.parent / '.env', ROOT / '.env'):
        if p.exists():
            for ln in p.read_text(encoding='utf-8').splitlines():
                ln = ln.strip()
                if ln and not ln.startswith('#') and '=' in ln:
                    k, v = ln.split('=', 1); e[k.strip()] = v.strip().strip('"').strip("'")
    return e


E = load_env()
_rd = lambda n: (PRIV / n).read_text().strip() if (PRIV / n).exists() else ''
DBPW = _rd('db_password_PRIVATE.txt')  # empty on a clean clone (no live setup there)
S3SK = _rd('s3_secret_PRIVATE.txt')
SECRETS = [v for k, v in E.items() if any(t in k for t in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) and len(v) >= 6] + [x for x in (DBPW, S3SK) if x]
LOG = ROOT / 'runs' / 'zetaris_setup.jsonl'


def secret_file(name):
    p = PRIV / name
    return p.read_text().strip() if p.exists() else ''


def scrub(s):
    s = str(s)
    for v in SECRETS + [secret_file(n) for n in ('zetaris_agent_key_PRIVATE.txt', 'zetaris_pharmacist_key_PRIVATE.txt',
                                                  'zetaris_agent_password_PRIVATE.txt', 'zetaris_pharmacist_password_PRIVATE.txt')]:
        if v:
            s = s.replace(v, '<redacted>')
    return s


def zrun(sql, tag='', key=None, timeout=300, limit=5000):
    body = {'queryId': str(uuid.uuid4()), 'sql': sql, 'source': 'SqlEditor', 'limit': limit}
    req = urllib.request.Request(E['ZETARIS_REST_URL'].rstrip('/') + '/sql-editor/sqls/run', data=json.dumps(body).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + (key or E['ZETARIS_API_KEY']), 'X-Org-ID': E.get('ZETARIS_ORG_ID', '1'),
                                          'X-Request-ID': str(uuid.uuid4()), 'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out, err = json.loads(r.read().decode('utf-8')), None
    except urllib.error.HTTPError as e:
        out, err = None, f'HTTP {e.code} ' + e.read().decode('utf-8', 'replace')[:1500]
    except Exception as e:
        out, err = None, f'{type(e).__name__}: {e}'
    rec = dict(ts=time.strftime('%Y-%m-%dT%H:%M:%S'), tag=tag, sql=scrub(sql)[:3000], ok=err is None, secs=round(time.time() - t0, 2),
               error=scrub(err) if err else None)
    LOG.parent.mkdir(exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    return err is None, out, rec


def step(sql, tag='', must=False, key=None, quiet_exists=True):
    ok, out, rec = zrun(sql, tag, key)
    if not ok and quiet_exists and 'already' in (rec['error'] or '').lower():
        ok = True
    print(('ok   ' if ok else 'FAIL ') + (tag or sql.split('\n')[0][:100]), '' if ok else (rec['error'] or '')[:260], flush=True)
    if must and not ok:
        raise SystemExit('stop: ' + tag)
    return ok, out


def api(method, path, body=None, token=None):
    h = {'X-Org-ID': E.get('ZETARIS_ORG_ID', '1'), 'X-Request-ID': str(uuid.uuid4()), 'Content-Type': 'application/json',
         'Authorization': 'Bearer ' + (token or E['ZETARIS_API_KEY'])}
    req = urllib.request.Request(E['ZETARIS_REST_URL'].rstrip('/') + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(t) if t.strip().startswith(('{', '[')) else t)
    except urllib.error.HTTPError as e:
        return e.code, scrub(e.read().decode('utf-8', 'replace')[:600])


def mysql(sql_text):
    """run SQL in the aprime-mysql container (database 'pharmacy') as user aprime; password passed via the environment"""
    env = dict(os.environ, MYSQL_PWD=DBPW)
    r = subprocess.run(['docker', 'exec', '-i', '-e', 'MYSQL_PWD', 'aprime-mysql', 'mysql', '-uaprime', '--local-infile=0', 'pharmacy'],
                       input=sql_text.encode('utf-8'), capture_output=True, env=env)
    if r.returncode:
        raise SystemExit('mysql: ' + scrub(r.stderr.decode('utf-8', 'replace'))[:800])
    return r.stdout.decode('utf-8', 'replace')


def psql(sql_text):
    env = dict(os.environ, PGPASSWORD=DBPW)
    r = subprocess.run(['docker', 'exec', '-i', '-e', 'PGPASSWORD', 'aprime-pg', 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'aprime', '-d', 'labels'],
                       input=sql_text.encode('utf-8'), capture_output=True, env=env)
    if r.returncode:
        raise SystemExit('psql: ' + scrub(r.stderr.decode('utf-8', 'replace'))[:800])
    return r.stdout.decode('utf-8', 'replace')


def q(v):
    return 'NULL' if v is None else "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def pq(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"
