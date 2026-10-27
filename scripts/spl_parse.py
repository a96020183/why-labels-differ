"""SPL XML -> list of sections (top-level LOINC code and title, path of subsection titles, own text)."""
import xml.etree.ElementTree as ET
NS = '{urn:hl7-org:v3}'


def spl_sections(path):
    root = ET.parse(path).getroot()
    ver = root.find(NS + 'versionNumber').get('value'); eff = root.find(NS + 'effectiveTime').get('value')
    out = []
    def own(sec):
        parts = []
        for c in sec:
            if c.tag in (NS + 'component', NS + 'title', NS + 'code', NS + 'id', NS + 'effectiveTime'):
                continue
            parts.append(' '.join(c.itertext()))
        return ' '.join(' '.join(parts).split())
    def rec(sec, trail, top):
        code = sec.find(NS + 'code'); t = sec.find(NS + 'title')
        title = ' '.join(''.join(t.itertext()).split()) if t is not None else ''
        if top is None:
            top = (code.get('code') if code is not None else '', (code.get('displayName') if code is not None else '') or title)
        tr = trail + [title or (code.get('displayName') if code is not None else '')]
        txt = own(sec)
        if txt:
            out.append(dict(sec_code=top[0], sec_title=top[1], path=' > '.join(x for x in tr if x), text=txt))
        for comp in sec.findall(NS + 'component'):
            s2 = comp.find(NS + 'section')
            if s2 is not None:
                rec(s2, tr, top)
    body = root.find(f'{NS}component/{NS}structuredBody')
    for comp in body.findall(NS + 'component'):
        s2 = comp.find(NS + 'section')
        if s2 is not None:
            rec(s2, [], None)
    return ver, f'{eff[:4]}-{eff[4:6]}-{eff[6:8]}', out
