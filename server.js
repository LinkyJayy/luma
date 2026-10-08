'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const multer = require('multer');

const { openDb } = require('./lib/db');
const { TYPES, MAX_REEL_SECONDS, kindOf, probeDuration } = require('./lib/media');
const { normalizeLinks } = require('./lib/social');

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'luma_session';
const SESSION_DAYS = 30;
const PAGE = 12;
const MB = 1024 * 1024;

// Railway sets these on every deploy.
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

// Uploads and the database live on a persistent volume when one is attached.
function defaultDataDir() {
  return process.env.LUMA_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
}

function createApp(options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const limits = {
    video: (Number(process.env.LUMA_MAX_VIDEO_MB) || 1024) * MB,
    image: (Number(process.env.LUMA_MAX_IMAGE_MB) || 20) * MB,
    audio: (Number(process.env.LUMA_MAX_AUDIO_MB) || 150) * MB,
  };

  const db = openDb(dataDir);
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  const app = express();
  app.disable('x-powered-by');
  // Behind Railway's HTTPS proxy, trust it so req.secure (and Secure cookies) work.
  const trustProxy = process.env.TRUST_PROXY || (ON_RAILWAY ? '1' : '');
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // ---------- helpers ----------

  const uploadUrl = (name) => (name ? `/uploads/${name}` : null);

  function removeUpload(name) {
    if (!name || name.includes('/') || name.includes('\\')) return;
    fs.unlink(path.join(uploadDir, name), () => {});
  }

  function removeFiles(files) {
    for (const f of files || []) fs.unlink(f.path, () => {});
  }

  function filesOf(req) {
    return Object.values(req.files || {}).flat();
  }

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const fail = (status, message) => {
    throw new HttpError(status, message);
  };

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      bio: u.bio,
      avatar: uploadUrl(u.avatar),
      links: JSON.parse(u.links || '{}'),
      verified: !!u.verified,
    };
  }

  // What a signed-in user sees about themselves.
  const selfUser = (u) => ({ ...publicUser(u), isAdmin: !!u.is_admin, isOwner: !!u.is_owner });

  async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async function checkPassword(password, stored) {
    const [, salt, key] = String(stored).split('$');
    if (!salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  }

  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = now() + SESSION_DAYS * 864e5;
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_DAYS * 864e5,
      path: '/',
    });
  }

  // Resolve the signed-in user (if any) on every request.
  app.use((req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    req.user = null;
    if (token) {
      const row = q(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0`,
      ).get(sha256(token), now());
      if (row) req.user = row;
    }
    next();
  });

  // Reject cross-site writes. SameSite=Lax already keeps the cookie off them;
  // this is a second line of defence for browsers that send Origin.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please sign in first.' });
    next();
  }

  // Multer writes uploads straight to disk under random names. Per-kind size
  // limits are enforced after the upload since multer has a single limit.
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => {
        const kind = kindOf(file.mimetype);
        cb(null, crypto.randomBytes(16).toString('hex') + TYPES[kind][file.mimetype]);
      },
    }),
    limits: { fileSize: Math.max(limits.video, limits.image, limits.audio), files: 10, fields: 20 },
    fileFilter: (req, file, cb) => {
      const kind = kindOf(file.mimetype);
      const allowed = {
        avatar: ['image'],
        media: ['video', 'image'],
        cover: ['image'],
        audio: ['audio'],
      }[file.fieldname];
      if (!kind || !allowed || !allowed.includes(kind)) {
        return cb(new HttpError(400, `Unsupported file type: ${file.mimetype || 'unknown'}`));
      }
      cb(null, true);
    },
  });

  function checkSizes(files) {
    for (const f of files) {
      const kind = kindOf(f.mimetype);
      if (f.size > limits[kind]) {
        fail(413, `That ${kind} is too large (max ${Math.round(limits[kind] / MB)} MB).`);
      }
    }
  }

  // Wraps a multer middleware so files are cleaned up whenever the handler fails.
  function withUpload(mw, handler) {
    return [
      requireAuth,
      mw,
      async (req, res, next) => {
        try {
          checkSizes(filesOf(req));
          await handler(req, res);
        } catch (err) {
          removeFiles(filesOf(req));
          next(err);
        }
      },
    ];
  }

  const clean = (s, max) => String(s ?? '').trim().slice(0, max);

  // ---------- auth ----------

  app.use('/api', express.json({ limit: '64kb' }));

  const USERNAME = /^[a-z0-9_.]{3,24}$/;

  app.post('/api/auth/register', async (req, res) => {
    const username = clean(req.body?.username, 64).toLowerCase();
    const password = String(req.body?.password ?? '');
    const displayName = clean(req.body?.displayName, 50) || username;
    if (!USERNAME.test(username)) {
      fail(400, 'Usernames are 3–24 characters: letters, numbers, dots and underscores.');
    }
    if (password.length < 8) fail(400, 'Passwords need at least 8 characters.');
    if (password.length > 200) fail(400, 'That password is too long.');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken.');

    // The very first account becomes the admin, and is verified.
    const first = !q('SELECT 1 FROM users LIMIT 1').get();
    const hash = await hashPassword(password);
    const { lastInsertRowid } = q(
      `INSERT INTO users (username, display_name, password_hash, verified, is_admin, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(username, displayName, hash, first ? 1 : 0, first ? 1 : 0, first ? 1 : 0, now());
    startSession(req, res, Number(lastInsertRowid));
    const user = q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ user: selfUser(user) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = clean(req.body?.username, 64).toLowerCase().replace(/^@/, '');
    const password = String(req.body?.password ?? '').slice(0, 200);
    const user = q('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await checkPassword(password, user.password_hash))) {
      fail(401, 'Wrong username or password.');
    }
    if (user.banned) {
      fail(403, `This account has been suspended.${user.ban_reason ? ` Reason: ${user.ban_reason}` : ''}`);
    }
    startSession(req, res, user.id);
    res.json({ user: selfUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Used by Railway's deploy healthcheck.
  app.get('/api/health', (req, res) => {
    q('SELECT 1').get();
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: selfUser(req.user) });
  });

  app.patch(
    '/api/me',
    ...withUpload(upload.fields([{ name: 'avatar', maxCount: 1 }]), async (req, res) => {
      const u = req.user;
      const displayName = req.body.displayName !== undefined ? clean(req.body.displayName, 50) : u.display_name;
      const bio = req.body.bio !== undefined ? clean(req.body.bio, 300) : u.bio;
      if (!displayName) fail(400, 'Display name cannot be empty.');

      let links = u.links;
      if (req.body.links !== undefined) {
        let parsed;
        try {
          parsed = JSON.parse(req.body.links);
        } catch {
          fail(400, 'Invalid links.');
        }
        const result = normalizeLinks(parsed);
        if (result.error) fail(400, result.error);
        links = JSON.stringify(result.links);
      }

      const avatarFile = req.files?.avatar?.[0];
      const avatar = avatarFile ? avatarFile.filename : u.avatar;
      q('UPDATE users SET display_name = ?, bio = ?, links = ?, avatar = ? WHERE id = ?').run(
        displayName,
        bio,
        links,
        avatar,
        u.id,
      );
      if (avatarFile && u.avatar) removeUpload(u.avatar);
      const user = q('SELECT * FROM users WHERE id = ?').get(u.id);
      res.json({ user: selfUser(user) });
    }),
  );

  app.post('/api/me/password', requireAuth, async (req, res) => {
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (!(await checkPassword(current, req.user.password_hash))) fail(401, 'Current password is wrong.');
    if (next.length < 8 || next.length > 200) fail(400, 'Passwords need at least 8 characters.');
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
    // Sign out every other device.
    q('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    startSession(req, res, req.user.id);
    res.json({ ok: true });
  });

  // ---------- users ----------

  // Suspended accounts are invisible to everyone except admins.
  function getUserOr404(username, viewer) {
    const u = q('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase());
    if (!u || (u.banned && !viewer?.is_admin)) fail(404, 'User not found.');
    return u;
  }

  app.get('/api/users/:username', (req, res) => {
    const u = getUserOr404(req.params.username, req.user);
    const count = (sql) => q(sql).get(u.id).n;
    res.json({
      user: publicUser(u),
      stats: {
        followers: count('SELECT COUNT(*) n FROM follows WHERE followee_id = ?'),
        following: count('SELECT COUNT(*) n FROM follows WHERE follower_id = ?'),
        posts: count('SELECT COUNT(*) n FROM posts WHERE user_id = ?'),
        tracks: count('SELECT COUNT(*) n FROM tracks WHERE user_id = ?'),
        likes: count('SELECT COUNT(*) n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?'),
      },
      isFollowing: req.user
        ? !!q('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, u.id)
        : false,
      isMe: req.user?.id === u.id,
      moderation: req.user?.is_admin ? moderationOut(u) : undefined,
    });
  });

  app.post('/api/users/:username/follow', requireAuth, (req, res) => {
    const u = getUserOr404(req.params.username, req.user);
    if (u.id === req.user.id) fail(400, "You can't follow yourself.");
    const existing = q('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, u.id);
    if (existing) q('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
    else q('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.user.id, u.id);
    res.json({ following: !existing });
  });

  app.get('/api/search', (req, res) => {
    const term = clean(req.query.q, 50).replace(/^@/, '');
    if (!term) return res.json({ users: [], tracks: [] });
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const users = q(
      `SELECT * FROM users WHERE banned = 0 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY verified DESC, id LIMIT 20`,
    ).all(like, like);
    const tracks = q(
      `SELECT ${TRACK_COLS} FROM tracks t JOIN users u ON u.id = t.user_id
       WHERE u.banned = 0 AND (t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\' OR t.album LIKE ? ESCAPE '\\')
       ORDER BY t.plays DESC LIMIT 20`,
    ).all(like, like, like);
    res.json({ users: users.map(publicUser), tracks: tracks.map(trackOut) });
  });

  // ---------- reels (videos + pictures) ----------

  const POST_COLS = `p.*, u.username, u.display_name, u.avatar AS u_avatar, u.verified AS u_verified, u.banned AS u_banned,
    (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count`;

  function postOut(row, viewer) {
    return {
      id: row.id,
      type: row.type,
      caption: row.caption,
      media: JSON.parse(row.media).map(uploadUrl),
      duration: row.duration,
      createdAt: row.created_at,
      likes: row.like_count,
      comments: row.comment_count,
      liked: viewer ? !!q('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(viewer.id, row.id) : false,
      author: {
        username: row.username,
        displayName: row.display_name,
        avatar: uploadUrl(row.u_avatar),
        verified: !!row.u_verified,
      },
    };
  }

  const cursorOf = (req) => {
    const c = parseInt(req.query.cursor, 10);
    return Number.isFinite(c) && c > 0 ? c : Number.MAX_SAFE_INTEGER;
  };

  function page(rows, map) {
    const items = rows.slice(0, PAGE).map(map);
    const nextCursor = rows.length > PAGE ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  app.get('/api/feed', (req, res) => {
    const filter = req.query.following === '1' && req.user ? 'AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)' : '';
    const typeFilter = ['video', 'photo'].includes(req.query.type) ? 'AND p.type = ?' : '';
    const params = [cursorOf(req)];
    if (filter) params.push(req.user.id);
    if (typeFilter) params.push(req.query.type);
    const rows = q(
      `SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.id < ? AND u.banned = 0 ${filter} ${typeFilter} ORDER BY p.id DESC LIMIT ${PAGE + 1}`,
    ).all(...params);
    res.json(page(rows, (r) => postOut(r, req.user)));
  });

  app.get('/api/users/:username/posts', (req, res) => {
    const u = getUserOr404(req.params.username, req.user);
    const rows = q(
      `SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ? AND p.id < ? ORDER BY p.id DESC LIMIT ${PAGE + 1}`,
    ).all(u.id, cursorOf(req));
    res.json(page(rows, (r) => postOut(r, req.user)));
  });

  app.get('/api/posts/:id', (req, res) => {
    const row = q(`SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(
      Number(req.params.id),
    );
    if (!row || (row.u_banned && !req.user?.is_admin)) fail(404, 'Post not found.');
    res.json({ post: postOut(row, req.user) });
  });

  app.post(
    '/api/posts',
    ...withUpload(upload.fields([{ name: 'media', maxCount: 10 }]), async (req, res) => {
      const files = req.files?.media || [];
      const caption = clean(req.body.caption, 2200);
      if (!files.length) fail(400, 'Add a video or at least one picture.');

      const kinds = new Set(files.map((f) => kindOf(f.mimetype)));
      if (kinds.size > 1) fail(400, 'A reel is either one video or a set of pictures, not both.');
      const type = kinds.has('video') ? 'video' : 'photo';

      let duration = null;
      if (type === 'video') {
        if (files.length > 1) fail(400, 'Reels hold one video at a time.');
        const f = files[0];
        const probed = await probeDuration(f.path, f.mimetype);
        const claimed = parseFloat(req.body.duration);
        duration = probed ?? (Number.isFinite(claimed) ? claimed : null);
        if (duration === null) fail(400, "Couldn't read the video's length.");
        if (duration > MAX_REEL_SECONDS + 1) fail(400, 'Reels can be up to 15 minutes long.');
      }

      const { lastInsertRowid } = q(
        'INSERT INTO posts (user_id, type, caption, media, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(req.user.id, type, caption, JSON.stringify(files.map((f) => f.filename)), duration, now());
      const row = q(`SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(
        lastInsertRowid,
      );
      res.status(201).json({ post: postOut(row, req.user) });
    }),
  );

  app.delete('/api/posts/:id', requireAuth, (req, res) => {
    const post = q('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
    if (!post) fail(404, 'Post not found.');
    if (post.user_id !== req.user.id && !req.user.is_admin) fail(403, "That isn't your post.");
    deletePost(post);
    if (post.user_id !== req.user.id) logAction(req.user, 'delete_post', `post #${post.id}`);
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/like', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!q('SELECT 1 FROM posts WHERE id = ?').get(id)) fail(404, 'Post not found.');
    const liked = !!q('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, id);
    if (liked) q('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, id);
    else q('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, id);
    const { n } = q('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(id);
    res.json({ liked: !liked, likes: n });
  });

  const commentOut = (c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: { username: c.username, displayName: c.display_name, avatar: uploadUrl(c.avatar), verified: !!c.verified },
  });

  app.get('/api/posts/:id/comments', (req, res) => {
    const rows = q(
      `SELECT c.*, u.username, u.display_name, u.avatar, u.verified FROM comments c
       JOIN users u ON u.id = c.user_id WHERE c.post_id = ? AND u.banned = 0 ORDER BY c.id DESC LIMIT 200`,
    ).all(Number(req.params.id));
    res.json({ comments: rows.map(commentOut) });
  });

  app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const body = clean(req.body?.body, 500);
    if (!body) fail(400, 'Write something first.');
    if (!q('SELECT 1 FROM posts WHERE id = ?').get(id)) fail(404, 'Post not found.');
    const { lastInsertRowid } = q('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      req.user.id,
      body,
      now(),
    );
    const row = q(
      `SELECT c.*, u.username, u.display_name, u.avatar, u.verified FROM comments c
       JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    ).get(lastInsertRowid);
    res.status(201).json({ comment: commentOut(row) });
  });

  // ---------- Luma Music ----------

  const TRACK_COLS = `t.*, u.username, u.display_name, u.verified AS u_verified`;

  function trackOut(r) {
    return {
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      audio: uploadUrl(r.audio),
      cover: uploadUrl(r.cover),
      duration: r.duration,
      plays: r.plays,
      createdAt: r.created_at,
      uploader: { username: r.username, displayName: r.display_name, verified: !!r.u_verified },
    };
  }

  app.get('/api/tracks', (req, res) => {
    const rows = q(
      `SELECT ${TRACK_COLS} FROM tracks t JOIN users u ON u.id = t.user_id
       WHERE t.id < ? AND u.banned = 0 ORDER BY t.id DESC LIMIT ${PAGE + 1}`,
    ).all(cursorOf(req));
    res.json(page(rows, trackOut));
  });

  app.get('/api/users/:username/tracks', (req, res) => {
    const u = getUserOr404(req.params.username, req.user);
    const rows = q(
      `SELECT ${TRACK_COLS} FROM tracks t JOIN users u ON u.id = t.user_id
       WHERE t.user_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ${PAGE + 1}`,
    ).all(u.id, cursorOf(req));
    res.json(page(rows, trackOut));
  });

  app.post(
    '/api/tracks',
    ...withUpload(
      upload.fields([
        { name: 'audio', maxCount: 1 },
        { name: 'cover', maxCount: 1 },
      ]),
      async (req, res) => {
        const audio = req.files?.audio?.[0];
        const cover = req.files?.cover?.[0];
        const title = clean(req.body.title, 120);
        const artist = clean(req.body.artist, 120) || req.user.display_name;
        const album = clean(req.body.album, 120);
        if (!audio) fail(400, 'Choose a song file.');
        if (!cover) fail(400, 'Add an album cover.');
        if (!title) fail(400, 'Give your song a title.');

        const probed = await probeDuration(audio.path, audio.mimetype);
        const claimed = parseFloat(req.body.duration);
        const duration = probed ?? (Number.isFinite(claimed) && claimed > 0 ? claimed : null);

        const { lastInsertRowid } = q(
          `INSERT INTO tracks (user_id, title, artist, album, audio, cover, duration, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(req.user.id, title, artist, album, audio.filename, cover.filename, duration, now());
        const row = q(`SELECT ${TRACK_COLS} FROM tracks t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(
          lastInsertRowid,
        );
        res.status(201).json({ track: trackOut(row) });
      },
    ),
  );

  app.post('/api/tracks/:id/play', (req, res) => {
    q('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.delete('/api/tracks/:id', requireAuth, (req, res) => {
    const t = q('SELECT * FROM tracks WHERE id = ?').get(Number(req.params.id));
    if (!t) fail(404, 'Song not found.');
    if (t.user_id !== req.user.id && !req.user.is_admin) fail(403, "That isn't your song.");
    deleteTrack(t);
    if (t.user_id !== req.user.id) logAction(req.user, 'delete_track', `song #${t.id} “${t.title}”`);
    res.json({ ok: true });
  });

  // ---------- content removal ----------

  function deletePost(post) {
    q('DELETE FROM posts WHERE id = ?').run(post.id);
    JSON.parse(post.media).forEach(removeUpload);
  }

  function deleteTrack(t) {
    q('DELETE FROM tracks WHERE id = ?').run(t.id);
    removeUpload(t.audio);
    removeUpload(t.cover);
  }

  function logAction(admin, action, detail) {
    q('INSERT INTO admin_log (admin_id, action, detail, created_at) VALUES (?, ?, ?, ?)').run(
      admin.id,
      action,
      detail,
      now(),
    );
  }

  app.delete('/api/comments/:id', requireAuth, (req, res) => {
    const c = q('SELECT c.*, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(
      Number(req.params.id),
    );
    if (!c) fail(404, 'Comment not found.');
    // The commenter, the reel's author and admins can remove a comment.
    if (c.user_id !== req.user.id && c.post_owner !== req.user.id && !req.user.is_admin) {
      fail(403, "You can't delete that comment.");
    }
    q('DELETE FROM comments WHERE id = ?').run(c.id);
    if (req.user.is_admin && c.user_id !== req.user.id && c.post_owner !== req.user.id) {
      logAction(req.user, 'delete_comment', `comment #${c.id}`);
    }
    res.json({ ok: true });
  });

  // ---------- reports ----------

  const REPORT_TARGETS = {
    post: 'SELECT user_id AS owner FROM posts WHERE id = ?',
    track: 'SELECT user_id AS owner FROM tracks WHERE id = ?',
    comment: 'SELECT user_id AS owner FROM comments WHERE id = ?',
    user: 'SELECT id AS owner FROM users WHERE id = ?',
  };

  app.post('/api/reports', requireAuth, (req, res) => {
    const type = String(req.body?.type ?? '');
    const targetId = Number(req.body?.id);
    const reason = clean(req.body?.reason, 500);
    if (!REPORT_TARGETS[type] || !Number.isInteger(targetId)) fail(400, 'Invalid report.');
    if (!reason) fail(400, 'Tell us what is wrong.');
    const target = q(REPORT_TARGETS[type]).get(targetId);
    if (!target) fail(404, 'That no longer exists.');
    if (target.owner === req.user.id) fail(400, "You can't report your own content.");
    const dupe = q(
      `SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'`,
    ).get(req.user.id, type, targetId);
    if (!dupe) {
      q('INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id,
        type,
        targetId,
        reason,
        now(),
      );
    }
    res.status(201).json({ ok: true });
  });

  // ---------- admin tools ----------

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please sign in first.' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
    next();
  }
  app.use('/api/admin', requireAdmin);

  function moderationOut(u) {
    return { admin: !!u.is_admin, owner: !!u.is_owner, banned: !!u.banned, banReason: u.ban_reason };
  }

  function adminUserOut(u) {
    const count = (sql) => q(sql).get(u.id).n;
    return {
      ...publicUser(u),
      ...moderationOut(u),
      createdAt: u.created_at,
      posts: count('SELECT COUNT(*) n FROM posts WHERE user_id = ?'),
      tracks: count('SELECT COUNT(*) n FROM tracks WHERE user_id = ?'),
      reports: count(
        `SELECT COUNT(*) n FROM reports r WHERE r.status = 'open' AND (
           (r.target_type = 'user' AND r.target_id = ?1)
           OR (r.target_type = 'post' AND r.target_id IN (SELECT id FROM posts WHERE user_id = ?1))
           OR (r.target_type = 'track' AND r.target_id IN (SELECT id FROM tracks WHERE user_id = ?1))
           OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE user_id = ?1)))`,
      ),
    };
  }

  // Who may change what: the owner can do anything to anyone but themselves
  // losing control; other admins can verify and moderate regular users only.
  function assertCanManage(actor, target, { admin, banned }) {
    if (target.id === actor.id && banned === true) fail(400, "You can't suspend yourself.");
    if (target.is_owner && !actor.is_owner) fail(403, "Only the owner can change the owner's account.");
    if (target.is_owner && (admin === false || banned === true)) fail(400, "The owner can't be demoted or suspended.");
    if (admin !== undefined && !actor.is_owner) fail(403, 'Only the owner can give or remove admin.');
    if (target.is_admin && !target.is_owner && !actor.is_owner && banned !== undefined) {
      fail(403, 'Only the owner can suspend another admin.');
    }
  }

  app.get('/api/admin/stats', (req, res) => {
    const n = (sql) => q(sql).get().n;
    res.json({
      users: n('SELECT COUNT(*) n FROM users'),
      verified: n('SELECT COUNT(*) n FROM users WHERE verified = 1'),
      admins: n('SELECT COUNT(*) n FROM users WHERE is_admin = 1'),
      banned: n('SELECT COUNT(*) n FROM users WHERE banned = 1'),
      reels: n("SELECT COUNT(*) n FROM posts WHERE type = 'video'"),
      pictures: n("SELECT COUNT(*) n FROM posts WHERE type = 'photo'"),
      tracks: n('SELECT COUNT(*) n FROM tracks'),
      comments: n('SELECT COUNT(*) n FROM comments'),
      openReports: n("SELECT COUNT(*) n FROM reports WHERE status = 'open'"),
      newUsersThisWeek: q('SELECT COUNT(*) n FROM users WHERE created_at > ?').get(now() - 7 * 864e5).n,
    });
  });

  app.get('/api/admin/users', (req, res) => {
    const term = clean(req.query.q, 50).replace(/^@/, '');
    const filters = {
      admins: 'AND is_admin = 1',
      verified: 'AND verified = 1',
      banned: 'AND banned = 1',
    };
    const where = filters[req.query.filter] || '';
    const params = [cursorOf(req)];
    let search = '';
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      search = "AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')";
      params.push(like, like);
    }
    const rows = q(`SELECT * FROM users WHERE id < ? ${where} ${search} ORDER BY id DESC LIMIT ${PAGE + 1}`).all(
      ...params,
    );
    res.json(page(rows, adminUserOut));
  });

  app.patch('/api/admin/users/:username', (req, res) => {
    const target = getUserOr404(req.params.username, req.user);
    const body = req.body || {};
    const change = {
      verified: typeof body.verified === 'boolean' ? body.verified : undefined,
      admin: typeof body.admin === 'boolean' ? body.admin : undefined,
      banned: typeof body.banned === 'boolean' ? body.banned : undefined,
    };
    assertCanManage(req.user, target, change);

    const actions = [];
    if (change.verified !== undefined && change.verified !== !!target.verified) {
      q('UPDATE users SET verified = ? WHERE id = ?').run(change.verified ? 1 : 0, target.id);
      actions.push(change.verified ? 'verify' : 'unverify');
    }
    if (change.admin !== undefined && change.admin !== !!target.is_admin) {
      q('UPDATE users SET is_admin = ? WHERE id = ?').run(change.admin ? 1 : 0, target.id);
      actions.push(change.admin ? 'make_admin' : 'remove_admin');
    }
    if (change.banned !== undefined && change.banned !== !!target.banned) {
      const reason = change.banned ? clean(body.banReason, 300) : '';
      q('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').run(change.banned ? 1 : 0, reason, target.id);
      // Signs the account out everywhere.
      if (change.banned) q('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      actions.push(change.banned ? 'suspend' : 'unsuspend');
    }
    for (const a of actions) logAction(req.user, a, `@${target.username}`);
    res.json({ user: adminUserOut(q('SELECT * FROM users WHERE id = ?').get(target.id)) });
  });

  // Removes everything a user has posted: reels, pictures, songs and comments.
  app.post('/api/admin/users/:username/purge', (req, res) => {
    const target = getUserOr404(req.params.username, req.user);
    if (target.id !== req.user.id) {
      if (target.is_owner) fail(403, "The owner's content can't be removed by others.");
      if (target.is_admin && !req.user.is_owner) fail(403, "Only the owner can remove another admin's content.");
    }
    const posts = q('SELECT * FROM posts WHERE user_id = ?').all(target.id);
    const tracks = q('SELECT * FROM tracks WHERE user_id = ?').all(target.id);
    posts.forEach(deletePost);
    tracks.forEach(deleteTrack);
    const { changes } = q('DELETE FROM comments WHERE user_id = ?').run(target.id);
    logAction(
      req.user,
      'purge',
      `@${target.username}: ${posts.length} reels, ${tracks.length} songs, ${changes} comments`,
    );
    res.json({ posts: posts.length, tracks: tracks.length, comments: Number(changes) });
  });

  function reportTarget(type, id) {
    if (type === 'post') {
      const r = q(`SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(id);
      return r && { ...postOut(r, null), owner: r.username };
    }
    if (type === 'track') {
      const r = q(`SELECT ${TRACK_COLS} FROM tracks t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(id);
      return r && { ...trackOut(r), owner: r.username };
    }
    if (type === 'comment') {
      const r = q(
        `SELECT c.*, u.username, u.display_name, u.avatar, u.verified FROM comments c
         JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      ).get(id);
      return r && { ...commentOut(r), postId: r.post_id, owner: r.username };
    }
    const u = q('SELECT * FROM users WHERE id = ?').get(id);
    return u && { ...publicUser(u), ...moderationOut(u), owner: u.username };
  }

  app.get('/api/admin/reports', (req, res) => {
    const status = req.query.status === 'resolved' ? "r.status != 'open'" : "r.status = 'open'";
    const rows = q(
      `SELECT r.*, u.username AS reporter, x.username AS resolver,
         (SELECT COUNT(*) FROM reports o WHERE o.target_type = r.target_type AND o.target_id = r.target_id
            AND o.status = 'open') AS open_count
       FROM reports r JOIN users u ON u.id = r.reporter_id LEFT JOIN users x ON x.id = r.resolved_by
       WHERE r.id < ? AND ${status} ORDER BY r.id DESC LIMIT ${PAGE + 1}`,
    ).all(cursorOf(req));
    res.json(
      page(rows, (r) => ({
        id: r.id,
        type: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        status: r.status,
        reporter: r.reporter,
        resolver: r.resolver,
        openCount: r.open_count,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        target: reportTarget(r.target_type, r.target_id) || null,
      })),
    );
  });

  // Resolves a report and every other open report on the same thing.
  // "remove" deletes the content, or suspends the account for a user report.
  app.post('/api/admin/reports/:id', (req, res) => {
    const report = q('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
    if (!report) fail(404, 'Report not found.');
    const action = req.body?.action;
    if (!['remove', 'dismiss'].includes(action)) fail(400, 'Choose remove or dismiss.');

    if (action === 'remove') {
      const id = report.target_id;
      if (report.target_type === 'post') {
        const post = q('SELECT * FROM posts WHERE id = ?').get(id);
        if (post) deletePost(post);
      } else if (report.target_type === 'track') {
        const t = q('SELECT * FROM tracks WHERE id = ?').get(id);
        if (t) deleteTrack(t);
      } else if (report.target_type === 'comment') {
        q('DELETE FROM comments WHERE id = ?').run(id);
      } else {
        const u = q('SELECT * FROM users WHERE id = ?').get(id);
        if (u) {
          assertCanManage(req.user, u, { banned: true });
          q('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(clean(report.reason, 300), u.id);
          q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        }
      }
    }
    const { changes } = q(
      `UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?
       WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    ).run(action === 'remove' ? 'removed' : 'dismissed', req.user.id, now(), report.target_type, report.target_id);
    logAction(req.user, `report_${action}`, `${report.target_type} #${report.target_id}`);
    res.json({ ok: true, resolved: Number(changes) });
  });

  app.get('/api/admin/log', (req, res) => {
    const rows = q(
      `SELECT l.*, u.username FROM admin_log l LEFT JOIN users u ON u.id = l.admin_id
       ORDER BY l.id DESC LIMIT 100`,
    ).all();
    res.json({
      items: rows.map((r) => ({ id: r.id, admin: r.username, action: r.action, detail: r.detail, createdAt: r.created_at })),
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // ---------- static ----------

  // Uploaded media. express.static supports Range requests, which video
  // seeking and audio scrubbing rely on.
  app.use(
    '/uploads',
    express.static(uploadDir, {
      immutable: true,
      maxAge: '365d',
      index: false,
      setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; sandbox"),
    }),
  );

  const publicDir = path.join(__dirname, 'public');
  app.use(
    express.static(publicDir, {
      setHeaders: (res, file) => {
        // The service worker and app shell must always revalidate so updates ship.
        if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
        if (file.endsWith('.webmanifest')) res.type('application/manifest+json');
      },
    }),
  );

  // ---------- errors ----------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message;
      return res.status(413).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  // Drop expired sessions now and then.
  const sweep = setInterval(() => q('DELETE FROM sessions WHERE expires_at < ?').run(now()), 36e5);
  sweep.unref();

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataDir = defaultDataDir();
  if (ON_RAILWAY && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.LUMA_DATA_DIR) {
    console.warn(
      'WARNING: No Railway volume is attached. Accounts and uploads will be lost on every redeploy. ' +
        'Attach a volume to this service (any mount path, e.g. /data).',
    );
  }
  const app = createApp({ dataDir });
  const server = app.listen(port, () => {
    console.log(`Luma is running on port ${port} (data: ${dataDir})`);
  });

  // Railway sends SIGTERM before replacing a deploy; finish in-flight requests first.
  const shutdown = () => {
    server.close(() => {
      app.locals.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
