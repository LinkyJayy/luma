// LumaKart: a night-time race for 2–8 stars. The host's browser runs the race;
// everyone else sends steering input and draws the host's state.

import { el, team, loadSprites, glowing, setupCanvas, loop, keyboard, rng, clamp, lerp, ordinal } from './common.js';
import { createRace, chaseCamera, HALF_W, SAMPLES, ITEMS, ITEM_CODES, COUNTDOWN } from './kart-race.js';

const SEND_HZ = 20;

export async function play({ stage, setInfo, mode, room, meId, isHost, players, seed, options, onEnd }) {
  const sprites = await loadSprites(['star', 'double', 'triple', 'bolt']);
  const laps = clamp(Number(options.laps) || 3, 1, 9);
  const R = createRace({ players, laps, onEnd });
  const { track, boxes, karts, race, step, snapshot } = R;
  const random = rng(seed);
  const pById = new Map(players.map((p) => [p.id, p]));
  const starSprite = (id) => {
    const t = team(pById.get(id)?.color);
    // Dark stars get a lighter glow so they stand out on the night grass.
    const glow = t.id === 'darkgray' ? '#b8b8c0' : t.id === 'brown' ? '#e0a46a' : t.hex;
    return glowing(sprites.star, t.hex, glow, 0.22);
  };

  // Scenery, the same for everyone.
  const trees = [];
  for (let tries = 0; trees.length < 160 && tries < 4000; tries++) {
    const x = track.minX - 500 + random() * (track.maxX - track.minX + 1000);
    const y = track.minY - 500 + random() * (track.maxY - track.minY + 1000);
    let near = Infinity;
    for (let i = 0; i < SAMPLES; i += 6) near = Math.min(near, Math.hypot(track.pts[i].x - x, track.pts[i].y - y));
    if (near > HALF_W + 70) trees.push({ x, y, r: 18 + random() * 22 });
  }
  const lamps = [];
  for (let i = 10; i < SAMPLES; i += 30) {
    const p = track.pts[i];
    const side = (i / 30) % 2 ? 1 : -1;
    lamps.push({ x: p.x - p.dy * (HALF_W + 34) * side, y: p.y + p.dx * (HALF_W + 34) * side, hue: random() < 0.5 ? 38 : 200 });
  }
  const fireflies = Array.from({ length: 70 }, () => ({
    x: track.minX - 300 + random() * (track.maxX - track.minX + 600),
    y: track.minY - 300 + random() * (track.maxY - track.minY + 600),
    ph: random() * 10,
  }));


  // ---------------- what we draw ----------------
  const view3 = { ph: 'countdown', t: -COUNTDOWN, karts: new Map(), boxes: boxes.map(() => 1), seen: 0 };
  const shown = new Map(); // smoothed positions per kart
  const fx = { flash: 0, trails: [], banner: null, bannerLife: 0 };

  function applySnapshot(s) {
    view3.ph = s.ph;
    view3.t = s.t;
    for (const [id, x, y, a, sp, item, boost, frozen, lap, place, fin] of s.k) {
      view3.karts.set(id, { id, x, y, a, sp, item: item >= 0 ? ITEM_CODES[item] : null, boost, frozen: !!frozen, lap, place, fin: !!fin });
      if (!shown.has(id)) shown.set(id, { x, y, a });
    }
    view3.boxes = [...s.b].map(Number);
    for (const e of s.e) {
      if (e.n <= view3.seen) continue;
      view3.seen = e.n;
      const who = pById.get(e.by ?? e.id)?.name || '';
      if (e.type === 'thunder') {
        fx.flash = 0.6;
        banner(e.by === meId ? 'Thunder! Everyone else is frozen!' : `${who} used Thunder! Frozen!`);
      } else if (e.type === 'go') banner('GO!');
      else if (e.type === 'finish') banner(e.id === meId ? `You finished ${ordinal(e.place)}!` : `${who} finished ${ordinal(e.place)}`);
      else if (e.type === 'lap' && e.id === meId) banner(e.lap === laps ? 'Final lap!' : `Lap ${e.lap}/${laps}`);
      else if (e.type === 'item' && e.id === meId) banner(`${ITEMS[e.item].label}! Press Space or tap to use`);
    }
  }
  function banner(text) {
    fx.banner = text;
    fx.bannerLife = 2;
  }

  // ---------------- controls ----------------
  const keys = keyboard();
  const input = { s: 0, b: 0, u: 0 };
  const touch = { left: false, right: false, brake: false };

  const canvas = el('canvas');
  const btn = (cls, label, key) => {
    const b = el('button', { class: `touch-btn ${cls}`, 'aria-label': label }, label === 'Left' ? '◀' : label === 'Right' ? '▶' : '■');
    const on = (v) => (e) => {
      e.preventDefault();
      touch[key] = v;
      b.classList.toggle('active', v);
    };
    b.addEventListener('pointerdown', on(true));
    b.addEventListener('pointerup', on(false));
    b.addEventListener('pointerleave', on(false));
    b.addEventListener('pointercancel', on(false));
    return b;
  };
  const itemBtn = el('button', { class: 'touch-btn kart-item', 'aria-label': 'Use item', onpointerdown: (e) => (e.preventDefault(), (input.u += 1)) });
  const leftBtn = btn('kart-left', 'Left', 'left');
  const rightBtn = btn('kart-right', 'Right', 'right');
  const brakeBtn = btn('kart-brake', 'Brake', 'brake');
  stage.append(canvas, leftBtn, rightBtn, brakeBtn, itemBtn);
  const view = setupCanvas(canvas);

  function readInput() {
    let s = 0;
    if (keys.down('ArrowLeft', 'KeyA') || touch.left) s -= 1;
    if (keys.down('ArrowRight', 'KeyD') || touch.right) s += 1;
    input.s = s;
    input.b = keys.down('ArrowDown', 'KeyS') || touch.brake ? 1 : 0;
    if (keys.hit('Space', 'ArrowUp', 'KeyW', 'Enter')) input.u += 1;
  }

  // ---------------- network ----------------
  const offs = [];
  let sendTimer = 0;
  let lastSent = '';
  if (mode === 'multi') {
    if (isHost) {
      offs.push(
        room.on('input', (m) => {
          const k = karts.get(m.from);
          if (k && m.i) k.input = { s: clamp(Number(m.i.s) || 0, -1, 1), b: m.i.b ? 1 : 0, u: Math.max(k.input.u, Number(m.i.u) || 0) };
        }),
      );
      offs.push(room.on('left', (m) => karts.delete(m.id)));
    } else {
      offs.push(room.on('state', (m) => applySnapshot(m.s)));
    }
  }

  // ---------------- drawing: third-person chase view ----------------
  const DRAW_DIST = 3400;
  const NEAR = 8;
  const cam = { x: 0, y: 0, a: 0, ready: false };
  // Distant hills on the horizon, as heights around the full circle.
  const hills = Array.from({ length: 96 }, (_, i) => {
    const t = (i / 96) * Math.PI * 2;
    return 0.5 + 0.3 * Math.sin(t * 3 + 1) + 0.2 * Math.sin(t * 7 + 2) + 0.12 * Math.sin(t * 13);
  });
  const skyStars = Array.from({ length: 120 }, () => ({ az: random() * Math.PI * 2, el: random(), r: random() * 1.2 + 0.4, ph: random() * 6 }));
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));

  // Clips a polygon (camera-space points) against the near plane.
  function clipNear(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ain = a[2] >= NEAR;
      const bin = b[2] >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    return out;
  }

  function draw(dt, time) {
    const g = view.g;
    const W = view.w;
    const H = view.h;
    const meK = view3.karts.get(meId);
    const meS = shown.get(meId) || { x: track.pts[0].x, y: track.pts[0].y, a: Math.atan2(track.pts[0].dy, track.pts[0].dx) };

    // Smooth everyone toward the latest state.
    const k = 1 - Math.exp(-dt * 14);
    for (const [id, kk] of view3.karts) {
      const sh = shown.get(id);
      sh.x = lerp(sh.x, kk.x, k);
      sh.y = lerp(sh.y, kk.y, k);
      sh.a += wrap(kk.a - sh.a) * k;
    }

    // The camera trails the kart's heading a little, so turns swing into view.
    if (!cam.ready) Object.assign(cam, { x: meS.x, y: meS.y, a: meS.a, ready: true });
    cam.x = meS.x;
    cam.y = meS.y;
    cam.a += wrap(meS.a - cam.a) * (1 - Math.exp(-dt * 5));
    const boosting = meK?.boost > 0;
    cam.zoom = lerp(cam.zoom || 1, boosting ? 0.86 : 1, 1 - Math.exp(-dt * 4));
    const C = chaseCamera(cam, W, H, { zoom: cam.zoom });
    const P = (x, y, z = 0) => C.toCam(x, y, z);
    const S = (c) => C.toScreen(c);

    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    // Night sky: stars, the moon and a line of hills that turn with you.
    const sky = g.createLinearGradient(0, 0, 0, C.horizon);
    sky.addColorStop(0, '#03041a');
    sky.addColorStop(0.7, '#141c46');
    sky.addColorStop(1, '#2e2a62');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, C.horizon + 2);
    const azX = (az) => W / 2 + Math.tan(clamp(wrap(az - cam.a), -1.45, 1.45)) * C.focal;
    for (const st of skyStars) {
      const d = wrap(st.az - cam.a);
      if (Math.abs(d) > 1.2) continue;
      g.globalAlpha = 0.5 + 0.4 * Math.sin(time * 2 + st.ph);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(azX(st.az), st.el * C.horizon * 0.85, st.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    const moonAz = -2.3;
    if (Math.abs(wrap(moonAz - cam.a)) < 1.1) {
      const mx = azX(moonAz);
      const my = C.horizon * 0.3;
      const mg = g.createRadialGradient(mx, my, 0, mx, my, 90);
      mg.addColorStop(0, 'rgba(255,250,220,.5)');
      mg.addColorStop(1, 'rgba(255,250,220,0)');
      g.fillStyle = mg;
      g.fillRect(mx - 90, my - 90, 180, 180);
      g.fillStyle = '#fff8dc';
      g.beginPath();
      g.arc(mx, my, 22, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#0b1530';
    g.beginPath();
    g.moveTo(0, C.horizon + 2);
    for (let x = 0; x <= W; x += 6) {
      const az = cam.a + Math.atan((x - W / 2) / C.focal);
      const t = (((az / (Math.PI * 2)) % 1) + 1) % 1;
      const i = t * hills.length;
      const h = lerp(hills[Math.floor(i) % hills.length], hills[Math.ceil(i) % hills.length], i % 1);
      g.lineTo(x, C.horizon - h * 38);
    }
    g.lineTo(W, C.horizon + 2);
    g.closePath();
    g.fill();

    // Ground.
    const ground = g.createLinearGradient(0, C.horizon, 0, H);
    ground.addColorStop(0, '#0a1d16');
    ground.addColorStop(1, '#123524');
    g.fillStyle = ground;
    g.fillRect(0, C.horizon, W, H - C.horizon);

    // Which stretch of track is in front of the camera?
    const camPts = track.pts.map((p) => P(p.x, p.y));
    const visible = [];
    for (let i = 0; i < SAMPLES; i++) {
      const a = camPts[i];
      const b = camPts[(i + 1) % SAMPLES];
      if ((a[2] > -HALF_W * 2 || b[2] > -HALF_W * 2) && a[2] < DRAW_DIST && Math.abs(a[0]) < a[2] * 3 + HALF_W * 3) visible.push(i);
    }

    // Road layers, each one merged into a single path: glow, neon edge, asphalt.
    const strip = (half, from = -half) => {
      const path = new Path2D();
      for (const i of visible) {
        const p = track.pts[i];
        const q = track.pts[(i + 1) % SAMPLES];
        const poly = clipNear([
          P(p.x - p.dy * from, p.y + p.dx * from),
          P(p.x - p.dy * half, p.y + p.dx * half),
          P(q.x - q.dy * half, q.y + q.dx * half),
          P(q.x - q.dy * from, q.y + q.dx * from),
        ]);
        if (poly.length < 3) continue;
        poly.forEach((c, j) => {
          const [sx, sy] = S(c);
          if (j) path.lineTo(sx, sy);
          else path.moveTo(sx, sy);
        });
        path.closePath();
      }
      return path;
    };
    g.fillStyle = 'rgba(70,130,255,.13)';
    g.fill(strip(HALF_W + 46));
    g.fillStyle = '#3fc8ff';
    g.fill(strip(HALF_W + 9));
    g.fillStyle = '#1c1f2b';
    g.fill(strip(HALF_W));

    // Centre dashes and the start line.
    const dashes = new Path2D();
    for (const i of visible) {
      if (i % 4 > 1) continue;
      const p = track.pts[i];
      const q = track.pts[(i + 1) % SAMPLES];
      const poly = clipNear([P(p.x - p.dy * 3, p.y + p.dx * 3), P(p.x + p.dy * 3, p.y - p.dx * 3), P(q.x + q.dy * 3, q.y - q.dx * 3), P(q.x - q.dy * 3, q.y + q.dx * 3)]);
      if (poly.length < 3) continue;
      poly.forEach((c, j) => (j ? dashes.lineTo(...S(c)) : dashes.moveTo(...S(c))));
      dashes.closePath();
    }
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fill(dashes);
    const s0 = track.pts[0];
    const cells = 12;
    for (let c = 0; c < cells; c++) {
      for (let r = 0; r < 2; r++) {
        const o0 = -HALF_W + (c * 2 * HALF_W) / cells;
        const o1 = o0 + (2 * HALF_W) / cells;
        const f0 = -14 + r * 14;
        const f1 = f0 + 14;
        const at = (o, f) => P(s0.x - s0.dy * o + s0.dx * f, s0.y + s0.dx * o + s0.dy * f);
        const poly = clipNear([at(o0, f0), at(o1, f0), at(o1, f1), at(o0, f1)]);
        if (poly.length < 3) continue;
        g.fillStyle = (c + r) % 2 ? '#fff' : '#111';
        g.beginPath();
        poly.forEach((cc, j) => (j ? g.lineTo(...S(cc)) : g.moveTo(...S(cc))));
        g.fill();
      }
    }

    // Pools of lamplight on the ground.
    g.globalCompositeOperation = 'lighter';
    for (const l of lamps) {
      const c = P(l.x, l.y);
      if (c[2] < NEAR * 4 || c[2] > DRAW_DIST) continue;
      const [sx, sy] = S(c);
      const rx = (170 * C.focal) / c[2];
      const squash = clamp((140 + c[2] * 0.2) / c[2], 0.08, 0.6);
      g.save();
      g.translate(sx, sy);
      g.scale(1, squash);
      const lg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      lg.addColorStop(0, `hsla(${l.hue},90%,65%,.35)`);
      lg.addColorStop(1, `hsla(${l.hue},90%,65%,0)`);
      g.fillStyle = lg;
      g.beginPath();
      g.arc(0, 0, rx, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';

    // Mist where the ground meets the sky.
    const fog = g.createLinearGradient(0, C.horizon - 4, 0, C.horizon + H * 0.12);
    fog.addColorStop(0, 'rgba(40,40,90,.85)');
    fog.addColorStop(1, 'rgba(40,40,90,0)');
    g.fillStyle = fog;
    g.fillRect(0, C.horizon - 4, W, H * 0.12 + 4);

    // Everything standing up, drawn far to near.
    const things = [];
    const add = (x, y, z, drawFn, kart = false) => {
      const c = P(x, y, z);
      if (c[2] < NEAR * 2 || c[2] > DRAW_DIST) return;
      const [sx, sy] = S(c);
      if (sx < -400 || sx > W + 400) return;
      things.push({ d: c[2], sx, sy, s: C.focal / c[2], draw: drawFn, kart });
    };
    for (const t of trees) {
      add(t.x, t.y, 0, (o) => {
        const r = t.r * 1.5 * o.s;
        g.fillStyle = 'rgba(0,0,0,.35)';
        g.beginPath();
        g.ellipse(o.sx, o.sy, r, r * 0.25, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#2a1d14';
        g.fillRect(o.sx - r * 0.12, o.sy - r * 1.1, r * 0.24, r * 1.1);
        const tg = g.createRadialGradient(o.sx - r * 0.3, o.sy - r * 2.1, 0, o.sx, o.sy - r * 1.8, r * 1.2);
        tg.addColorStop(0, '#2d7a4f');
        tg.addColorStop(1, '#0d2c1c');
        g.fillStyle = tg;
        g.beginPath();
        g.arc(o.sx, o.sy - r * 1.8, r * 1.05, 0, Math.PI * 2);
        g.fill();
      });
    }
    for (const l of lamps) {
      add(l.x, l.y, 0, (o) => {
        const h = 110 * o.s;
        g.strokeStyle = '#3a3f4d';
        g.lineWidth = Math.max(1, 5 * o.s);
        g.beginPath();
        g.moveTo(o.sx, o.sy);
        g.lineTo(o.sx, o.sy - h);
        g.stroke();
        const bg = g.createRadialGradient(o.sx, o.sy - h, 0, o.sx, o.sy - h, 40 * o.s);
        bg.addColorStop(0, `hsla(${l.hue},100%,85%,1)`);
        bg.addColorStop(1, `hsla(${l.hue},100%,70%,0)`);
        g.fillStyle = bg;
        g.beginPath();
        g.arc(o.sx, o.sy - h, 40 * o.s, 0, Math.PI * 2);
        g.fill();
      });
    }
    for (const f of fireflies) {
      const x = f.x + Math.sin(time * 0.6 + f.ph) * 30;
      const y = f.y + Math.cos(time * 0.5 + f.ph * 2) * 30;
      add(x, y, 30 + 20 * Math.sin(time + f.ph), (o) => {
        g.globalAlpha = 0.4 + 0.5 * Math.sin(time * 3 + f.ph);
        g.fillStyle = '#e8ff8a';
        g.beginPath();
        g.arc(o.sx, o.sy, Math.max(1, 3 * o.s), 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      });
    }
    boxes.forEach((b, i) => {
      if (!view3.boxes[i]) return;
      add(b.x, b.y, 30 + Math.sin(time * 3 + i) * 5, (o) => {
        const size = 40 * o.s;
        g.save();
        g.translate(o.sx, o.sy);
        const glow = g.createRadialGradient(0, 0, 0, 0, 0, size * 1.3);
        glow.addColorStop(0, 'rgba(255,208,0,.45)');
        glow.addColorStop(1, 'rgba(255,208,0,0)');
        g.fillStyle = glow;
        g.fillRect(-size * 1.3, -size * 1.3, size * 2.6, size * 2.6);
        // A cube turning in place.
        g.scale(Math.max(0.15, Math.abs(Math.cos(time * 1.6 + i))), 1);
        const bg = g.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2);
        bg.addColorStop(0, `hsl(${(time * 90 + i * 30) % 360},90%,60%)`);
        bg.addColorStop(1, `hsl(${(time * 90 + i * 30 + 120) % 360},90%,55%)`);
        g.fillStyle = bg;
        g.beginPath();
        g.roundRect(-size / 2, -size / 2, size, size, size * 0.2);
        g.fill();
        g.lineWidth = Math.max(1, size * 0.08);
        g.strokeStyle = 'rgba(255,255,255,.9)';
        g.stroke();
        g.restore();
        g.fillStyle = '#fff';
        g.font = `900 ${Math.max(8, size * 0.6)}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('?', o.sx, o.sy + size * 0.04);
        g.textBaseline = 'alphabetic';
      });
    });

    // Boost trails.
    for (const [id, kk] of view3.karts) {
      if (kk.boost > 0) {
        const sh = shown.get(id);
        fx.trails.push({ x: sh.x - Math.cos(sh.a) * 30, y: sh.y - Math.sin(sh.a) * 30, life: 0.5, hue: kk.boost >= 2 ? 185 : 140 });
      }
    }
    for (const tr of fx.trails) {
      tr.life -= dt;
      add(tr.x, tr.y, 18, (o) => {
        g.globalAlpha = Math.max(0, tr.life * 1.6);
        g.fillStyle = `hsl(${tr.hue},90%,60%)`;
        g.beginPath();
        g.arc(o.sx, o.sy, (10 * tr.life + 4) * o.s, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      });
    }
    fx.trails = fx.trails.filter((t) => t.life > 0);

    // Karts: a star standing on the road with its headlight glow.
    for (const [id, kk] of view3.karts) {
      const sh = shown.get(id);
      add(sh.x, sh.y, 0, (o) => {
        const spr = starSprite(id);
        const c = spr.canvas;
        const size = 58 * o.s;
        const full = (size * c.width) / (c.width - spr.pad * 2);
        // Headlight on the road ahead.
        const ahead = P(sh.x + Math.cos(sh.a) * 120, sh.y + Math.sin(sh.a) * 120);
        if (ahead[2] > NEAR) {
          const [hx, hy] = S(ahead);
          const hr = (110 * C.focal) / ahead[2];
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.translate(hx, hy);
          g.scale(1, 0.35);
          const hg = g.createRadialGradient(0, 0, 0, 0, 0, hr);
          hg.addColorStop(0, 'rgba(255,245,200,.28)');
          hg.addColorStop(1, 'rgba(255,245,200,0)');
          g.fillStyle = hg;
          g.beginPath();
          g.arc(0, 0, hr, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
        g.fillStyle = 'rgba(0,0,0,.4)';
        g.beginPath();
        g.ellipse(o.sx, o.sy, size * 0.45, size * 0.12, 0, 0, Math.PI * 2);
        g.fill();
        // Lean into turns.
        const lean = id === meId ? input.s * 0.18 : wrap(kk.a - sh.a) * 2;
        const bounce = Math.abs(Math.sin(time * 18 + id)) * size * 0.03 * clamp(kk.sp / 400, 0, 1);
        g.save();
        g.translate(o.sx, o.sy - size * 0.5 - bounce);
        g.rotate(clamp(lean, -0.3, 0.3) + Math.sin(time * 9 + id) * 0.02);
        g.drawImage(c, -full / 2, -full / 2, full, full * (c.height / c.width));
        g.restore();
        if (kk.frozen) {
          g.fillStyle = 'rgba(150,220,255,.45)';
          g.strokeStyle = 'rgba(220,245,255,.9)';
          g.lineWidth = Math.max(1.5, 3 * o.s);
          g.beginPath();
          g.arc(o.sx, o.sy - size * 0.5, size * 0.62, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.fillStyle = '#fff';
          g.font = `800 ${Math.max(10, size * 0.4)}px system-ui, sans-serif`;
          g.textAlign = 'center';
          g.fillText('❄', o.sx, o.sy - size * 0.38);
        }
        if (id !== meId) {
          const name = pById.get(id)?.name || '';
          g.font = `800 ${clamp(16 * o.s * 2, 10, 16)}px system-ui, sans-serif`;
          g.textAlign = 'center';
          g.lineWidth = 4;
          g.strokeStyle = 'rgba(0,0,0,.7)';
          g.strokeText(name, o.sx, o.sy - size * 1.15);
          g.fillStyle = '#fff';
          g.fillText(name, o.sx, o.sy - size * 1.15);
        }
      }, true);
    }
    // Scenery between the camera and your kart turns see-through so it never hides you.
    const myDepth = P(meS.x, meS.y)[2];
    things
      .sort((a, b) => b.d - a.d)
      .forEach((t) => {
        g.globalAlpha = t.d < myDepth + 60 && !t.kart ? 0.28 : 1;
        t.draw(t);
        g.globalAlpha = 1;
      });

    // Edge-of-vision darkening.
    const vig = g.createRadialGradient(W / 2, H * 0.6, Math.min(W, H) * 0.35, W / 2, H * 0.6, Math.max(W, H) * 0.8);
    vig.addColorStop(0, 'rgba(0,0,10,0)');
    vig.addColorStop(1, 'rgba(0,0,10,.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);
    if (boosting) {
      // Speed streaks.
      g.strokeStyle = 'rgba(255,255,255,.25)';
      g.lineWidth = 2;
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * Math.PI * 2 + time * 3;
        const r0 = Math.max(W, H) * (0.45 + ((time * 2 + i * 0.37) % 1) * 0.2);
        g.beginPath();
        g.moveTo(W / 2 + Math.cos(ang) * r0, H * 0.45 + Math.sin(ang) * r0);
        g.lineTo(W / 2 + Math.cos(ang) * (r0 + 60), H * 0.45 + Math.sin(ang) * (r0 + 60));
        g.stroke();
      }
    }

    if (fx.flash > 0) {
      fx.flash -= dt;
      g.fillStyle = `rgba(255,240,170,${Math.max(0, fx.flash) * 0.7})`;
      g.fillRect(0, 0, W, H);
    }
    if (meK?.frozen) {
      g.fillStyle = 'rgba(120,200,255,.2)';
      g.fillRect(0, 0, W, H);
    }

    // HUD.
    g.textAlign = 'left';
    if (meK) {
      g.font = '900 34px system-ui, sans-serif';
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.lineWidth = 5;
      const place = ordinal(meK.place);
      g.strokeText(place, 14, 46);
      g.fillText(place, 14, 46);
      g.font = '700 14px system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.fillText(`of ${view3.karts.size} · Lap ${Math.min(meK.lap + 1, laps)}/${laps}`, 16, 66);
    }
    drawMinimap(g, W, H);

    // Item slot (also the touch button).
    const item = meK?.item || '';
    if (item !== (itemBtn.dataset.item || '')) {
      itemBtn.dataset.item = item;
      itemBtn.replaceChildren(item ? el('img', { src: `/img/play/${ITEMS[item].sprite}.png`, alt: ITEMS[item].label }) : '');
      itemBtn.classList.toggle('has-item', !!item);
    }

    g.textAlign = 'center';
    if (view3.ph === 'countdown') {
      const n = Math.ceil(-view3.t);
      g.font = '900 96px system-ui, sans-serif';
      g.lineWidth = 8;
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.strokeText(String(Math.max(1, n)), W / 2, H / 2);
      g.fillStyle = '#ffd000';
      g.fillText(String(Math.max(1, n)), W / 2, H / 2);
    }
    if (fx.bannerLife > 0 && fx.banner) {
      fx.bannerLife -= dt;
      g.globalAlpha = clamp(fx.bannerLife, 0, 1);
      g.font = `900 ${fx.banner === 'GO!' ? 90 : 24}px system-ui, sans-serif`;
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,.6)';
      const y = fx.banner === 'GO!' ? H / 2 : H * 0.24;
      g.strokeText(fx.banner, W / 2, y);
      g.fillStyle = fx.banner === 'GO!' ? '#30d158' : '#fff';
      g.fillText(fx.banner, W / 2, y);
      g.globalAlpha = 1;
    }
  }

  function drawMinimap(g, W) {
    const size = Math.min(130, W * 0.3);
    const sx = size / (track.maxX - track.minX);
    const sy = size / (track.maxY - track.minY);
    const s = Math.min(sx, sy);
    const ox = W - size - 14;
    const oy = 14;
    g.save();
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath();
    g.roundRect(ox - 8, oy - 8, size + 16, (track.maxY - track.minY) * s + 16, 12);
    g.fill();
    g.translate(ox - track.minX * s, oy - track.minY * s);
    g.strokeStyle = 'rgba(63,200,255,.8)';
    g.lineWidth = 3;
    g.beginPath();
    track.pts.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s)));
    g.closePath();
    g.stroke();
    for (const [id] of view3.karts) {
      const sh = shown.get(id);
      g.fillStyle = team(pById.get(id)?.color).hex;
      g.strokeStyle = id === meId ? '#fff' : '#000';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sh.x * s, sh.y * s, id === meId ? 5 : 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  // ---------------- main loop ----------------
  if (isHost) applySnapshot(snapshot());
  let lastInfo = '';
  const stop = loop((dt, time) => {
    readInput();
    keys.frame();
    if (isHost) {
      const mine = karts.get(meId);
      if (mine) mine.input = { ...input };
      // Fixed small steps keep the physics steady.
      const steps = Math.ceil(dt / (1 / 120));
      for (let i = 0; i < steps; i++) step(dt / steps);
      applySnapshot(snapshot());
      sendTimer -= dt;
      if (mode === 'multi' && sendTimer <= 0) {
        sendTimer = 1 / SEND_HZ;
        room.send({ t: 'state', s: snapshot() });
      }
      race.events = race.events.filter((e) => e.n > race.evSeq - 12);
    } else {
      sendTimer -= dt;
      const now = JSON.stringify(input);
      if (sendTimer <= 0 || now !== lastSent) {
        sendTimer = 1 / SEND_HZ;
        lastSent = now;
        room.send({ t: 'input', i: input });
      }
    }
    draw(dt, time);
    const raceT = Math.max(0, view3.t);
    const info = `${Math.floor(raceT / 60)}:${String(Math.floor(raceT % 60)).padStart(2, '0')}`;
    if (info !== lastInfo) {
      lastInfo = info;
      setInfo(el('span', { class: 'pill' }, info));
    }
  });

  return () => {
    stop();
    keys.destroy();
    offs.forEach((off) => off());
    view.destroy();
    stage.replaceChildren();
  };
}
