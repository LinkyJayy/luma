'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PLAYERS = [
  { id: 1, name: 'Red', color: 'red' },
  { id: 2, name: 'Blue', color: 'blue' },
  { id: 3, name: 'Teal', color: 'teal' },
];

// Steers each kart toward a point a little way along the track.
function autopilot(R, k, useItems) {
  const { track } = R;
  const target = track.pts[(k.idx + 22) % track.pts.length];
  const want = Math.atan2(target.y - k.y, target.x - k.x);
  const diff = Math.atan2(Math.sin(want - k.a), Math.cos(want - k.a));
  k.input = { s: Math.max(-1, Math.min(1, diff * 3)), b: 0, u: k.input.u + (useItems && k.item ? 1 : 0) };
}

function run(R, seconds, useItems = true, each) {
  for (let i = 0; i < seconds * 120; i++) {
    for (const k of R.karts.values()) autopilot(R, k, useItems);
    R.step(1 / 120);
    each?.();
  }
}

test('LumaKart race rules', async (t) => {
  const { createRace, ITEMS } = await import('../public/js/play/kart-race.js');

  await t.test('power-ups: double 1.5×, triple 2×, thunder 2× and freezes everyone else for 5 s', () => {
    const R = createRace({ players: PLAYERS, laps: 3, onEnd() {} });
    run(R, 3 + 4, false); // countdown, then get up to speed
    const [a, b, c] = [...R.karts.values()];
    const cruise = a.sp;
    assert.ok(cruise > 500 && cruise <= 560, `cruising at ${cruise}`);

    for (const [code, mul] of [['double', 1.5], ['triple', 2.0]]) {
      a.item = code;
      a.input.u += 1;
      let peak = 0;
      run(R, 2, false, () => (peak = Math.max(peak, a.sp)));
      assert.equal(ITEMS[code].mul, mul);
      assert.ok(Math.abs(peak - 560 * mul) < 2, `${code}: top speed ${peak.toFixed(0)} = ${560 * mul}`);
      run(R, 4, false); // boost wears off
      assert.ok(a.sp < 600, `${code} wore off: ${a.sp.toFixed(0)}`);
    }

    a.item = 'thunder';
    a.input.u += 1;
    run(R, 1 / 60, false);
    assert.equal(a.frozen, 0, 'the thunderer keeps driving');
    assert.ok(b.frozen > 4.9 && c.frozen > 4.9, 'everyone else is frozen');
    assert.equal(a.boostMul, 2.0);
    run(R, 2, false);
    assert.ok(b.sp < 20 && c.sp < 20, 'frozen karts stop');
    run(R, 3.2, false);
    assert.equal(b.frozen, 0, 'thaws after 5 seconds');
    assert.ok(R.race.events.some((e) => e.type === 'thunder' && e.by === a.id));
  });

  await t.test('a full race: laps count, items get picked up, everyone finishes in order', async () => {
    let results = null;
    const done = new Promise((resolve) => {
      const R = createRace({
        players: PLAYERS,
        laps: 2,
        onEnd(r) {
          results = r;
          resolve();
        },
      });
      let picked = 0;
      let seen = 0;
      run(R, 120, true, () => {
        for (const e of R.race.events) {
          if (e.n > seen) {
            seen = e.n;
            if (e.type === 'item') picked += 1;
          }
        }
      });
      t.diagnostic(`items picked up: ${picked}, winner finished in ${R.race.firstFinish.toFixed(1)} s`);
      assert.ok(picked >= 2, 'drove through item boxes');
      for (const k of R.karts.values()) {
        assert.ok(k.finished, `kart ${k.id} finished`);
        assert.equal(k.lap, 2);
      }
      assert.deepEqual(R.race.finishOrder.length, 3);
    });
    await done;
    assert.equal(results.rows.length, 3);
    assert.equal(results.rows[0].place, '1st');
    assert.match(results.rows[0].score, /^\d+:\d\d\.\d$/);
  });

  await t.test('chase camera: right is right, ahead is up the screen', async () => {
    const { chaseCamera } = await import('../public/js/play/kart-race.js');
    // A kart heading "down" the map, which is where the old top-down view
    // made steering look backwards.
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.3]) {
      const kart = { x: 500, y: 300, a };
      const cam = chaseCamera(kart, 400, 800);
      const at = (dx, dy) => cam.toScreen(cam.toCam(kart.x + dx, kart.y + dy));
      const [kx, ky] = at(0, 0);
      const right = { x: -Math.sin(a) * 80, y: Math.cos(a) * 80 };
      const ahead = { x: Math.cos(a) * 300, y: Math.sin(a) * 300 };
      assert.ok(Math.abs(kx - 200) < 1e-6, 'kart is centred');
      assert.ok(at(right.x, right.y)[0] > kx, `a=${a}: the kart's right is screen right`);
      assert.ok(at(-right.x, -right.y)[0] < kx, `a=${a}: the kart's left is screen left`);
      assert.ok(at(ahead.x, ahead.y)[1] < ky, `a=${a}: the road ahead is higher up the screen`);
      assert.ok(ky > 800 * 0.6 && ky < 800, 'kart sits in the lower part of the screen');
    }
    // Steering right turns the heading toward the kart's right-hand side.
    const R = createRace({ players: PLAYERS.slice(0, 2), laps: 3, onEnd() {} });
    run(R, 3.5, false);
    const k = R.karts.get(1);
    const before = k.a;
    for (let i = 0; i < 60; i++) {
      k.input = { s: 1, b: 0, u: 0 };
      R.step(1 / 120);
    }
    const cam = chaseCamera({ x: k.x, y: k.y, a: before }, 400, 800);
    const ahead = cam.toScreen(cam.toCam(k.x + Math.cos(k.a) * 300, k.y + Math.sin(k.a) * 300));
    assert.ok(ahead[0] > 200, 'after steering right, the kart points to the right of the screen');
  });

  await t.test('driving backwards over the line does not count as a lap', () => {
    const R = createRace({ players: PLAYERS.slice(0, 2), laps: 3, onEnd() {} });
    run(R, 3, false);
    const k = R.karts.get(1);
    // Put the kart just past the line, then drive it back across.
    const p0 = R.track.pts[3];
    Object.assign(k, { x: p0.x, y: p0.y, a: Math.atan2(-p0.dy, -p0.dx), idx: 3, lap: 0, half: false });
    for (let i = 0; i < 240; i++) {
      k.input = { s: 0, b: 0, u: 0 };
      R.step(1 / 120);
    }
    assert.equal(k.lap, 0);
  });
});
