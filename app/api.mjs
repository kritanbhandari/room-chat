import { authenticate, authRoute } from './auth.mjs';
const MAX_BODY_BYTES = 8192;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const hashInvite = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
function cleanText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new HttpError(400, `${label} must contain 1–${max} characters.`);
  }
  return value.trim();
}
async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Send JSON data.');
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Request body is required.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'A JSON object is required.');
  return data;
}
async function limit(db, id, action, max) {
  const window = Math.floor(now() / 60);
  const result = await db.prepare(`INSERT INTO rate_limits(user_id,action,window,count) VALUES(?,?,?,1)
    ON CONFLICT(user_id,action,window) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`).bind(id, action, window, max).first();
  if (!result) throw new HttpError(429, 'Too many requests. Please try again shortly.', { 'Retry-After': String(60 - now() % 60) });
}
async function member(db, room, user) {
  const result = await db.prepare('SELECT 1 AS allowed FROM room_members WHERE room_id=? AND user_id=?').bind(room, user).first();
  if (!result) throw new HttpError(404, 'Room not found or access denied.');
}
function cursor(url, key) {
  const text = url.searchParams.get(key);
  if (text === null) return null;
  if (!/^\d{1,15}$/.test(text)) throw new HttpError(400, 'Invalid message cursor.');
  return Number(text);
}
async function api(request, env, ctx, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    if (!env.DB) return json({ status: 'unavailable' }, 503);
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ status: 'ok', storage: 'SQLite', version: '1.0.0' });
  }
  const db = env.DB;
  if (!db) throw new HttpError(503, 'Storage is not configured.');
  const write = !['GET', 'HEAD'].includes(request.method);
  if (write && request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Request origin is not allowed.');
  if (write && request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (url.pathname.startsWith('/api/auth/')) return authRoute(request, env, { url, json, readJson, cleanText, limit, HttpError });
  const user = await authenticate(request, db, HttpError);
  await limit(db, user.id, write ? 'write' : 'read', write ? 120 : 240);
  if (write && ctx?.waitUntil) ctx.waitUntil(db.prepare('DELETE FROM rate_limits WHERE window < ?').bind(Math.floor(now() / 60) - 2).run().catch(() => {}));
  if (url.pathname === '/api/me' && request.method === 'GET') {
    await db.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?) ON CONFLICT DO NOTHING').bind(user.id, user.name).run();
    const profile = await db.prepare('SELECT display_name AS name FROM profiles WHERE user_id=?').bind(user.id).first();
    return json({ user: { id: user.id, name: profile.name } });
  }
  if (url.pathname === '/api/profile' && request.method === 'POST') {
    await limit(db, user.id, 'profile', 10);
    const data = await readJson(request); const name = cleanText(data.name, 'Display name', 40);
    await db.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name').bind(user.id, name).run();
    return json({ user: { id: user.id, name } });
  }
  if (url.pathname === '/api/rooms' && request.method === 'GET') {
    const { results } = await db.prepare(`SELECT r.id,r.name,r.created_at,r.created_by,
      (SELECT COUNT(*) FROM room_members c WHERE c.room_id=r.id) AS member_count
      FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY r.created_at DESC,r.id LIMIT 100`).bind(user.id).all();
    return json({ rooms: results });
  }
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    await limit(db, user.id, 'create', 5);
    const { name } = await readJson(request); const roomName = cleanText(name, 'Room name', 60);
    const room = random(); const invite = `${room}.${random()}`;
    await db.batch([
      db.prepare('INSERT INTO rooms(id,name,invite_hash,created_by,created_at) VALUES(?,?,?,?,?)').bind(room, roomName, await hashInvite(invite), user.id, now()),
      db.prepare('INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)').bind(room, user.id, now()),
    ]);
    return json({ room: { id: room, name: roomName, created_by: user.id }, invite }, 201);
  }
  if (url.pathname === '/api/join' && request.method === 'POST') {
    await limit(db, user.id, 'join', 10);
    const { invite } = await readJson(request);
    if (typeof invite !== 'string' || !/^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(invite.trim())) throw new HttpError(400, 'Enter a valid invitation code.');
    const room = await db.prepare('SELECT id,name,created_by FROM rooms WHERE invite_hash=?').bind(await hashInvite(invite.trim())).first();
    if (!room) throw new HttpError(404, 'Invitation not found. Ask the room owner for a new one.');
    await db.prepare('INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(room.id, user.id, now()).run();
    return json({ room });
  }
  const route = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})\/(messages|presence|invite|leave)$/);
  if (!route) throw new HttpError(404, 'API route not found.');
  const [, room, action] = route;
  await member(db, room, user.id);
  if (action === 'messages' && request.method === 'GET') {
    const after = cursor(url, 'after'); const before = cursor(url, 'before');
    if (after !== null && before !== null) throw new HttpError(400, 'Choose one message cursor.');
    const condition = after !== null ? 'm.id > ?' : 'm.id < ?';
    const ascending = after !== null;
    const { results } = await db.prepare(`SELECT m.id,m.user_id,m.text,m.created_at,m.client_id,
      COALESCE(p.display_name,'Member') AS name FROM messages m LEFT JOIN profiles p ON p.user_id=m.user_id
      WHERE m.room_id=? AND ${condition} ORDER BY m.id ${ascending ? 'ASC' : 'DESC'} LIMIT 101`).bind(room, after ?? before ?? Number.MAX_SAFE_INTEGER).all();
    const hasMore = results.length > 100; const messages = results.slice(0, 100);
    if (!ascending) messages.reverse();
    const { results: online } = await db.prepare(`SELECT p.user_id,COALESCE(f.display_name,'Member') AS name,
      MAX(p.last_seen) AS last_seen FROM presence p LEFT JOIN profiles f ON f.user_id=p.user_id
      WHERE p.room_id=? AND p.last_seen>? GROUP BY p.user_id ORDER BY name`).bind(room, now() - 45).all();
    return json({ messages, online, hasMore, nextCursor: messages.at(-1)?.id ?? after ?? 0 });
  }
  if (action === 'messages' && request.method === 'POST') {
    await limit(db, user.id, 'message', 30);
    const data = await readJson(request); const text = cleanText(data.text, 'Message', 2000);
    if (typeof data.clientId !== 'string' || !/^[a-f0-9-]{16,64}$/.test(data.clientId)) throw new HttpError(400, 'A valid message ID is required.');
    // A transaction serializes membership checks with concurrent leave requests.
    const result = await db.batch([
      db.prepare(`INSERT INTO messages(room_id,user_id,client_id,text,created_at)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM room_members WHERE room_id=? AND user_id=?)
        ON CONFLICT(room_id,user_id,client_id) DO NOTHING`).bind(room, user.id, data.clientId, text, now(), room, user.id),
      db.prepare('SELECT id,user_id,text,created_at,client_id FROM messages WHERE room_id=? AND user_id=? AND client_id=?').bind(room, user.id, data.clientId),
    ]);
    const message = result[1].results[0];
    if (!message) throw new HttpError(404, 'Room not found or access denied.');
    return json({ message }, 201);
  }
  if (action === 'presence' && request.method === 'POST') {
    const data = await readJson(request);
    if (typeof data.sessionId !== 'string' || !/^[a-f0-9-]{16,64}$/.test(data.sessionId)) throw new HttpError(400, 'Invalid session ID.');
    if (data.active === false) {
      await db.prepare('DELETE FROM presence WHERE room_id=? AND user_id=? AND session_id=?').bind(room, user.id, data.sessionId).run();
    } else {
      await db.prepare(`INSERT INTO presence(room_id,user_id,session_id,last_seen) VALUES(?,?,?,?)
        ON CONFLICT(room_id,user_id,session_id) DO UPDATE SET last_seen=excluded.last_seen`).bind(room, user.id, data.sessionId, now()).run();
      await db.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now() - 120).run();
    }
    return json({ ok: true });
  }
  if (action === 'invite' && request.method === 'POST') {
    await limit(db, user.id, 'invite', 5);
    const invite = `${room}.${random()}`;
    const updated = await db.prepare('UPDATE rooms SET invite_hash=? WHERE id=? AND created_by=? RETURNING id').bind(await hashInvite(invite), room, user.id).first();
    if (!updated) throw new HttpError(403, 'Only the room owner can create invitations.');
    return json({ invite });
  }
  if (action === 'leave' && request.method === 'POST') {
    await db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').bind(room, user.id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      const assets = env.ASSETS || {};
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
      const asset = assets[path];
      if (!asset) return json({ error: 'Not found.' }, 404);
      return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
        ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': 'no-cache',
      } });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.headers);
      console.error('Request failed', url.pathname, error.message);
      return json({ error: 'The server could not complete this request. Please try again.' }, 500);
    }
  },
};
