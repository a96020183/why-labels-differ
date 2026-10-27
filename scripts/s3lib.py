"""Minimal S3 SigV4 PUT (stdlib only) for the local S3-compatible store (SeaweedFS). Secret from data/private, never printed."""
import datetime, hashlib, hmac, pathlib, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
AK, REGION = 'aprimekey', 'us-east-1'


def _req(ep, method, path, body=b''):
    sk = (ROOT / 'data' / 'private' / 's3_secret_PRIVATE.txt').read_text().strip()
    host = ep.split('://')[1]
    now = datetime.datetime.utcnow(); amz = now.strftime('%Y%m%dT%H%M%SZ'); ds = now.strftime('%Y%m%d')
    ph = hashlib.sha256(body).hexdigest()
    canon = f"{method}\n{path}\n\nhost:{host}\nx-amz-content-sha256:{ph}\nx-amz-date:{amz}\n\nhost;x-amz-content-sha256;x-amz-date\n{ph}"
    scope = f'{ds}/{REGION}/s3/aws4_request'
    sts = f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
    k = ('AWS4' + sk).encode()
    for m in (ds, REGION, 's3', 'aws4_request'):
        k = hmac.new(k, m.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    h = {'x-amz-date': amz, 'x-amz-content-sha256': ph,
         'Authorization': f'AWS4-HMAC-SHA256 Credential={AK}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}'}
    try:
        with urllib.request.urlopen(urllib.request.Request(ep + path, data=body if method == 'PUT' else None, method=method, headers=h), timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return f'{e.code} {e.read()[:200]!r}'


def put(ep, bucket, key, data):
    _req(ep, 'PUT', f'/{bucket}')
    return _req(ep, 'PUT', f'/{bucket}/{key}', data)
