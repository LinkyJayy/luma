'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer } = require('./helpers');

// A socket client that queues messages so tests can await the next one of a type.
function connect(base, cookie, origin) {
  const url = base.replace('http', 'ws') + '/ws/play';
  const ws = new WebSocket(url, { headers: { cookie, origin: origin ?? base } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.t);
    if (i > -1) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject))),
    send: (m) => ws.send(JSON.stringify(m)),
    next(type) {
      const i = inbox.findIndex((m) => m.t === type);
      if (i > -1) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
        waiters.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    // Resolves to the latest 'room' message once the predicate holds.
    async roomWhere(pred) {
      for (;;) {
        const { room } = await this.next('room');
        if (pred(room)) return room;
      }
    },
    close: () => ws.close(),
  };
}

test('Luma Playables rooms', async (t) => {
  const { base, client, signUp } = await startServer(t);
  const host = await signUp('host');
  const guest = await signUp('guest');

  await t.test('sockets need a signed-in session from this site', async () => {
    await assert.rejects(connect(base, '').open(), /401/);
    await assert.rejects(connect(base, host.cookie(), 'https://evil.example').open(), /401/);
    const anon = client();
    await assert.rejects(connect(base, anon.cookie()).open(), /401/);
  });

  const h = connect(base, host.cookie());
  const g = connect(base, guest.cookie());
  await Promise.all([h.open(), g.open()]);
  t.after(() => (h.close(), g.close()));
  const hostId = (await h.next('hello')).me.id;
  const guestId = (await g.next('hello')).me.id;

  let code;
  await t.test('host creates, guest joins with the code', async () => {
    h.send({ t: 'create', game: 'kart' });
    const room = await h.roomWhere(() => true);
    assert.match(room.code, /^[A-Z]{4}$/);
    assert.equal(room.hostId, hostId);
    code = room.code;

    g.send({ t: 'join', code: code.toLowerCase() });
    const seen = await g.roomWhere((r) => r.players.length === 2);
    assert.deepEqual(seen.players.map((p) => p.username), ['host', 'guest']);
    await h.roomWhere((r) => r.players.length === 2);
  });

  await t.test('lobby, picks, input and state are relayed', async () => {
    g.send({ t: 'pick', data: { color: 'teal' } });
    assert.deepEqual(await h.next('pick'), { t: 'pick', from: guestId, data: { color: 'teal' } });

    g.send({ t: 'lobby', lobby: { hacked: true } }); // ignored: not the host
    h.send({ t: 'lobby', lobby: { colors: { [guestId]: 'teal' } } });
    const r = await g.roomWhere((x) => x.lobby);
    assert.deepEqual(r.lobby, { colors: { [guestId]: 'teal' } });

    h.send({ t: 'start', data: { seed: 7 } });
    assert.deepEqual((await g.next('start')).data, { seed: 7 });

    g.send({ t: 'input', i: { left: true } });
    assert.deepEqual(await h.next('input'), { t: 'input', from: guestId, i: { left: true } });
    h.send({ t: 'state', s: { tick: 1 } });
    assert.deepEqual((await g.next('state')).s, { tick: 1 });
  });

  await t.test('nobody can join a game in progress', async () => {
    const late = await signUp('late');
    const l = connect(base, late.cookie());
    await l.open();
    l.send({ t: 'join', code });
    assert.match((await l.next('error')).error, /already started/);
    l.close();
  });

  await t.test('games need enough players, and the room ends with the host', async () => {
    h.send({ t: 'end' });
    await g.next('end');
    g.send({ t: 'leave' });
    await h.roomWhere((r) => r.players.length === 1);
    h.send({ t: 'start' });
    assert.match((await h.next('error')).error, /at least 2/);

    g.send({ t: 'join', code });
    await g.roomWhere((r) => r.players.length === 2);
    h.close();
    assert.match((await g.next('closed')).reason, /host left/);
  });

  await t.test('rooms hold at most 8 players', async () => {
    const owner = await signUp('owner8');
    const o = connect(base, owner.cookie());
    await o.open();
    o.send({ t: 'create', game: 'chaos' });
    const room = await o.roomWhere(() => true);
    const others = [];
    for (let i = 0; i < 8; i++) {
      const c = connect(base, (await signUp(`player${i}`)).cookie());
      await c.open();
      c.send({ t: 'join', code: room.code });
      others.push(c);
    }
    const last = others.pop();
    assert.match((await last.next('error')).error, /full/);
    [o, last, ...others].forEach((c) => c.close());
  });
});
