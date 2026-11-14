'use strict';
const $ = id => document.getElementById(id);
let user = null, rooms = [], current = null, mode = 'login', dialogMode = 'create';
let pollTimer, heartbeatTimer, noticeTimer, generation = 0, loadingOlder = false;
let messages = new Map(), cursor = 0, hasOlder = false, pendingMessage = null;
const sessionId = crypto.randomUUID();
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 6000); }
async function api(path, data, options = {}) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(12000), ...options });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && user && !path.startsWith('/api/auth/')) showAuth();
    const error = new Error(result.error || 'Something went wrong.'); error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After') || 3); throw error;
  }
  return result;
}
async function busy(button, fn) { button.disabled = true; try { await fn(); } catch (error) { notice(error.message); } finally { button.disabled = false; } }
function stopRoom() {
  if (current) api(`/api/rooms/${current.id}/presence`, { sessionId, active: false }, { keepalive: true }).catch(() => {});
  generation++; clearTimeout(pollTimer); clearInterval(heartbeatTimer); current = null;
}
function showAuth() { stopRoom(); user = null; $('workspace').hidden = true; $('auth').hidden = false; $('password').value = ''; }
async function showWorkspace(nextUser) {
  user = nextUser; $('auth').hidden = true; $('workspace').hidden = false; $('profile-name').value = user.name;
  $('chat').hidden = true; $('empty').hidden = false; await refreshRooms();
  const selected = localStorage.getItem('room-chat-last-room');
  const room = rooms.find(r => r.id === selected); if (room) await selectRoom(room);
}
async function refreshRooms() {
  const result = await api('/api/rooms'); rooms = result.rooms; renderRooms();
}
function renderRooms() {
  $('room-count').textContent = rooms.length; $('rooms').replaceChildren();
  for (const room of rooms) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'room-item' + (current?.id === room.id ? ' selected' : '');
    button.append(document.createTextNode('# ' + room.name));
    const count = document.createElement('span'); count.textContent = `${room.member_count || 1} member${room.member_count === 1 ? '' : 's'}`; button.append(count);
    button.addEventListener('click', () => selectRoom(room)); $('rooms').append(button);
  }
}
function renderMessages() {
  const container = $('messages'); const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  $('message-list').replaceChildren();
  if (!messages.size) { const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = 'This is the beginning of your conversation. Say hello.'; $('message-list').append(empty); }
  for (const message of [...messages.values()].sort((a,b) => a.id - b.id)) {
    const row = document.createElement('div'); row.className = 'message-row' + (message.user_id === user.id ? ' own' : '');
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const name = document.createElement('span'); name.className = 'message-name'; name.textContent = message.user_id === user.id ? 'You' : message.name || 'Member';
    const date = document.createElement('time'); date.dateTime = new Date(message.created_at * 1000).toISOString(); date.textContent = new Date(message.created_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    meta.append(name, date); const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text; row.append(meta, bubble); $('message-list').append(row);
  }
  $('older').hidden = !hasOlder;
  if (nearBottom && !loadingOlder) container.scrollTop = container.scrollHeight;
}
async function poll(room, token, initial = false) {
  if (token !== generation || !current) return;
  let delay = 1500;
  try {
    const data = await api(`/api/rooms/${room.id}/messages${initial ? '' : '?after=' + cursor}`);
    if (token !== generation) return;
    for (const message of data.messages) messages.set(message.id, message);
    cursor = Math.max(cursor, data.nextCursor); if (initial) hasOlder = data.hasMore;
    if (data.messages.length || initial) renderMessages();
    $('online').textContent = data.online.length ? data.online.map(p => p.user_id === user.id ? p.name + ' (you)' : p.name).join(', ') + ' · online' : 'No one online yet';
    $('connection').textContent = 'Connected · messages saved';
    if (!initial && data.hasMore) delay = 0;
  } catch (error) {
    if (token !== generation) return;
    $('connection').textContent = 'Reconnecting…'; delay = Math.max(4000, error.retryAfter * 1000 || 0);
    if (error.status === 404) { stopRoom(); $('chat').hidden = true; $('empty').hidden = false; notice(error.message); refreshRooms().catch(() => {}); return; }
  }
  if (token === generation) pollTimer = setTimeout(() => poll(room, token), document.hidden ? Math.max(delay, 10000) : delay);
}
async function selectRoom(room) {
  stopRoom(); current = room; messages = new Map(); cursor = 0; hasOlder = false; pendingMessage = null;
  const token = generation; localStorage.setItem('room-chat-last-room', room.id);
  $('room-title').textContent = room.name; $('invite').hidden = room.created_by !== user.id;
  $('chat').hidden = false; $('empty').hidden = true; $('message').value = ''; updateCount(); renderRooms(); renderMessages();
  const heartbeat = () => api(`/api/rooms/${room.id}/presence`, { sessionId }).catch(() => {});
  await heartbeat(); if (token !== generation) return;
  heartbeatTimer = setInterval(heartbeat, 15000); await poll(room, token, true); $('message').focus();
}
function openRoomDialog(join = false) {
  dialogMode = join ? 'join' : 'create'; $('dialog-title').textContent = join ? 'Join a conversation' : 'Create a room';
  $('dialog-help').textContent = join ? 'Paste the invitation code from the room owner.' : 'Give your conversation a name.';
  $('dialog-label').textContent = join ? 'Invitation code' : 'Room name'; $('dialog-submit').textContent = join ? 'Join room' : 'Create room';
  $('dialog-input').value = ''; $('dialog-input').maxLength = join ? 65 : 60; $('room-dialog').showModal(); $('dialog-input').focus();
}
function showInvite(invite) { $('invite-code').value = invite; $('invite-dialog').showModal(); }
$('auth-toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'; const register = mode === 'register';
  $('auth-title').textContent = register ? 'Make yourself at home.' : 'Welcome back.';
  $('auth-description').textContent = register ? 'Create an account for this local server.' : 'Sign in with your local account.';
  $('auth-submit').textContent = register ? 'Create account →' : 'Sign in →'; $('name-field').hidden = !register;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-toggle').textContent = register ? 'Already have an account? Sign in' : 'New here? Create an account';
});
$('auth-form').addEventListener('submit', event => {
  event.preventDefault(); busy($('auth-submit'), async () => {
    const data = await api('/api/auth/' + mode, { username: $('username').value.trim(), password: $('password').value, name: $('display-name').value.trim() });
    $('password').value = ''; await showWorkspace(data.user);
  });
});
$('logout').addEventListener('click', () => busy($('logout'), async () => { stopRoom(); await api('/api/auth/logout', {}); showAuth(); }));
$('profile-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { const result = await api('/api/profile', { name: $('profile-name').value }); user = result.user; notice('Display name saved.'); }); });
$('create-open').onclick = $('empty-create').onclick = () => openRoomDialog(); $('join-open').onclick = () => openRoomDialog(true);
$('dialog-cancel').onclick = () => $('room-dialog').close(); $('invite-close').onclick = () => $('invite-dialog').close();
$('room-form').addEventListener('submit', event => { event.preventDefault(); busy($('dialog-submit'), async () => {
  const data = await api(dialogMode === 'join' ? '/api/join' : '/api/rooms', dialogMode === 'join' ? { invite: $('dialog-input').value.trim() } : { name: $('dialog-input').value.trim() });
  $('room-dialog').close(); await refreshRooms(); await selectRoom(rooms.find(r => r.id === data.room.id) || data.room); if (data.invite) showInvite(data.invite);
}); });
$('invite').onclick = () => busy($('invite'), async () => { if (current) showInvite((await api(`/api/rooms/${current.id}/invite`, {})).invite); });
$('copy-invite').onclick = () => busy($('copy-invite'), async () => { await navigator.clipboard.writeText($('invite-code').value); notice('Invitation code copied.'); });
$('leave').onclick = () => busy($('leave'), async () => {
  if (!current || !confirm('Leave this room? You will need an invitation code to join again.')) return;
  await api(`/api/rooms/${current.id}/leave`, {}); stopRoom(); localStorage.removeItem('room-chat-last-room'); $('chat').hidden = true; $('empty').hidden = false; await refreshRooms();
});
function updateCount() { $('character-count').textContent = `${$('message').value.length} / 2000`; }
$('message').addEventListener('input', () => { updateCount(); $('message').style.height = 'auto'; $('message').style.height = Math.min($('message').scrollHeight, 150) + 'px'; });
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('message-form').requestSubmit(); } });
$('message-form').addEventListener('submit', event => { event.preventDefault(); if (!current || !$('message').value.trim()) return;
  const room = current; const text = $('message').value.trim(); const token = generation;
  if (!pendingMessage || pendingMessage.text !== text || pendingMessage.room !== room.id) pendingMessage = { text, room: room.id, clientId: crypto.randomUUID() };
  const sending = pendingMessage;
  busy($('send'), async () => {
    const result = await api(`/api/rooms/${room.id}/messages`, { text, clientId: sending.clientId });
    if (token !== generation) return;
    messages.set(result.message.id, { ...result.message, name: user.name }); renderMessages(); $('messages').scrollTop = $('messages').scrollHeight;
    if ($('message').value.trim() === text) { $('message').value = ''; updateCount(); }
    pendingMessage = null; $('message').focus();
  });
});
$('older').onclick = () => busy($('older'), async () => {
  if (!current || !messages.size) return;
  const room = current, token = generation, before = Math.min(...messages.keys()), height = $('messages').scrollHeight;
  const data = await api(`/api/rooms/${room.id}/messages?before=${before}`); if (token !== generation) return;
  loadingOlder = true; for (const message of data.messages) messages.set(message.id, message); hasOlder = data.hasMore;
  renderMessages(); $('messages').scrollTop += $('messages').scrollHeight - height; loadingOlder = false;
});
window.addEventListener('pagehide', () => { if (current) fetch(`/api/rooms/${current.id}/presence`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, active: false }), keepalive: true }).catch(() => {}); });
api('/api/me').then(data => showWorkspace(data.user)).catch(error => { showAuth(); if (error.status !== 401) notice('Start the local server, then refresh this page.'); });
