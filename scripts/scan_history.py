"""Scan every object git holds (all commits, all blobs, unreachable ones included). Prints only object ids, file names
and which check matched, never a matched value. Exit 1 on any hit. Usage (from a_prime): python -I scripts/scan_history.py

Checks that need nothing from this machine (they run the same in a clean clone):
  1. key shapes: NVIDIA (nvapi-), OpenAI (sk-...), AWS access key ids, GitHub and Slack tokens, private-key blocks, a
     bearer token, a KEY/TOKEN/SECRET/PASSWORD assignment with a real-looking value, a literal S3 secret in Zetaris SQL
  2. local paths: a Windows drive path or a user home directory (C:/..., C:\\..., /Users/<name>/, /home/<name>/)
  3. internal working notes (they are in Chinese): any file name with Chinese characters, and Chinese text in any text file
Check that needs this machine (skipped, and said so, in a clean clone):
  4. the exact secret values in .env and data/private/"""
import os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zhelp import E, ROOT, PRIV

secrets = {k: v for k, v in E.items() if any(t in k for t in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) and len(v) >= 6}
for f in (PRIV.glob('*PRIVATE*') if PRIV.exists() else []):
    v = f.read_text(encoding='utf-8', errors='replace').strip()
    if len(v) >= 6:
        secrets[f.name] = v

PLACEHOLDER = r'(?!<|\$\{|\{|your|optional|changeme|xxx|\.\.\.|process\.env|env\(|E\[|os\.environ|[A-Za-z_]{1,12}\.[A-Za-z_])'
SHAPES = {
    'NVIDIA key': re.compile(r'\bnvapi-[A-Za-z0-9_-]{20,}'),
    'OpenAI key': re.compile(r'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}'),
    'AWS access key id': re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    'GitHub token': re.compile(r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}'),
    'Slack token': re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{20,}'),
    'private key block': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'bearer token': re.compile(r'\bBearer\s+' + PLACEHOLDER + r'[A-Za-z0-9._~+/-]{24,}'),
    'secret assignment': re.compile(r'\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["\']?' + PLACEHOLDER + r'[A-Za-z0-9._~+/=-]{16,}'),
    'S3 secret in SQL': re.compile(r'awsSecretAccessKey\s+\\?"(?!<redacted>|\{)[^"\\]{8,}'),
}
LOCAL = re.compile(r'(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}(?:Users|2026|Documents|Desktop|[^\s"\'<>|*?:\\/]*[\u4e00-\u9fff])|/(?:Users|home)/(?!<|runner/|USER|user/|\$)[A-Za-z0-9._-]+/')
CJK = re.compile(r'[\u3400-\u9fff\uf900-\ufaff]')
SELF = 'scripts/scan_history.py'

git = lambda *a: subprocess.run(['git', *a], cwd=ROOT, capture_output=True)
listing = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').stdout.decode().split('\n')
blobs = [l.split()[0] for l in listing if l.endswith(' blob')]
commits = [c for c in git('rev-list', '--all').stdout.decode().split() if c]
# which path(s) each blob was committed under, so a hit names a file (and the scanner's own patterns are not hits)
paths, names = {}, set()
for c in commits:
    for ln in git('ls-tree', '-r', '-z', c).stdout.decode('utf-8', 'replace').split('\0'):
        if '\t' in ln:
            meta, name = ln.split('\t', 1); oid = meta.split()[2]
            paths.setdefault(oid, set()).add(name); names.add(name)
hits = {'secret value': 0, **{k: 0 for k in SHAPES}, 'local path': 0, 'Chinese file name': 0, 'Chinese text': 0}
BINARY = ('.png', '.jpg', '.jpeg', '.gif', '.pdf', '.xlsx', '.xls', '.zip', '.gz', '.bundle', '.woff', '.woff2', '.ico')
for oid in blobs:
    where = sorted(paths.get(oid, {'(unreachable)'}))
    if where == [SELF]:
        continue
    data = git('cat-file', '-p', oid).stdout.decode('utf-8', 'replace')
    for name, v in secrets.items():
        if v in data:
            print('secret value', name, 'in', oid, where[0]); hits['secret value'] += 1
    for kind, rx in SHAPES.items():
        if rx.search(data):
            print(kind, 'in', oid, where[0]); hits[kind] += 1
    if LOCAL.search(data):
        print('local path in', oid, where[0]); hits['local path'] += 1
    if not all(w.lower().endswith(BINARY) for w in where) and chr(0) not in data[:4096] and CJK.search(data):
        print('Chinese text in', oid, where[0]); hits['Chinese text'] += 1
for n in sorted(names):
    if CJK.search(n):
        print('Chinese file name in history:', n); hits['Chinese file name'] += 1
total = sum(hits.values())
print(f'{len(commits)} commit(s), {len(blobs)} blob(s), {len(names)} file name(s) scanned')
print(f'  key shapes ({len(SHAPES)} kinds): {sum(hits[k] for k in SHAPES)} hit(s); local paths: {hits["local path"]}; Chinese file names: {hits["Chinese file name"]}; Chinese text: {hits["Chinese text"]}')
print('  exact secret values: ' + (f'{len(secrets)} value(s) from .env / data/private: {hits["secret value"]} hit(s)' if secrets
      else 'skipped, no .env or data/private on this machine (a clean clone); the checks above still ran'))
print(f'{total} hit(s)')
sys.exit(1 if total else 0)
