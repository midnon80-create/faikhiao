"""TrafficLight Map backend.

Serves the web app and learns real traffic-light timings from what app users report
(floating-car method, the same idea map apps in China use for red-light countdowns):

  * 'go'    - a car that was waiting at the light started moving   -> green just began (+ reaction/queue delay)
  * 'stop'  - a car came to a stop in front of the light           -> light was red at that moment
  * 'pass'  - a car drove through the junction without stopping    -> light was green at that moment
  * 'green' / 'red' - a user tapped "the light just turned green/red"

Only (signal id, approach direction, event kind, time) is stored - never a GPS track.

Run:  python server.py            (http://localhost:8765)
      python server.py --reset    (delete all collected events)
"""
import json, math, os, sqlite3, sys, threading, time
import floods_routes as fr
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('DATA_DIR', ROOT)          # point at a persistent disk in the cloud
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'signals.db')
PORT = int(os.environ.get('PORT', 8765))

WINDOW = 3 * 3600          # only the last 3 h of reports count (signal plans change during the day)
REACTION = 2.0             # first car moves ~2 s after green
MIN_CYCLE, MAX_CYCLE = 30, 240
KINDS = {'go', 'stop', 'pass', 'green', 'red'}

db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS ev (node INTEGER, dir INTEGER, kind TEXT, t REAL, src TEXT)')
db.execute('CREATE INDEX IF NOT EXISTS ev_nd ON ev(node, dir, t)')
fr.init(db)
try:   # signal positions, used to count traffic lights along a route
    SIGNALS = [(e['lat'], e['lon']) for e in json.load(open(os.path.join(ROOT, 'bangkok.json'), encoding='utf-8'))['el'] if e['t'] == 'n']
except Exception:
    SIGNALS = []
db.commit()


# ---------------------------------------------------------------- estimator
def _resultant(times, c):
    """How tightly the event times line up when folded by cycle length c (0..1)."""
    sx = sy = 0.0
    for t in times:
        a = 2 * math.pi * (t % c) / c
        sx += math.cos(a); sy += math.sin(a)
    return math.hypot(sx, sy) / len(times)


def _pct(vals, p):
    v = sorted(vals)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def estimate(events):
    """events: list of (kind, t). Returns dict or None.

    1. Green-start anchors = manual 'green' taps and 'go' events (minus reaction delay).
    2. Cycle length = the period that makes the anchors line up best (periodogram).
       Shorter divisors of the true cycle line up equally well, so take the LONGEST
       period that is within 5% of the best score; longer multiples score worse.
    3. Green start = early edge of the anchor cluster (queued cars start late, never early).
    4. Green length = from manual 'red' taps, else the boundary between 'pass' (green)
       and 'stop' (red) events.
    """
    anchors = [t for k, t in events if k == 'green'] + [t - REACTION for k, t in events if k == 'go']
    if len(anchors) < 4:
        return None
    span = max(anchors) - min(anchors)
    max_c = min(MAX_CYCLE, span / 2)          # need to see at least two cycles
    if max_c < MIN_CYCLE:
        return None

    scores = [(c, _resultant(anchors, c)) for c in range(MIN_CYCLE, int(max_c) + 1)]
    best = max(s for _, s in scores)
    if best < 0.6:
        return None
    c0 = max(c for c, s in scores if s >= 0.95 * best)
    # Group anchors by cycle, keep the EARLIEST one per cycle (the first car in the queue,
    # or a manual tap), then fit  t = a + k * cycle  by least squares for a precise cycle.
    sx = sum(math.cos(2 * math.pi * (t % c0) / c0) for t in anchors)
    sy = sum(math.sin(2 * math.pi * (t % c0) / c0) for t in anchors)
    mu = (math.atan2(sy, sx) / (2 * math.pi) * c0) % c0
    first = {}
    for t in anchors:
        k = round((t - mu) / c0)
        first[k] = min(first.get(k, t), t)
    pts = sorted(first.items())
    if len(pts) < 3:
        return None

    def fit(points):
        n = len(points); mk = sum(k for k, _ in points) / n; mt = sum(t for _, t in points) / n
        var = sum((k - mk) ** 2 for k, _ in points)
        c = sum((k - mk) * (t - mt) for k, t in points) / var if var else c0
        return c, mt - c * mk

    cycle, a = fit(pts)
    res = [t - (a + k * cycle) for k, t in pts]
    mad = _pct([abs(x) for x in res], 0.5) or 1.0
    kept = [p for p, x in zip(pts, res) if abs(x) <= max(4.0, 3 * mad)]
    if len(kept) >= 3:
        cycle, a = fit(kept)
        res = [t - (a + k * cycle) for k, t in kept]
    if not (MIN_CYCLE * 0.9 <= cycle <= MAX_CYCLE * 1.1):
        return None
    spread = (sum(x * x for x in res) / len(res)) ** 0.5
    kmax = max(k for k, _ in kept)
    g0 = a + kmax * cycle                                   # most recent green start
    r = math.exp(-spread / 4)                               # 1 = first cars line up perfectly

    rel = lambda t: (t - g0) % cycle
    reds = [rel(t) for k, t in events if k == 'red']
    stops = [rel(t) for k, t in events if k == 'stop']
    passes = [rel(t) for k, t in events if k == 'pass']
    green_known = True
    if len(reds) >= 2:
        green = _pct(reds, 0.5)
    elif stops and passes:
        green = (_pct(passes, 0.95) + _pct(stops, 0.05)) / 2
    elif len(stops) >= 3:
        green = _pct(stops, 0.05)
    elif len(passes) >= 3:
        green = _pct(passes, 0.95)
    else:
        green, green_known = cycle * 0.45, False
    green = max(8.0, min(cycle - 8.0, green))

    n = len(events)
    conf = r * best * (1 - math.exp(-len(kept) / 4)) * (1.0 if green_known else 0.7)
    return {'cycle': round(cycle, 2), 'g0': round(g0, 2), 'green': round(green, 1),
            'conf': round(conf, 2), 'n': n, 'greenKnown': green_known, 'last': round(max(t for _, t in events))}


