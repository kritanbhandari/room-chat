import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadAssets } from '../server.mjs';
import { openDatabase } from '../database.mjs';
import api from '../api.mjs';
const transports = new Map();
let nextPort = 3100;
async function testFetch(url, options = {}) {
  const transport = transports.get(new URL(url).origin);
  return transport ? transport(new Request(url, options)) : fetch(url, options);
}

const PASSWORD = 'testing-password-123';
async function client(app, username) {
  const agent = { cookie: '', async request(path, data, headers = {}) {
    const response = await testFetch(app.url + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(data === undefined ? {} : { Origin: app.url, 'Content-Type': 'application/json' }),
      ...(agent.cookie ? { Cookie: agent.cookie } : {}), ...headers,
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (response.headers.has('set-cookie')) agent.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, data: await response.json() };
  } };
  if (username) {
    const response = await agent.request('/api/auth/register', { username, name: username, password: PASSWORD });
    assert.equal(response.status, 201, JSON.stringify(response.data)); agent.user = response.data.user;
  }
  return agent;
}
async function start(options = {}) {
  if (process.env.CHAT_HTTP_TESTS === '1') {
    const instance = createServer({ port: 0, assets: loadAssets(), ...options });
    const url = await instance.listen(); return { ...instance, url };
  }
  const DB = openDatabase(options.databasePath || ':memory:');
  const url = `http://localhost:${nextPort++}`; const pending = new Set();
  transports.set(url, request => api.fetch(request, { DB, ASSETS: loadAssets(), clientIp: 'local' }, {
    waitUntil(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); },
  }));
  return { DB, url, async close() { transports.delete(url); await Promise.allSettled([...pending]); DB.close(); } };
}

test('authentication, private rooms, history, invitation rotation, and logout', async t => {
  const app = await start(); t.after(() => app.close());
  const anonymous = await client(app);
  assert.equal((await anonymous.request('/api/rooms')).status, 401);
  assert.equal((await anonymous.request('/api/me', undefined, { 'oai-authenticated-user-id': 'forged' })).status, 401);
  const alice = await client(app, 'alice'); const bob = await client(app, 'bob');
  assert.equal((await alice.request('/api/me')).data.user.name, 'alice');
  const created = await alice.request('/api/rooms', { name: 'Project team' }); assert.equal(created.status, 201);
  const room = created.data.room.id; let invite = created.data.invite;
  assert.equal((await bob.request(`/api/rooms/${room}/messages`)).status, 404);
  assert.equal((await bob.request('/api/rooms')).data.rooms.length, 0);
  assert.equal((await bob.request('/api/join', { invite })).status, 200);
  assert.equal((await bob.request(`/api/rooms/${room}/invite`, {})).status, 403);
  const newInvite = await alice.request(`/api/rooms/${room}/invite`, {}); assert.equal(newInvite.status, 200);
  assert.equal((await bob.request('/api/join', { invite })).status, 404); invite = newInvite.data.invite;
  const msg = { text: 'Hello <script>alert(1)</script>', clientId: '12345678-1234-1234-1234-123456789abc' };
  const sent = await alice.request(`/api/rooms/${room}/messages`, msg); assert.equal(sent.status, 201);
  const duplicate = await alice.request(`/api/rooms/${room}/messages`, msg); assert.equal(duplicate.data.message.id, sent.data.message.id);
  const history = await bob.request(`/api/rooms/${room}/messages`);
  assert.equal(history.data.messages.length, 1); assert.equal(history.data.messages[0].text, msg.text);
  assert.equal((await bob.request(`/api/rooms/${room}/messages?after=${sent.data.message.id}`)).data.messages.length, 0);
  assert.equal((await bob.request(`/api/rooms/${room}/messages?after=bad`)).status, 400);
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  assert.equal((await bob.request(`/api/rooms/${room}/presence`, { sessionId })).status, 200);
  assert.equal((await alice.request(`/api/rooms/${room}/messages`)).data.online[0].name, 'bob');
  assert.equal((await bob.request(`/api/rooms/${room}/presence`, { sessionId, active: false })).status, 200);
  assert.equal((await alice.request(`/api/rooms/${room}/messages`)).data.online.length, 0);
  assert.equal((await bob.request(`/api/rooms/${room}/leave`, {})).status, 200);
  assert.equal((await bob.request(`/api/rooms/${room}/messages`)).status, 404);
  assert.equal((await bob.request('/api/join', { invite })).status, 200);
  const cookie = bob.cookie;
  assert.equal((await bob.request('/api/auth/logout', {})).status, 200);
  bob.cookie = cookie; assert.equal((await bob.request('/api/me')).status, 401);
  assert.equal((await bob.request('/api/auth/login', { username: 'bob', password: 'incorrect-password' })).status, 401);
  assert.equal((await bob.request('/api/auth/login', { username: 'bob', password: PASSWORD })).status, 200);
  assert.equal((await bob.request('/api/me')).data.user.name, 'bob');
});

