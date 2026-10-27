"""Build the regulatory evidence tables that Zetaris serves to the agents (sample/evidence/*.csv).

Every row is cut from a public regulator document downloaded by this script (cache: data/evidence_raw/, not in git):
  EU   EMA PRAC highlights 2025-06-06, EMA news on semaglutide/NAION, Ozempic EPAR procedural steps, Ozempic product
       information (SmPC 4.4/4.8, package leaflet), PRAC recommendations on signals of 13-16 May 2019 (SSRI/SNRI)
  EU   (valproate, darolutamide, gemcitabine) EMA news of 26 January 2024 (valproate in men), PRAC highlights 8-11 June 2026,
       PRAC recommendations on signals of 8-11 June 2026 (EMA/PRAC/124080/2026)
  UK   MHRA Drug Safety Update 2026-02-05 (semaglutide/NAION), 2026-10-15 (antidepressants), 2024-09-05 (valproate in men)
  US   DailyMed SPL XML (current versions, and the version history used by the reopen replay), FDA AEMS quarterly
       potential-signal pages 2023 Q1 - 2026 Q2, FDA Sentinel study page (Wayback snapshot; the live site blocks scripts)
Outputs (all plain CSV, UTF-8):
  reg_doc.csv      one row per document: regulator, body, doc_type, authority (primary/secondary), dates, url
  reg_passage.csv  passages cut from those documents (section + exact text)
  spl_section.csv  U.S. label sections (LOINC section, path, text) for the hero products and the replay versions
  spl_version.csv  DailyMed version history for those set ids
  aems.csv         one row per AEMS potential-signal entry: quarter, products, term, FDA's stated action, as-of date
  sentinel.csv     Sentinel study status rows
Usage: python -I scripts/build_evidence.py            (needs network on first run; afterwards the cache is enough)"""
import csv, datetime, glob, html, io, json, os, re, subprocess, sys, time, urllib.request, zipfile
import xml.etree.ElementTree as ET
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spl_parse import spl_sections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'evidence_raw'); os.makedirs(RAW, exist_ok=True)
OUT = os.path.join(ROOT, 'sample', 'evidence'); os.makedirs(OUT, exist_ok=True)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
TODAY = datetime.date.today().isoformat()
NS = '{urn:hl7-org:v3}'


def fetch(url, name, binary=False):
    p = os.path.join(RAW, name)
    if not os.path.exists(p):
        for i in range(4):
            try:
                data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=180).read()
                open(p, 'wb').write(data); break
            except Exception as e:
                err = e; time.sleep(3)
        else:
            raise SystemExit(f'download failed: {url}: {err}')
    return p


def page_text(p):
    t = open(p, encoding='utf-8', errors='replace').read()
    t = re.sub(r'(?is)<script.*?</script>|<style.*?</style>', '', t)
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', t)).split())


def pdf_text(p):
    out = p + '.txt'
    if not os.path.exists(out):
        subprocess.run(['pdftotext', '-enc', 'UTF-8', '-layout', p, out], check=True)
    return open(out, encoding='utf-8', errors='replace').read()


def between(s, a, b, n=1):
    i = s.find(a)
    if i < 0:
        raise SystemExit(f'anchor not found: {a[:60]}')
    j = s.find(b, i + len(a)) if b else -1
    return s[i: j if j > 0 else i + 1500].strip()


def squash(s):
    return ' '.join(s.replace('', '').replace('•', '').split())


docs, passages = [], []


def doc(doc_id, regulator, body, doc_type, authority, title, published, url, scope, substances, reaction):
    docs.append(dict(doc_id=doc_id, regulator=regulator, body=body, doc_type=doc_type, authority=authority, title=title,
                     published=published, retrieved=TODAY, url=url, scope=scope, substances=substances, reaction_key=reaction))


def passage(doc_id, section, text):
    passages.append(dict(passage_id=f'{doc_id}-{sum(1 for p in passages if p["doc_id"] == doc_id) + 1:02d}', doc_id=doc_id, section=section, text=squash(text)))


