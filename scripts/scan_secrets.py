"""Before any commit: no secret value (from .env and data/private) may appear in a file git would publish.
Prints only file names and which kind of secret matched, never the value. Exit 1 on any hit.
Usage: python -I scripts/scan_secrets.py"""
import os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zhelp import E, ROOT, PRIV

secrets = {k: v for k, v in E.items() if any(t in k for t in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) and len(v) >= 6}
for f in (PRIV.glob('*PRIVATE*') if PRIV.exists() else []):
    v = f.read_text(encoding='utf-8', errors='replace').strip()
    if len(v) >= 6:
        secrets[f.name] = v
files = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT, capture_output=True).stdout.decode('utf-8').split('\0')
hits = 0
for rel in filter(None, files):
    p = ROOT / rel
    if not p.is_file():
        continue
    try:
        data = p.read_bytes().decode('utf-8', 'replace')
    except OSError:
        continue
    for name, v in secrets.items():
        if v in data:
            print('SECRET', name, 'in', rel); hits += 1
    if re.search(r'awsSecretAccessKey\s+\\?"(?!<redacted>|\{)[^"\\]+', data) and not rel.endswith('scan_secrets.py'):
        print('SECRET S3 key literal in', rel); hits += 1
print(f'scanned {len([f for f in files if f])} files, {len(secrets)} secret values, {hits} hits')
sys.exit(1 if hits else 0)
