'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { normalizeLink } = require('../lib/social');

// Builds the smallest MP4 our parser understands: ftyp + moov/mvhd.
function fakeMp4(seconds) {
  const box = (type, body) => {
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(b.length, 0);
    b.write(type, 4, 'latin1');
    body.copy(b, 8);
    return b;
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16); // duration
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('mvhd', mvhd))]);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('Luma API', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-test-'));
  const server = createApp({ dataDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function client() {
    let cookie = '';
    return async (p, { method = 'GET', body, form } = {}) => {
      const headers = { cookie };
      let payload;
      if (form) payload = form;
      else if (body) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + p, { method, headers, body: payload });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  }

  const alice = client();
  const bob = client();

  await t.test('first account is admin and verified', async () => {
    const r = await alice('/api/auth/register', { method: 'POST', body: { username: 'Alice', password: 'password1', displayName: 'Alice' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.username, 'alice');
    assert.equal(r.data.user.verified, true);
    assert.equal(r.data.user.isAdmin, true);
  });

  await t.test('second account is a regular user', async () => {
    const r = await bob('/api/auth/register', { method: 'POST', body: { username: 'bob', password: 'password2' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.verified, false);
    assert.equal(r.data.user.isAdmin, false);
    const dupe = await client()('/api/auth/register', { method: 'POST', body: { username: 'bob', password: 'password3' } });
    assert.equal(dupe.status, 409);
  });

  await t.test('login checks the password', async () => {
    const c = client();
    assert.equal((await c('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'nope-nope' } })).status, 401);
    const ok = await c('/api/auth/login', { method: 'POST', body: { username: '@bob', password: 'password2' } });
    assert.equal(ok.status, 200);
    assert.equal((await c('/api/me')).data.user.username, 'bob');
    await c('/api/auth/logout', { method: 'POST' });
    assert.equal((await c('/api/me')).data.user, null);
  });

  await t.test('profile with social badges', async () => {
    const form = new FormData();
    form.append('bio', 'hello');
    form.append(
      'links',
      JSON.stringify({ tiktok: '@bobby', instagram: 'https://www.instagram.com/bob', x: 'bob_x', youtube: '', linktree: 'bob' }),
    );
    form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png');
    const r = await bob('/api/me', { method: 'PATCH', form });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.user.links, {
      tiktok: 'https://www.tiktok.com/@bobby',
      instagram: 'https://www.instagram.com/bob',
      x: 'https://x.com/bob_x',
      linktree: 'https://linktr.ee/bob',
    });
    assert.match(r.data.user.avatar, /^\/uploads\/[0-9a-f]{32}\.png$/);

    const bad = new FormData();
    bad.append('links', JSON.stringify({ facebook: 'https://evil.example.com/x' }));
    assert.equal((await bob('/api/me', { method: 'PATCH', form: bad })).status, 400);
  });

  await t.test('admins can verify; others cannot', async () => {
    assert.equal((await bob('/api/admin/users/alice', { method: 'PATCH', body: { verified: false } })).status, 403);
    const r = await alice('/api/admin/users/bob', { method: 'PATCH', body: { verified: true } });
    assert.equal(r.data.user.verified, true);
    assert.equal((await bob('/api/users/bob')).data.user.verified, true);
  });

  let videoId;
  await t.test('video reels up to 15 minutes', async () => {
    const ok = new FormData();
    ok.append('media', new Blob([fakeMp4(14 * 60 + 59)], { type: 'video/mp4' }), 'v.mp4');
    ok.append('caption', 'my long reel');
    const r = await bob('/api/posts', { method: 'POST', form: ok });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.post.type, 'video');
    assert.equal(Math.round(r.data.post.duration), 899);
    videoId = r.data.post.id;

    // The server reads the real length, so lying about it doesn't help.
    const long = new FormData();
    long.append('media', new Blob([fakeMp4(16 * 60)], { type: 'video/mp4' }), 'v.mp4');
    long.append('duration', '10');
    const r2 = await bob('/api/posts', { method: 'POST', form: long });
    assert.equal(r2.status, 400);
    assert.match(r2.data.error, /15 minutes/);
  });

  await t.test('picture reels', async () => {
    const form = new FormData();
    for (let i = 0; i < 3; i++) form.append('media', new Blob([PNG], { type: 'image/png' }), `${i}.png`);
    const r = await alice('/api/posts', { method: 'POST', form });
    assert.equal(r.status, 201);
    assert.equal(r.data.post.type, 'photo');
    assert.equal(r.data.post.media.length, 3);

    const mixed = new FormData();
    mixed.append('media', new Blob([PNG], { type: 'image/png' }), 'a.png');
    mixed.append('media', new Blob([fakeMp4(5)], { type: 'video/mp4' }), 'v.mp4');
    assert.equal((await alice('/api/posts', { method: 'POST', form: mixed })).status, 400);

    const html = new FormData();
    html.append('media', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
    assert.equal((await alice('/api/posts', { method: 'POST', form: html })).status, 400);
  });

  await t.test('uploading requires an account', async () => {
    const form = new FormData();
    form.append('media', new Blob([PNG], { type: 'image/png' }), 'a.png');
    assert.equal((await client()('/api/posts', { method: 'POST', form })).status, 401);
  });

  await t.test('feed, likes, comments, follows', async () => {
    const feed = await alice('/api/feed');
    assert.equal(feed.data.items.length, 2);
    assert.equal(feed.data.items[1].author.verified, true);

    const like = await alice(`/api/posts/${videoId}/like`, { method: 'POST' });
    assert.deepEqual(like.data, { liked: true, likes: 1 });
    const c = await alice(`/api/posts/${videoId}/comments`, { method: 'POST', body: { body: 'nice!' } });
    assert.equal(c.status, 201);
    assert.equal((await bob(`/api/posts/${videoId}`)).data.post.comments, 1);

    assert.equal((await alice('/api/feed?following=1')).data.items.length, 0);
    assert.equal((await alice('/api/users/bob/follow', { method: 'POST' })).data.following, true);
    assert.equal((await alice('/api/feed?following=1')).data.items.length, 1);

    assert.equal((await alice(`/api/posts/${videoId}`, { method: 'DELETE' })).status, 200, 'admin can delete');
  });

  await t.test('Luma Music needs a song and an album cover', async () => {
    const noCover = new FormData();
    noCover.append('audio', new Blob([Buffer.alloc(1000)], { type: 'audio/mpeg' }), 's.mp3');
    noCover.append('title', 'Song');
    assert.equal((await bob('/api/tracks', { method: 'POST', form: noCover })).status, 400);

    const form = new FormData();
    form.append('audio', new Blob([Buffer.alloc(1000)], { type: 'audio/mpeg' }), 's.mp3');
    form.append('cover', new Blob([PNG], { type: 'image/png' }), 'c.png');
    form.append('title', 'Starlight');
    form.append('album', 'Glow');
    form.append('duration', '183.4');
    const r = await bob('/api/tracks', { method: 'POST', form });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.track.artist, 'bob');
    assert.equal(r.data.track.uploader.verified, true);

    const audio = await fetch(base + r.data.track.audio, { headers: { range: 'bytes=0-9' } });
    assert.equal(audio.status, 206, 'media supports range requests');

    const list = await client()('/api/tracks');
    assert.equal(list.data.items[0].title, 'Starlight');
    const search = await client()('/api/search?q=star');
    assert.equal(search.data.tracks.length, 1);
  });

  await t.test('PWA files are served', async () => {
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.equal((await m.json()).name, 'Luma');
    assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  });
});

test('social link normalization', () => {
  assert.equal(normalizeLink('youtube', '@luma'), 'https://www.youtube.com/@luma');
  assert.equal(normalizeLink('facebook', 'https://m.facebook.com/luma'), 'https://m.facebook.com/luma');
  assert.equal(normalizeLink('x', 'https://twitter.com/luma'), 'https://twitter.com/luma');
  assert.equal(normalizeLink('x', 'javascript:alert(1)'), null);
  assert.equal(normalizeLink('instagram', 'http://instagram.com/luma'), null);
  assert.equal(normalizeLink('linktree', 'https://linktr.ee.evil.com/a'), null);
});