# ---------------- EU: semaglutide x NAION ----------------
u = 'https://www.ema.europa.eu/en/news/meeting-highlights-pharmacovigilance-risk-assessment-committee-prac-2-5-june-2025'
s = page_text(fetch(u, 'ema_prac_highlights_2025-06.html'))
doc('EU-PRESS-2025-06', 'EU', 'EMA', 'press_release', 'secondary', 'Meeting highlights from PRAC 2-5 June 2025', '2025-06-06', u, 'product', 'semaglutide', 'NAION')
passage('EU-PRESS-2025-06', 'PRAC concludes eye condition NAION is a very rare side effect of semaglutide medicines',
        between(s, 'EMA’s safety committee (PRAC) has concluded its review of medicines containing semaglutide', 'More information is available'))

u = 'https://www.ema.europa.eu/en/news/prac-concludes-eye-condition-naion-very-rare-side-effect-semaglutide-medicines-ozempic-rybelsus-wegovy'
s = page_text(fetch(u, 'ema_news_naion.html'))
doc('EU-NEWS-NAION', 'EU', 'EMA', 'press_release', 'secondary', 'PRAC concludes eye condition NAION is a very rare side effect of semaglutide medicines', '2025-06-06', u, 'product', 'semaglutide', 'NAION')
passage('EU-NEWS-NAION', 'Revision note', between(s, 'This news announcement was revised on 13 June 2025', 'EMA’s safety committee'))
passage('EU-NEWS-NAION', 'Evidence', between(s, 'Results from several large epidemiological studies', 'EMA has therefore recommended'))
passage('EU-NEWS-NAION', 'More about the procedure', between(s, 'The potential association between exposure to semaglutide and NAION', 'Related content'))

u = 'https://www.ema.europa.eu/en/documents/procedural-steps-after/ozempic-epar-procedural-steps-taken-scientific-information-after-authorisation_en.pdf'
t = pdf_text(fetch(u, 'ozempic_procedural_steps.pdf'))
i = t.find('C.I.z - to update sections 4.4 and 4.8'); seg = re.sub(r'\n.*Page \d+/\d+.*\n', '\n', t[i:i + 1400])
seg = seg[: seg.find('Variation type IB /  Outcome')] if 'Variation type IB /  Outcome' in seg else seg
doc('EU-EPAR-STEPS-OZEMPIC', 'EU', 'EMA / European Commission', 'procedural_record', 'primary', 'Ozempic EPAR: procedural steps taken and scientific information after authorisation',
    'current at retrieval', u, 'product', 'semaglutide', 'NAION')
passage('EU-EPAR-STEPS-OZEMPIC', 'Worksharing variation, scope C.I.z', re.sub(r'\s{2,}', ' ', seg))

u = 'https://www.ema.europa.eu/en/documents/product-information/ozempic-epar-product-information_en.pdf'
t = pdf_text(fetch(u, 'ozempic_product_information.pdf'))
doc('EU-SMPC-OZEMPIC', 'EU', 'European Commission (EPAR)', 'smpc', 'primary', 'Ozempic: Summary of Product Characteristics and Package Leaflet', 'current at retrieval', u, 'product', 'semaglutide', 'NAION')
a = t.find('Non-arteritic anterior ischaemic optic neuropathy (NAION)\n\nData from')
passage('EU-SMPC-OZEMPIC', 'SmPC 4.4 Special warnings and precautions for use', re.sub(r'\n\s*\d+\s*\n', ' ', t[a: t.find('(see section 4.8).', a) + 18]))
a = t.find('Non-arteritic anterior ischaemic optic neuropathy (NAION)\nResults from')
passage('EU-SMPC-OZEMPIC', 'SmPC 4.8 Undesirable effects (description of selected adverse reactions)', t[a: t.find('person-years of treatment.', a) + 26])
passage('EU-SMPC-OZEMPIC', 'SmPC 4.8 Tabulated list (frequency)', 'Eye disorders: Non-arteritic anterior ischaemic optic neuropathy (NAION) - frequency: very rare.')
a = t.find('Very Rare (may affect up to 1 in 10 000 people)')
e = t.find('Sudden changes to your eyesight', a); e = t.find(')', e) + 1 if e > 0 else a + 600  # quotes are curly in UTF-8 text
passage('EU-SMPC-OZEMPIC', 'Package leaflet section 4 (patients)', t[a: e + 1 if t[e:e + 1] == '.' else e])
a = t.find('If you notice a sudden loss of vision or rapidly worsening eyesight')
passage('EU-SMPC-OZEMPIC', 'Package leaflet section 2 (patients)', t[a: t.find('this medicine.', a + 200) + 14])

