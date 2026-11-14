import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const timestamp = () => Math.floor(Date.now() / 1000);
function sessionToken(request) {
  return request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith('room_session='))?.slice(13) || '';
}
export async function authenticate(request, db, HttpError) {
  const token = sessionToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Sign in to continue.');
  const user = await db.prepare(`SELECT a.user_id AS id,p.display_name AS name FROM sessions s
    JOIN accounts a ON a.user_id=s.user_id JOIN profiles p ON p.user_id=a.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash(token), timestamp()).first();
  if (!user) throw new HttpError(401, 'Your session has expired. Please sign in.');
  return user;
}
export async function authRoute(request, env, helpers) {
  const { url, json, readJson, cleanText, limit, HttpError } = helpers;
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const db = env.DB; const action = url.pathname.split('/').at(-1);
  const cookie = (token, age) => `room_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
  if (action === 'logout') {
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(tokenHash(sessionToken(request))).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (!['login', 'register'].includes(action)) throw new HttpError(404, 'Route not found.');
  await limit(db, env.clientIp || 'local', 'authentication', 20);
  const data = await readJson(request);
  if (typeof data.username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(data.username)) throw new HttpError(400, 'Use a username with 3–32 letters, numbers, or underscores.');
  if (typeof data.password !== 'string' || data.password.length < 10 || data.password.length > 128) throw new HttpError(400, 'Use a password with 10–128 characters.');
  const username = data.username.toLowerCase();
  let account = await db.prepare('SELECT user_id,salt,password_hash FROM accounts WHERE username=?').bind(username).first();
  if (action === 'register') {
    if (account) throw new HttpError(409, 'That username is already taken.');
    const name = cleanText(data.name || data.username, 'Display name', 40);
    const userId = randomBytes(16).toString('hex'); const salt = randomBytes(16).toString('hex');
    const password = (await scrypt(data.password, salt, 64)).toString('hex');
    try {
      await db.batch([
        db.prepare('INSERT INTO accounts(user_id,username,salt,password_hash) VALUES(?,?,?,?)').bind(userId, username, salt, password),
        db.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(userId, name),
      ]);
    } catch (error) {
      if (await db.prepare('SELECT user_id FROM accounts WHERE username=?').bind(username).first()) throw new HttpError(409, 'That username is already taken.');
      throw error;
    }
    account = { user_id: userId };
  } else {
    // Perform the same expensive hash for unknown users to avoid a quick username probe.
    const attempt = await scrypt(data.password, account?.salt || '00000000000000000000000000000000', 64);
    if (!account || !timingSafeEqual(attempt, Buffer.from(account.password_hash, 'hex'))) throw new HttpError(401, 'Username or password is incorrect.');
  }
  const token = randomBytes(32).toString('hex');
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(timestamp()),
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(tokenHash(token), account.user_id, timestamp() + 604800),
  ]);
  const user = await db.prepare('SELECT user_id AS id,display_name AS name FROM profiles WHERE user_id=?').bind(account.user_id).first();
  return json({ user }, action === 'register' ? 201 : 200, { 'Set-Cookie': cookie(token, 604800) });
}
