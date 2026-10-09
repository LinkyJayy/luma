// Luma Playables: the game list, solo play, multiplayer lobbies and results.

import { TEAMS, team, Room, spriteURL, el, ordinal } from './common.js';

export const GAMES = {
  kart: {
    name: 'LumaKart',
    icon: 'star',
    tagline: 'Night-time kart racing for 2–8 stars.',
    how: [
      'Steer with ← → (or A / D). Hold ↓ to brake. On a phone, use the buttons.',
      'Drive through glowing boxes to grab a power-up, then press Space (or tap the item) to use it.',
      'Double speed: 1.5× speed. Triple speed: 2× speed. Thunder: 2× speed and freezes everyone else for 5 seconds.',
    ],
    solo: false,
    multi: true,
    options: { laps: 3 },
  },
  chaos: {
    name: 'Circle Chaos',
    icon: 'star-face',
    tagline: 'Grab circles, steal points. 15 rounds, 2–8 players.',
    how: [
      'On your turn, tap a circle in your team colour (+1) or a rainbow circle.',
      'Rainbow −2 and −4: pick anyone and take 2 or 4 of their circles.',
      'Everyone gets 15 turns. Most circles at the end wins.',
    ],
    solo: false,
    multi: true,
  },
  escape: {
    name: 'StarEscape',
    icon: 'star',
    tagline: 'Run from the black-star cop and grab bolts.',
    how: [
      'Swipe or use ← → to switch lanes, ↑ to jump, ↓ to slide.',
      'Jump low barriers, slide under high ones, dodge trains.',
      'Each crash lets the cop catch up. In multiplayer, the host picks who runs and who plays a cop.',
    ],
    solo: true,
    multi: true,
    roles: true,
  },
  invaders: {
    name: 'StarInvaders',
    icon: 'bolt',
    tagline: 'Blast circles with bolts for 2 minutes.',
    how: [
      'Move with ← → (or drag) and fire bolts with Space (or hold your finger down).',
      'Circles are worth 10 to 50 points; higher rows are worth more.',
      'Getting hit costs 50 points. Highest score after 2 minutes wins.',
    ],
    solo: true,
    multi: true,
  },
  wordle: {
    name: 'StarWordle',
    icon: 'circle',
    tagline: 'Guess the five-letter word in six tries.',
    how: ['Green: right letter, right spot.', 'Yellow: in the word, wrong spot.', 'Gray: not in the word.'],
    solo: true,
    multi: false,
  },
};

const ORDER = ['kart', 'chaos', 'escape', 'invaders', 'wordle'];

const loadGame = (id) => import(`./${id}.js`);

function savedColor() {
  try {
    return localStorage.getItem('luma-play-color') || 'yellow';
  } catch {
    return 'yellow';
  }
}
function saveColor(c) {
  try {
    localStorage.setItem('luma-play-color', c);
  } catch {
    /* private mode */
  }
}

async function iconImg(gameId, cls = 'game-icon') {
  const g = GAMES[gameId];
  const src = g.icon === 'circle' ? await spriteURL('circle', '#ffd000', 160) : await spriteURL(g.icon, null, 160);
  return el('img', { class: cls, src, alt: '' });
}

// ---------- entry ----------

// parts: ['play'] | ['play', gameId] | ['play', 'join', CODE]
export function viewPlay(view, parts, params, ctx) {
  const [, gameId, arg] = parts;
  if (!gameId) return renderHub(view, ctx);
  if (gameId === 'join') return joinByCode(view, arg, ctx);
  if (!GAMES[gameId]) {
    view.replaceChildren(el('div', { class: 'page' }, el('div', { class: 'empty' }, 'Game not found.')));
    return;
  }
  return renderGamePage(view, gameId, ctx);
}

