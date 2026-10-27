"""A' day-one step 4: US label status for every PRAC row (the per-row fact the night scan reads) and the answer key
for the cross-class questions.
- Rows in a reaction group: hand-picked US labels (brand / RLD) and a hand-written reaction pattern. These are the
  ones scored; status is section-aware.
- Other rows: first substance, pattern built automatically from the signal text (noise for the scan; not scored;
  marked auto=True).
openFDA drug label endpoint (same SPL set ids as DailyMed), cached in data/spl/.
Status per label: 'written' = hit inside Boxed Warning / Warnings (and Precautions) / Precautions / Contraindications;
'partial' = hit only in Adverse Reactions or another section; 'not found' = no hit; 'not marketed' = no current US SPL.
Row status = best over its labels. FDA AEMS quarterly pages (2023 Q1 - 2026 Q2, saved earlier) are searched with the
same pattern for a class-level or product-level listing.
Usage: .venv/Scripts/python -I scripts/a4_uslabel.py out/rows.json out/groups.json data/spl AEMS_DIR out/uslabel.json"""
import json, sys, io, os, re, time, urllib.request, urllib.parse, urllib.error, xml.etree.ElementTree as ET, html, glob
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
ROWS, GROUPS, SPLD, AEMSD, OUT = sys.argv[1:6]
os.makedirs(SPLD, exist_ok=True)
rows = json.load(open(ROWS, encoding='utf-8'))
G = json.load(open(GROUPS, encoding='utf-8'))
rkey = G['row_rkey']

PAT = {
    'DRESS': r'\bDRESS\b|(?i:drug reaction with eosinophilia|multi-?organ hypersensitivity)',
    'HLH': r'(?i:hemophagocytic|haemophagocytic|\bHLH\b)',
    'anaphylaxis': r'(?i:anaphyla)',
    'erythema multiforme': r'(?i:erythema multiforme)',
    'PML': r'(?i:progressive multifocal leukoencephalopathy)|\bPML\b',
    'sarcoidosis': r'(?i:sarcoid)',
    'myasthenia gravis': r'(?i:myasthenia)',
    'cutaneous vasculitis': r'(?i:vasculitis)',
    'capillary leak syndrome': r'(?i:capillary leak)',
    'microscopic colitis': r'(?i:microscopic colitis|collagenous colitis|lymphocytic colitis)',
    'colitis': r'(?i:\bcolitis)',
    'hyperammonaemia': r'(?i:hyperammon)',
    'choroidal effusion': r'(?i:choroidal effusion|choroidal detachment)',
    'thrombotic microangiopathy': r'(?i:thrombotic microangiopathy|hemolytic uremic syndrome)',
    'toxic epidermal necrolysis': r'(?i:toxic epidermal necrolysis)',
    'suppressed lactation': r'(?i:(decreas|reduc|suppress|diminish|inhibit)\w*[^.]{0,60}(milk|lactation)|milk (production|supply))',
    'pulmonary oedema': r'(?i:pulmonary edema)',
    'QT prolongation': r'(?i:qtc? (interval )?prolong|prolong\w* (of )?(the )?qtc?|torsade)',
    'tumour lysis syndrome': r'(?i:tumor lysis)',
    'meningioma': r'(?i:meningioma)',
    'myocarditis/pericarditis': r'(?i:myocarditis)',
    'embolic and thrombotic events': r'(?i:thrombosis)',
    'heavy menstrual bleeding': r'(?i:heavy menstrual|menorrhagia)',
}
# DailyMed search names for grouped rows; [] = no current US label (reason in NOTE)
LABELS = {
    'R010': ['protonix'], 'R033': ['paxil'], 'R044': ['zoloft'], 'R017': ['temodar'], 'R037': ['zydelig'], 'R043': ['remeron'],
    'R067': ['kineret', 'ilaris'], 'R132': ['esbriet'], 'R135': ['cefotaxime'], 'R142': ['ethambutol'], 'R191': ['gemcitabine'],
    'R197': ['oxacillin'], 'R027': ['imfinzi'], 'R116': ['lipitor', 'crestor'], 'R032': ['opdivo'], 'R080': ['bactrim'],
    'R094': ['zosyn'], 'R117': ['tafinlar', 'mekinist'], 'R034': ['hydrochlorothiazide'], 'R127': ['acetazolamide'],
    'R045': ['desogestrel'], 'R098': ['labetalol'], 'R047': ['vyvanse'], 'R087': ['aricept'], 'R049': ['zytiga'],
    'R060': ['xeloda'], 'R068': [], 'R180': ['datroway'], 'R052': ['pomalyst'], 'R093': ['trexall'], 'R130': ['yescarta'],
    'R171': ['carvykti', 'abecma', 'kymriah'], 'R056': ['tafinlar', 'mekinist'], 'R074': ['lemtrada'], 'R069': [], 'R072': [],
    'R073': [], 'R077': [], 'R083': [], 'R110': ['spikevax'], 'R124': ['yervoy', 'opdivo', 'keytruda'], 'R085': ['comirnaty'],
    'R086': ['spikevax'], 'R100': ['spikevax'], 'R102': ['comirnaty'], 'R090': ['comirnaty'], 'R091': ['spikevax'],
    'R105': ['xtandi'], 'R137': ['verzenio', 'ibrance', 'kisqali'], 'R099': ['lenvima'], 'R161': ['poteligeo'], 'R104': ['lyrica'],
    'R149': ['bumetanide'], 'R107': ['nexavar'], 'R160': ['lenvima'], 'R114': ['spikevax'], 'R115': ['comirnaty'],
    'R118': ['stivarga'], 'R184': ['doxil'], 'R128': ['vidaza'], 'R179': ['bosulif'], 'R148': ['acetazolamide'],
    'R157': ['inomax'], 'R153': ['depo-provera'], 'R195': ['nexplanon'], 'R162': [], 'R164': ['stivarga'],
}
NOTE = {'R068': 'ChAdOx1-S (AstraZeneca) never licensed in the US', 'R069': 'ChAdOx1-S never licensed in the US',
        'R073': 'ChAdOx1-S never licensed in the US', 'R083': 'ChAdOx1-S never licensed in the US',
        'R072': 'Ad26.COV2.S: US EUA revoked 2023-06', 'R077': 'Ad26.COV2.S: US EUA revoked 2023-06',
        'R162': 'tegafur/gimeracil/oteracil not approved in the US'}