test('server rejects bad input, cross-origin writes, oversized payloads, and excessive messages', async t => {
  const app = await start(); t.after(() => app.close());
  const alice = await client(app, 'alice');
  assert.equal((await alice.request('/api/rooms', { name: '' })).status, 400);
  assert.equal((await alice.request('/api/rooms', { name: 'Hidden' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await alice.request('/api/profile', { name: 'x'.repeat(10000) })).status, 413);
  const room = (await alice.request('/api/rooms', { name: 'Limits' })).data.room.id;
  assert.equal((await alice.request(`/api/rooms/${room}/messages`, { text: ' ', clientId: crypto.randomUUID() })).status, 400);
  assert.equal((await alice.request(`/api/rooms/${room}/messages`, { text: 'x'.repeat(2001), clientId: crypto.randomUUID() })).status, 400);
  assert.equal((await alice.request(`/api/rooms/${room}/messages`, { text: 'Hi', clientId: 'bad' })).status, 400);
  // Fill this user's current message window deterministically, avoiding a wall-clock minute boundary.
  const window = Math.floor(Date.now() / 60000);
  await app.DB.prepare("INSERT INTO rate_limits(user_id,action,window,count) VALUES(?,'message',?,30) ON CONFLICT(user_id,action,window) DO UPDATE SET count=30").bind(alice.user.id, window).run();
  const limited = await alice.request(`/api/rooms/${room}/messages`, { text: 'Hi', clientId: crypto.randomUUID() });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('messages, accounts, and sessions survive a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'room-chat-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'chat.sqlite'); let app = await start({ databasePath });
  const alice = await client(app, 'alice'); const cookie = alice.cookie;
  const room = (await alice.request('/api/rooms', { name: 'Persistent' })).data.room.id;
  await alice.request(`/api/rooms/${room}/messages`, { text: 'Still here after restart', clientId: crypto.randomUUID() });
  await app.close(); app = await start({ databasePath }); t.after(() => app.close());
  const restored = await client(app); restored.cookie = cookie;
  assert.equal((await restored.request('/api/me')).data.user.name, 'alice');
  assert.equal((await restored.request(`/api/rooms/${room}/messages`)).data.messages[0].text, 'Still here after restart');
});

test('message history paginates without gaps and usernames/passwords are handled correctly', async t => {
  const app = await start(); t.after(() => app.close()); const alice = await client(app, 'alice');
  assert.equal((await alice.request('/api/auth/register', { username: 'ALICE', password: PASSWORD })).status, 409);
  const room = (await alice.request('/api/rooms', { name: 'History' })).data.room.id;
  const statements = [];
  for (let i = 1; i <= 205; i++) statements.push(app.DB.prepare('INSERT INTO messages(room_id,user_id,client_id,text,created_at) VALUES(?,?,?,?,?)').bind(room, alice.user.id, crypto.randomUUID(), `Message ${i}`, Math.floor(Date.now() / 1000)));
  await app.DB.batch(statements);
  const latest = (await alice.request(`/api/rooms/${room}/messages`)).data;
  assert.equal(latest.messages.length, 100); assert.equal(latest.hasMore, true); assert.equal(latest.messages[0].text, 'Message 106');
  const older = (await alice.request(`/api/rooms/${room}/messages?before=${latest.messages[0].id}`)).data;
  assert.equal(older.messages[0].text, 'Message 6'); assert.equal(older.messages.at(-1).text, 'Message 105');
  const first = (await alice.request(`/api/rooms/${room}/messages?before=${older.messages[0].id}`)).data;
  assert.equal(first.messages.length, 5); assert.equal(first.hasMore, false);
  const forward = (await alice.request(`/api/rooms/${room}/messages?after=0`)).data;
  assert.equal(forward.messages[0].text, 'Message 1'); assert.equal(forward.hasMore, true);
  const account = await app.DB.prepare('SELECT password_hash FROM accounts WHERE user_id=?').bind(alice.user.id).first();
  assert.notEqual(account.password_hash, PASSWORD); assert.equal(account.password_hash.length, 128);
});

test('browser assets, health check, and migrations are ready without dependencies', async t => {
  const app = await start(); t.after(() => app.close());
  const health = await testFetch(app.url + '/api/health'); assert.equal(health.status, 200); assert.equal((await health.json()).storage, 'SQLite');
  for (const path of ['/', '/app.js', '/style.css']) {
    const response = await testFetch(app.url + path); assert.equal(response.status, 200, path); assert.ok((await response.text()).length > 100);
    assert.ok(response.headers.get('content-security-policy'));
  }
  const response = await testFetch(app.url + '/not-found'); assert.equal(response.status, 404);
});
