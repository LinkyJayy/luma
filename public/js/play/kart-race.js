// LumaKart race rules: the track, karts, item boxes, laps and power-ups.
// No DOM here, so the host's browser and the tests can both run it.

import { clamp, ordinal } from './common.js';

export const HALF_W = 125; // half the road's width
export const SAMPLES = 720;
const BASE_SPEED = 560;
const KART_R = 24;
export const ITEMS = {
  double: { sprite: 'double', mul: 1.5, label: 'Double speed' },
  triple: { sprite: 'triple', mul: 2.0, label: 'Triple speed' },
  thunder: { sprite: 'bolt', mul: 2.0, label: 'Thunder' },
};
export const ITEM_CODES = ['double', 'triple', 'thunder'];
const BOOST_SECONDS = 4;
const FREEZE_SECONDS = 5;
export const COUNTDOWN = 3;

// A looping track through the night, as Catmull-Rom control points.
const CONTROL = [
  [0, 0], [700, -60], [1300, -20], [1750, 220], [1900, 700], [1650, 1100], [1150, 1080],
  [850, 800], [500, 900], [420, 1350], [0, 1550], [-550, 1400], [-800, 950], [-600, 550], [-850, 200], [-500, -60],
];

export function buildTrack() {
  const n = CONTROL.length;
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * n;
    const k = Math.floor(t);
    const u = t - k;
    const p0 = CONTROL[(k - 1 + n) % n];
    const p1 = CONTROL[k % n];
    const p2 = CONTROL[(k + 1) % n];
    const p3 = CONTROL[(k + 2) % n];
    const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
    pts.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), y: cr(p0[1], p1[1], p2[1], p3[1]) });
  }
  let len = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % SAMPLES];
    a.s = len;
    a.dx = b.x - a.x;
    a.dy = b.y - a.y;
    const d = Math.hypot(a.dx, a.dy);
    a.dx /= d;
    a.dy /= d;
    len += d;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { pts, length: len, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Nearest centre-line sample, searching around a previous guess.
export function nearest(track, x, y, guess, span = 40) {
  let best = guess;
  let bestD = Infinity;
  for (let o = -span; o <= span; o++) {
    const i = (guess + o + SAMPLES) % SAMPLES;
    const p = track.pts[i];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { i: best, d: Math.sqrt(bestD) };
}

// Creates a race. The caller advances it with step(dt), feeds each kart's
// input into karts.get(id).input, and sends snapshot() to the other players.
export function createRace({ players, laps, onEnd }) {
  const track = buildTrack();
  const pById = new Map(players.map((p) => [p.id, p]));

  // Item boxes: three across the road at four spots.
  const boxes = [];
  for (const f of [0.18, 0.4, 0.62, 0.84]) {
    const i = Math.floor(f * SAMPLES);
    const p = track.pts[i];
    for (const off of [-65, 0, 65]) boxes.push({ x: p.x - p.dy * off, y: p.y + p.dx * off, active: true, respawn: 0 });
  }

  // ---------------- the race (host) ----------------
  const race = { phase: 'countdown', t: -COUNTDOWN, firstFinish: null, finishOrder: [], events: [], evSeq: 0, over: false };
  const karts = new Map();
  players.forEach((p, idx) => {
    const row = Math.floor(idx / 2);
    const side = idx % 2 ? 1 : -1;
    const start = track.pts[0];
    const back = 70 + row * 70;
    karts.set(p.id, {
      id: p.id,
      x: start.x - start.dx * back - start.dy * 45 * side,
      y: start.y - start.dy * back + start.dx * 45 * side,
      a: Math.atan2(start.dy, start.dx),
      sp: 0,
      idx: SAMPLES - 1 - Math.round(back / (track.length / SAMPLES)),
      lap: 0,
      half: false,
      item: null,
      boostT: 0,
      boostMul: 1,
      frozen: 0,
      finished: false,
      time: 0,
      place: idx + 1,
      input: { s: 0, b: 0, u: 0 },
      used: 0,
    });
  });
  const event = (e) => race.events.push({ ...e, n: ++race.evSeq });

  function rollItem(k) {
    const leading = k.place === 1;
    const w = { double: 45, triple: 33, thunder: leading ? 6 : 22 };
    let r = Math.random() * (w.double + w.triple + w.thunder);
    for (const code of ITEM_CODES) {
      r -= w[code];
      if (r <= 0) return code;
    }
    return 'double';
  }

  function useItem(k) {
    if (!k.item || k.frozen > 0 || k.finished) return;
    const it = ITEMS[k.item];
    k.boostT = BOOST_SECONDS;
    k.boostMul = it.mul;
    if (k.item === 'thunder') {
      for (const o of karts.values()) if (o !== k && !o.finished) o.frozen = FREEZE_SECONDS;
      event({ type: 'thunder', by: k.id });
    } else event({ type: 'boost', by: k.id, item: k.item });
    k.item = null;
  }

  function step(dt) {
    race.t += dt;
    if (race.phase === 'countdown') {
      if (race.t >= 0) {
        race.phase = 'race';
        event({ type: 'go' });
      }
      return;
    }
    for (const b of boxes) {
      if (!b.active && (b.respawn -= dt) <= 0) b.active = true;
    }
    for (const k of karts.values()) {
      const inp = k.input;
      if (inp.u > k.used) {
        k.used = inp.u;
        useItem(k);
      }
      k.boostT = Math.max(0, k.boostT - dt);
      k.frozen = Math.max(0, k.frozen - dt);
      const near = nearest(track, k.x, k.y, k.idx);
      const offroad = near.d > HALF_W;
      let max = BASE_SPEED * (k.boostT > 0 ? k.boostMul : 1) * (offroad ? 0.45 : 1);
      if (k.finished) max = 160;
      if (k.frozen > 0) {
        k.sp *= Math.pow(0.02, dt);
      } else {
        if (inp.b && !k.finished) k.sp -= 900 * dt;
        else if (k.sp < max) k.sp = Math.min(max, k.sp + (k.boostT > 0 ? 900 : 380) * dt);
        else k.sp = Math.max(max, k.sp - 700 * dt);
        k.sp = Math.max(-160, k.sp);
        const steer = k.finished ? 0 : clamp(inp.s, -1, 1);
        k.a += steer * 2.6 * dt * clamp(k.sp / 220, -1, 1);
      }
      if (k.finished) {
        // Coast along the road after the finish.
        const p = track.pts[near.i];
        const want = Math.atan2(p.dy, p.dx);
        k.a += Math.atan2(Math.sin(want - k.a), Math.cos(want - k.a)) * Math.min(1, dt * 3);
      }
      k.x += Math.cos(k.a) * k.sp * dt;
      k.y += Math.sin(k.a) * k.sp * dt;
      k.x = clamp(k.x, track.minX - 400, track.maxX + 400);
      k.y = clamp(k.y, track.minY - 400, track.maxY + 400);

      // Laps: cross the line forward after passing the halfway point.
      const prev = k.idx;
      let found = nearest(track, k.x, k.y, k.idx);
      // Far off the road (cutting across the grass): search the whole track.
      if (found.d > HALF_W * 3) found = nearest(track, k.x, k.y, k.idx, SAMPLES / 2);
      k.idx = found.i;
      if (k.idx > SAMPLES * 0.4 && k.idx < SAMPLES * 0.6) k.half = true;
      if (k.finished) {
        // Laps stop counting once you've finished.
      } else if (prev > SAMPLES * 0.85 && k.idx < SAMPLES * 0.15) {
        if (k.half) {
          k.lap += 1;
          k.half = false;
          if (k.lap >= laps) {
            k.finished = true;
            k.time = race.t;
            race.finishOrder.push(k.id);
            race.firstFinish ??= race.t;
            event({ type: 'finish', id: k.id, place: race.finishOrder.length });
          } else event({ type: 'lap', id: k.id, lap: k.lap + 1 });
        }
      } else if (prev < SAMPLES * 0.15 && k.idx > SAMPLES * 0.85 && k.lap > 0) {
        k.lap -= 1; // drove backwards over the line
        k.half = true;
      }

      // Item boxes.
      for (const b of boxes) {
        if (b.active && !k.item && !k.finished && Math.hypot(b.x - k.x, b.y - k.y) < 40) {
          b.active = false;
          b.respawn = 4;
          k.item = rollItem(k);
          event({ type: 'item', id: k.id, item: k.item });
        }
      }
    }
    // Karts bump each other.
    const list = [...karts.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < KART_R * 2) {
          const push = (KART_R * 2 - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
    }
    // Places: finishers by time, then by distance travelled.
    const progress = (k) => (k.finished ? 1e9 - k.time : k.lap * track.length + track.pts[k.idx].s + (k.idx > SAMPLES * 0.85 && !k.half ? -track.length : 0));
    list.sort((a, b) => progress(b) - progress(a)).forEach((k, i) => (k.place = i + 1));

    const allDone = list.every((k) => k.finished);
    if (!race.over && (allDone || (race.firstFinish !== null && race.t - race.firstFinish > 30))) {
      race.over = true;
      setTimeout(finish, 1500);
    }
  }

  function finish() {
    const rows = [...karts.values()]
      .sort((a, b) => a.place - b.place)
      .map((k) => {
        const p = pById.get(k.id);
        const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
        return { name: p.name, color: p.color, place: ordinal(k.place), score: k.finished ? fmt(k.time) : `Lap ${Math.min(k.lap + 1, laps)}/${laps}` };
      });
    onEnd({ title: `${rows[0].name} wins!`, subtitle: `LumaKart · ${laps} lap${laps > 1 ? 's' : ''}`, rows });
  }

  function snapshot() {
    return {
      ph: race.phase,
      t: Math.round(race.t * 100) / 100,
      k: [...karts.values()].map((k) => [k.id, r1(k.x), r1(k.y), Math.round(k.a * 1000) / 1000, Math.round(k.sp), k.item ? ITEM_CODES.indexOf(k.item) : -1, k.boostT > 0 ? k.boostMul : 0, k.frozen > 0 ? 1 : 0, k.lap, k.place, k.finished ? 1 : 0]),
      b: boxes.map((b) => (b.active ? 1 : 0)).join(''),
      e: race.events.slice(-12),
    };
  }
  const r1 = (v) => Math.round(v * 10) / 10;

  return { track, boxes, karts, race, step, snapshot };
}