# ---------------- EU: SSRI/SNRI x persistent sexual dysfunction (PRAC 13-16 May 2019) ----------------
u = 'https://www.ema.europa.eu/en/documents/prac-recommendation/prac-recommendations-signals-adopted-13-16-may-2019-prac-meeting_en.pdf'
t = pdf_text(fetch(u, 'prac_recommendations_2019-05.pdf'))
doc('EU-PRAC-REC-2019-05', 'EU', 'EMA PRAC', 'prac_recommendation', 'primary', 'PRAC recommendations on signals adopted at the 13-16 May 2019 PRAC meeting (EPITT 19277)',
    '2019-05-16', u, 'class', 'citalopram;escitalopram;fluvoxamine;fluoxetine;paroxetine;sertraline;duloxetine;venlafaxine;desvenlafaxine;milnacipran', 'persistent sexual dysfunction')
a = t.find('Having considered the available evidence from EudraVigilance, literature, social media')
passage('EU-PRAC-REC-2019-05', 'Recommendation', t[a: t.find('(new\ntext underlined)', a) + 20] if '(new\ntext underlined)' in t else t[a: a + 900])
a = t.find('4.4. Special warnings and precautions for use\nSexual dysfunction')
passage('EU-PRAC-REC-2019-05', 'SmPC 4.4 wording', t[a: t.find('discontinuation of SSRIs/SNRI.', a) + 30])
a = t.find('Medicines like [Invented name] (so called SSRIs/SNRIs)')
passage('EU-PRAC-REC-2019-05', 'Package leaflet wording', t[a: t.find('after stopping treatment.', a) + 25])

# ---------------- UK ----------------
u = 'https://www.gov.uk/drug-safety-update/semaglutide-wegovy-ozempic-and-rybelsus-risk-of-non-arteritic-anterior-ischemic-optic-neuropathy-naion'
s = page_text(fetch(u, 'mhra_dsu_semaglutide_naion.html'))
doc('UK-DSU-2026-02-05', 'UK', 'MHRA', 'drug_safety_update', 'primary', 'Semaglutide (Wegovy, Ozempic and Rybelsus): risk of NAION', '2026-02-05', u, 'product', 'semaglutide', 'NAION')
passage('UK-DSU-2026-02-05', 'Background: European review and CHM advice', between(s, 'A European review of evidence', 'UK reports'))
passage('UK-DSU-2026-02-05', 'UK reports (Yellow Card)', between(s, 'In the UK, since semaglutide', 'Updated product information'))
passage('UK-DSU-2026-02-05', 'Advice for healthcare professionals', between(s, 'patients reporting a sudden loss of vision (including partial loss) should be urgently referred', 'advise new patients'))
passage('UK-DSU-2026-02-05', 'Advice to give patients', between(s, 'if you notice a change in your eyesight', 'Background'))
passage('UK-DSU-2026-02-05', 'Updated product information', between(s, 'The Summary of Product Characteristics (SmPC) and Patient information Leaflet (PIL) for semaglutide', 'About semaglutide'))

