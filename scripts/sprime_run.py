"""S' comparison arm (OFFLINE ONLY, never on the product path): an OpenAI reasoning model with web search answers the
same 39 set-1a questions our agents answer. Same question text for both arms: ingredient, EU signal, PRAC month and the
same representative U.S. product. Output: out/sprime_answers.json (answers + cited URLs + quoted label text).
The key is read from ../.env and never printed or written. Usage: python -I scripts/sprime_run.py [MODEL]"""
import json, os, sys, time, urllib.request, urllib.error, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
MODEL = sys.argv[1] if len(sys.argv) > 1 else 'gpt-5.5'
E = {}
for p in (os.path.join(ROOT, '..', '.env'), os.path.join(ROOT, '.env')):
    if os.path.exists(p):
        for l in open(p, encoding='utf-8'):
            l = l.strip()
            if l and not l.startswith('#') and '=' in l:
                k, v = l.split('=', 1); E[k.strip()] = v.strip().strip('"').strip("'")
KEY = E.get('OPENAI_API_KEY', '')
KEYS = json.load(open(os.path.join(ROOT, 'sample', 'scoreboard', 'set1a_questions.json'), encoding='utf-8'))
RAW = os.path.join(ROOT, 'runs', 'sprime'); os.makedirs(RAW, exist_ok=True)

PROMPT = """You are helping a hospital medication-safety pharmacist. Today is 2026-10-24.
The EU PRAC (EMA safety committee) recommended a product-information update for {inn} about: "{signal}" (PRAC meeting {month}).
Question: Does the CURRENT U.S. prescribing information for {product} mention this adverse reaction, and where?
Classify the U.S. label as exactly one of:
- written: in Boxed Warning, Warnings and Precautions, Warnings, Precautions or Contraindications
- partial: only in Adverse Reactions / Postmarketing, dosage-modification tables, Use in Specific Populations, or patient information
- not found: not mentioned (or only as a symptom of a different syndrome / a pre-existing condition)
- not marketed: no U.S.-approved product
Also say, in one short line each: where the EU stands, where the UK MHRA stands, and whether the FDA has any public evaluation (for example the FAERS/AEMS potential-signals list or a Sentinel study).
Search the web (DailyMed, FDA, EMA, GOV.UK). Quote the exact U.S. label sentence you rely on (or empty if none).
Reply with ONE JSON object only:
{{"us_status":"written|partial|not found|not marketed","label_product":"...","label_version_or_date":"...","label_section":"...","quote":"exact label sentence or empty","eu":"...","uk":"...","us_regulator":"...","sources":["url", "..."]}}"""


def ask(q):
    f = os.path.join(RAW, f"{q['id']}_{MODEL}.json")
    if os.path.exists(f):
        return json.load(open(f, encoding='utf-8'))
    body = {'model': MODEL, 'tools': [{'type': 'web_search'}], 'reasoning': {'effort': 'medium'},
            'input': PROMPT.format(inn=q['inn'], signal=q['signal'], month=q['prac_meeting'], product=q['product'] or q['inn'] + ' (any U.S. product)')}
    last = ''
    for attempt in range(4):
        t0 = time.time()
        try:
            req = urllib.request.Request('https://api.openai.com/v1/responses', data=json.dumps(body).encode(), method='POST',
                                         headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=900) as r:
                out = json.loads(r.read().decode('utf-8'))
            text = ''.join(c.get('text', '') for it in out.get('output', []) if it.get('type') == 'message' for c in it.get('content', []))
            urls = sorted({a.get('url') for it in out.get('output', []) if it.get('type') == 'message' for c in it.get('content', [])
                           for a in c.get('annotations', []) or [] if a.get('url')})
            rec = {'id': q['id'], 'model_requested': MODEL, 'model_served': out.get('model'), 'secs': round(time.time() - t0, 1),
                   'usage': out.get('usage'), 'text': text, 'annotation_urls': urls, 'at': time.strftime('%Y-%m-%dT%H:%M:%S')}
            json.dump(rec, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print(q['id'], 'ok', rec['secs'], flush=True)
            return rec
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code} ' + e.read().decode('utf-8', 'replace')[:300]
        except Exception as e:
            last = f'{type(e).__name__}: {str(e)[:200]}'
        print(q['id'], 'retry', attempt + 1, last[:160], flush=True)
        time.sleep(20 * (attempt + 1))
    return {'id': q['id'], 'error': last}


def parse(rec):
    t = rec.get('text') or ''
    s = t.replace('```json', '').replace('```', '')
    i, j = s.find('{'), s.rfind('}')
    try:
        return json.loads(s[i:j + 1])
    except Exception:
        return None


if __name__ == '__main__':
    if not KEY:
        raise SystemExit('OPENAI_API_KEY not set (S\' is an offline comparison only)')
    with cf.ThreadPoolExecutor(3) as ex:
        recs = list(ex.map(ask, KEYS['questions']))
    out = []
    for q, r in zip(KEYS['questions'], recs):
        a = parse(r) if 'error' not in r else None
        out.append({'id': q['id'], 'model_served': r.get('model_served'), 'answer': a, 'annotation_urls': r.get('annotation_urls', []), 'error': r.get('error')})
    json.dump({'arm': "S' (OpenAI reasoning model + web search; offline comparison only)", 'model_requested': MODEL,
               'run_at': time.strftime('%Y-%m-%d'), 'answers': out}, open(os.path.join(ROOT, 'out', 'sprime_answers.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('done', sum(1 for o in out if o['answer']), 'parsed of', len(out))
