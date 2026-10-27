"""For reading, not for labeling: print every passage in a label that mentions one of the row's concept terms,
with the section path (top-level LOINC title > subsection titles). Usage: hits.py ROW [cur|asof] [ctx]"""
import json, sys, os, re
import xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = '{urn:hl7-org:v3}'
M = json.load(open(os.path.join(BASE, 'map.json'), encoding='utf-8'))
P = json.load(open(os.path.join(BASE, 'plan.json'), encoding='utf-8'))


def term_re(t):
    if t.isupper() and len(t) <= 5:  # acronyms: case-sensitive whole word
        return re.compile(r'\b' + re.escape(t) + r'\b')
    return re.compile(t.replace(' ', r'\s+').replace('-', r'[-\s]?'), re.I)


def own_text(sec):
    parts = []
    def walk(e):
        for c in e:
            if c.tag == NS + 'component':
                continue
            if c.tag == NS + 'title':
                continue
            parts.append(' '.join(c.itertext()))
    walk(sec)
    return re.sub(r'\s+', ' ', ' '.join(parts))


def sections(path):
    root = ET.parse(path).getroot()
    eff = root.find(NS + 'effectiveTime').get('value')
    ver = root.find(NS + 'versionNumber').get('value') if root.find(NS + 'versionNumber') is not None else '?'
    out = []
    def rec(sec, trail, top):
        code = sec.find(NS + 'code'); t = sec.find(NS + 'title')
        title = re.sub(r'\s+', ' ', ''.join(t.itertext())).strip() if t is not None else ''
        if top is None:
            top = (code.get('code') if code is not None else '', code.get('displayName') if code is not None else '')
        tr = trail + [title or (code.get('displayName') if code is not None else '')]
        out.append((top, tr, own_text(sec)))
        for comp in sec.findall(NS + 'component'):
            s = comp.find(NS + 'section')
            if s is not None:
                rec(s, tr, top)
    body = root.find(f'{NS}component/{NS}structuredBody')
    for comp in body.findall(NS + 'component'):
        s = comp.find(NS + 'section')
        if s is not None:
            rec(s, [], None)
    return eff, ver, out


if __name__ == '__main__':
    rid = sys.argv[1]; which = sys.argv[2] if len(sys.argv) > 2 else 'cur'; ctx = int(sys.argv[3]) if len(sys.argv) > 3 else 160
    pats = [term_re(t) for t in M[rid]['t']]
    for prod in P[rid]['products']:
        path = prod.get(which)
        if not path:
            print(f'## {prod["name"]} {which}: none', prod.get('asof_error', ''), 'first_published', prod.get('first_published')); continue
        eff, ver, secs = sections(path)
        print(f'## {prod["name"]} {prod["setid"]} {which} v{ver} eff {eff}')
        seen = set()
        for top, tr, txt in secs:
            spans = []
            for p in pats:
                for m in p.finditer(txt):
                    spans.append((m.start(), m.end()))
            spans.sort(); last = -10**9
            for a, b in spans:
                if a < last + ctx: continue
                last = a
                snip = txt[max(0, a - ctx):b + ctx]
                key = (top[0], snip[:60])
                if key in seen: continue
                seen.add(key)
                print(f'  [{top[0]} {top[1][:28]} > {" > ".join(x[:40] for x in tr[1:])}] ...{snip}...')
