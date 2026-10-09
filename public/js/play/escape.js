// StarEscape: an endless three-lane runner. Dodge barriers and trains, grab
// bolts, and don't let the black-star cop catch you.
//
// Multiplayer: everyone runs the same seeded course on their own screen.
// Players send their position to the host, who decides when a cop catches a
// runner and when the game ends.

import { el, team, COP_HEX, loadSprites, glowing, setupCanvas, loop, keyboard, swipes, rng, clamp, lerp } from './common.js';

const LANE_W = 2.6;
const CAM_BACK = 7;
const CAM_H = 4.2;
const VIEW_DIST = 140;
const GAME_SECONDS = 120;
const COUNTDOWN = 3;
const COP_START_GAP = 16;

const BUILDING_COLORS = ['#f4a261', '#e76f51', '#2a9d8f', '#e9c46a', '#8ab17d', '#6d597a', '#b5838d'];

export async function play({ stage, setInfo, mode, room, meId, isHost, players, seed, onEnd }) {
  const sprites = await loadSprites(['star', 'bolt']);
  const me = players.find((p) => p.id === meId);
  const isCop = me.role === 'cop';
  const starOf = (p) =>
    p.role === 'cop' ? glowing(sprites.star, COP_HEX, '#ff2d2d', 0.16) : glowing(sprites.star, team(p.color).hex, team(p.color).hex, 0.12);
  const copBlue = glowing(sprites.star, COP_HEX, '#2f7bff', 0.16);
  const boltGlow = glowing(sprites.bolt, '#ffd000', '#ffd000', 0.1);

  const canvas = el('canvas');
  stage.append(canvas);
  const view = setupCanvas(canvas);
  const keys = keyboard();

  // ---------------- the course ----------------
  const random = rng(seed);
  const world = { rows: [], bolts: [], buildings: [], genZ: 40, buildZ: -20, trainEnd: -1 };

  function genRow() {
    const z = world.genZ;
    const difficulty = clamp(z / 2500, 0, 1);
    const lanes = [0, 1, 2].sort(() => random() - 0.5);
    const count = random() < 0.35 + difficulty * 0.35 ? 2 : 1;
    const blocked = new Set();
    for (let i = 0; i < count; i++) {
      const lane = lanes[i];
      let type = random() < 0.4 ? 'low' : random() < 0.6 ? 'high' : 'train';
      // Only one train at a time, so there's always a way through.
      if (type === 'train' && z < world.trainEnd) type = 'low';
      const len = type === 'train' ? 16 + random() * 10 : 0.8;
      if (type === 'train') world.trainEnd = z + len + 6;
      world.rows.push({ type, lane, z, len, hit: false, color: BUILDING_COLORS[Math.floor(random() * BUILDING_COLORS.length)] });
      blocked.add(lane);
    }
    // A line of bolts in a free lane, sometimes arcing over a low barrier.
    const free = [0, 1, 2].filter((l) => !blocked.has(l));
    if (random() < 0.75) {
      const lane = free.length ? free[Math.floor(random() * free.length)] : lanes[0];
      const over = random() < 0.25 ? world.rows.find((r) => r.z === z && r.type === 'low') : null;
      const bl = over ? over.lane : lane;
      for (let i = 0; i < 6; i++) {
        const bz = z - 7 + i * 2.2;
        const arc = over ? Math.max(0, 2.2 - Math.abs(bz - z) * 0.35) : 0;
        world.bolts.push({ lane: bl, z: bz, y: 0.9 + arc, got: false });
      }
    }
    world.genZ += lerp(24, 12, difficulty) + random() * 8;
  }

  function genBuildings(upTo) {
    while (world.buildZ < upTo) {
      for (const side of [-1, 1]) {
        world.buildings.push({
          side,
          z: world.buildZ + random() * 4,
          w: 6 + random() * 6,
          h: 6 + random() * 14,
          d: 8 + random() * 6,
          color: BUILDING_COLORS[Math.floor(random() * BUILDING_COLORS.length)],
        });
      }
      world.buildZ += 14 + random() * 6;
    }
  }

  const laneX = (lane) => (lane - 1) * LANE_W;

  // ---------------- me ----------------
  const p = {
    z: isCop ? -COP_START_GAP : 0,
    lane: 1,
    x: 0,
    y: 0,
    vy: 0,
    slide: 0,
    stumble: 0,
    invuln: 0,
    speed: 13,
    bolts: 0,
    caught: false,
    caughtBy: null,
  };
  const s = { t: -COUNTDOWN, over: false, copGap: 10, msg: null, msgLife: 0, flash: 0 };
  // Build the street ahead before the countdown so it isn't empty.
  while (world.genZ < p.z + VIEW_DIST + 40) genRow();
  genBuildings(p.z + VIEW_DIST + 40);

  function say(text, life = 1.6) {
    s.msg = text;
    s.msgLife = life;
  }

  function control(dir) {
    if (s.t < 0 || s.over || p.caught) return;
    if (dir === 'left' && p.lane > 0) p.lane -= 1;
    if (dir === 'right' && p.lane < 2) p.lane += 1;
    if (dir === 'up' && p.y <= 0.01) {
      p.vy = 9.2;
      p.slide = 0;
    }
    if (dir === 'down') {
      if (p.y > 0.01) p.vy = -16;
      p.slide = 0.75;
    }
  }
  const offSwipe = swipes(canvas, (d) => d !== 'tap' && control(d));

  // ---------------- others (multiplayer) ----------------
  const others = new Map(); // id -> { z, x, y, sl, caught, shown: {z, x, y} }
  const catches = new Map();
  const caughtSet = new Set();
  const caughtBy = new Map(); // runner id -> cop id
  const finalStats = new Map();
  const offs = [];
  let netTimer = 0;
  let timeLeft = GAME_SECONDS;
  const prevGap = new Map(); // `${cop}-${runner}` -> previous dz

  if (mode === 'multi') {
    if (isHost) {
      offs.push(
        room.on('input', (m) => {
          const i = m.i;
          if (!i || typeof i.z !== 'number') return;
          others.set(m.from, { ...(others.get(m.from) || {}), z: i.z, x: i.x, y: i.y, sl: i.sl, b: i.b });
        }),
      );
      offs.push(room.on('left', (m) => others.delete(m.id)));
    } else {
      offs.push(
        room.on('state', (m) => {
          const st = m.s;
          for (const [id, v] of Object.entries(st.p || {})) {
            if (Number(id) === meId) continue;
            const o = others.get(Number(id)) || {};
            others.set(Number(id), { ...o, z: v[0], x: v[1], y: v[2], sl: v[3], b: v[4] });
          }
          timeLeft = st.t;
          for (const [runner, cop] of st.caught || []) {
            if (!caughtSet.has(runner)) {
              caughtSet.add(runner);
              const r = players.find((x) => x.id === runner);
              const c = players.find((x) => x.id === cop);
              if (runner === meId) {
                p.caught = true;
                p.caughtBy = c?.name;
              } else say(`${c?.name || 'A cop'} caught ${r?.name || 'a runner'}!`);
            }
          }
        }),
      );
    }
  }

  // Host: decide catches from everyone's reported positions.
  function hostReferee() {
    const all = new Map(others);
    all.set(meId, { z: p.z, x: p.x, y: p.y, sl: p.slide > 0, b: p.bolts });
    for (const cop of players.filter((x) => x.role === 'cop')) {
      const c = all.get(cop.id);
      if (!c) continue;
      for (const runner of players.filter((x) => x.role !== 'cop' && !caughtSet.has(x.id))) {
        const r = all.get(runner.id);
        if (!r) continue;
        const dz = r.z - c.z;
        const key = `${cop.id}-${runner.id}`;
        const before = prevGap.get(key);
        prevGap.set(key, dz);
        const sameLane = Math.abs(r.x - c.x) < 1.6;
        const reached = Math.abs(dz) < 1.2 || (before !== undefined && before > 0 && dz <= 0);
        if (sameLane && reached) {
          caughtSet.add(runner.id);
          caughtBy.set(runner.id, cop.id);
          catches.set(cop.id, (catches.get(cop.id) || 0) + 1);
          finalStats.set(runner.id, { z: r.z, b: r.b });
          if (runner.id === meId) {
            p.caught = true;
            p.caughtBy = cop.name;
          } else say(`${cop.name} caught ${runner.name}!`);
        }
      }
    }
    const runnersLeft = players.filter((x) => x.role !== 'cop' && !caughtSet.has(x.id)).length;
    if (!s.over && (timeLeft <= 0 || runnersLeft === 0)) {
      s.over = true;
      finishMulti(all);
    }
  }

  function finishMulti(all) {
    const runnersWon = players.some((x) => x.role !== 'cop' && !caughtSet.has(x.id));
    const rows = players.map((x) => {
      const pos = finalStats.get(x.id) || all.get(x.id) || { z: 0, b: 0 };
      if (x.role === 'cop') {
        const n = catches.get(x.id) || 0;
        return { name: x.name, color: x.color, hex: COP_HEX, label: 'Cop', value: n * 1000, score: `${n} catch${n === 1 ? '' : 'es'}`, side: 'cop' };
      }
      const dist = Math.max(0, Math.round(pos.z));
      const b = pos.b || 0;
      const got = caughtSet.has(x.id);
      return { name: x.name, color: x.color, label: got ? 'Caught' : 'Escaped!', value: dist + b * 10, score: `${dist} m · ${b} bolts`, side: 'runner' };
    });
    // Winning side first, best score first within each side.
    const win = runnersWon ? 'runner' : 'cop';
    rows.sort((a, b) => (b.side === win) - (a.side === win) || b.value - a.value);
    onEnd({ title: runnersWon ? 'Runners escaped!' : 'The cops win!', subtitle: 'StarEscape', rows });
  }

  // ---------------- simulation ----------------
  function stumble(text, gap) {
    p.stumble = 1.4;
    p.invuln = 1.3;
    s.flash = 0.3;
    say(text, 1.2);
    if (mode === 'solo') s.copGap -= gap;
  }

  function update(dt) {
    s.t += dt;
    s.msgLife -= dt;
    s.flash = Math.max(0, s.flash - dt);
    if (s.t < 0 || s.over) return;

    if (keys.hit('ArrowLeft', 'KeyA')) control('left');
    if (keys.hit('ArrowRight', 'KeyD')) control('right');
    if (keys.hit('ArrowUp', 'KeyW', 'Space')) control('up');
    if (keys.hit('ArrowDown', 'KeyS')) control('down');

    if (mode === 'multi') {
      timeLeft = isHost ? Math.max(0, GAME_SECONDS - s.t) : timeLeft;
    }
    if (p.caught) return;

    // Speed ramps up over time; cops are a touch faster.
    let base = Math.min(25, 13 + s.t * 0.1) * (isCop ? 1.07 : 1);
    if (isCop && mode === 'multi') {
      // A cop who has run past every runner eases off so they can be caught up to.
      const ahead = [...others.entries()].filter(([id]) => {
        const pl = players.find((x) => x.id === id);
        return pl && pl.role !== 'cop' && !caughtSet.has(id);
      });
      if (ahead.length && ahead.every(([, o]) => o.z < p.z - 2)) base *= 0.8;
    }
    p.stumble = Math.max(0, p.stumble - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    const target = base * (p.stumble > 0 ? 0.55 : 1);
    p.speed = lerp(p.speed, target, Math.min(1, dt * 2.5));
    p.z += p.speed * dt;

    // Lane change, jump, slide.
    p.x = lerp(p.x, laneX(p.lane), Math.min(1, dt * 14));
    p.vy -= 26 * dt;
    p.y = Math.max(0, p.y + p.vy * dt);
    if (p.y === 0) p.vy = Math.max(0, p.vy);
    p.slide = Math.max(0, p.slide - dt);

    while (world.genZ < p.z + VIEW_DIST + 40) genRow();
    genBuildings(p.z + VIEW_DIST + 40);
    world.rows = world.rows.filter((r) => r.z + r.len > p.z - 20);
    world.bolts = world.bolts.filter((b) => b.z > p.z - 20);
    world.buildings = world.buildings.filter((b) => b.z + b.d > p.z - 20);

    // Collisions.
    for (const r of world.rows) {
      if (r.hit || p.invuln > 0) continue;
      if (Math.abs(laneX(r.lane) - p.x) > 1.2) continue;
      if (p.z + 0.4 < r.z || p.z - 0.4 > r.z + r.len) continue;
      if (r.type === 'low' && p.y > 1.0) continue;
      if (r.type === 'high' && p.slide > 0) continue;
      r.hit = true;
      if (r.type === 'train' && p.z > r.z + 1.2) {
        // Clipped the side of a train while changing lanes: bounce back.
        p.lane = Math.round(p.x / LANE_W + 1) === r.lane ? clamp(r.lane + (p.x > laneX(r.lane) ? 1 : -1), 0, 2) : p.lane;
        stumble('Whoa!', 2.5);
      } else {
        if (r.type === 'train') p.z = r.z - 0.5;
        stumble(r.type === 'low' ? 'Jump!' : r.type === 'high' ? 'Slide!' : 'Train!', r.type === 'train' ? 5.5 : 4.2);
      }
    }
    for (const b of world.bolts) {
      if (b.got) continue;
      if (Math.abs(b.z - p.z) < 1 && Math.abs(laneX(b.lane) - p.x) < 1.1 && Math.abs(b.y - (p.y + 0.8)) < 1.3) {
        b.got = true;
        p.bolts += 1;
      }
    }

    if (mode === 'solo') {
      s.copGap = Math.min(10, s.copGap + 0.55 * dt);
      if (s.copGap <= 0) {
        p.caught = true;
        s.over = true;
        const dist = Math.round(p.z);
        let best = 0;
        try {
          best = Math.max(Number(localStorage.getItem('luma-escape-best')) || 0, dist + p.bolts * 10);
          localStorage.setItem('luma-escape-best', String(best));
        } catch {
          best = dist + p.bolts * 10;
        }
        setTimeout(
          () => onEnd({ title: 'Caught!', subtitle: `Score ${dist + p.bolts * 10} · best ${best}`, rows: [{ name: me.name, color: me.color, score: `${dist} m · ${p.bolts} bolts` }] }),
          900,
        );
      }
    }
  }

  function net(dt) {
    if (mode !== 'multi' || s.t < 0) return;
    netTimer -= dt;
    if (netTimer > 0) return;
    netTimer = 1 / 12;
    const mine = [round(p.z), round(p.x), round(p.y), p.slide > 0 ? 1 : 0, p.bolts];
    if (isHost) {
      hostReferee();
      const all = { [meId]: mine };
      for (const [id, o] of others) all[id] = [round(o.z), round(o.x), round(o.y), o.sl ? 1 : 0, o.b || 0];
      room.send({
        t: 'state',
        s: { p: all, t: Math.ceil(timeLeft), caught: [...caughtBy.entries()] },
      });
    } else if (!p.caught) {
      room.send({ t: 'input', i: { z: mine[0], x: mine[1], y: mine[2], sl: mine[3], b: mine[4] } });
    }
  }
  const round = (v) => Math.round(v * 100) / 100;

  // ---------------- drawing ----------------
  function draw(time) {
    const g = view.g;
    const W = view.w;
    const H = view.h;
    const horizon = H * 0.36;
    const focal = H * 0.95;
    const camZ = p.z - CAM_BACK;
    const camX = p.x * 0.55;
    const proj = (x, y, z) => {
      const dz = z - camZ;
      const sc = focal / dz;
      return { x: W / 2 + (x - camX) * sc, y: horizon + (CAM_H - y) * sc, sc };
    };

    // Sky and sun.
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#2b6cd4');
    sky.addColorStop(0.7, '#8fc3f2');
    sky.addColorStop(1, '#ffd9a8');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon + 1);
    const sun = g.createRadialGradient(W * 0.72, horizon * 0.55, 0, W * 0.72, horizon * 0.55, H * 0.12);
    sun.addColorStop(0, '#fff7d6');
    sun.addColorStop(0.35, 'rgba(255,214,120,.9)');
    sun.addColorStop(1, 'rgba(255,214,120,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, horizon);

    // Ground.
    const ground = g.createLinearGradient(0, horizon, 0, H);
    ground.addColorStop(0, '#9c8f7a');
    ground.addColorStop(1, '#6e6151');
    g.fillStyle = ground;
    g.fillRect(0, horizon, W, H - horizon);

    // Track bed.
    // The bottom of the screen shows the ground about 6 m ahead of the camera.
    const near = camZ + 3;
    const far = camZ + VIEW_DIST;
    const quad = (x0, x1, z0, z1, fill) => {
      const a = proj(x0, 0, z0);
      const b = proj(x1, 0, z0);
      const c = proj(x1, 0, z1);
      const d = proj(x0, 0, z1);
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(c.x, c.y);
      g.lineTo(d.x, d.y);
      g.closePath();
      g.fill();
    };
    quad(-LANE_W * 1.6, LANE_W * 1.6, near, far, '#6b5d50');
    // Sleepers.
    const step = 1.6;
    for (let z = Math.ceil(near / step) * step; z < camZ + 60; z += step) {
      for (let l = 0; l < 3; l++) quad(laneX(l) - 1, laneX(l) + 1, z, z + 0.35, '#3b2f27');
    }
    // Rails, as thin strips so they narrow with distance.
    for (let l = 0; l < 3; l++) {
      for (const off of [-0.72, 0.72]) quad(laneX(l) + off - 0.07, laneX(l) + off + 0.07, near, far, '#c9ced6');
    }

    // Everything with depth, drawn far to near.
    const items = [];
    for (const b of world.buildings) if (b.z > camZ + 1 && b.z < far) items.push({ z: b.z, draw: () => drawBuilding(b) });
    for (const r of world.rows) if (r.z + r.len > camZ + 1 && r.z < far) items.push({ z: Math.max(r.z, camZ + 1), draw: () => drawObstacle(r) });
    for (const b of world.bolts) if (!b.got && b.z > camZ + 1 && b.z < far) items.push({ z: b.z, draw: () => drawBolt(b) });
    for (const [id, o] of others) {
      if (o.z === undefined) continue;
      o.shown ||= { z: o.z, x: o.x, y: o.y };
      o.shown.z = lerp(o.shown.z, o.z, 0.25);
      o.shown.x = lerp(o.shown.x, o.x, 0.25);
      o.shown.y = lerp(o.shown.y, o.y, 0.25);
      if (o.shown.z > camZ + 1.5 && o.shown.z < far) {
        const pl = players.find((x) => x.id === id);
        items.push({ z: o.shown.z, draw: () => drawStar(pl, o.shown.x, o.shown.y, o.shown.z, o.sl, true) });
      }
    }
    if (mode === 'solo' && s.t > 0) {
      const copZ = p.z - s.copGap;
      if (copZ > camZ + 1.5) items.push({ z: copZ, draw: () => drawStar({ role: 'cop', name: 'Cop' }, lerp(p.x, 0, 0.3), 0, copZ, false, false) });
    }
    items.push({ z: p.z, draw: () => drawStar(me, p.x, p.y, p.z, p.slide > 0, false, true) });
    items.sort((a, b) => b.z - a.z).forEach((i) => i.draw());

    function box(x, w, y0, h, z0, len, front, top, side) {
      const zf = Math.max(z0, camZ + 1);
      const a = proj(x - w / 2, y0 + h, zf);
      const b = proj(x + w / 2, y0, zf);
      // Top face.
      const t1 = proj(x - w / 2, y0 + h, zf + len);
      const t2 = proj(x + w / 2, y0 + h, zf + len);
      g.fillStyle = top;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, a.y);
      g.lineTo(t2.x, t2.y);
      g.lineTo(t1.x, t1.y);
      g.closePath();
      g.fill();
      // Side face toward the camera.
      if (side) {
        const sx = x > camX ? x - w / 2 : x + w / 2;
        const s0 = proj(sx, y0, zf);
        const s1 = proj(sx, y0 + h, zf);
        const s2 = proj(sx, y0 + h, zf + len);
        const s3 = proj(sx, y0, zf + len);
        g.fillStyle = side;
        g.beginPath();
        g.moveTo(s0.x, s0.y);
        g.lineTo(s1.x, s1.y);
        g.lineTo(s2.x, s2.y);
        g.lineTo(s3.x, s3.y);
        g.closePath();
        g.fill();
      }
      g.fillStyle = front;
      g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      return { a, b };
    }

    function drawBuilding(b) {
      const x = b.side * (LANE_W * 1.6 + 3 + b.w / 2);
      const { a, b: c } = box(x, b.w, 0, b.h, b.z, b.d, b.color, shade(b.color, 1.15), shade(b.color, 0.75));
      // Windows.
      const cols = 3;
      const rows = Math.floor(b.h / 3);
      const ww = (c.x - a.x) / (cols * 2 + 1);
      const wh = (c.y - a.y) / (rows * 2 + 1);
      if (ww > 2) {
        g.fillStyle = 'rgba(255,255,255,.55)';
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) g.fillRect(a.x + ww * (1 + i * 2), a.y + wh * (1 + j * 2), ww, wh);
      }
    }

    function drawObstacle(r) {
      const x = laneX(r.lane);
      if (r.type === 'train') {
        const { a, b } = box(x, 2.3, 0, 3.3, r.z, r.len, r.color, shade(r.color, 1.2), shade(r.color, 0.7));
        const w = b.x - a.x;
        const h = b.y - a.y;
        g.fillStyle = '#1d2733';
        g.fillRect(a.x + w * 0.12, a.y + h * 0.14, w * 0.76, h * 0.3);
        g.fillStyle = '#fff6b0';
        g.beginPath();
        g.arc(a.x + w * 0.22, a.y + h * 0.75, w * 0.07, 0, Math.PI * 2);
        g.arc(a.x + w * 0.78, a.y + h * 0.75, w * 0.07, 0, Math.PI * 2);
        g.fill();
      } else if (r.type === 'low') {
        const { a, b } = box(x, 2.2, 0, 1.0, r.z, 0.3, '#ffffff', '#e8e8e8', null);
        stripes(a, b, '#e63946');
      } else {
        // Overhead bar on two posts: slide under it.
        const l = proj(x - 1.1, 0, Math.max(r.z, camZ + 1));
        const top = proj(x - 1.1, 2.7, Math.max(r.z, camZ + 1));
        const pw = Math.max(2, l.sc * 0.16);
        g.fillStyle = '#444';
        g.fillRect(l.x - pw / 2, top.y, pw, l.y - top.y);
        const rr = proj(x + 1.1, 0, Math.max(r.z, camZ + 1));
        g.fillRect(rr.x - pw / 2, top.y, pw, rr.y - top.y);
        const { a, b } = box(x, 2.3, 1.45, 1.1, r.z, 0.3, '#ffd000', '#ffe866', null);
        stripes(a, b, '#1b1b1b');
      }
    }

    function stripes(a, b, color) {
      g.save();
      g.beginPath();
      g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      g.clip();
      g.fillStyle = color;
      const w = (b.x - a.x) / 6;
      for (let i = -1; i < 8; i += 2) {
        g.beginPath();
        g.moveTo(a.x + i * w, b.y);
        g.lineTo(a.x + (i + 1) * w, a.y);
        g.lineTo(a.x + (i + 2) * w, a.y);
        g.lineTo(a.x + (i + 1) * w, b.y);
        g.fill();
      }
      g.restore();
    }

    function drawBolt(b) {
      const q = proj(laneX(b.lane), b.y, b.z);
      const size = q.sc * 0.9;
      const spin = Math.abs(Math.cos(time * 3 + b.z));
      const c = boltGlow.canvas;
      const w = size * (c.width / c.height) * (0.35 + 0.65 * spin);
      g.drawImage(c, q.x - w / 2, q.y - size / 2, w, size);
    }

    function drawStar(pl, x, y, z, sliding, label, isMe) {
      const q = proj(x, y + 0.85, z);
      const ground0 = proj(x, 0, z);
      const size = q.sc * 1.45;
      // Shadow.
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.beginPath();
      g.ellipse(ground0.x, ground0.y, size * 0.4, size * 0.1, 0, 0, Math.PI * 2);
      g.fill();
      const cop = pl.role === 'cop';
      const spr = cop && Math.floor(time * 4) % 2 ? copBlue : starOf(pl);
      const c = spr.canvas;
      const bob = y > 0 ? 0 : Math.abs(Math.sin(time * 10 + z)) * size * 0.06;
      const sy = sliding ? 0.55 : 1;
      const hgt = size * (c.height / c.width) * sy;
      g.save();
      g.translate(q.x, q.y + (sliding ? size * 0.25 : 0) - bob);
      g.rotate(isMe ? (laneX(p.lane) - x) * -0.05 : 0);
      g.globalAlpha = isMe && p.invuln > 0 && Math.floor(time * 12) % 2 ? 0.5 : 1;
      g.drawImage(c, -size / 2, -hgt / 2, size, hgt);
      g.restore();
      if (label) {
        g.font = `700 ${clamp(q.sc * 0.5, 10, 14)}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.fillStyle = cop ? '#ff6b6b' : '#fff';
        g.strokeStyle = 'rgba(0,0,0,.6)';
        g.lineWidth = 3;
        g.strokeText(pl.name, q.x, q.y - size * 0.7);
        g.fillText(pl.name, q.x, q.y - size * 0.7);
      }
    }

    // HUD text.
    g.textAlign = 'center';
    if (s.flash > 0) {
      g.fillStyle = `rgba(255,60,60,${s.flash})`;
      g.fillRect(0, 0, W, H);
    }
    if (s.t < 0) {
      big(String(Math.ceil(-s.t)), '#ffd000');
      small(isCop ? "You're a cop! Catch the runners." : 'Swipe or use arrow keys. Run!', H / 2 + 46);
    } else if (p.caught) {
      big(mode === 'solo' ? 'Caught!' : 'Caught!', '#ff5a5f');
      small(p.caughtBy ? `${p.caughtBy} got you. Watch the others…` : '', H / 2 + 46);
    } else if (s.msgLife > 0 && s.msg) {
      g.globalAlpha = clamp(s.msgLife, 0, 1);
      small(s.msg, H * 0.22, 22);
      g.globalAlpha = 1;
    }
    // How close is danger?
    if (s.t > 0 && !p.caught) {
      let warn = null;
      if (mode === 'solo' && s.copGap < 6) warn = `Cop ${Math.max(0, s.copGap).toFixed(0)} m behind!`;
      if (mode === 'multi' && !isCop) {
        const d = Math.min(...[...others.entries()].filter(([id]) => players.find((x) => x.id === id)?.role === 'cop').map(([, o]) => p.z - o.z).filter((v) => v > 0));
        if (Number.isFinite(d) && d < 15) warn = `Cop ${d.toFixed(0)} m behind!`;
      }
      if (warn) {
        g.font = '800 16px system-ui, sans-serif';
        g.fillStyle = Math.floor(time * 4) % 2 ? '#ff5a5f' : '#fff';
        g.fillText(warn, W / 2, H - 28);
      }
    }

    function big(text, color) {
      g.font = '900 64px system-ui, sans-serif';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,.5)';
      g.strokeText(text, W / 2, H / 2);
      g.fillStyle = color;
      g.fillText(text, W / 2, H / 2);
    }
    function small(text, y, size = 16) {
      g.font = `700 ${size}px system-ui, sans-serif`;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.strokeText(text, W / 2, y);
      g.fillStyle = '#fff';
      g.fillText(text, W / 2, y);
    }
  }

  let lastInfo = '';
  const stop = loop((dt, time) => {
    update(dt);
    net(dt);
    keys.frame();
    draw(time);
    const parts = [`${Math.max(0, Math.round(p.z))} m`, `⚡ ${p.bolts}`];
    if (mode === 'multi') parts.push(`${Math.floor(timeLeft / 60)}:${String(Math.ceil(timeLeft) % 60).padStart(2, '0')}`);
    const info = parts.join('|');
    if (info !== lastInfo) {
      lastInfo = info;
      setInfo(parts.map((t) => el('span', { class: 'pill' }, t)));
    }
  });

  return () => {
    stop();
    keys.destroy();
    offSwipe();
    offs.forEach((off) => off());
    view.destroy();
    canvas.remove();
  };
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => clamp(Math.round(v * k), 0, 255);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