async function renderHub(view, ctx) {
  const page = el('div', { class: 'page' });
  const joinForm = el(
    'form',
    { class: 'join-row' },
    el('input', { class: 'input', name: 'code', placeholder: 'Game code', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters' }),
    el('button', { class: 'btn primary' }, 'Join'),
  );
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = joinForm.code.value.trim().toUpperCase();
    if (code) location.hash = `#/play/join/${code}`;
  });
  const list = el('div', { class: 'game-list' });
  page.append(
    el('div', { class: 'page-head' }, el('div', { class: 'brand' }, el('img', { src: '/img/logo.png', alt: '' }), el('h1', {}, 'Luma Playables'))),
    joinForm,
    list,
  );
  view.replaceChildren(page);
  for (const id of ORDER) {
    const g = GAMES[id];
    const modes = [g.solo && 'Solo', g.multi && (id === 'kart' || id === 'chaos' ? '2–8 players' : 'Multiplayer')].filter(Boolean);
    list.append(
      el(
        'a',
        { class: 'game-card', href: `#/play/${id}` },
        await iconImg(id),
        el('div', { class: 'meta' }, el('div', { class: 'title' }, g.name), el('div', { class: 'sub' }, g.tagline), el('div', { class: 'chips', style: { justifyContent: 'flex-start' } }, modes.map((m) => el('span', { class: 'chip muted' }, m)))),
      ),
    );
  }
}

function colorPicker(selected, onPick, taken = {}) {
  return el(
    'div',
    { class: 'swatches', role: 'radiogroup', 'aria-label': 'Team colour' },
    TEAMS.map((t) => {
      const owner = taken[t.id];
      return el(
        'button',
        {
          class: `swatch ${t.id === selected ? 'on' : ''}`,
          style: { background: t.hex },
          title: owner ? `${t.name} (${owner})` : t.name,
          'aria-label': t.name,
          'aria-checked': String(t.id === selected),
          role: 'radio',
          disabled: !!owner && t.id !== selected,
          onclick: () => onPick(t.id),
        },
        owner && t.id !== selected ? owner.slice(0, 1).toUpperCase() : '',
      );
    }),
  );
}

async function renderGamePage(view, gameId, ctx) {
  const g = GAMES[gameId];
  let color = savedColor();
  const page = el('div', { class: 'page' });
  const back = el('a', { class: 'icon-btn', href: '#/play', 'aria-label': 'All games' }, '‹');
  back.style.fontSize = '30px';
  page.append(el('div', { class: 'page-head' }, back, el('h1', {}, g.name)));
  const hero = el('div', { class: 'game-hero' }, await iconImg(gameId, 'game-hero-icon'), el('p', {}, g.tagline));
  page.append(hero);
  page.append(el('div', { class: 'card' }, el('h2', {}, 'How to play'), el('ul', { class: 'how' }, g.how.map((h) => el('li', {}, h)))));

  if (gameId !== 'wordle') {
    const pickerWrap = el('div');
    const drawPicker = () =>
      pickerWrap.replaceChildren(
        colorPicker(color, (c) => {
          color = c;
          saveColor(c);
          drawPicker();
        }),
      );
    drawPicker();
    page.append(el('div', { class: 'card' }, el('h2', {}, 'Your colour'), pickerWrap));
  }

  const actions = el('div', { class: 'card play-actions' });
  if (g.solo) {
    actions.append(el('button', { class: 'btn primary block', onclick: () => startSolo(gameId, color, ctx) }, gameId === 'wordle' ? 'Play' : 'Play solo'));
  }
  if (g.multi) {
    actions.append(
      el(
        'button',
        {
          class: `btn block ${g.solo ? '' : 'primary'}`,
          onclick: () => {
            if (!ctx.me) return ctx.requireLogin();
            multiplayer(gameId, { host: true, color }, ctx);
          },
        },
        'Host a game',
      ),
    );
    const join = el(
      'form',
      { class: 'join-row' },
      el('input', { class: 'input', name: 'code', placeholder: 'Code', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters' }),
      el('button', { class: 'btn' }, 'Join'),
    );
    join.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = join.code.value.trim().toUpperCase();
      if (!code) return;
      if (!ctx.me) return ctx.requireLogin();
      multiplayer(gameId, { code, color }, ctx);
    });
    actions.append(join);
    if (!ctx.me) actions.append(el('p', { class: 'hint' }, 'Sign in to host or join multiplayer games.'));
  }
  page.append(actions);
  view.replaceChildren(page);
}

