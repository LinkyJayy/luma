'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Starts Luma on a random port with a throwaway data directory.
async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-test-'));
  const app = createApp({ dataDir });
  const server = app.listen(0);
  const realtime = app.locals.attachRealtime(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    realtime.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // A cookie-carrying API client, i.e. one signed-in browser.
  function client() {
    let cookie = '';
    const call = async (p, { method = 'GET', body, form } = {}) => {
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
    call.cookie = () => cookie;
    return call;
  }

  async function signUp(username) {
    const c = client();
    const r = await c('/api/auth/register', { method: 'POST', body: { username, password: 'password123' } });
    if (r.status !== 201) throw new Error(`sign up failed: ${JSON.stringify(r.data)}`);
    c.user = r.data.user;
    return c;
  }

  return { base, client, signUp };
}

module.exports = { startServer, PNG };
