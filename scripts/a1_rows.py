"""A' day-one step 1: PRAC signal rows since 2019 with a product-information update, in meeting order.
Input: EMA 'List of signals discussed at PRAC since September 2012' (xlsx, 2026-09-28 version).
Output: out/rows.json  (id, inn, substances, sig, meeting, yr, mo)
Usage: .venv/Scripts/python -I scripts/a1_rows.py data/prac_signals.xlsx out/rows.json"""
import openpyxl, sys, re, json, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
M = {m: i + 1 for i, m in enumerate(MONTHS)}
ws = openpyxl.load_workbook(sys.argv[1], read_only=True).worksheets[0]
rows = list(ws.iter_rows(values_only=True))
h = next(i for i, r in enumerate(rows) if r[0] == 'INN')


def substances(inn):
    """Split an INN cell into substances. 'Class (x): a; b, c; d' -> a, b, c, d. Combos 'a, b' are split too
    (each component gets its own ATC lookup; the row keeps every component)."""
    s = inn
    if ':' in s and not re.match(r'^[^:]{0,6}:', s):
        head, s = s.split(':', 1)
    s = re.sub(r'\([^)]*\)', ' ', s)
    s = re.sub(r'\band other relevant fixed dose combinations\b', ' ', s, flags=re.I)
    parts = re.split(r';|,|\band\b|/', s)
    out = []
    for p in parts:
        p = re.sub(r'\s+', ' ', p).strip(' .-').lower()
        p = re.sub(r'^(incl\.?|including)\s+', '', p)
        if p and len(p) > 2 and p not in out: out.append(p)
    return out


data = []
for r in rows[h + 1:]:
    if not r[0] or not r[1] or not r[2]: continue
    mtg = str(r[2]); m = re.search(r'(20\d\d)', mtg)
    if not m: continue
    if not str(r[3] or '').strip().lower().startswith('yes'): continue
    yr = int(m.group(1))
    if yr < 2019: continue
    mons = [M[x.lower()] for x in re.findall('(' + '|'.join(MONTHS) + ')', mtg, re.I)]
    inn = re.sub(r'\s+', ' ', str(r[0])).strip()
    data.append(dict(inn=inn, substances=substances(inn), sig=re.sub(r'\s+', ' ', str(r[1])).strip(),
                     meeting=mtg.strip(), yr=yr, mo=mons[-1] if mons else 0))
data.sort(key=lambda d: (d['yr'], d['mo'], d['inn'].lower(), d['sig'].lower()))
for i, d in enumerate(data, 1): d['id'] = f'R{i:03d}'
json.dump(data, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(data), 'rows;', sum(len(d['substances']) for d in data), 'substance mentions;',
      len({s for d in data for s in d['substances']}), 'unique substances')