u = 'https://www.gov.uk/drug-safety-update/antidepressants-new-safety-measures-for-all-patients-to-improve-communication-of-the-risk-of-suicidal-thoughts-and-behaviours-and-persistent-sexual-dysfunction'
s = page_text(fetch(u, 'mhra_dsu_antidepressants_2026-10-15.html'))
doc('UK-DSU-2026-10-15', 'UK', 'MHRA', 'drug_safety_update', 'primary', 'Antidepressants: new safety measures ... suicidal thoughts and behaviours and persistent sexual dysfunction',
    '2026-10-15', u, 'class', 'antidepressants', 'persistent sexual dysfunction')
passage('UK-DSU-2026-10-15', 'Summary', between(s, 'New safety measures are now being implemented for all patients taking antidepressant', 'Advice for Healthcare Professionals:'))
passage('UK-DSU-2026-10-15', 'Advice to give patients', between(s, 'there is the potential for you to experience sexual dysfunction', 'do not stop taking'))
passage('UK-DSU-2026-10-15', 'New measures: boxed warning and patient card', between(s, 'A new boxed warning in the PILs to better highlight information on suicidal thoughts', 'The expectation is'))
passage('UK-DSU-2026-10-15', 'New measures: PSSD term', between(s, 'The term “Post SSRI Sexual Dysfunction” (“PSSD”) will be added', 'This will better reflect'))
passage('UK-DSU-2026-10-15', 'Background', between(s, 'The EWG considered the views in the context of the literature published since 2019', 'The EWG heard'))

# ---------------- EU + UK: valproate and paternal exposure (first acted in 2024; June 2026 was a re-review) ----------------
u = 'https://www.ema.europa.eu/en/news/precautionary-measures-address-potential-risk-neurodevelopmental-disorders-children-born-men-treated-valproate-medicines'
s = page_text(fetch(u, 'ema_news_valproate_men_2024-01.html'))
doc('EU-NEWS-VALPROATE-2024-01', 'EU', 'EMA', 'press_release', 'secondary', 'Precautionary measures to address potential risk of neurodevelopmental disorders in children born to men treated with valproate medicines',
    '2024-01-26', u, 'class', 'valproate;valproic acid;sodium valproate;valproate semisodium;valpromide', 'neurodevelopmental disorders, paternal exposure')
passage('EU-NEWS-VALPROATE-2024-01', 'CMDh endorses PRAC precautionary measures for male patients (24 January 2024)',
        between(s, 'On 24 January 2024, the CMDh 1 endorsed precautionary measures', 'In reaching its conclusion'))
passage('EU-NEWS-VALPROATE-2024-01', 'Evidence reviewed', between(s, 'In reaching its conclusion, the PRAC reviewed data from a retrospective observational study', 'Neurodevelopmental disorders are problems'))
passage('EU-NEWS-VALPROATE-2024-01', 'Limitations', between(s, 'The study data on male patients had limitations', 'Nonetheless'))

u = 'https://www.ema.europa.eu/en/news/meeting-highlights-pharmacovigilance-risk-assessment-committee-prac-8-11-june-2026'
s = page_text(fetch(u, 'ema_prac_highlights_2026-06.html'))
doc('EU-PRESS-2026-06', 'EU', 'EMA', 'press_release', 'secondary', 'Meeting highlights from PRAC 8-11 June 2026', '2026-06-12', u, 'class',
    'valproate;valproic acid;sodium valproate;valproate semisodium;valpromide', 'neurodevelopmental disorders, paternal exposure')
passage('EU-PRESS-2026-06', 'PRAC concludes evidence of potential risk of neurodevelopmental disorders in children born to men treated with valproate is inconsistent',
        between(s, 'EMA’s safety committee, the PRAC, has completed its review of a safety signal for valproate', 'Valproate medicines are used'))
passage('EU-PRESS-2026-06', 'What happened in 2024', between(s, 'In January 2024, the assessment of the findings of a post authorisation safety study', 'The latest safety signal'))
passage('EU-PRESS-2026-06', 'The 2025-2026 signal review', between(s, 'The latest safety signal was started in July 2025', 'New safety information for healthcare professionals'))

