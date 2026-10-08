'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PNG } = require('./helpers');

function photoForm() {
  const form = new FormData();
  form.append('media', new Blob([PNG], { type: 'image/png' }), 'p.png');
  return form;
}

test('admin tools', async (t) => {
  const { client, signUp } = await startServer(t);
  const owner = await signUp('owner');
  const mod = await signUp('mod');
  const carol = await signUp('carol');
  const dave = await signUp('dave');

  await t.test('the first account owns the platform', () => {
    assert.equal(owner.user.isOwner, true);
    assert.equal(owner.user.isAdmin, true);
    assert.equal(owner.user.verified, true);
    assert.equal(mod.user.isOwner, false);
    assert.equal(mod.user.isAdmin, false);
  });

  await t.test('regular users cannot reach admin tools', async () => {
    assert.equal((await carol('/api/admin/stats')).status, 403);
    assert.equal((await client()('/api/admin/stats')).status, 401);
    assert.equal((await carol('/api/admin/users/dave', { method: 'PATCH', body: { verified: true } })).status, 403);
  });

  await t.test('owner gives verified badges and admin', async () => {
    let r = await owner('/api/admin/users/carol', { method: 'PATCH', body: { verified: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.verified, true);
    r = await owner('/api/admin/users/mod', { method: 'PATCH', body: { admin: true } });
    assert.equal(r.data.user.admin, true);
    assert.equal((await mod('/api/me')).data.user.isAdmin, true);
  });

  await t.test('other admins can verify but not hand out admin or touch the owner', async () => {
    assert.equal((await mod('/api/admin/users/dave', { method: 'PATCH', body: { verified: true } })).status, 200);
    assert.equal((await mod('/api/admin/users/dave', { method: 'PATCH', body: { admin: true } })).status, 403);
    assert.equal((await mod('/api/admin/users/owner', { method: 'PATCH', body: { verified: false } })).status, 403);
    assert.equal((await mod('/api/admin/users/owner', { method: 'PATCH', body: { banned: true } })).status, 403);
    assert.equal((await owner('/api/admin/users/owner', { method: 'PATCH', body: { admin: false } })).status, 400);
    assert.equal((await mod('/api/admin/users/mod', { method: 'PATCH', body: { banned: true } })).status, 400);
  });

  await t.test('users report content and admins remove it', async () => {
    const post = (await dave('/api/posts', { method: 'POST', form: photoForm() })).data.post;
    assert.equal((await dave('/api/reports', { method: 'POST', body: { type: 'post', id: post.id, reason: 'mine' } })).status, 400);
    assert.equal((await carol('/api/reports', { method: 'POST', body: { type: 'post', id: post.id, reason: 'spam' } })).status, 201);
    assert.equal((await mod('/api/reports', { method: 'POST', body: { type: 'post', id: post.id, reason: 'spam!' } })).status, 201);

    const stats = (await owner('/api/admin/stats')).data;
    assert.equal(stats.openReports, 2);
    assert.equal(stats.users, 4);

    const reports = (await owner('/api/admin/reports')).data.items;
    assert.equal(reports.length, 2);
    assert.equal(reports[0].target.id, post.id);
    assert.equal(reports[0].target.owner, 'dave');
    assert.equal(reports[0].openCount, 2);

    const r = await mod(`/api/admin/reports/${reports[0].id}`, { method: 'POST', body: { action: 'remove' } });
    assert.equal(r.data.resolved, 2, 'resolves every report on the same reel');
    assert.equal((await carol(`/api/posts/${post.id}`)).status, 404);
    assert.equal((await owner('/api/admin/reports')).data.items.length, 0);
    assert.equal((await owner('/api/admin/reports?status=resolved')).data.items[0].status, 'removed');
  });

  await t.test('dismissing a report keeps the content', async () => {
    const post = (await dave('/api/posts', { method: 'POST', form: photoForm() })).data.post;
    await carol('/api/reports', { method: 'POST', body: { type: 'post', id: post.id, reason: 'meh' } });
    const [report] = (await owner('/api/admin/reports')).data.items;
    await owner(`/api/admin/reports/${report.id}`, { method: 'POST', body: { action: 'dismiss' } });
    assert.equal((await carol(`/api/posts/${post.id}`)).status, 200);
  });

  await t.test('comments can be removed by their author, the reel author and admins', async () => {
    const post = (await carol('/api/posts', { method: 'POST', form: photoForm() })).data.post;
    const c1 = (await dave(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body: 'one' } })).data.comment;
    const c2 = (await dave(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body: 'two' } })).data.comment;
    const c3 = (await dave(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body: 'three' } })).data.comment;
    const stranger = await signUp('stranger');
    assert.equal((await stranger(`/api/comments/${c1.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await dave(`/api/comments/${c1.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await carol(`/api/comments/${c2.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await mod(`/api/comments/${c3.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await carol(`/api/posts/${post.id}/comments`)).data.comments.length, 0);
  });

  await t.test('suspending an account signs it out and hides it', async () => {
    const post = (await dave('/api/posts', { method: 'POST', form: photoForm() })).data.post;
    const r = await mod('/api/admin/users/dave', { method: 'PATCH', body: { banned: true, banReason: 'spam' } });
    assert.equal(r.data.user.banned, true);

    assert.equal((await dave('/api/me')).data.user, null, 'existing session ended');
    const login = await client()('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'password123' } });
    assert.equal(login.status, 403);
    assert.match(login.data.error, /suspended.*spam/);

    assert.equal((await carol('/api/users/dave')).status, 404);
    assert.equal((await carol(`/api/posts/${post.id}`)).status, 404);
    assert.ok(!(await carol('/api/feed')).data.items.some((p) => p.author.username === 'dave'));
    assert.equal((await carol('/api/search?q=dave')).data.users.length, 0);

    const seen = await owner('/api/users/dave');
    assert.equal(seen.status, 200, 'admins can still open the profile');
    assert.equal(seen.data.moderation.banned, true);
    assert.equal((await owner('/api/admin/users?filter=banned')).data.items[0].username, 'dave');

    await owner('/api/admin/users/dave', { method: 'PATCH', body: { banned: false } });
    const back = await client()('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'password123' } });
    assert.equal(back.status, 200);
  });

  await t.test('only the owner can suspend another admin', async () => {
    const r = await signUp('mod2');
    await owner('/api/admin/users/mod2', { method: 'PATCH', body: { admin: true } });
    assert.equal((await mod('/api/admin/users/mod2', { method: 'PATCH', body: { banned: true } })).status, 403);
    assert.equal((await owner('/api/admin/users/mod2', { method: 'PATCH', body: { banned: true } })).status, 200);
    assert.equal((await r('/api/me')).data.user, null);
  });

  await t.test('purge removes everything a user posted', async () => {
    await dave('/api/posts', { method: 'POST', form: photoForm() });
    const r = await mod('/api/admin/users/dave/purge', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.ok(r.data.posts >= 1);
    assert.equal((await owner('/api/users/dave/posts')).data.items.length, 0);
    assert.equal((await mod('/api/admin/users/owner/purge', { method: 'POST' })).status, 403);
  });

  await t.test('every admin action is logged', async () => {
    const { items } = (await owner('/api/admin/log')).data;
    const actions = items.map((i) => i.action);
    for (const a of ['verify', 'make_admin', 'suspend', 'unsuspend', 'report_remove', 'report_dismiss', 'purge']) {
      assert.ok(actions.includes(a), `${a} logged`);
    }
  });
});
