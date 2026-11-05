"""Monthly subscription ("ไฟเขียว พรีเมียม") for the FaiKhiao server.

The Android app (a Trusted Web Activity) buys the subscription through Google Play
Billing. The app sends the Play purchase token here; we ask Google whether it is
active, acknowledge it (Google refunds purchases that are never acknowledged), and
hand back a short session id the app sends with premium requests.

Settings (environment variables):
  PLAY_PACKAGE        Android package name, e.g. com.faikhiao.app
  PLAY_SA_JSON        Google Cloud service-account key (the JSON text) that has
                      access to the app in Play Console
  PREMIUM_DEV=1       testing only: grant premium without Google (never in production)
"""
import json, os, secrets, time, urllib.parse, urllib.request

PACKAGE = os.environ.get('PLAY_PACKAGE', 'com.faikhiao.app')
SKUS = {'faikhiao_monthly'}
DEV = os.environ.get('PREMIUM_DEV') == '1'
API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE


def init(db):
    db.execute('''CREATE TABLE IF NOT EXISTS premium (session TEXT PRIMARY KEY, purchase_token TEXT,
                  sku TEXT, expires REAL, created REAL)''')
    db.commit()


def session_valid(db, session):
    if not session:
        return False
    row = db.execute('SELECT expires FROM premium WHERE session=?', [session]).fetchone()
    return bool(row and row[0] > time.time())


_token_cache = [None, 0]

def _google_token():
    """OAuth access token for the service account (needs the google-auth package)."""
    if _token_cache[0] and _token_cache[1] > time.time() + 60:
        return _token_cache[0]
    from google.oauth2 import service_account               # installed on the server via requirements.txt
    import google.auth.transport.requests
    info = json.loads(os.environ['PLAY_SA_JSON'])
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=['https://www.googleapis.com/auth/androidpublisher'])
    creds.refresh(google.auth.transport.requests.Request())
    _token_cache[:] = [creds.token, creds.expiry.timestamp() if creds.expiry else time.time() + 1800]
    return creds.token


def _call(url, method='GET', body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + _google_token(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def check_with_google(purchase_token, sku):
    """Returns expiry (unix seconds) if the subscription is active, else None."""
    q = urllib.parse.quote(purchase_token, safe='')
    sub = _call(f'{API}/purchases/subscriptionsv2/tokens/{q}')
    if sub.get('subscriptionState') not in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'):
        return None
    if sub.get('acknowledgementState') == 'ACKNOWLEDGEMENT_STATE_PENDING':
        _call(f'{API}/purchases/subscriptions/{urllib.parse.quote(sku)}/tokens/{q}:acknowledge', 'POST', {})
    expiries = [li.get('expiryTime') for li in sub.get('lineItems', []) if li.get('expiryTime')]
    if not expiries:
        return None
    from datetime import datetime
    return max(datetime.fromisoformat(e.replace('Z', '+00:00')).timestamp() for e in expiries)


def verify(db, purchase_token, sku):
    """Check a Play purchase and return {'session', 'expires'} or raise ValueError."""
    if sku not in SKUS or not purchase_token or len(purchase_token) > 2000:
        raise ValueError('bad purchase')
    if DEV and purchase_token.startswith('dev-'):
        expires = time.time() + 30 * 86400
    elif not os.environ.get('PLAY_SA_JSON'):
        raise ValueError('billing not configured on server')
    else:
        expires = check_with_google(purchase_token, sku)
        if not expires:
            raise ValueError('subscription not active')
    row = db.execute('SELECT session FROM premium WHERE purchase_token=?', [purchase_token]).fetchone()
    session = row[0] if row else secrets.token_urlsafe(24)
    db.execute('INSERT OR REPLACE INTO premium VALUES (?,?,?,?,?)', [session, purchase_token, sku, expires, time.time()])
    db.commit()
    return {'session': session, 'expires': expires}


def assetlinks():
    """Digital Asset Links: proves the Android app and this website belong together,
    so the app opens full-screen without a browser bar."""
    # upload key of the first build; add Google Play's app-signing key (Play Console > App integrity) via ASSETLINKS_SHA256
    default = '95:DB:63:C0:91:C6:2B:EA:32:C5:3C:B8:77:F3:86:E6:46:BD:E0:C9:F0:EF:41:A9:C1:8F:0B:B8:75:4D:19:12'
    fps = [f.strip() for f in (os.environ.get('ASSETLINKS_SHA256', '') + ',' + default).split(',') if f.strip()]
    return [{'relation': ['delegate_permission/common.handle_all_urls'],
             'target': {'namespace': 'android_app', 'package_name': PACKAGE, 'sha256_cert_fingerprints': fps}}]
