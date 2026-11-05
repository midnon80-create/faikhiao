"""Flood reports + flood-aware routing for the FaiKhiao server.

Floods: users report a spot and a depth level; reports near each other merge,
expire after 6 h, and can be cleared by other users ("the water is gone").

Routing: Valhalla (open-source router, public FOSSGIS server) gives the normal
routes; if they cross a flood we ask again with the flooded spots excluded, so the
user gets "fastest" and "least flooding" options side by side.
"""
import json, math, os, time, urllib.request

LEVELS = {1: 'น้ำท่วมขัง (รถผ่านได้)', 2: 'ท่วมสูง (รถเล็กเสี่ยง)', 3: 'ผ่านไม่ได้'}
FLOOD_TTL = 6 * 3600
MERGE_M = 60
VALHALLA = 'https://valhalla1.openstreetmap.de/route'
UA = 'faikhiao-prototype/0.1'


def dist_m(a, b):
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    y = math.radians(b[0] - a[0])
    return math.hypot(x, y) * 6371000


def init(db):
    db.execute('''CREATE TABLE IF NOT EXISTS flood (id INTEGER PRIMARY KEY, lat REAL, lon REAL, level INTEGER,
                  t REAL, first_t REAL, confirms INTEGER, clears INTEGER)''')
    db.commit()


def active_floods(db):
    rows = db.execute('SELECT id, lat, lon, level, t, first_t, confirms, clears FROM flood WHERE t > ?',
                      [time.time() - FLOOD_TTL]).fetchall()
    return [dict(id=r[0], lat=r[1], lon=r[2], level=r[3], t=r[4], first_t=r[5], confirms=r[6], clears=r[7])
            for r in rows if r[7] < max(2, r[6])]          # enough "water is gone" votes hides it


def report_flood(db, lat, lon, level):
    now = time.time()
    for f in active_floods(db):
        if dist_m((lat, lon), (f['lat'], f['lon'])) < MERGE_M:
            db.execute('UPDATE flood SET level=?, t=?, confirms=confirms+1, clears=0 WHERE id=?', [level, now, f['id']])
            db.commit()
            return f['id']
    cur = db.execute('INSERT INTO flood (lat, lon, level, t, first_t, confirms, clears) VALUES (?,?,?,?,?,1,0)',
                     [lat, lon, level, now, now])
    db.commit()
    return cur.lastrowid


def vote_flood(db, fid, still_flooded):
    if still_flooded:
        db.execute('UPDATE flood SET t=?, confirms=confirms+1 WHERE id=?', [time.time(), fid])
    else:
        db.execute('UPDATE flood SET clears=clears+1 WHERE id=?', [fid])
    db.commit()


# ---------------------------------------------------------------- routing
_TH = {1: 'ออกเดินทาง', 2: 'ออกเดินทาง', 3: 'ออกเดินทาง', 4: 'ถึงที่หมาย', 5: 'ถึงที่หมาย (ทางขวา)', 6: 'ถึงที่หมาย (ทางซ้าย)',
       7: 'ตรงไป', 8: 'ตรงไป', 9: 'เบี่ยงขวา', 10: 'เลี้ยวขวา', 11: 'เลี้ยวขวาหักศอก', 12: 'กลับรถ', 13: 'กลับรถ',
       14: 'เลี้ยวซ้ายหักศอก', 15: 'เลี้ยวซ้าย', 16: 'เบี่ยงซ้าย', 17: 'ขึ้นทางลาดตรงไป', 18: 'ขึ้นทางลาดด้านขวา',
       19: 'ขึ้นทางลาดด้านซ้าย', 20: 'ออกทางขวา', 21: 'ออกทางซ้าย', 22: 'ตรงไป', 23: 'ชิดขวา', 24: 'ชิดซ้าย',
       25: 'รวมเข้าเส้นทาง', 26: 'เข้าวงเวียน', 27: 'ออกจากวงเวียน', 28: 'ขึ้นเรือข้ามฟาก', 29: 'ลงจากเรือข้ามฟาก',
       37: 'รวมเข้าทางขวา', 38: 'รวมเข้าทางซ้าย'}


def thai_step(m):
    verb = _TH.get(m.get('type'), 'ไปต่อ')
    names = m.get('street_names') or m.get('begin_street_names') or []
    if m.get('type') == 26 and m.get('roundabout_exit_count'):
        verb += f" ออกทางออกที่ {m['roundabout_exit_count']}"
    if names and m.get('type') not in (4, 5, 6):
        return f"{verb} เข้าสู่ {names[0]}" if m.get('type') not in (1, 2, 3, 7, 8, 22) else f"{verb} ตาม {names[0]}"
    return verb