_cache = {}     # (node, dir) -> (expires, count, result)

def estimates_for(nodes):
    now = time.time()
    out = {}
    with db_lock:
        rows = db.execute(
            f'SELECT node, dir, kind, t FROM ev WHERE t > ? AND node IN ({",".join("?" * len(nodes))})',
            [now - WINDOW, *nodes]).fetchall()
    groups = {}
    for node, d, kind, t in rows:
        groups.setdefault((node, d), []).append((kind, t))
    for key, evs in groups.items():
        hit = _cache.get(key)
        if hit and hit[0] > now and hit[1] == len(evs):
            res = hit[2]
        else:
            res = estimate(evs)
            _cache[key] = (now + 15, len(evs), res)
        if res:
            out.setdefault(str(key[0]), {})[str(key[1])] = res
    return out


# ---------------------------------------------------------------- http
_rate = {}      # ip -> [window_start, count]
PUBLIC = {'/', '/index.html', '/app.css', '/app.js', '/bangkok.json', '/favicon.svg', '/manifest.json'}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if args and '/api/' in str(args[0]):
            return
        super().log_message(fmt, *args)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 200_000:
            raise ValueError('too large')
        return json.loads(self.rfile.read(n) or b'null')

    def do_GET(self):
        if self.path.startswith('/api/time'):
            return self._json(200, {'t': time.time()})
        if self.path.startswith('/api/floods'):
            with db_lock:
                return self._json(200, fr.active_floods(db))
        if self.path == '/healthz':
            return self._json(200, {'ok': True})
        # serve only the app's own files, nothing else from the folder
        if self.path.split('?')[0] not in PUBLIC:
            return self.send_error(404)
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def ip(self):
        # behind a cloud proxy the real client is the first X-Forwarded-For entry
        fwd = self.headers.get('X-Forwarded-For')
        return fwd.split(',')[0].strip() if fwd else self.client_address[0]

    def do_POST(self):
        try:
            data = self._body()
        except Exception:
            return self._json(400, {'error': 'bad json'})
        if self.path == '/api/events':
            return self._events(data)
        if self.path == '/api/estimates':
            nodes = [int(x) for x in (data or {}).get('nodes', [])[:600] if str(x).isdigit()]
            return self._json(200, estimates_for(nodes) if nodes else {})
        try:
            if self.path == '/api/floods':
                lat, lon, lv = float(data['lat']), float(data['lon']), int(data['level'])
                if not (lv in fr.LEVELS and -90 < lat < 90 and -180 < lon < 180):
                    return self._json(400, {'error': 'bad flood'})
                if not self._allow(20):
                    return self._json(429, {'error': 'rate limit'})
                with db_lock:
                    return self._json(200, {'id': fr.report_flood(db, lat, lon, lv)})
            if self.path == '/api/floods/vote':
                if not self._allow(20):
                    return self._json(429, {'error': 'rate limit'})
                with db_lock:
                    fr.vote_flood(db, int(data['id']), bool(data['still']))
                return self._json(200, {'ok': True})
            if self.path == '/api/route':
                frm = (float(data['from'][0]), float(data['from'][1])); to = (float(data['to'][0]), float(data['to'][1]))
                with db_lock:
                    floods = fr.active_floods(db)
                return self._json(200, fr.plan_routes(floods, frm, to, SIGNALS))
        except (KeyError, TypeError, ValueError):
            return self._json(400, {'error': 'bad request'})
        except Exception as e:
            return self._json(502, {'error': 'routing failed: ' + str(e)[:100]})
        self._json(404, {'error': 'not found'})

    def _allow(self, n):
        ip = self.ip(); now = time.time()
        w = _rate.setdefault('f' + ip, [now, 0])
        if now - w[0] > 3600:
            w[:] = [now, 0]
        w[1] += 1
        return w[1] <= n

    def _events(self, data):
        ip = self.ip()
        now = time.time()
        w = _rate.setdefault(ip, [now, 0])
        if now - w[0] > 3600:
            w[:] = [now, 0]
        evs = (data or {}).get('events', [])[:50]
        src = str((data or {}).get('src', ''))[:40]
        ok = []
        for e in evs:
            try:
                node, d, kind, t = int(e['node']), int(e['dir']), str(e['kind']), float(e['t'])
            except Exception:
                continue
            if kind in KINDS and 0 <= d <= 3 and abs(now - t) < 180:   # reject stale or future reports
                ok.append((node, d, kind, t, src))
        if w[1] + len(ok) > 1500:
            return self._json(429, {'error': 'rate limit'})
        w[1] += len(ok)
        if ok:
            with db_lock:
                db.executemany('INSERT INTO ev VALUES (?,?,?,?,?)', ok)
                db.execute('DELETE FROM ev WHERE t < ?', [now - 7 * 86400])
                db.commit()
        self._json(200, {'saved': len(ok)})


if __name__ == '__main__':
    if '--reset' in sys.argv:
        with db_lock:
            db.execute('DELETE FROM ev'); db.commit()
        print('all events deleted'); sys.exit(0)
    print(f'TrafficLight Map on http://localhost:{PORT}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
