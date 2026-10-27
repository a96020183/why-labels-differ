"""A' day-one step 2: ATC codes for every substance in the 197 PRAC rows.
Sources, in order, all kept (union):
  1. EMA medicines list (centrally authorised, 'ATC code (human)'), downloaded 2026-10-23 to data/ema_dl/.
  2. NLM RxClass API, relaSource=ATC (ATC level 4 per RxNorm ingredient), cached in data/rxclass/.
  3. A short manual table for names neither source resolves (class words, vaccines by brand), each with its WHO ATC code.
ATC level 3 = first 4 characters (e.g. L01AX03 -> L01A).
Usage: .venv/Scripts/python -I scripts/a2_atc.py out/rows.json data/ema_dl/medicines_output_medicines_report_en.xlsx data/rxclass out/atc.json"""
import json, sys, io, os, re, time, urllib.request, urllib.parse, openpyxl
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROWS, EMA, RXD, OUT = sys.argv[1:5]
os.makedirs(RXD, exist_ok=True)
rows = json.load(open(ROWS, encoding='utf-8'))

# Manual WHO ATC codes for names the two sources cannot resolve (checked against WHO ATC index naming).
MANUAL = {
    'covid-19 vaccine': ['J07BN'], 'covid-19 vaccine - vaxzevria': ['J07BN'], 'covid-19 vaccine - covid-19 vaccine janssen': ['J07BN'],
    'covid-19 mrna vaccine - comirnaty': ['J07BN'], 'covid-19 mrna vaccine - spikevax': ['J07BN'], 'tozinameran - comirnaty': ['J07BN'],
    'elasomeran - spikevax': ['J07BN'], 'calcineurin inhibitors': ['L04AD'], 'mammalian target of rapamycin inhibitors': ['L04AH'],
    'thiazide': ['C03AA'], 'thiazide-like diuretics': ['C03BA'], 'valproate': ['N03AG'], 'risperidone oral solution': ['N05AX'],
    'levonorgestrel intrauterine device 13.5 mg': ['G02BA'], 'macrogol-containing products for bowel preparation': ['A06AD'],
    'pegylated liposomal doxorubicin': ['L01DB'], 'human papillomavirus 9-valent vaccine': ['J07BM'], 'varicella vaccine': ['J07BK'],
    'measles': ['J07BD'], 'mumps': ['J07BD'], 'rubella': ['J07BD'], 'pneumococcal polysaccharide vaccine': ['J07AL'],
    'chikungunya vaccine': ['J07BX'], 'amino acids': ['B05BA'], 'or lipids with or without admixture of vitamins or trace elements': ['B05BA'],
    'iron isomaltoside': ['B03AC'], 'insulin bovine': ['A10AB'], 'fixed dose combinations containing paracetamol': ['N02BE'],
    'ciltabtagene autoleucel': ['L01XL'], 'ciltacabtagene autoleucel': ['L01XL'], 'selective serotonin reuptake inhibitors : citalopram': ['N06AB'],
    'colistimethate sodium': ['J01XB'], 'olmesartan medoxomil': ['C09CA'], 'amlodipine besilate': ['C08CA'], 'azilsartan medoxomil': ['C09CA'],
    'oxytetracycline hydrochloride': ['J01AA', 'S01AA'], 'hydrocortisone acetate': ['H02AB', 'D07AA', 'S01BA'], 'polymyxin b sulfate': ['J01XB', 'S01AA'],
    'dabigatran': ['B01AE'], 'ethinylestradiol': ['G03CA'], 'ferric carboxymaltose': ['B03AC'], 'insulin determir': ['A10AE'],
    'insulin porcine': ['A10AB'], 'ioxitalamic acid': ['V08AA'], 'iron': ['B03AC'], 'iron dextran': ['B03AC'], 'methallenestril': ['G03CB'],
    'moxestrol': ['G03CB'], 'norethisterone': ['G03AC', 'G03DC'], 'other relevant fixed dose combinations containing angiotensin ii receptor blockers': ['C09DA'],
    'pancreatin': ['A09AA'], 'paracetamol': ['N02BE'], 'prulifloxacin': ['J01MA'], 'rufloxacin': ['J01MA'], 'sodium ferric gluconate': ['B03AC'],
}
SKIP = {'combinations', 'related substances', 'other relevant fixed-dose combinations', 'human papillomavirus vaccine [types 6', '18]'}

# EMA list
ws = openpyxl.load_workbook(EMA, read_only=True).worksheets[0]
er = list(ws.iter_rows(values_only=True))
h = next(i for i, r in enumerate(er) if r and r[0] == 'Category')
H = [str(x or '') for x in er[h]]; ci = {k: next(i for i, c in enumerate(H) if c.startswith(k)) for k in ['Category', 'International non-proprietary name (INN) / common name', 'Active substance', 'ATC code (human)']}
ema = {}
for r in er[h + 1:]:
    if r[ci['Category']] != 'Human' or not r[ci['ATC code (human)']]: continue
    codes = [c.strip() for c in re.split(r'[;,\s]+', str(r[ci['ATC code (human)']])) if re.match(r'^[A-Z]\d\d[A-Z]', c.strip())]
    for col in ('International non-proprietary name (INN) / common name', 'Active substance'):
        v = str(r[ci[col]] or '').lower()
        for name in {v.strip()} | {p.strip() for p in re.split(r'[,/;]| and ', v)}:
            name = re.sub(r'\s+', ' ', name)
            if name: ema.setdefault(name, set()).update(codes)


def rxclass(name):
    p = os.path.join(RXD, re.sub(r'[^a-z0-9]+', '_', name) + '.json')
    if not os.path.exists(p):
        u = 'https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?' + urllib.parse.urlencode({'drugName': name, 'relaSource': 'ATC'})
        try:
            b = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60).read()
        except Exception as e:
            b = json.dumps({'error': str(e)[:80]}).encode()
        open(p, 'wb').write(b); time.sleep(0.25)
    j = json.load(open(p, encoding='utf-8'))
    items = (j.get('rxclassDrugInfoList') or {}).get('rxclassDrugInfo') or []
    return sorted({it['rxclassMinConceptItem']['classId'] for it in items})


subs = sorted({s for d in rows for s in d['substances']})
atc, miss = {}, []
for s in subs:
    if s in SKIP: continue
    e = sorted(ema.get(s, set())); x = rxclass(s); m = MANUAL.get(s, [])
    codes = sorted(set(e) | set(x) | set(m))
    src = [n for n, v in (('ema', e), ('rxclass', x), ('manual', m)) if v]
    atc[s] = dict(codes=codes, atc3=sorted({c[:4] for c in codes}), sources=src)
    if not codes: miss.append(s)
for d in rows:
    d['atc3'] = sorted({a for s in d['substances'] for a in atc.get(s, {}).get('atc3', [])})
json.dump(dict(substances=atc, unresolved=miss, rows={d['id']: d['atc3'] for d in rows}), open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(atc), 'substances;', len(miss), 'unresolved:', miss)
print('rows with no ATC3:', [d['id'] for d in rows if not d['atc3']])