function joinByCode(view, code, ctx) {
  view.replaceChildren(el('div', { class: 'page' }, el('div', { class: 'spinner' })));
  if (!ctx.me) return ctx.requireLogin();
  multiplayer(null, { code: String(code || '').toUpperCase(), color: savedColor() }, ctx, () => {
    location.hash = '#/play';
  });
}

// ---------- full-screen game layer ----------

function openLayer(title, onExit) {
  const info = el('div', { class: 'game-info' });
  const stage = el('div', { class: 'game-stage' });
  const exitBtn = el('button', { class: 'icon-btn game-exit', 'aria-label': 'Leave game' }, '✕');
  const titleEl = el('div', { class: 'game-title' }, title);
  const layer = el('div', { class: 'game-layer' }, el('div', { class: 'game-top' }, exitBtn, titleEl, info), stage);
  document.body.append(layer);
  document.body.classList.add('in-game');
  const close = () => {
    layer.remove();
    document.body.classList.remove('in-game');
  };
  exitBtn.addEventListener('click', () => onExit());
  return {
    layer,
    stage,
    setTitle: (t) => (titleEl.textContent = t),
    setInfo: (content) => info.replaceChildren(...[].concat(content ?? [])),
    close,
  };
}

async function resultsPanel(results, buttons) {
  const rows = await Promise.all(
    results.rows.map(async (r, i) =>
      el(
        'li',
        { class: `result-row ${i === 0 ? 'winner' : ''}` },
        el('span', { class: 'place' }, r.place ?? ordinal(i + 1)),
        el('img', { class: r.label === 'Cop' ? 'cop' : null, src: await spriteURL(r.sprite || 'star', r.hex || team(r.color).hex, 64), alt: '' }),
        el('span', { class: 'who' }, r.name, r.label ? el('small', {}, r.label) : null),
        el('b', {}, r.score),
      ),
    ),
  );
  return el(
    'div',
    { class: 'results' },
    el('div', { class: 'results-card' }, el('h2', {}, results.title), results.subtitle ? el('p', { class: 'hint' }, results.subtitle) : null, el('ol', {}, rows), el('div', { class: 'results-actions' }, buttons)),
  );
}

// ---------- solo ----------

async function startSolo(gameId, color, ctx) {
  const g = GAMES[gameId];
  let cleanup = null;
  const exit = () => {
    cleanup?.();
    layer.close();
    window.removeEventListener('hashchange', exit);
  };
  const layer = openLayer(g.name, exit);
  window.addEventListener('hashchange', exit);

  const run = async () => {
    cleanup?.();
    layer.stage.replaceChildren();
    layer.setInfo(null);
    const mod = await loadGame(gameId);
    cleanup = await mod.play({
      stage: layer.stage,
      setInfo: layer.setInfo,
      mode: 'solo',
      meId: 'me',
      isHost: true,
      players: [{ id: 'me', name: ctx.me?.displayName || 'You', color, role: 'runner' }],
      seed: (Math.random() * 2 ** 31) | 0,
      options: g.options || {},
      toast: ctx.toast,
      onEnd: async (results) => {
        if (results.noPanel) return;
        const panel = await resultsPanel(results, [
          el('button', { class: 'btn primary', onclick: () => (panel.remove(), run()) }, 'Play again'),
          el('button', { class: 'btn', onclick: exit }, 'Exit'),
        ]);
        layer.layer.append(panel);
      },
    });
  };
  run();
}

// ---------- multiplayer ----------

