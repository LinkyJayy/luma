// StarInvaders: blast circles with bolts for two minutes. Highest score wins.

import { el, team, loadSprites, tinted, glowing, setupCanvas, fitField, loop, keyboard, rng, clamp } from './common.js';

const W = 360;
const H = 560;
const GAME_SECONDS = 120;
const COUNTDOWN = 3;
const ROWS = [
  { points: 50, color: '#ff2d95' },
  { points: 40, color: '#8e4dff' },
  { points: 30, color: '#2f7bff' },
  { points: 20, color: '#14c8c8' },
  { points: 10, color: '#30d158' },
];
const COLS = 7;
const PLAYER_Y = 512;

export async function play({ stage, setInfo, mode, room, meId, isHost, players, seed, onEnd }) {
  const sprites = await loadSprites(['star', 'bolt', 'circle']);
  const me = players.find((p) => p.id === meId);
  const myHex = team(me.color).hex;
  const ship = glowing(sprites.star, myHex, myHex, 0.18);
  const rowSprites = ROWS.map((r) => tinted(sprites.circle, r.color));
  const random = rng(seed);

  const canvas = el('canvas');
  stage.append(canvas);
  const view = setupCanvas(canvas);
  const keys = keyboard();

  // Background stars, generated once.
  const sky = Array.from({ length: 90 }, () => ({ x: random() * W, y: random() * H, r: random() * 1.4 + 0.3, sp: random() * 14 + 6, tw: random() * 6 }));

  const s = {
    t: -COUNTDOWN,
    over: false,
    score: 0,
    x: W / 2,
    cooldown: 0,
    invuln: 0,
    bullets: [],
    shots: [],
    fx: [],
    texts: [],
    wave: 0,
    inv: [],
    formX: 0,
    formY: 0,
    dir: 1,
    fireTimer: 1.5,
  };
  const scores = new Map(players.map((p) => [p.id, 0]));

  function newWave() {
    s.wave += 1;
    s.inv = [];
    for (let r = 0; r < ROWS.length; r++) {
      for (let c = 0; c < COLS; c++) s.inv.push({ r, c, alive: true });
    }
    s.formX = 0;
    s.formY = Math.min(40, (s.wave - 1) * 8);
    s.dir = 1;
    s.fireTimer = 1.2;
  }
  newWave();

  const invPos = (v) => ({ x: 48 + v.c * 44 + s.formX, y: 70 + v.r * 40 + s.formY });

  // ---- touch: follow the finger, fire while held ----
  let touchX = null;
  const toField = (e) => {
    const rect = canvas.getBoundingClientRect();
    const f = fitField(view, W, H);
    return (e.clientX - rect.left - f.ox) / f.s;
  };
  const onDown = (e) => {
    touchX = toField(e);
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (touchX !== null) touchX = toField(e);
  };
  const onUp = () => (touchX = null);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ---- multiplayer ----
  const offs = [];
  let netTimer = 0;
  let waitingSince = null;
  if (mode === 'multi') {
    if (isHost) {
      offs.push(room.on('input', (m) => typeof m.i?.score === 'number' && scores.set(m.from, Math.max(0, m.i.score | 0))));
    } else {
      offs.push(
        room.on('state', (m) => {
          for (const [id, v] of Object.entries(m.s.scores || {})) if (Number(id) !== meId) scores.set(Number(id), v);
        }),
      );
    }
  }

  function finishHost() {
    scores.set(meId, s.score);
    const rows = players
      .map((p) => ({ name: p.name, color: p.color, value: scores.get(p.id) || 0 }))
      .sort((a, b) => b.value - a.value)
      .map((r) => ({ ...r, score: `${r.value.toLocaleString()} pts` }));
    onEnd({ title: `${rows[0].name} wins!`, subtitle: 'StarInvaders · 2 minutes', rows });
  }

  function finishSolo() {
    let best = 0;
    try {
      best = Math.max(Number(localStorage.getItem('luma-invaders-best')) || 0, s.score);
      localStorage.setItem('luma-invaders-best', String(best));
    } catch {
      best = s.score;
    }
    onEnd({ title: 'Time!', subtitle: `Your best: ${best.toLocaleString()} pts`, rows: [{ name: me.name, color: me.color, score: `${s.score.toLocaleString()} pts` }] });
  }

  function addText(x, y, text, color) {
    s.texts.push({ x, y, text, color, life: 0.9 });
  }
  function burst(x, y, color, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 140;
      s.fx.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.3, color });
    }
  }

  function update(dt) {
    s.t += dt;
    // Background drifts even during the countdown.
    for (const st of sky) {
      st.y += st.sp * dt;
      if (st.y > H) st.y -= H;
    }
    for (const p of s.fx) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= dt;
    }
    s.fx = s.fx.filter((p) => p.life > 0);
    for (const t of s.texts) {
      t.y -= 40 * dt;
      t.life -= dt;
    }
    s.texts = s.texts.filter((t) => t.life > 0);

    if (s.t < 0 || s.over) return;
    if (s.t >= GAME_SECONDS) {
      s.over = true;
      touchX = null;
      if (mode === 'solo') finishSolo();
      else if (isHost) waitingSince = performance.now();
      else room.send({ t: 'input', i: { score: s.score } });
      return;
    }

    // Player movement.
    const speed = 270;
    let move = 0;
    if (keys.down('ArrowLeft', 'KeyA')) move -= 1;
    if (keys.down('ArrowRight', 'KeyD')) move += 1;
    if (touchX !== null) move = clamp((touchX - s.x) / 18, -1, 1);
    s.x = clamp(s.x + move * speed * dt, 22, W - 22);

    // Fire bolts.
    s.cooldown -= dt;
    const wantFire = keys.down('Space', 'ArrowUp', 'KeyW') || touchX !== null;
    if (wantFire && s.cooldown <= 0 && s.bullets.length < 4) {
      s.bullets.push({ x: s.x, y: PLAYER_Y - 26 });
      s.cooldown = 0.3;
    }
    for (const b of s.bullets) b.y -= 600 * dt;
    s.bullets = s.bullets.filter((b) => b.y > -20 && !b.dead);

    // Formation sweeps sideways, dropping at the edges, faster as it thins out.
    const alive = s.inv.filter((v) => v.alive);
    const total = ROWS.length * COLS;
    const v = (34 + s.wave * 9) * (1 + (1 - alive.length / total) * 2.2);
    s.formX += s.dir * v * dt;
    const xs = alive.map((a) => invPos(a).x);
    if (xs.length && (Math.max(...xs) > W - 22 || Math.min(...xs) < 22)) {
      s.dir *= -1;
      s.formX += s.dir * v * dt * 2;
      s.formY += 14;
    }

    // Bolts hit circles.
    for (const b of s.bullets) {
      for (const a of alive) {
        if (!a.alive) continue;
        const p = invPos(a);
        if (Math.abs(p.x - b.x) < 17 && Math.abs(p.y - b.y) < 19) {
          a.alive = false;
          b.dead = true;
          const pts = ROWS[a.r].points;
          s.score += pts;
          addText(p.x, p.y, `+${pts}`, ROWS[a.r].color);
          burst(p.x, p.y, ROWS[a.r].color);
          break;
        }
      }
    }

    // Circles fire back from the bottom of a random column.
    s.fireTimer -= dt;
    if (s.fireTimer <= 0 && alive.length) {
      const cols = [...new Set(alive.map((a) => a.c))];
      const col = cols[Math.floor(Math.random() * cols.length)];
      const shooter = alive.filter((a) => a.c === col).sort((p, q) => q.r - p.r)[0];
      const p = invPos(shooter);
      s.shots.push({ x: p.x, y: p.y + 16 });
      s.fireTimer = Math.max(0.45, 1.25 - s.wave * 0.1) * (0.6 + Math.random() * 0.8);
    }
    for (const sh of s.shots) sh.y += (210 + s.wave * 12) * dt;
    s.invuln -= dt;
    for (const sh of s.shots) {
      if (s.invuln <= 0 && Math.abs(sh.x - s.x) < 16 && Math.abs(sh.y - PLAYER_Y) < 18) {
        sh.dead = true;
        s.invuln = 1.6;
        const lost = Math.min(50, s.score);
        s.score -= lost;
        addText(s.x, PLAYER_Y - 30, `−${lost}`, '#ff5a5f');
        burst(s.x, PLAYER_Y, '#ff5a5f', 20);
      }
    }
    s.shots = s.shots.filter((sh) => sh.y < H + 10 && !sh.dead);

    // Cleared, or the circles reached the bottom: next wave.
    if (!alive.some((a) => a.alive)) {
      s.score += 100;
      addText(W / 2, H / 2, 'Wave cleared! +100', '#ffd000');
      newWave();
    } else if (alive.some((a) => a.alive && invPos(a).y > PLAYER_Y - 40)) {
      addText(W / 2, H / 2, 'They got through!', '#ff5a5f');
      s.shots = [];
      newWave();
    }
  }

  function net(dt) {
    if (mode !== 'multi') return;
    netTimer -= dt;
    if (isHost) {
      scores.set(meId, s.score);
      if (netTimer <= 0) {
        netTimer = 0.5;
        room.send({ t: 'state', s: { scores: Object.fromEntries(scores) } });
      }
      // Give everyone a moment to report their final score.
      if (waitingSince && performance.now() - waitingSince > 1500) {
        waitingSince = null;
        finishHost();
      }
    } else if (netTimer <= 0 && !s.over) {
      netTimer = 0.5;
      room.send({ t: 'input', i: { score: s.score } });
    }
  }

  function draw() {
    const g = view.g;
    g.clearRect(0, 0, view.w, view.h);
    const bg = g.createLinearGradient(0, 0, 0, view.h);
    bg.addColorStop(0, '#0b0820');
    bg.addColorStop(1, '#170a2c');
    g.fillStyle = bg;
    g.fillRect(0, 0, view.w, view.h);

    const f = fitField(view, W, H);
    g.save();
    g.translate(f.ox, f.oy);
    g.scale(f.s, f.s);
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();

    const now = performance.now() / 1000;
    for (const st of sky) {
      g.globalAlpha = 0.45 + 0.4 * Math.sin(now * 2 + st.tw);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    for (const a of s.inv) {
      if (!a.alive) continue;
      const p = invPos(a);
      const bob = Math.sin(now * 3 + a.c) * 1.5;
      g.drawImage(rowSprites[a.r], p.x - 17, p.y - 17 + bob, 34, 34);
    }

    for (const sh of s.shots) {
      const grad = g.createRadialGradient(sh.x, sh.y, 0, sh.x, sh.y, 9);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.35, '#ff5a5f');
      grad.addColorStop(1, 'rgba(255,90,95,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sh.x, sh.y, 9, 0, Math.PI * 2);
      g.fill();
    }

    for (const b of s.bullets) g.drawImage(sprites.bolt, b.x - 12, b.y - 18, 24, 36);

    const blink = s.invuln > 0 && Math.floor(s.invuln * 10) % 2 === 0;
    if (!blink) {
      const size = 46;
      const full = (size * ship.canvas.width) / (ship.canvas.width - ship.pad * 2);
      g.drawImage(ship.canvas, s.x - full / 2, PLAYER_Y - full / 2, full, full * (ship.canvas.height / ship.canvas.width));
    }

    for (const p of s.fx) {
      g.globalAlpha = Math.max(0, p.life * 1.6);
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.textAlign = 'center';
    for (const t of s.texts) {
      g.globalAlpha = Math.min(1, t.life * 2);
      g.font = '800 16px system-ui, sans-serif';
      g.fillStyle = t.color;
      g.fillText(t.text, t.x, t.y);
    }
    g.globalAlpha = 1;

    // Other players' scores, top-left.
    if (mode === 'multi') {
      const list = players.map((p) => ({ p, v: p.id === meId ? s.score : scores.get(p.id) || 0 })).sort((a, b) => b.v - a.v);
      g.textAlign = 'left';
      g.font = '700 11px system-ui, sans-serif';
      list.forEach(({ p, v }, i) => {
        g.fillStyle = team(p.color).hex;
        g.beginPath();
        g.arc(10, 14 + i * 16, 4, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = p.id === meId ? '#fff' : 'rgba(255,255,255,.75)';
        g.fillText(`${p.name.slice(0, 12)}  ${v}`, 19, 18 + i * 16);
      });
    }

    if (s.t < 0) {
      g.textAlign = 'center';
      g.font = '900 72px system-ui, sans-serif';
      g.fillStyle = '#ffd000';
      g.fillText(String(Math.ceil(-s.t)), W / 2, H / 2);
      g.font = '600 15px system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.fillText('Move: ← →  or drag · Fire: Space or hold', W / 2, H / 2 + 40);
    } else if (s.over) {
      g.textAlign = 'center';
      g.font = '900 44px system-ui, sans-serif';
      g.fillStyle = '#fff';
      g.fillText('Time!', W / 2, H / 2);
      if (mode === 'multi') {
        g.font = '600 15px system-ui, sans-serif';
        g.fillText('Waiting for results…', W / 2, H / 2 + 32);
      }
    }
    g.restore();
  }

  let lastInfo = '';
  const stop = loop((dt) => {
    update(dt);
    net(dt);
    keys.frame();
    draw();
    const left = Math.max(0, Math.ceil(GAME_SECONDS - Math.max(0, s.t)));
    const info = `${s.score}|${left}`;
    if (info !== lastInfo) {
      lastInfo = info;
      setInfo([el('span', { class: 'pill' }, `${s.score.toLocaleString()} pts`), el('span', { class: 'pill' }, `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)]);
    }
  });

  return () => {
    stop();
    keys.destroy();
    offs.forEach((off) => off());
    view.destroy();
    canvas.remove();
  };
}