def _decode(shape, precision=6):
    coords, idx, lat, lon, f = [], 0, 0, 0, 10 ** precision
    while idx < len(shape):
        for which in (0, 1):
            res = shift = 0
            while True:
                b = ord(shape[idx]) - 63; idx += 1
                res |= (b & 0x1f) << shift; shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if which == 0: lat += d
            else: lon += d
        coords.append((lat / f, lon / f))
    return coords


def _valhalla(frm, to, exclude=None):
    body = {'locations': [{'lat': frm[0], 'lon': frm[1]}, {'lat': to[0], 'lon': to[1]}],
            'costing': 'auto', 'alternates': 2, 'units': 'kilometers'}
    if exclude:
        body['exclude_polygons'] = exclude
    req = urllib.request.Request(VALHALLA, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'User-Agent': UA})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=25))
    except urllib.error.HTTPError as e:
        if e.code == 400:          # e.g. no route possible with these exclusions
            return []
        raise
    trips = [data['trip']] + [a['trip'] for a in data.get('alternates', [])]
    out = []
    for trip in trips:
        shape, steps = [], []
        for leg in trip['legs']:
            shape += _decode(leg['shape'])
            steps += [{'text': thai_step(m), 'km': round(m.get('length', 0), 2), 'type': m.get('type')}
                      for m in leg['maneuvers']]
        out.append({'shape': shape, 'steps': steps, 'sec': trip['summary']['time'], 'km': trip['summary']['length']})
    return out


def _near_route(shape, pts, radius):
    """indices of pts lying within radius metres of the route polyline"""
    hits = []
    lats = [p[0] for p in shape]; lons = [p[1] for p in shape]
    pad = radius / 111000 * 1.5
    box = (min(lats) - pad, max(lats) + pad, min(lons) - pad, max(lons) + pad)
    for i, p in enumerate(pts):
        if not (box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3]):
            continue
        for a, b in zip(shape, shape[1:]):
            # distance from p to segment a-b on a local flat projection
            kx = math.cos(math.radians(p[0])) * 111320; ky = 110540
            ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky
            bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            u = 0 if L2 == 0 else max(0, min(1, -(ax * dx + ay * dy) / L2))
            if math.hypot(ax + u * dx, ay + u * dy) <= radius:
                hits.append(i); break
    return hits


def _circle(lat, lon, r_m, n=10):
    pts = []
    for k in range(n + 1):
        a = 2 * math.pi * k / n
        pts.append([lon + r_m * math.sin(a) / (111320 * math.cos(math.radians(lat))), lat + r_m * math.cos(a) / 110540])
    return pts


def plan_routes(floods, frm, to, signals):
    fpts = [(f['lat'], f['lon']) for f in floods]
    routes = _valhalla(frm, to)
    if not routes:
        return {'routes': [], 'error': 'ไม่พบเส้นทาง'}

    # also ask for a route that avoids every flood of level >= 2 near the trip
    lat_lo, lat_hi = sorted([frm[0], to[0]]); lon_lo, lon_hi = sorted([frm[1], to[1]])
    nearby = [f for f in floods if f['level'] >= 2 and lat_lo - 0.05 <= f['lat'] <= lat_hi + 0.05
              and lon_lo - 0.05 <= f['lon'] <= lon_hi + 0.05][:40]
    if nearby and any(_near_route(r['shape'], [(f['lat'], f['lon']) for f in nearby], 40) for r in routes):
        routes += _valhalla(frm, to, [_circle(f['lat'], f['lon'], 70 if f['level'] == 2 else 90) for f in nearby])

    out, seen = [], set()
    for r in routes:
        key = (round(r['sec'] / 20), round(r['km'], 1))
        if key in seen:
            continue
        seen.add(key)
        hit = [floods[i] for i in _near_route(r['shape'], fpts, 40)]
        lights = len(_near_route(r['shape'], signals, 12)) if signals else 0
        out.append({'sec': round(r['sec']), 'km': round(r['km'], 1), 'shape': [[round(a, 6), round(b, 6)] for a, b in r['shape']],
                    'steps': r['steps'], 'floods': [{'id': f['id'], 'level': f['level']} for f in hit],
                    'floodScore': sum(f['level'] ** 2 for f in hit), 'lights': lights})
    fastest = min(out, key=lambda r: r['sec'])
    fastest['tags'] = ['fastest']
    if fastest['floodScore']:
        safest = min(out, key=lambda r: (r['floodScore'], r['sec']))
        if safest is not fastest and safest['floodScore'] < fastest['floodScore']:
            safest['tags'] = safest.get('tags', []) + ['least_flood']
    # best route first: least flooding wins when the fastest one has deep water (level 3)
    out.sort(key=lambda r: (r['floodScore'] >= 9, r['sec']))
    out = out[:3]
    if fastest not in out:            # always show the fastest one too, even if flooded
        out[-1] = fastest
    return {'routes': out, 'floods': len(floods)}