def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=90).read()


LABEL_FIELDS = ['boxed_warning', 'warnings_and_cautions', 'warnings', 'precautions', 'contraindications', 'adverse_reactions',
                'postmarketing_experience', 'patient_counseling_information', 'spl_patient_package_insert', 'information_for_patients']
WRITTEN_FIELDS = {'boxed_warning', 'warnings_and_cautions', 'warnings', 'precautions', 'contraindications'}

NS = '{urn:hl7-org:v3}'


def dailymed_fallback(name):
    """openFDA has no label for this name: ask DailyMed (metadata is fast; the XML is slow, so only for these few)."""
    try:
        j = json.loads(get('https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?' + urllib.parse.urlencode({'drug_name': name, 'pagesize': 1})))
    except Exception as e:
        return dict(error='dailymed ' + str(e)[:60])
    if not j.get('data'): return None
    d = j['data'][0]
    try:
        x = urllib.request.urlopen(urllib.request.Request(f"https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{d['setid']}.xml",
                                                          headers={'User-Agent': 'Mozilla/5.0'}), timeout=600).read()
    except Exception as e:
        return dict(error='dailymed xml ' + str(e)[:60])
    root = ET.fromstring(x)
    rec = dict(set_id=d['setid'], effective_time=d.get('published_date'), version=d.get('spl_version'), source='dailymed',
               openfda=dict(brand_name=[d['title'][:60]], generic_name=[''], manufacturer_name=['']))
    for comp in root.find(f'.//{NS}structuredBody').findall(f'{NS}component'):
        sec = comp.find(f'{NS}section')
        if sec is None: continue
        t = sec.find(f'{NS}title'); title = ' '.join(''.join(t.itertext()).split()).upper() if t is not None else ''
        text = ' '.join(''.join(sec.itertext()).split())
        f = ('boxed_warning' if 'BOXED' in title else 'warnings_and_cautions' if 'WARNINGS AND PRECAUTIONS' in title else
             'warnings' if 'WARNING' in title else 'precautions' if 'PRECAUTION' in title else 'contraindications' if 'CONTRAINDICATION' in title
             else 'adverse_reactions' if 'ADVERSE' in title else 'information_for_patients')
        rec.setdefault(f, []).append(text)
    return rec


def spl(name, fallback=False):
    """Current U.S. label for a name via the openFDA drug label endpoint (same SPL set ids as DailyMed; DailyMed's own
    XML download ran at ~12 KB/s on 2026-10-23, too slow for 200 labels). Brand name first, then generic name; most
    recent effective_time that has clinical sections."""
    p = os.path.join(SPLD, re.sub(r'[^a-z0-9]+', '_', name) + '.openfda.json')
    if not os.path.exists(p):
        got = None
        for field in ('openfda.brand_name', 'openfda.generic_name'):
            u = 'https://api.fda.gov/drug/label.json?' + urllib.parse.urlencode({'search': f'{field}:"{name}"', 'sort': 'effective_time:desc', 'limit': 10})
            try:
                j = json.loads(get(u))
            except urllib.error.HTTPError as e:
                if e.code == 404: continue
                return dict(error=f'HTTP {e.code}'), None
            except Exception as e:
                return dict(error=str(e)[:80]), None
            cand = [r for r in j.get('results', []) if any(f in r for f in LABEL_FIELDS[:6])]
            if cand: got = cand[0]; break
        if not got and fallback:
            got = dailymed_fallback(name)
            if got is not None and 'error' in got: return dict(error=got['error']), None
        json.dump(got or {}, open(p + '.part', 'w', encoding='utf-8')); os.replace(p + '.part', p); time.sleep(0.3)
    r = json.load(open(p, encoding='utf-8'))
    if not r: return {}, None
    of = r.get('openfda', {})
    m = dict(setid=r.get('set_id'), title=f"{'/'.join(of.get('brand_name', [])[:1])} ({'/'.join(of.get('generic_name', [])[:1])}) {'/'.join(of.get('manufacturer_name', [])[:1])}",
             published=r.get('effective_time'), version=r.get('version'))
    return m, r


