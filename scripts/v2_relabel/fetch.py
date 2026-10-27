"""Download current SPL XML and the version in effect on each row's PRAC month (DailyMed). Cache in dl/."""
import json, sys, os, io, zipfile, urllib.request, datetime, time
sys.stdout.reconfigure(encoding='utf-8')
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DL = os.path.join(BASE, 'dl')
M = json.load(open(os.path.join(BASE, 'map.json'), encoding='utf-8'))
ROWS = {r['id']: r for r in json.load(open(sys.argv[1], encoding='utf-8'))}


def get(u):
    for i in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=180).read()
        except Exception as e:
            err = e; time.sleep(3)
    raise err


def pd(s):
    return datetime.datetime.strptime(s, '%b %d, %Y').date()


hist = {}
def history(sid):
    p = os.path.join(DL, sid + '_hist.json')
    if not os.path.exists(p):
        open(p, 'wb').write(get(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{sid}/history.json?pagesize=100'))
    return json.load(open(p, encoding='utf-8'))['data']['history']


def current(sid):
    p = os.path.join(DL, sid + '_cur.xml')
    if not os.path.exists(p):
        open(p, 'wb').write(get(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{sid}.xml'))
    return p


def version(sid, v):
    p = os.path.join(DL, f'{sid}_v{v}.xml')
    if not os.path.exists(p):
        z = zipfile.ZipFile(io.BytesIO(get(f'https://dailymed.nlm.nih.gov/dailymed/getFile.cfm?setid={sid}&type=zip&version={v}')))
        xn = [n for n in z.namelist() if n.endswith('.xml')][0]
        open(p, 'wb').write(z.read(xn))
    return p


plan = {}
for rid, m in M.items():
    r = ROWS[rid]; asof = datetime.date(r['yr'], r['mo'], 1)
    plan[rid] = {'asof_date': str(asof), 'products': []}
    for name, sid in m.get('p', []):
        h = history(sid)
        before = [x for x in h if pd(x['published_date']) < asof]
        ent = {'name': name, 'setid': sid, 'cur': current(sid), 'n_versions_listed': len(h)}
        if before:
            b = max(before, key=lambda x: x['spl_version'])
            ent['asof_version'] = b['spl_version']; ent['asof_published'] = str(pd(b['published_date']))
            try:
                ent['asof'] = version(sid, b['spl_version'])
            except Exception as e:
                ent['asof_error'] = str(e)
        else:
            ent['asof_version'] = None
            ent['first_published'] = str(min(pd(x['published_date']) for x in h)) if h else None
        plan[rid]['products'].append(ent)
        print(rid, name, 'asof v', ent.get('asof_version'), ent.get('asof_published'), ent.get('asof_error', ''), flush=True)
json.dump(plan, open(os.path.join(BASE, 'plan.json'), 'w', encoding='utf-8'), indent=1)