u = 'https://www.ema.europa.eu/en/documents/prac-recommendation/prac-recommendations-signals-adopted-8-11-june-2026-prac-meeting_en.pdf'
t = pdf_text(fetch(u, 'prac-recommendations-signals-adopted-8-11-june-2026-prac-meeting_en.pdf'))
for did, inn, reaction, a, b, wa, wb in [
    ('EU-PRAC-REC-2026-06-DAROLUTAMIDE', 'darolutamide', 'angioedema', 'Having considered the available evidence in EudraVigilance, including the submitted cumulative review', 'Package leaflet', 'Summary of product characteristics\n4.8', '1.2. Gemcitabine'),
    ('EU-PRAC-REC-2026-06-GEMCITABINE', 'gemcitabine', 'DRESS', 'Having considered all the available evidence, including data from EudraVigilance and the literature', 'drug hypersensitivity syndrome)', 'epidermal necrolysis (TEN), drug reaction with eosinophilia', '1.3. Valproate'),
    ('EU-PRAC-REC-2026-06-VALPROATE', 'valproate;valproic acid;sodium valproate;valproate semisodium;valpromide', 'neurodevelopmental disorders, paternal exposure', 'Taking into account the available evidence in the literature', 'Therefore, the PRAC has agreed that the MAHs of valproate', 'A retrospective observational study suggests an increased risk of neuro-developmental disorders', '4.6 Fertility, pregnancy and lactation')]:
    doc(did, 'EU', 'EMA PRAC', 'prac_recommendation', 'primary', f'PRAC recommendations on signals adopted at the 8-11 June 2026 PRAC meeting ({inn.split(";")[0]})', '2026-06-11', u,
        'class' if ';' in inn else 'product', inn, reaction)
    i = t.find(a); passage(did, 'Recommendation', re.sub(r'\s+', ' ', t[i: t.find(b, i) + (len(b) if b.endswith(')') else 0)]))
    i = t.find(wa); passage(did, 'Product information wording', re.sub(r'\s+', ' ', re.sub(r'\n.*Page \d+/\d+.*\n|\nPRAC recommendations on signals\s*\n|\nEMA/PRAC/\d+/\d+\s*\n', '\n', t[i: t.find(wb, i)]))[:1600])

u = 'https://www.gov.uk/drug-safety-update/valproate-use-in-men-as-a-precaution-men-and-their-partners-should-use-effective-contraception'
s = page_text(fetch(u, 'mhra_dsu_valproate_men_2024-09.html'))
doc('UK-DSU-2024-09-05', 'UK', 'MHRA', 'drug_safety_update', 'primary', 'Valproate use in men: as a precaution, men and their partners should use effective contraception', '2024-09-05', u,
    'class', 'valproate;valproic acid;sodium valproate;valproate semisodium', 'neurodevelopmental disorders, paternal exposure')
passage('UK-DSU-2024-09-05', 'Information for healthcare professionals (study findings)', between(s, 'findings from a retrospective observational study, combining analyses', 'Advice for healthcare professionals:'))
passage('UK-DSU-2024-09-05', 'Advice for healthcare professionals', between(s, 'inform male patients (of any age) who may father children of the possible risk', 'Information for healthcare professionals to provide to patients'))
passage('UK-DSU-2024-09-05', 'Advice to give patients', between(s, 'it is recommended that you and your female sexual partner should both use effective birth control', 'Review of data regarding'))
passage('UK-DSU-2024-09-05', 'Review of data (CHM)', between(s, 'During the 2018 European review into the risks of valproate in pregnancy', 'This advice is in addition'))