def check(r, pat):
    rx = re.compile(pat)
    hits = []
    for f in LABEL_FIELDS:
        for text in r.get(f, []) or []:
            mm = rx.search(text)
            if mm:
                hits.append(dict(section=f, snippet=text[max(0, mm.start() - 90): mm.end() + 90])); break
    if any(h['section'] in WRITTEN_FIELDS for h in hits): st = 'written'
    elif hits: st = 'partial'
    else: st = 'not found'
    return st, hits


def auto_pat(sig):
    s = re.sub(r'\([^)]*\)', ' ', sig.lower())
    for a, b in [('oedema', 'edema'), ('haem', 'hem'), ('aemia', 'emia'), ('oesoph', 'esoph'), ('foet', 'fet'), ('tumour', 'tumor'),
                 ('paediatric', 'pediatric'), ('ischaem', 'ischem'), ('diarrhoea', 'diarrhea'), ('anaemia', 'anemia'), ('leukaem', 'leukem')]:
        s = s.replace(a, b)
    w = [x for x in re.findall(r'[a-z][a-z\-]+', s) if x not in {'and', 'of', 'the', 'with', 'in', 'new', 'aspect', 'known', 'risk', 'to', 'a', 'or', 'due', 'drug'}]
    return '(?i:' + re.escape(' '.join(w[:2])) + ')' if w else None


RANK = {'written': 3, 'partial': 2, 'not found': 1, 'unknown': 0, 'not marketed': 0}
res = {}
for d in rows:
    k = rkey.get(d['id'])
    curated = d['id'] in LABELS
    if curated:
        names, pat, auto = LABELS[d['id']], PAT[k], False
    else:
        names, pat, auto = [d['substances'][0]], auto_pat(d['sig']), True
    labels = []
    if not names:
        res[d['id']] = dict(status='not marketed', note=NOTE.get(d['id'], ''), labels=[], auto=auto, pattern=pat); continue
    for n in names:
        m, xp = spl(n, fallback=curated)
        if not xp:
            if curated: labels.append(dict(search=n, status='not marketed', note=m.get('error') or 'no openFDA or DailyMed label for this name'))
            else: labels.append(dict(search=n, status='unknown', note=m.get('error') or 'no openFDA label for this name (auto row, not checked further)'))
            continue
        st, hits = check(xp, pat) if pat else ('not found', [])
        labels.append(dict(search=n, setid=m['setid'], title=m['title'][:90], published=m.get('published'), version=m.get('version'),
                           status=st, hits=hits[:3]))
    best = max(labels, key=lambda x: RANK[x['status']])
    res[d['id']] = dict(status=best['status'], labels=labels, auto=auto, pattern=pat)
    print(d['id'], 'C' if curated else 'a', res[d['id']]['status'], '|', d['sig'][:40], '|', [(l['search'], l['status']) for l in labels])

# FDA AEMS (FAERS potential signals) pages, 2023 Q1 - 2026 Q2
aems = []
for p in sorted(glob.glob(os.path.join(AEMSD, '*.html'))):
    q = os.path.basename(p)[:30]
    t = open(p, encoding='utf-8', errors='replace').read()
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', t, re.S | re.I):
        cells = [' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', c)).split()) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.S | re.I)]
        if cells: aems.append(dict(page=q, cells=cells))
aems_hits = {}
for k, pat in PAT.items():
    rx = re.compile(pat)
    aems_hits[k] = [dict(page=a['page'], row=' | '.join(a['cells'])[:260]) for a in aems if rx.search(' '.join(a['cells'][:1])) or rx.search(' '.join(a['cells']))]
# hand override after reading the snippet (same as a5_register.py)
res['R148']['status'] = 'not found'; res['R148']['note'] = 'override: only hit is high-altitude pulmonary edema as a disease context, not a drug-induced reaction'
json.dump(dict(rows=res, aems=aems_hits, aems_pages=len(glob.glob(os.path.join(AEMSD, '*.html'))), aems_rows=len(aems)),
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('AEMS rows parsed:', len(aems), {k: len(v) for k, v in aems_hits.items() if v})