async function multiplayer(gameId, { host, code, color }, ctx, onFail) {
  let room;
  try {
    room = await new Room().ready;
  } catch (e) {
    ctx.toast(e.message);
    onFail?.();
    return;
  }
  const me = room.me.id;
  let state = null; // latest room snapshot from the server
  let lobby = null; // host's copy of lobby settings
  let game = gameId ? GAMES[gameId] : null;
  let running = null;
  let closed = false;

  const exit = () => {
    if (closed) return;
    closed = true;
    running?.();
    room.send({ t: 'leave' });
    room.close();
    layer.close();
    window.removeEventListener('hashchange', exit);
  };
  const layer = openLayer(game ? game.name : 'Joining…', exit);
  window.addEventListener('hashchange', exit);
  layer.stage.append(el('div', { class: 'spinner' }));

  const isHost = () => state && state.hostId === me;
  const nameOf = (id) => state?.players.find((p) => p.id === id)?.name || 'Player';

  // Host: keep colours unique, give newcomers a free colour, default roles.
  function syncLobby() {
    if (!isHost()) return;
    lobby ||= { colors: { [me]: color }, roles: {}, options: { ...(game.options || {}) } };
    const ids = state.players.map((p) => p.id);
    let changed = false;
    for (const key of ['colors', 'roles']) {
      for (const id of Object.keys(lobby[key])) {
        if (!ids.includes(Number(id))) {
          delete lobby[key][id];
          changed = true;
        }
      }
    }
    for (const id of ids) {
      if (!lobby.colors[id]) {
        const used = new Set(Object.values(lobby.colors));
        lobby.colors[id] = TEAMS.find((t) => !used.has(t.id)).id;
        changed = true;
      }
      if (game.roles && !lobby.roles[id]) {
        // First guest to arrive plays the cop by default; the host can change it.
        const hasCop = Object.values(lobby.roles).includes('cop');
        lobby.roles[id] = !hasCop && id !== me ? 'cop' : 'runner';
        changed = true;
      }
    }
    if (changed || !state.lobby) room.send({ t: 'lobby', lobby });
  }

  function setLobby(mut) {
    mut(lobby);
    room.send({ t: 'lobby', lobby });
  }

  async function renderLobby() {
    if (running || closed || !state) return;
    const L = state.lobby || { colors: {}, roles: {}, options: {} };
    const hostView = isHost();
    const players = state.players;
    const enough = players.length >= 2;

    const link = `${location.origin}/#/play/join/${state.code}`;
    const codeBox = el(
      'button',
      {
        class: 'room-code',
        title: 'Share invite link',
        onclick: async () => {
          try {
            if (navigator.share) await navigator.share({ title: `Join my ${game.name} game on Luma`, url: link });
            else {
              await navigator.clipboard.writeText(link);
              ctx.toast('Invite link copied');
            }
          } catch {
            /* dismissed */
          }
        },
      },
      el('small', {}, 'Game code'),
      el('b', {}, state.code),
      el('small', {}, 'Tap to share the invite link'),
    );

    const rows = await Promise.all(
      players.map(async (p) => {
        const c = team(L.colors?.[p.id]);
        const role = L.roles?.[p.id];
        const cop = game.roles && role === 'cop';
        const roleBtn =
          game.roles && hostView
            ? el(
                'button',
                { class: 'btn small', onclick: () => setLobby((l) => (l.roles[p.id] = cop ? 'runner' : 'cop')) },
                cop ? 'Cop → Runner' : 'Runner → Cop',
              )
            : game.roles
              ? el('span', { class: `chip ${cop ? 'danger' : ''}` }, cop ? 'Cop' : 'Runner')
              : null;
        return el(
          'li',
          { class: 'lobby-player' },
          el('img', { class: cop ? 'cop' : null, src: await spriteURL('star', cop ? '#17171c' : c.hex, 64), alt: '' }),
          el('span', { class: 'who' }, p.name, p.id === state.hostId ? el('small', {}, 'Host') : el('small', {}, c.name), p.id === me ? el('small', {}, ' · you') : null),
          roleBtn,
          hostView && p.id !== me ? el('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => room.send({ t: 'kick', id: p.id }) }, '✕') : null,
        );
      }),
    );

    const taken = {};
    for (const [id, cid] of Object.entries(L.colors || {})) if (Number(id) !== me) taken[cid] = nameOf(Number(id));
    const myColor = L.colors?.[me] || color;
    const picker = colorPicker(myColor, (c) => {
      color = c;
      saveColor(c);
      if (hostView) {
        if (!Object.entries(lobby.colors).some(([id, v]) => v === c && Number(id) !== me)) setLobby((l) => (l.colors[me] = c));
      } else room.send({ t: 'pick', data: { color: c } });
    }, taken);

    const options = [];
    if (state.game === 'kart') {
      const laps = L.options?.laps ?? 3;
      options.push(
        el('h2', {}, 'Laps'),
        el(
          'div',
          { class: 'segmented' },
          [1, 3, 5].map((n) =>
            el('button', { 'aria-pressed': String(laps === n), disabled: !hostView, onclick: () => setLobby((l) => (l.options.laps = n)) }, `${n} lap${n > 1 ? 's' : ''}`),
          ),
        ),
      );
    }
    if (game.roles) {
      const cops = players.filter((p) => L.roles?.[p.id] === 'cop').length;
      options.push(el('p', { class: 'hint' }, `${players.length - cops} runner${players.length - cops === 1 ? '' : 's'} vs ${cops} cop${cops === 1 ? '' : 's'}.`, hostView ? ' Use the buttons to switch roles.' : ' The host decides who is a runner and who is a cop.'));
    }

    const canStart = hostView && enough && (!game.roles || (players.some((p) => L.roles?.[p.id] === 'cop') && players.some((p) => L.roles?.[p.id] !== 'cop')));
    const startBtn = hostView
      ? el(
          'button',
          {
            class: 'btn primary block',
            disabled: !canStart,
            onclick: () => {
              room.send({
                t: 'start',
                data: {
                  seed: (Math.random() * 2 ** 31) | 0,
                  options: lobby.options,
                  players: players.map((p) => ({ id: p.id, name: p.name, color: lobby.colors[p.id], role: lobby.roles[p.id] || 'runner' })),
                },
              });
            },
          },
          !enough ? 'Waiting for players…' : canStart ? `Start ${game.name}` : 'Needs at least one runner and one cop',
        )
      : el('p', { class: 'hint', style: { textAlign: 'center' } }, 'Waiting for the host to start…');

    layer.stage.replaceChildren(
      el(
        'div',
        { class: 'lobby' },
        codeBox,
        el('div', { class: 'card' }, el('h2', {}, `Players · ${players.length}/8`), el('ul', { class: 'lobby-list' }, rows)),
        el('div', { class: 'card' }, el('h2', {}, 'Your colour'), picker, ...options),
        startBtn,
      ),
    );
  }

  room.on('room', (m) => {
    state = m.room;
    if (!game) {
      game = GAMES[state.game];
      layer.setTitle(game.name);
    }
    syncLobby();
    renderLobby();
  });
  room.on('pick', (m) => {
    if (!isHost() || !m.data?.color || !TEAMS.some((t) => t.id === m.data.color)) return;
    const used = Object.entries(lobby.colors).some(([id, c]) => c === m.data.color && Number(id) !== m.from);
    if (!used) setLobby((l) => (l.colors[m.from] = m.data.color));
  });
  room.on('error', (m) => ctx.toast(m.error));
  room.on('closed', (m) => {
    ctx.toast(m.reason);
    exit();
  });
  room.on('disconnect', () => {
    if (!closed) {
      ctx.toast('Lost connection to the game.');
      exit();
    }
  });
  room.on('start', async (m) => {
    layer.layer.querySelector('.results')?.remove();
    layer.stage.replaceChildren();
    const mod = await loadGame(state.game);
    const data = m.data;
    running = await mod.play({
      stage: layer.stage,
      setInfo: layer.setInfo,
      mode: 'multi',
      room,
      meId: me,
      isHost: isHost(),
      players: data.players,
      seed: data.seed,
      options: data.options || {},
      toast: ctx.toast,
      onEnd: (results) => {
        if (isHost()) room.send({ t: 'end', data: results });
      },
    });
  });
  room.on('end', async (m) => {
    running?.();
    running = null;
    layer.setInfo(null);
    await renderLobby();
    if (m.data) {
      const panel = await resultsPanel(m.data, [el('button', { class: 'btn primary', onclick: () => panel.remove() }, 'Back to lobby')]);
      layer.layer.append(panel);
    }
  });

  if (host) room.send({ t: 'create', game: gameId });
  else room.send({ t: 'join', code });
  // A bad code just gets an error; leave once it arrives.
  const offErr = room.on('error', () => {
    if (!state) {
      offErr();
      exit();
      onFail?.();
    }
  });
}
