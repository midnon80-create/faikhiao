"""Seed / remove simulated driver reports for one light (testing only).
   python tools/demo_seed.py <node>     seed 30 min of fake drivers, cycle 120 s, green 50 s
   python tools/demo_seed.py --remove   delete all seeded rows"""
import sqlite3, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_test import simulate
db = sqlite3.connect(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'signals.db'))
if sys.argv[1] == '--remove':
    n = db.execute("DELETE FROM ev WHERE src='demo-sim'").rowcount; db.commit(); print('removed', n); sys.exit()
node, now = int(sys.argv[1]), time.time()
C, G = 120, 50
g0 = now - 30 * 60 - 7                       # true timing: a green started at g0 + k*120
ev = [e for e in simulate(C, G, g0, 31, 5, seed=3) if e[1] < now]
db.executemany("INSERT INTO ev VALUES (?,?,?,?,'demo-sim')", [(node, 0, k, t) for k, t in ev]); db.commit()
rel = (now - g0) % C
print(f'seeded {len(ev)} events. TRUE state now: ' + (f'green, {G-3-rel:.0f}s left' if rel < G-3 else f'yellow' if rel < G else f'red, {C-rel:.0f}s left'))
print('true g0 =', g0)