# ---------------- US: Sentinel (Wayback snapshot; live site returns 403 to scripts) ----------------
u = 'https://web.archive.org/web/2026/https://www.sentinelinitiative.org/studies/drugs/individual-drug-analyses/risk-non-arteritic-anterior-ischemic-optic-neuropathy-naion'
s = page_text(fetch(u, 'sentinel_naion.html'))
snap = re.search(r'web/(\d{8})\d*/', open(os.path.join(RAW, 'sentinel_naion.html'), encoding='utf-8', errors='replace').read())
snap = f'{snap.group(1)[:4]}-{snap.group(1)[4:6]}-{snap.group(1)[6:8]}' if snap else ''
status = re.search(r'Status (\w[\w ]*?) Medical Product', s).group(1)
posted = re.search(r'Date Posted \w+, (\w+ \d+, \d{4})', s).group(1)
sent = [dict(study_id='SENTINEL-NAION-GLP1', title=re.search(r'Individual Drug Analyses (Risk of Non-arteritic.*?Mellitus)', s).group(1),
             product_scope='glucagon-like peptide-1 receptor agonists (GLP-1 RAs)', outcome='non-arteritic anterior ischemic optic neuropathy',
             date_posted=datetime.datetime.strptime(posted, '%B %d, %Y').date().isoformat(), status=status,
             protocol_note=between(s, 'The Sentinel Innovation Center posted this final draft protocol', 'Deliverables'),
             description=between(s, 'This concern was raised', 'Given the severe'), snapshot=snap,
             url='https://www.sentinelinitiative.org/studies/drugs/individual-drug-analyses/risk-non-arteritic-anterior-ischemic-optic-neuropathy-naion')]

# ---------------- US: AEMS quarterly potential-signal pages ----------------
AEMS_PAGES = 'https://www.fda.gov/drugs/fda-adverse-event-monitoring-system-aems/'
aems = []
src_dir = os.environ.get('APRIME_AEMS_DIR', os.path.join(RAW, 'aems'))
for p in sorted(glob.glob(os.path.join(src_dir, '*.html'))):
    name = os.path.basename(p)
    m = re.match(r'(january-march|april-june|july-september|october-december)-(\d{4})', name)
    q = {'january-march': 'Q1', 'april-june': 'Q2', 'july-september': 'Q3', 'october-december': 'Q4'}[m.group(1)] + ' ' + m.group(2)
    raw = open(p, encoding='utf-8', errors='replace').read()
    asof = re.search(r'\(as of ([A-Z][a-z]+ \d{1,2}, \d{4})\)', html.unescape(re.sub(r'<[^>]+>', ' ', raw)))
    asof = datetime.datetime.strptime(asof.group(1), '%B %d, %Y').date().isoformat() if asof else ''
    for tr in re.findall(r'(?is)<tr[^>]*>(.*?)</tr>', raw):
        cells = [' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', c)).split()) for c in re.findall(r'(?is)<td[^>]*>(.*?)</td>', tr)]
        if len(cells) >= 3:
            aems.append(dict(quarter=q, as_of=asof, products=cells[0][:400], term=cells[1][:200], fda_action=cells[2][:600], page=AEMS_PAGES + name.replace('.html', '')))
aems_src = 'fda.gov AEMS quarterly pages saved in ' + ('APRIME_AEMS_DIR' if 'APRIME_AEMS_DIR' in os.environ else 'data/evidence_raw/aems')

# ---------------- US: DailyMed SPL ----------------
def dm(url, name, binary=True):
    return fetch(url, name, binary)


def history(setid):
    p = dm(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{setid}/history.json?pagesize=100', f'{setid}_hist.json')
    return json.load(open(p, encoding='utf-8'))['data']['history']


def version_xml(setid, v, current=False):
    name = f'{setid}_v{v}.xml'
    p = os.path.join(RAW, name)
    if not os.path.exists(p):
        if current:
            fetch(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{setid}.xml', name)
        else:
            z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(urllib.request.Request(
                f'https://dailymed.nlm.nih.gov/dailymed/getFile.cfm?setid={setid}&type=zip&version={v}', headers={'User-Agent': UA}), timeout=300).read()))
            open(p, 'wb').write(z.read([n for n in z.namelist() if n.endswith('.xml')][0]))
    return p


def pub(d):
    return datetime.datetime.strptime(d, '%b %d, %Y').date().isoformat()


