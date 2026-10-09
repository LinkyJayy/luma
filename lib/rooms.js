'use strict';

// Real-time rooms for Luma Playables.
//
// The server only manages rooms and relays messages. Each game runs in the
// host's browser: the host sends authoritative state to everyone, and the
// other players send their input to the host.

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const GAMES = {
  kart: { min: 2, max: 8 },
  chaos: { min: 2, max: 8 },
  escape: { min: 2, max: 8 },
  invaders: { min: 2, max: 8 },
};

const MAX_ROOMS = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they read like 1 and 0

function attachRooms(server, { userFromRequest }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const rooms = new Map();
  let nextId = 1;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/play') return;
    // Only pages from this site may open a socket with the user's cookie.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = !origin || new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    const user = sameOrigin ? userFromRequest(req) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user));
  });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function snapshot(room) {
    return {
      code: room.code,
      game: room.game,
      hostId: room.hostId,
      status: room.status,
      lobby: room.lobby,
      players: [...room.members.values()].map((m) => ({
        id: m.id,
        name: m.user.displayName,
        username: m.user.username,
        verified: m.user.verified,
      })),
    };
  }

  function broadcast(room, msg, except) {
    const data = JSON.stringify(msg);
    for (const m of room.members.values()) {
      if (m !== except && m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }

  const announce = (room) => broadcast(room, { t: 'room', room: snapshot(room) });

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function leave(member, reason) {
    const room = member.room;
    if (!room) return;
    room.members.delete(member.id);
    member.room = null;
    if (room.hostId === member.id || room.members.size === 0) {
      // The game lives in the host's browser, so the room ends with them.
      for (const m of room.members.values()) {
        m.room = null;
        send(m.ws, { t: 'closed', reason: reason || 'The host left the game.' });
      }
      rooms.delete(room.code);
      return;
    }
    broadcast(room, { t: 'left', id: member.id });
    announce(room);
  }

  wss.on('connection', (ws, user) => {
    const member = { id: nextId++, ws, user, room: null, tokens: 200, last: Date.now() };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    send(ws, { t: 'hello', me: { id: member.id, name: user.displayName, username: user.username } });

    ws.on('message', (raw) => {
      // Token bucket: 120 messages per second sustained, bursts of 200.
      const now = Date.now();
      member.tokens = Math.min(200, member.tokens + ((now - member.last) / 1000) * 120);
      member.last = now;
      if (member.tokens < 1) return;
      member.tokens -= 1;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      const room = member.room;
      const isHost = room && room.hostId === member.id;

      switch (msg.t) {
        case 'create': {
          const spec = GAMES[msg.game];
          if (!spec) return send(ws, { t: 'error', error: 'Unknown game.' });
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', error: 'Too many games are running. Try again soon.' });
          leave(member);
          const r = { code: newCode(), game: msg.game, spec, hostId: member.id, status: 'lobby', lobby: null, members: new Map() };
          r.members.set(member.id, member);
          member.room = r;
          rooms.set(r.code, r);
          return announce(r);
        }
        case 'join': {
          const r = rooms.get(String(msg.code || '').toUpperCase().trim());
          if (!r) return send(ws, { t: 'error', error: 'No game with that code.' });
          if (r === room) return announce(r);
          if (r.status !== 'lobby') return send(ws, { t: 'error', error: 'That game has already started.' });
          if (r.members.size >= r.spec.max) return send(ws, { t: 'error', error: `That game is full (${r.spec.max} players).` });
          leave(member);
          r.members.set(member.id, member);
          member.room = r;
          broadcast(r, { t: 'joined', id: member.id }, member);
          return announce(r);
        }
        case 'leave':
          return leave(member);
        case 'lobby':
          // Host-owned lobby settings: colours, roles, options.
          if (!isHost) return;
          room.lobby = msg.lobby ?? null;
          return announce(room);
        case 'pick': {
          // A player asks the host for something (a colour, ready, ...).
          if (!room) return;
          const host = room.members.get(room.hostId);
          if (host) send(host.ws, { t: 'pick', from: member.id, data: msg.data });
          return;
        }
        case 'start':
          if (!isHost || room.status !== 'lobby') return;
          if (room.members.size < room.spec.min) {
            return send(ws, { t: 'error', error: `You need at least ${room.spec.min} players.` });
          }
          room.status = 'playing';
          announce(room);
          return broadcast(room, { t: 'start', data: msg.data ?? null });
        case 'state': {
          if (!isHost) return;
          const out = { t: 'state', s: msg.s };
          if (msg.to) {
            const target = room.members.get(msg.to);
            if (target) send(target.ws, out);
          } else broadcast(room, out, member);
          return;
        }
        case 'input': {
          if (!room || isHost) return;
          const host = room.members.get(room.hostId);
          if (host) send(host.ws, { t: 'input', from: member.id, i: msg.i });
          return;
        }
        case 'end':
          if (!isHost) return;
          room.status = 'lobby';
          broadcast(room, { t: 'end', data: msg.data ?? null });
          return announce(room);
        case 'kick': {
          if (!isHost || msg.id === member.id) return;
          const target = room.members.get(msg.id);
          if (!target) return;
          send(target.ws, { t: 'closed', reason: 'The host removed you from the game.' });
          return leave(target);
        }
        default:
      }
    });

    ws.on('close', () => leave(member));
  });

  // Drop connections that stopped answering (phones going to sleep, etc).
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
  }

  return { wss, rooms, close };
}

module.exports = { attachRooms, GAMES };
