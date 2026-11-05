"""Check the estimator: simulate cars at lights with KNOWN timings, compare estimate vs truth."""
import random, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import estimate

def simulate(cycle, green, g0, minutes, cars_per_min, manual_taps=0, seed=0):
    rnd = random.Random(seed); ev = []; t = g0 + rnd.random() * cycle
    end = t + minutes * 60; queue_at = {}
    while t < end:
        t += rnd.expovariate(cars_per_min / 60)
        ph = (t - g0) % cycle
        if ph < green - 2:                       # arrives on green: drives through
            ev.append(('pass', t + rnd.uniform(0, 3)))
        else:                                    # arrives on red: stops, waits in queue
            ev.append(('stop', t + rnd.uniform(0, 2)))
            next_green = t + (cycle - ph)
            pos = queue_at.get(round(next_green), 0); queue_at[round(next_green)] = pos + 1
            ev.append(('go', next_green + 2 + 2.2 * pos + rnd.gauss(0, 0.7)))
    for _ in range(manual_taps):
        k = rnd.randrange(int(minutes * 60 / cycle))
        ev.append(('green', g0 + k * cycle + rnd.gauss(1.5, 1)))
    return [e for e in ev if e[1] < end]

def err_now(est, cycle, green, g0, now):
    true_left = cycle - ((now - g0) % cycle)              # seconds to next green start
    est_left = est['cycle'] - ((now - est['g0']) % est['cycle'])
    d = (est_left - true_left + cycle / 2) % cycle - cycle / 2
    return d

if __name__ == '__main__':
  cases = [  # cycle, green, minutes, cars/min, taps
      (120, 50, 30, 6, 0), (180, 70, 45, 8, 0), (90, 35, 20, 4, 0), (150, 40, 60, 2, 0),
      (60, 25, 15, 5, 0), (200, 90, 40, 10, 0), (120, 50, 8, 3, 0), (140, 60, 20, 2, 3),
  ]
  for i, (C, G, mins, rate, taps) in enumerate(cases):
      g0 = 1_700_000_000 + i * 37.3
      ev = simulate(C, G, g0, mins, rate, taps, seed=i)
      est = estimate(ev)
      if not est:
          print(f'C={C:3} G={G:2} {mins:2}min {rate}/min events={len(ev):3} -> no estimate yet'); continue
      now = max(t for _, t in ev) + 120          # predict 2 minutes after the last report
      print(f'C={C:3} G={G:2} {mins:2}min {rate}/min events={len(ev):3} -> cycle {est["cycle"]:6} green {est["green"]:5} '
            f'conf {est["conf"]:.2f}  countdown error now: {err_now(est, C, G, g0, now):+.1f}s')
