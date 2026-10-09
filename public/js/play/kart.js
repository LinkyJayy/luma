// LumaKart: a night-time race for 2–8 stars. The host's browser runs the race;
// everyone else sends steering input and draws the host's state.

import { el, team, loadSprites, glowing, setupCanvas, loop, keyboard, rng, clamp, lerp, ordinal } from './common.js';
import { createRace, HALF_W, SAMPLES, ITEMS, ITEM_CODES, COUNTDOWN } from './kart-race.js';

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

  // ---------------- drawing ----------------
  function draw(dt, time) {
    const g = view.g;
    const W = view.w;
    const H = view.h;
    const meK = view3.karts.get(meId);
    const meS = shown.get(meId) || { x: track.pts[0].x, y: track.pts[0].y, a: 0 };

    // Smooth everyone toward the latest state.
    const k = 1 - Math.exp(-dt * 14);
    for (const [id, kk] of view3.karts) {
      const sh = shown.get(id);
      sh.x = lerp(sh.x, kk.x, k);
      sh.y = lerp(sh.y, kk.y, k);
      sh.a += Math.atan2(Math.sin(kk.a - sh.a), Math.cos(kk.a - sh.a)) * k;
    }

    const zoom = (Math.min(W, H) / 520) * (1 - clamp((meK?.sp || 0) / 2400, 0, 0.18));
    const look = 0.22 * (meK?.sp || 0);
    const camX = meS.x + Math.cos(meS.a) * look;
    const camY = meS.y + Math.sin(meS.a) * look;

    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.fillStyle = '#06110d';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(zoom, zoom);
    g.translate(-camX, -camY);
    const vx0 = camX - W / 2 / zoom - 200;
    const vx1 = camX + W / 2 / zoom + 200;
    const vy0 = camY - H / 2 / zoom - 200;
    const vy1 = camY + H / 2 / zoom + 200;
    const inView = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

    // Grass with a soft moonlit gradient.
    const moon = g.createRadialGradient(camX - 300, camY - 400, 0, camX, camY, 1400);
    moon.addColorStop(0, '#12301f');
    moon.addColorStop(1, '#06110d');
    g.fillStyle = moon;
    g.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);

    // Road: glow, neon edges, asphalt, centre dashes.
    const path = new Path2D();
    track.pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(90,140,255,.10)';
    g.lineWidth = HALF_W * 2 + 70;
    g.stroke(path);
    g.strokeStyle = '#3fc8ff';
    g.lineWidth = HALF_W * 2 + 10;
    g.stroke(path);
    g.strokeStyle = '#1c1f2b';
    g.lineWidth = HALF_W * 2;
    g.stroke(path);
    g.setLineDash([46, 46]);
    g.strokeStyle = 'rgba(255,255,255,.28)';
    g.lineWidth = 5;
    g.stroke(path);
    g.setLineDash([]);

    // Start / finish line.
    const s0 = track.pts[0];
    g.save();
    g.translate(s0.x, s0.y);
    g.rotate(Math.atan2(s0.dy, s0.dx));
    const sq = 14;
    for (let i = -HALF_W / sq; i < HALF_W / sq; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? '#fff' : '#111';
        g.fillRect(j * sq - sq, i * sq, sq, sq);
      }
    }
    g.restore();

    // Street lamps throw warm and cool pools of light.
    g.globalCompositeOperation = 'lighter';
    for (const l of lamps) {
      if (!inView(l.x, l.y)) continue;
      const grad = g.createRadialGradient(l.x, l.y, 0, l.x, l.y, 190);
      grad.addColorStop(0, `hsla(${l.hue},90%,65%,.32)`);
      grad.addColorStop(1, `hsla(${l.hue},90%,65%,0)`);
      g.fillStyle = grad;
      g.fillRect(l.x - 190, l.y - 190, 380, 380);
    }
    g.globalCompositeOperation = 'source-over';
    for (const l of lamps) {
      if (!inView(l.x, l.y)) continue;
      g.fillStyle = '#2b2f3a';
      g.beginPath();
      g.arc(l.x, l.y, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `hsl(${l.hue},100%,85%)`;
      g.beginPath();
      g.arc(l.x, l.y, 5, 0, Math.PI * 2);
      g.fill();
    }

    // Trees.
    for (const t of trees) {
      if (!inView(t.x, t.y)) continue;
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.beginPath();
      g.arc(t.x + 8, t.y + 10, t.r, 0, Math.PI * 2);
      g.fill();
      const tg = g.createRadialGradient(t.x - t.r * 0.3, t.y - t.r * 0.3, 0, t.x, t.y, t.r);
      tg.addColorStop(0, '#1f5a3a');
      tg.addColorStop(1, '#0c2a1b');
      g.fillStyle = tg;
      g.beginPath();
      g.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      g.fill();
    }

    // Fireflies.
    for (const f of fireflies) {
      const x = f.x + Math.sin(time * 0.6 + f.ph) * 30;
      const y = f.y + Math.cos(time * 0.5 + f.ph * 2) * 30;
      if (!inView(x, y)) continue;
      g.globalAlpha = 0.4 + 0.5 * Math.sin(time * 3 + f.ph);
      g.fillStyle = '#e8ff8a';
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // Item boxes.
    boxes.forEach((b, i) => {
      if (!view3.boxes[i] || !inView(b.x, b.y)) return;
      const bob = Math.sin(time * 3 + i) * 3;
      g.save();
      g.translate(b.x, b.y + bob);
      g.rotate(time * 1.2 + i);
      const glow = g.createRadialGradient(0, 0, 0, 0, 0, 40);
      glow.addColorStop(0, 'rgba(255,208,0,.45)');
      glow.addColorStop(1, 'rgba(255,208,0,0)');
      g.fillStyle = glow;
      g.fillRect(-40, -40, 80, 80);
      const bg = g.createLinearGradient(-18, -18, 18, 18);
      bg.addColorStop(0, 'hsl(' + ((time * 90 + i * 30) % 360) + ',90%,60%)');
      bg.addColorStop(1, 'hsl(' + ((time * 90 + i * 30 + 120) % 360) + ',90%,55%)');
      g.fillStyle = bg;
      g.beginPath();
      g.roundRect(-18, -18, 36, 36, 8);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(255,255,255,.85)';
      g.stroke();
      g.rotate(-(time * 1.2 + i));
      g.fillStyle = '#fff';
      g.font = '900 22px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('?', 0, 1);
      g.restore();
    });
    g.textBaseline = 'alphabetic';

    // Boost trails.
    for (const [id, kk] of view3.karts) {
      if (kk.boost > 0 && Math.random() < 0.9) {
        const sh = shown.get(id);
        fx.trails.push({ x: sh.x - Math.cos(sh.a) * 22, y: sh.y - Math.sin(sh.a) * 22, life: 0.5, hue: kk.boost >= 2 ? 185 : 140 });
      }
    }
    for (const tr of fx.trails) {
      tr.life -= dt;
      g.globalAlpha = Math.max(0, tr.life * 1.6);
      g.fillStyle = `hsl(${tr.hue},90%,60%)`;
      g.beginPath();
      g.arc(tr.x, tr.y, 8 * tr.life + 3, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    fx.trails = fx.trails.filter((t) => t.life > 0);

    // Karts: headlights, then the stars.
    g.globalCompositeOperation = 'lighter';
    for (const [id] of view3.karts) {
      const sh = shown.get(id);
      if (!inView(sh.x, sh.y)) continue;
      const hx = sh.x + Math.cos(sh.a) * 110;
      const hy = sh.y + Math.sin(sh.a) * 110;
      const beam = g.createRadialGradient(hx, hy, 0, hx, hy, 120);
      beam.addColorStop(0, 'rgba(255,245,200,.22)');
      beam.addColorStop(1, 'rgba(255,245,200,0)');
      g.fillStyle = beam;
      g.beginPath();
      g.moveTo(sh.x, sh.y);
      g.arc(sh.x, sh.y, 230, sh.a - 0.42, sh.a + 0.42);
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    for (const [id, kk] of view3.karts) {
      const sh = shown.get(id);
      if (!inView(sh.x, sh.y)) continue;
      const spr = starSprite(id);
      const c = spr.canvas;
      const size = 66;
      const full = (size * c.width) / (c.width - spr.pad * 2);
      g.save();
      g.translate(sh.x, sh.y);
      g.rotate(sh.a + Math.PI / 2);
      g.drawImage(c, -full / 2, -full / 2, full, full * (c.height / c.width));
      g.restore();
      if (kk.frozen) {
        g.fillStyle = 'rgba(150,220,255,.45)';
        g.strokeStyle = 'rgba(220,245,255,.9)';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(sh.x, sh.y, 36, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = '#fff';
        g.font = '800 22px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('❄', sh.x, sh.y + 8);
      }
      const name = pById.get(id)?.name || '';
      g.font = '800 17px system-ui, sans-serif';
      g.textAlign = 'center';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.strokeText(id === meId ? 'You' : name, sh.x, sh.y - 44);
      g.fillStyle = id === meId ? '#ffd000' : '#fff';
      g.fillText(id === meId ? 'You' : name, sh.x, sh.y - 44);
    }
    g.restore();

    // Moonlight vignette.
    const vig = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,10,0)');
    vig.addColorStop(1, 'rgba(0,0,10,.6)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);

    if (fx.flash > 0) {
      fx.flash -= dt;
      g.fillStyle = `rgba(255,240,170,${Math.max(0, fx.flash) * 0.7})`;
      g.fillRect(0, 0, W, H);
    }
    if (meK?.frozen) {
      g.fillStyle = 'rgba(120,200,255,.18)';
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