# purpose: hero = current label for the hero cards; replay = every version in the reopen replay window
SPL = [
    ('hero', 'Ozempic', 'adec4fd2-6858-4c99-91d4-531f5f2a2d79', 'semaglutide'),
    ('hero', 'Rybelsus', '27f15fac-7d98-4114-a2ec-92494a91da98', 'semaglutide'),
    ('hero', 'Wegovy', 'ee06186f-2aa3-4990-a760-757579d8f77b', 'semaglutide'),
    ('hero', 'Zoloft', 'fda754f6-d0f3-4dce-a17a-927d64f912f7', 'sertraline'),
    ('hero', 'Prozac', 'c88f33ed-6dfb-4c5e-bc01-d8e36dd97299', 'fluoxetine'),
    ('replay', 'Yescarta', '9b70606e-b99c-4272-a0f1-b5523cce0c59', 'axicabtagene ciloleucel'),
    ('replay', 'Nubeqa', '1a7cb212-56e4-4b9d-a73d-bfee7fe4735e', 'darolutamide'),
]
REPLAY_FROM = {'Yescarta': '2026-02-01', 'Nubeqa': '2026-04-01'}


def find_setid(product):
    p = dm(f'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name={product.lower()}&pagesize=50', f'search_{product.lower()}.json')
    hits = [x for x in json.load(open(p, encoding='utf-8'))['data'] if product.upper() in x['title'].upper() and 'REMEDYREPACK' not in x['title'].upper()]
    # innovator label: the title starts with the brand name; prefer the shortest title (no repackager suffix)
    hits.sort(key=lambda x: len(x['title']))
    return hits[0]['setid']


# version history only (no sections here: their current labels are in the scoreboard label table), so the agents can
# say which versions they searched and the Skeptic can check for a newer one
VERSIONS_ONLY = [('Depakote', '08a65cf4-7749-4ceb-6895-8f4805e2b01f', 'valproate'), ('Gemcitabine (Hospira)', 'dc02a23b-3ff9-4441-aa91-8e9e629a7315', 'gemcitabine')]
sections, versions = [], []
for product, setid, inn in VERSIONS_ONLY:
    versions += [dict(setid=setid, product=product, inn=inn, version=x['spl_version'], published=pub(x['published_date'])) for x in history(setid)]
for purpose, product, setid, inn in SPL:
    setid = setid or find_setid(product)
    h = history(setid)
    for x in h:
        versions.append(dict(setid=setid, product=product, inn=inn, version=x['spl_version'], published=pub(x['published_date'])))
    cur = max(h, key=lambda x: x['spl_version'])
    want = [cur] if purpose == 'hero' else [x for x in h if pub(x['published_date']) >= REPLAY_FROM[product]] + \
        [max([x for x in h if pub(x['published_date']) < REPLAY_FROM[product]], key=lambda x: x['spl_version'])]
    for x in sorted(want, key=lambda x: x['spl_version']):
        ver, eff, secs = spl_sections(version_xml(setid, x['spl_version'], current=(x is cur)))
        for s2 in secs:
            if purpose == 'replay' and s2['sec_code'] not in ('34066-1', '43685-7', '34084-4', '34071-1', '34070-3'):
                continue  # replay keeps Boxed Warning, Warnings and Precautions, Adverse Reactions, Warnings, Contraindications
            sections.append(dict(setid=setid, product=product, inn=inn, purpose=purpose, version=ver, effective=eff,
                                 published=pub(x['published_date']), **s2))
        print(product, 'v' + ver, eff, len(secs), 'sections', flush=True)


def write(name, rows):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print('wrote', name, len(rows))


write('reg_doc.csv', docs); write('reg_passage.csv', passages); write('sentinel.csv', sent)
write('aems.csv', aems); write('spl_section.csv', sections); write('spl_version.csv', versions)
json.dump({'built': TODAY, 'aems_source': aems_src, 'sentinel_snapshot': snap, 'docs': len(docs), 'passages': len(passages),
           'spl_sections': len(sections), 'aems_rows': len(aems)}, open(os.path.join(OUT, 'build_info.json'), 'w'), indent=1)
