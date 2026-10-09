// Circle Chaos: take turns grabbing circles. Your colour is +1; rainbow
// circles let you take 2 or 4 from anyone. 15 rounds, most circles wins.

import { el, team, loadSprites, tinted, setupCanvas, loop, spriteURL, clamp } from './common.js';

const ROUNDS = 15;
const TURN_MS = 15000;
const TARGET_MS = 10000;
const MARGIN = 0.08;

// Bouncing motion that's a pure function of time, so every screen agrees
// without streaming positions.
function bounce(p0, v, dt) {
  const L = 1 - 2 * MARGIN;
  const u = ((((p0 - MARGIN + v * dt) % (2 * L)) + 2 * L) % (2 * L));
  return MARGIN + (u <= L ? u : 2 * L - u);
}
const circlePos = (c, now) => ({ x: bounce(c.x0, c.vx, (now - c.t0) / 1000), y: bounce(c.y0, c.vy, (now - c.t0) / 1000) });

export async function play({ stage, setInfo, mode, room, meId, isHost, players, onEnd }) {
  const sprites = await loadSprites(['circle', 'rainbow-2', 'rainbow-4', 'star-face']);
  const circleSprite = (c) => (c.kind === 'r2' ? sprites['rainbow-2'] : c.kind === 'r4' ? sprites['rainbow-4'] : tinted(sprites.circle, team(c.color).hex));
  const faces = Object.fromEntries(await Promise.all(players.map(async (p) => [p.id, await spriteURL('star-face', team(p.color).hex, 120)])));

  const cards = el('div', { class: 'chaos-cards' });
  const canvas = el('canvas', { class: 'chaos-board' });
  const banner = el('div', { class: 'chaos-banner' });
  const wrap = el('div', { class: 'chaos' }, cards, el('div', { class: 'chaos-canvas-wrap' }, canvas), banner);
  stage.append(wrap);
  const view = setupCanvas(canvas);

  let st = null; // latest game state
  let clockOffset = 0; // host time - local time
  const hostNow = () => Date.now() + clockOffset;
  const fx = [];
  const floaters = [];
  let lastLog = 0;
  const gone = new Set();

  // ---------------- host: the rules ----------------
  let host = null;
  if (isHost) {
    const order = players.map((p) => p.id);
    let nextId = 1;
    const total = clamp(8 + players.length * 2, 12, 24);
    const rand = Math.random;

    const newCircle = (circles) => {
      const counts = {};
      for (const c of circles) if (c.kind === 'solid') counts[c.color] = (counts[c.color] || 0) + 1;
      const short = players.find((p) => !gone.has(p.id) && (counts[p.color] || 0) < 2);
      let kind = 'solid';
      let color = null;
      if (short) color = short.color;
      else if (rand() < 0.2) kind = rand() < 0.66 ? 'r2' : 'r4';
      else color = players[Math.floor(rand() * players.length)].color;
      const speed = 0.05 + rand() * 0.07;
      const a = rand() * Math.PI * 2;
      return { id: nextId++, kind, color, x0: MARGIN + rand() * (1 - 2 * MARGIN), y0: MARGIN + rand() * (1 - 2 * MARGIN), vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, t0: Date.now() };
    };

    const circles = [];
    for (let i = 0; i < total; i++) circles.push(newCircle(circles));

    host = {
      s: {
        phase: 'turn',
        round: 1,
        turn: 0,
        order,
        deadline: Date.now() + TURN_MS + 3000,
        circles,
        scores: Object.fromEntries(order.map((id) => [id, 0])),
        amount: 0,
        log: [],
        logId: 0,
      },
      broadcast() {
        this.s.hostNow = Date.now();
        apply(structuredClone(this.s));
        if (mode === 'multi') room.send({ t: 'state', s: this.s });
      },
      active() {
        return this.s.order[this.s.turn];
      },
      say(text) {
        this.s.logId += 1;
        this.s.log = [{ id: this.s.logId, text }, ...this.s.log].slice(0, 4);
      },
      next() {
        const s = this.s;
        for (let guard = 0; guard < 64; guard++) {
          s.turn += 1;
          if (s.turn >= s.order.length) {
            s.turn = 0;
            s.round += 1;
          }
          if (s.round > ROUNDS) return this.finish();
          if (!gone.has(this.active())) break;
        }
        s.phase = 'turn';
        s.amount = 0;
        s.deadline = Date.now() + TURN_MS;
        this.broadcast();
      },
      act(from, a) {
        const s = this.s;
        if (s.phase === 'over' || from !== this.active()) return;
        const who = players.find((p) => p.id === from);
        if (s.phase === 'turn' && a.pick) {
          const i = s.circles.findIndex((c) => c.id === a.pick);
          if (i < 0) return;
          const c = s.circles[i];
          if (c.kind === 'solid' && c.color !== who.color) return;
          s.circles.splice(i, 1);
          s.circles.push(newCircle(s.circles));
          if (c.kind === 'solid') {
            s.scores[from] += 1;
            this.say(`${who.name} grabbed a circle (+1)`);
            return this.next();
          }
          s.phase = 'target';
          s.amount = c.kind === 'r2' ? 2 : 4;
          s.deadline = Date.now() + TARGET_MS;
          this.say(`${who.name} found a rainbow −${s.amount}!`);
          return this.broadcast();
        }
        if (s.phase === 'target' && a.target !== undefined) {
          const target = players.find((p) => p.id === a.target && p.id !== from);
          if (!target) return;
          const take = Math.min(s.amount, s.scores[target.id]);
          s.scores[target.id] -= take;
          s.scores[from] += take;
          this.say(take ? `${who.name} took ${take} from ${target.name}` : `${who.name} tried to take from ${target.name}, but they had none`);
          return this.next();
        }
      },
      tick() {
        const s = this.s;
        if (s.phase === 'over' || Date.now() < s.deadline) return;
        const who = players.find((p) => p.id === this.active());
        if (s.phase === 'turn') {
          this.say(`${who.name} ran out of time`);
          this.next();
        } else {
          // Auto-pick whoever has the most.
          const rich = players.filter((p) => p.id !== who.id && !gone.has(p.id)).sort((a, b) => s.scores[b.id] - s.scores[a.id])[0];
          if (rich) this.act(who.id, { target: rich.id });
          else this.next();
        }
      },
      finish() {
        const s = this.s;
        s.phase = 'over';
        this.broadcast();
        const rows = players
          .map((p) => ({ name: p.name, color: p.color, sprite: 'star-face', value: s.scores[p.id] }))
          .sort((a, b) => b.value - a.value)
          .map((r) => ({ ...r, score: `${r.value} circle${r.value === 1 ? '' : 's'}` }));
        const tie = rows.length > 1 && rows[0].value === rows[1].value;
        setTimeout(() => onEnd({ title: tie ? "It's a tie!" : `${rows[0].name} wins!`, subtitle: 'Circle Chaos · 15 rounds', rows }), 1200);
      },
    };
  }

  // ---------------- everyone: show the state ----------------
  function apply(s) {
    const prev = st;
    st = s;
    clockOffset = s.hostNow - Date.now();
    // Pop effect for circles that disappeared.
    if (prev) {
      const ids = new Set(s.circles.map((c) => c.id));
      for (const c of prev.circles) {
        if (!ids.has(c.id)) {
          const p = circlePos(c, hostNow());
          fx.push({ x: p.x, y: p.y, life: 0.5, color: c.kind === 'solid' ? team(c.color).hex : '#ffffff' });
        }
      }
    }
    for (const entry of [...s.log].reverse()) {
      if (entry.id > lastLog) {
        lastLog = entry.id;
        floaters.unshift({ text: entry.text, life: 2.2 });
        floaters.length = Math.min(floaters.length, 2);
      }
    }
    renderCards();
    renderBanner();
  }

  const activeId = () => st && st.order[st.turn];
  const myTurn = () => st && st.phase !== 'over' && activeId() === meId;
  const myColor = players.find((p) => p.id === meId)?.color;

  function act(a) {
    if (isHost) host.act(meId, a);
    else room.send({ t: 'input', i: a });
  }

  function renderCards() {
    cards.replaceChildren(
      ...st.order.map((id) => {
        const p = players.find((x) => x.id === id);
        const t = team(p.color);
        const active = id === activeId() && st.phase !== 'over';
        return el(
          'div',
          { class: `chaos-card ${active ? 'active' : ''} ${gone.has(id) ? 'gone' : ''}`, style: { '--team': t.hex } },
          el('img', { src: faces[id], alt: '' }),
          el('div', { class: 'name' }, id === meId ? `${p.name} (you)` : p.name),
          el('b', {}, String(st.scores[id] ?? 0)),
        );
      }),
    );
    cards.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function renderBanner() {
    const who = players.find((p) => p.id === activeId());
    const t = team(who?.color);
    if (st.phase === 'over') {
      banner.replaceChildren(el('b', {}, 'Game over!'));
    } else if (myTurn() && st.phase === 'target') {
      banner.replaceChildren(
        el('div', {}, `Take ${st.amount} from…`),
        el(
          'div',
          { class: 'chaos-targets' },
          players
            .filter((p) => p.id !== meId && !gone.has(p.id))
            .map((p) =>
              el(
                'button',
                { class: 'chaos-target', style: { '--team': team(p.color).hex }, onclick: () => act({ target: p.id }) },
                el('img', { src: faces[p.id], alt: '' }),
                el('span', {}, p.name),
                el('b', {}, String(st.scores[p.id])),
              ),
            ),
        ),
      );
    } else if (myTurn()) {
      banner.replaceChildren(el('div', {}, 'Your turn! Tap a ', el('b', { style: { color: team(myColor).hex } }, team(myColor).name), ' circle or a rainbow one.'));
    } else {
      banner.replaceChildren(
        el('div', {}, el('b', { style: { color: t.hex } }, who?.name || ''), st.phase === 'target' ? ` is choosing who to take ${st.amount} from…` : '’s turn'),
      );
    }
    setInfo([el('span', { class: 'pill' }, `Round ${Math.min(st.round, ROUNDS)}/${ROUNDS}`), el('span', { class: 'pill', 'data-timer': '' }, '')]);
  }

  // ---------------- input: tap a circle ----------------
  const radius = () => Math.min(view.w, view.h) * 0.07;
  canvas.addEventListener('pointerdown', (e) => {
    if (!st || !myTurn() || st.phase !== 'turn') return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const now = hostNow();
    let best = null;
    let bestD = Infinity;
    for (const c of st.circles) {
      const p = circlePos(c, now);
      const d = Math.hypot(p.x * view.w - x, p.y * view.h - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD > radius() * 1.25) return;
    if (best.kind === 'solid' && best.color !== myColor) {
      floaters.unshift({ text: `That's ${team(best.color).name}'s circle!`, life: 1.6 });
      floaters.length = Math.min(floaters.length, 2);
      return;
    }
    act({ pick: best.id });
  });

  // ---------------- network ----------------
  const offs = [];
  if (mode === 'multi') {
    if (isHost) {
      offs.push(room.on('input', (m) => m.i && host.act(m.from, m.i)));
      offs.push(
        room.on('left', (m) => {
          gone.add(m.id);
          if (host.active() === m.id) host.next();
          else host.broadcast();
        }),
      );
    } else {
      offs.push(room.on('state', (m) => apply(m.s)));
      offs.push(room.on('left', (m) => gone.add(m.id)));
    }
  }
  const hostTimer = isHost ? setInterval(() => host.tick(), 250) : null;
  if (isHost) host.broadcast();

  // ---------------- drawing ----------------
  const stop = loop((dt, time) => {
    const g = view.g;
    g.clearRect(0, 0, view.w, view.h);
    const bg = g.createRadialGradient(view.w / 2, view.h / 2, 0, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.7);
    bg.addColorStop(0, '#1d1630');
    bg.addColorStop(1, '#0a0812');
    g.fillStyle = bg;
    g.fillRect(0, 0, view.w, view.h);
    if (!st) return;

    const now = hostNow();
    const r = radius();
    const mine = myTurn() && st.phase === 'turn';
    for (const c of st.circles) {
      const p = circlePos(c, now);
      const x = p.x * view.w;
      const y = p.y * view.h;
      const eligible = c.kind !== 'solid' || c.color === myColor;
      let alpha = 1;
      let size = r * 2;
      if (mine) {
        alpha = eligible ? 1 : 0.35;
        if (eligible) size *= 1 + Math.sin(time * 6 + c.id) * 0.06;
      }
      if (c.kind !== 'solid' && st.phase !== 'over') {
        // Rainbow circles shimmer.
        g.save();
        g.globalAlpha = 0.35 * alpha;
        g.fillStyle = `hsl(${(time * 120 + c.id * 40) % 360} 100% 60%)`;
        g.beginPath();
        g.arc(x, y, size * 0.62, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.globalAlpha = alpha;
      g.drawImage(circleSprite(c), x - size / 2, y - size / 2, size, size);
      g.globalAlpha = 1;
    }

    for (const f of fx) {
      f.life -= dt;
      const k = 1 - f.life / 0.5;
      g.globalAlpha = Math.max(0, f.life * 2);
      g.strokeStyle = f.color;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(f.x * view.w, f.y * view.h, r * (1 + k * 1.2), 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    for (let i = fx.length - 1; i >= 0; i--) if (fx[i].life <= 0) fx.splice(i, 1);

    // Announcements float in the middle of the board.
    floaters.forEach((f, i) => {
      f.life -= dt;
      g.globalAlpha = clamp(f.life, 0, 1);
      g.font = `800 ${Math.max(14, Math.min(22, view.w / 22))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      const y = view.h / 2 + i * 34 - (2.2 - f.life) * 10;
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.strokeText(f.text, view.w / 2, y);
      g.fillStyle = '#fff';
      g.fillText(f.text, view.w / 2, y);
    });
    g.globalAlpha = 1;
    for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);

    const timer = document.querySelector('[data-timer]');
    if (timer && st.phase !== 'over') timer.textContent = `${Math.max(0, Math.ceil((st.deadline - now) / 1000))}s`;
  });

  return () => {
    stop();
    clearInterval(hostTimer);
    offs.forEach((off) => off());
    view.destroy();
    wrap.remove();
  };
}
