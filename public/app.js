'use strict';
(() => {
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const ICONS = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-3-7z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.4 3-5 6-5s5.4 1.6 6 5M17 6v6M14 9h6"/></svg>',
};
const put = (node, name) => { node.innerHTML = ICONS[name]; node.firstElementChild.setAttribute('class', 'ico'); };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};
const fmtCode = (c) => (c || '').slice(0, 4) + '-' + (c || '').slice(4);
 
const S = {
  me: null, spaces: [], activeSid: null, activeCid: null, msgs: [], hasMore: false,
  pending: null, busy: false, pin: true, stick: true, loadingEarlier: false,
  unread: new Set(), unreadCh: new Set(), typing: new Map(), ws: null, wsTries: 0, loadTok: 0,
};
 
/* ---------- api ---------- */
async function api(method, url, body, raw) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (raw) { opt.headers['Content-Type'] = raw.type; opt.body = raw; }
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); } catch (e) { throw new Error('Cannot reach the server. Check your connection.'); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) {
    if (r.status === 401 && S.me) { S.me = null; showAuth(); }
    const err = new Error((data && data.error) || 'Something went wrong. Try again.');
    err.status = r.status; throw err;
  }
  return data;
}
let toastTimer = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4200);
}
 
/* ---------- helpers ---------- */
const activeSpace = () => S.spaces.find((s) => s.id === S.activeSid) || null;
const otherMember = (s) => (s.members || []).find((m) => m.id !== S.me.id) || null;
const spaceTitle = (s) => (s.kind === 'dm' ? (otherMember(s) ? otherMember(s).name : 'Direct message') : (s.name || 'Untitled'));
function avatar(name, hue, big) {
  const a = el('div', 'av', (String(name || '?').trim()[0] || '?').toUpperCase());
  a.style.setProperty('--h', hue == null ? 230 : hue);
  if (big) { a.style.width = '36px'; a.style.height = '36px'; a.style.fontSize = '15px'; }
  return a;
}
function arm(btn, label, fn) {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed) { fn(); return; }
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label;
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3500);
  });
}
const dayLabel = (ts) => {
  const d = new Date(ts), n = new Date();
  const sd = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sd(n) - sd(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
};
const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
 
/* ---------- auth ---------- */
function showAuth() {
  closeSocket(); $('app').hidden = true; $('auth').hidden = false; closeModal();
}
function setTab(which) {
  const login = which === 'login';
  $('tab-login').setAttribute('aria-selected', String(login)); $('tab-signup').setAttribute('aria-selected', String(!login));
  $('form-login').hidden = !login; $('form-signup').hidden = login;
  $('err-login').hidden = true; $('err-signup').hidden = true;
}
function formErr(id, msg) { const e = $('err-' + id); e.textContent = msg; e.hidden = false; }
async function enter(me) {
  S.me = me; $('auth').hidden = true; $('app').hidden = false;
  S.spaces = []; S.activeSid = null; S.activeCid = null; S.msgs = [];
  await refreshSpaces(true); connectSocket();
}
 
/* ---------- spaces ---------- */
async function refreshSpaces(first) {
  const { spaces } = await api('GET', '/api/spaces');
  S.spaces = spaces;
  const saved = Number(store.get('pl:space'));
  if (S.pendingSelect && spaces.some((s) => s.id === S.pendingSelect)) { const id = S.pendingSelect; S.pendingSelect = null; await selectSpace(id); return; }
  if (!activeSpace()) { await selectSpace((spaces.find((s) => s.id === saved) || spaces[0] || {}).id || null); return; }
  const sp = activeSpace();
  if (!sp.channels.some((c) => c.id === S.activeCid)) { await selectChannel(pickChannel(sp)); return; }
  renderAll();
  if (first) await loadMessages();
}
const pickChannel = (sp) => {
  const saved = Number(store.get('pl:ch:' + sp.id));
  return (sp.channels.find((c) => c.id === saved) || sp.channels[0] || {}).id || null;
};
async function selectSpace(id) {
  S.activeSid = id; S.msgs = []; S.hasMore = false; S.typing.clear();
  const sp = activeSpace();
  S.activeCid = sp ? pickChannel(sp) : null;
  if (id) { store.set('pl:space', String(id)); S.unread.delete(id); }
  if (S.activeCid) S.unreadCh.delete(S.activeCid);
  closeDrawer(); renderAll(); await loadMessages();
}
async function selectChannel(cid) {
  S.activeCid = cid; S.msgs = []; S.hasMore = false; S.typing.clear();
  if (cid) { store.set('pl:ch:' + S.activeSid, String(cid)); S.unreadCh.delete(cid); }
  closeDrawer(); renderAll(); await loadMessages();
}
async function loadMessages() {
  const tok = ++S.loadTok;
  if (!S.activeCid) { renderMsgs(); return; }
  const cid = S.activeCid;
  try {
    const { messages, hasMore } = await api('GET', `/api/channels/${cid}/messages?limit=50`);
    if (tok !== S.loadTok || cid !== S.activeCid) return;
    S.msgs = messages; S.hasMore = hasMore; S.stick = true; renderMsgs();
  } catch (e) { toast(e.message); }
}
async function loadEarlier() {
  if (!S.msgs.length) return;
  const cid = S.activeCid;
  try {
    const { messages, hasMore } = await api('GET', `/api/channels/${cid}/messages?limit=50&before=${S.msgs[0].id}`);
    if (cid !== S.activeCid) return;
    S.msgs = messages.concat(S.msgs); S.hasMore = hasMore; S.loadingEarlier = true; renderMsgs();
  } catch (e) { toast(e.message); }
}
 
/* ---------- rendering ---------- */
function renderAll() {
  const has = S.spaces.length > 0;
  $('welcome').hidden = has; $('msgs').hidden = !has; $('composer').hidden = !has; $('typing').hidden = !has; $('top').hidden = false;
  renderRail(); renderChrome(); renderMsgs();
}
function renderRail() {
  const rail = $('rail'); rail.textContent = '';
  const rank = { server: 0, group: 1, dm: 2 };
  const list = S.spaces.slice().sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a.id - b.id));
  let last = null;
  for (const s of list) {
    if (last && last !== s.kind) rail.append(el('div', 'sep'));
    last = s.kind;
    const name = spaceTitle(s);
    const b = el('button', 'tile' + (s.kind === 'dm' ? ' dm' : '') + (S.unread.has(s.id) ? ' unread' : ''), (name.trim()[0] || '?').toUpperCase());
    b.style.setProperty('--h', (s.kind === 'dm' && otherMember(s) ? otherMember(s).color : (s.id * 47) % 360));
    b.title = name; b.setAttribute('aria-label', name);
    b.setAttribute('aria-current', s.id === S.activeSid ? 'true' : 'false');
    b.addEventListener('click', () => selectSpace(s.id));
    rail.append(b);
  }
  if (list.length) rail.append(el('div', 'sep'));
  const add = el('button', 'tile add'); put(add, 'plus'); add.title = 'Start or join'; add.setAttribute('aria-label', 'Start or join a space');
  add.addEventListener('click', () => openModal('start', 'Start or join'));
  rail.append(add, el('div', 'brand', 'Porchlight'));
}
function renderChrome() {
  const sp = activeSpace(); const panel = $('panel'); panel.textContent = '';
  if (!sp) {
    panel.append(el('p', 'hint', 'Pick a space on the left, or use the plus button to start one.'));
    $('topTitle').textContent = 'Porchlight'; $('topSub').textContent = ''; $('inviteBtn').hidden = true;
  } else {
    const isDm = sp.kind === 'dm'; const title = spaceTitle(sp);
    const head = el('div'); head.append(el('div', 'kind', isDm ? 'Direct message' : sp.kind === 'group' ? 'Group chat' : 'Server'));
    panel.append(head, el('h2', null, title));
    if (sp.kind === 'server') {
      const sec = el('div'); const h = el('div', 'sec-h'); h.append(el('span', null, 'Channels'));
      const a = el('button', 'mini'); put(a, 'plus'); a.title = 'Add channel'; a.setAttribute('aria-label', 'Add channel');
      a.addEventListener('click', () => openModal('channel', 'New channel')); h.append(a);
      const ul = el('ul', 'list');
      for (const c of sp.channels) {
        const li = el('li'); const b = el('button', 'row' + (S.unreadCh.has(c.id) ? ' unread' : ''));
        b.setAttribute('aria-current', c.id === S.activeCid ? 'true' : 'false');
        b.append(el('span', 'hash', '#'), el('span', 'nm', c.name));
        b.addEventListener('click', () => selectChannel(c.id)); li.append(b); ul.append(li);
      }
      sec.append(h, ul); panel.append(sec);
    }
    if (!isDm) {
      const sec = el('div'); const h = el('div', 'sec-h'); h.append(el('span', null, 'People'));
      const ul = el('ul', 'list');
      for (const m of sp.members) {
        const li = el('li'); const me = m.id === S.me.id; const b = el('button', 'row');
        b.append(avatar(m.name, m.color), el('span', 'nm', m.name + (me ? ' (you)' : '')));
        if (m.id === sp.ownerId) b.append(el('span', 'tag', 'owner'));
        if (!me) { b.title = 'Message ' + m.name; b.addEventListener('click', () => openDm(m.id)); } else { b.disabled = true; b.style.cursor = 'default'; }
        li.append(b); ul.append(li);
      }
      sec.append(h, ul);
      if (sp.members.length > 1) sec.append(el('p', 'hint', 'Select a person to message them directly.'));
      panel.append(sec);
      const lv = el('button', 'leave', 'Leave ' + (sp.kind === 'group' ? 'group' : 'server')); arm(lv, 'Tap again to leave', leaveSpace); panel.append(lv);
    }
    const ch = sp.channels.find((c) => c.id === S.activeCid);
    $('topTitle').textContent = sp.kind === 'server' ? (ch ? '# ' + ch.name : title) : title;
    $('topSub').textContent = sp.kind === 'server' ? title : isDm ? 'Direct message' : sp.members.length + (sp.members.length === 1 ? ' person' : ' people');
    $('inviteBtn').hidden = isDm;
    $('input').placeholder = sp.kind === 'server' ? 'Message #' + (ch ? ch.name : 'channel') : isDm ? 'Message ' + title : 'Message the group';
  }
  const acct = el('div', 'account');
  acct.append(avatar(S.me.name, S.me.color));
  const who = el('div', 'who'); who.append(el('b', null, S.me.name), el('span', null, '@' + S.me.username));
  const out = el('button', 'btn', 'Log out'); out.addEventListener('click', logout);
  acct.append(who, out); panel.append(acct);
}
function renderMsgs() {
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  box.textContent = '';
  if (S.hasMore) {
    const b = el('button', 'btn more', 'Show earlier messages'); b.addEventListener('click', loadEarlier); box.append(b);
  }
  if (!S.msgs.length) {
    const e = el('div', 'empty'); const sp = activeSpace();
    e.append(el('b', null, 'Nothing here yet'), document.createTextNode(sp && sp.kind === 'dm' ? 'Send the first message to start the conversation.' : 'Say hello, or drop in a photo to get things going.'));
    box.append(e);
  }
  let lastUser = null, lastTs = 0, lastDay = '';
  for (const m of S.msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { box.append(el('div', 'day', dayLabel(m.ts))); lastDay = day; lastUser = null; }
    const compact = lastUser === m.userId && m.ts - lastTs < 5 * 60 * 1000;
    const row = el('div', 'msg' + (compact ? ' compact' : ''));
    const meta = el('div', 'meta'); meta.append(el('b', null, m.name), el('time', null, timeLabel(m.ts)));
    row.append(avatar(m.name, m.color, true), meta);
    if (m.body) row.append(el('div', 'body', m.body));
    if (m.imageId) {
      const ph = el('img', 'photo'); ph.alt = 'Photo shared by ' + m.name; ph.loading = 'lazy'; ph.src = '/images/' + m.imageId;
      ph.addEventListener('load', () => { if (S.pin) box.scrollTop = box.scrollHeight; });
      ph.addEventListener('error', () => { ph.classList.add('gone'); ph.removeAttribute('src'); ph.alt = 'Photo unavailable'; });
      ph.addEventListener('click', () => { if (ph.getAttribute('src')) { $('lightImg').src = ph.src; $('lightbox').hidden = false; } });
      const wrap = el('div', 'body'); wrap.style.whiteSpace = 'normal'; wrap.append(ph); row.append(wrap);
    }
    if (m.userId === S.me.id) { const d = el('button', 'del', 'Delete'); arm(d, 'Sure?', () => deleteMsg(m.id)); row.append(d); }
    box.append(row); lastUser = m.userId; lastTs = m.ts;
  }
  if (S.loadingEarlier) { box.scrollTop = prevTop + (box.scrollHeight - prevH); S.loadingEarlier = false; }
  else if (S.stick || nearBottom) { box.scrollTop = box.scrollHeight; S.pin = true; }
  S.stick = false;
}
function renderTyping() {
  const now = Date.now(); const sp = activeSpace(); const names = [];
  for (const [uid, t] of S.typing) {
    if (now - t > 4000) { S.typing.delete(uid); continue; }
    const m = sp && sp.members.find((x) => x.id === uid); if (m) names.push(m.name);
  }
  $('typing').textContent = names.length === 0 ? '' : names.length === 1 ? names[0] + ' is typing…' : names.slice(0, 2).join(' and ') + ' are typing…';
}
setInterval(renderTyping, 1000);
 
/* ---------- live connection ---------- */
function connectSocket() {
  closeSocket();
  if (!S.me) return;
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.addEventListener('open', () => {
    const wasDown = S.wsTries > 0; S.wsTries = 0; $('conn').hidden = true;
    if (wasDown) { refreshSpaces().then(loadMessages).catch(() => {}); }
  });
  ws.addEventListener('message', (ev) => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } onSocket(d); });
  ws.addEventListener('close', () => {
    if (S.ws !== ws) return;
    S.ws = null; if (!S.me) return;
    $('conn').hidden = false; S.wsTries++;
    setTimeout(() => { if (S.me && !S.ws) connectSocket(); }, Math.min(1000 * 2 ** Math.min(S.wsTries, 4), 15000));
  });
}
function closeSocket() { if (S.ws) { const w = S.ws; S.ws = null; w.close(); } }
function onSocket(d) {
  if (d.type === 'refresh') { refreshSpaces().catch(() => {}); return; }
  if (d.type === 'typing') { if (d.channelId === S.activeCid) { S.typing.set(d.userId, Date.now()); renderTyping(); } return; }
  if (d.type === 'delete') {
    if (d.channelId === S.activeCid) { S.msgs = S.msgs.filter((m) => m.id !== d.messageId); renderMsgs(); }
    return;
  }
  if (d.type === 'message') {
    const m = d.message;
    if (m.channelId === S.activeCid) {
      if (!S.msgs.some((x) => x.id === m.id)) { S.msgs.push(m); S.typing.delete(m.userId); renderTyping(); renderMsgs(); }
    } else if (m.userId !== S.me.id) {
      S.unreadCh.add(m.channelId); if (d.spaceId !== S.activeSid) S.unread.add(d.spaceId);
      renderRail(); renderChrome();
    }
  }
}
 
/* ---------- actions ---------- */
async function deleteMsg(id) { try { await api('DELETE', '/api/messages/' + id); S.msgs = S.msgs.filter((m) => m.id !== id); renderMsgs(); } catch (e) { toast(e.message); } }
async function leaveSpace() {
  try { await api('POST', `/api/spaces/${S.activeSid}/leave`); store.set('pl:space', ''); S.activeSid = null; await refreshSpaces(); } catch (e) { toast(e.message); }
}
async function openDm(userId) {
  try { const { spaceId } = await api('POST', '/api/dms', { userId }); S.pendingSelect = spaceId; await refreshSpaces(); } catch (e) { toast(e.message); }
}
async function logout() { try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ } S.me = null; showAuth(); }
 
/* ---------- composer ---------- */
async function prepImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPG, GIF or WebP photo.');
  if (file.type === 'image/gif') { if (file.size > 5.5e6) throw new Error('That GIF is too large. Keep it under 5 MB.'); return file; }
  try {
    const bmp = await createImageBitmap(file); const max = 1600; const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (blob) return blob;
  } catch (e) { /* fall through */ }
  if (file.size > 5.5e6) throw new Error('That photo is too large.');
  return file;
}
async function setPending(file) {
  try {
    const blob = await prepImage(file); clearPending();
    S.pending = { blob, url: URL.createObjectURL(blob), name: file.name || 'Photo' };
    $('chipImg').src = S.pending.url; $('chipName').textContent = S.pending.name; $('chip').hidden = false; $('input').focus();
  } catch (e) { toast(e.message); }
}
function clearPending() { if (S.pending) URL.revokeObjectURL(S.pending.url); S.pending = null; $('chip').hidden = true; $('file').value = ''; }
async function send() {
  if (S.busy || !S.activeCid) return;
  const input = $('input'); const text = input.value.trim();
  if (!text && !S.pending) return;
  S.busy = true; $('sendBtn').disabled = true; $('attachBtn').disabled = true;
  const cid = S.activeCid;
  try {
    const body = { body: text };
    if (S.pending) { const up = await api('POST', '/api/images', undefined, S.pending.blob); body.imageId = up.id; }
    const { message } = await api('POST', `/api/channels/${cid}/messages`, body);
    input.value = ''; input.style.height = 'auto'; clearPending();
    if (cid === S.activeCid && !S.msgs.some((m) => m.id === message.id)) { S.msgs.push(message); S.stick = true; renderMsgs(); }
  } catch (e) { toast(e.message); }
  finally { S.busy = false; $('sendBtn').disabled = false; $('attachBtn').disabled = false; input.focus(); }
}
let lastTypingSent = 0;
function sendTyping() {
  const now = Date.now();
  if (now - lastTypingSent < 2500 || !S.ws || S.ws.readyState !== 1 || !S.activeCid) return;
  lastTypingSent = now; S.ws.send(JSON.stringify({ type: 'typing', channelId: S.activeCid }));
}
 
/* ---------- modal ---------- */
const PANES = ['start', 'server', 'group', 'join', 'channel', 'invite'];
function openModal(pane, title) {
  $('modalTitle').textContent = title;
  PANES.forEach((p) => { $('pane-' + p).hidden = p !== pane; });
  document.querySelectorAll('#modal .err').forEach((e) => { e.hidden = true; });
  if (pane === 'invite') showInvite();
  $('modal').hidden = false;
  const f = { server: 'serverName', group: 'groupName', join: 'joinCode', channel: 'channelName' }[pane];
  if (f) { $(f).value = ''; setTimeout(() => $(f).focus(), 30); }
}
function closeModal() { $('modal').hidden = true; }
function showInvite() {
  const sp = activeSpace(); if (!sp) return;
  $('inviteCode').textContent = fmtCode(sp.inviteCode);
  $('newCode').hidden = sp.ownerId !== S.me.id;
}
function closeDrawer() { $('app').classList.remove('open'); }
 
/* ---------- wiring ---------- */
function wire() {
  put($('menuBtn'), 'menu'); put($('attachBtn'), 'clip'); put($('sendBtn'), 'send'); put($('chipX'), 'x'); put($('modalX'), 'x');
  const ib = $('inviteBtn'); const ii = el('span', 'ico'); ib.append(ii, document.createTextNode('Invite')); put(ii, 'user');
 
  $('tab-login').addEventListener('click', () => setTab('login'));
  $('tab-signup').addEventListener('click', () => setTab('signup'));
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const { me } = await api('POST', '/api/login', { username: $('login-user').value, password: $('login-pass').value }); $('login-pass').value = ''; await enter(me); }
    catch (x) { formErr('login', x.message); }
  });
  $('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { me } = await api('POST', '/api/signup', { displayName: $('signup-name').value, username: $('signup-user').value, password: $('signup-pass').value });
      $('signup-pass').value = ''; await enter(me);
    } catch (x) { formErr('signup', x.message); }
  });
 
  $('menuBtn').addEventListener('click', () => $('app').classList.add('open'));
  $('scrim').addEventListener('click', closeDrawer);
  $('inviteBtn').addEventListener('click', () => openModal('invite', 'Invite friends'));
  $('modalX').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.open; openModal(k, { server: 'Start a server', group: 'New group chat', join: 'Join with a code' }[k]);
  }));
  const create = (kind, inputId, errId) => async (e) => {
    e.preventDefault();
    try {
      const { spaceId } = await api('POST', '/api/spaces', { kind, name: $(inputId).value });
      S.pendingSelect = spaceId; closeModal(); await refreshSpaces();
    } catch (x) { formErr(errId, x.message); }
  };
  $('pane-server').addEventListener('submit', create('server', 'serverName', 'server'));
  $('pane-group').addEventListener('submit', create('group', 'groupName', 'group'));
  $('pane-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const { spaceId } = await api('POST', '/api/spaces/join', { code: $('joinCode').value }); S.pendingSelect = spaceId; closeModal(); await refreshSpaces(); }
    catch (x) { formErr('join', x.message); }
  });
  $('pane-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { channelId } = await api('POST', `/api/spaces/${S.activeSid}/channels`, { name: $('channelName').value });
      closeModal(); await refreshSpaces(); await selectChannel(channelId);
    } catch (x) { formErr('channel', x.message); }
  });
  $('copyCode').addEventListener('click', async () => {
    const node = $('inviteCode');
    try { await navigator.clipboard.writeText(node.textContent); toast('Code copied'); }
    catch (e) { const r = document.createRange(); r.selectNodeContents(node); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Copy the selected code with your keyboard'); }
  });
  $('newCode').addEventListener('click', async () => {
    try { await api('POST', `/api/spaces/${S.activeSid}/invite/regenerate`); await refreshSpaces(); showInvite(); toast('New code ready'); } catch (e) { toast(e.message); }
  });
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('lightbox').hidden = true; closeModal(); closeDrawer(); } });
  $('msgs').addEventListener('scroll', () => { const b = $('msgs'); S.pin = b.scrollHeight - b.scrollTop - b.clientHeight < 80; });
  $('sendBtn').addEventListener('click', send);
  $('attachBtn').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) setPending(f); });
  $('chipX').addEventListener('click', clearPending);
  const input = $('input');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; sendTyping(); });
  input.addEventListener('paste', (e) => {
    const it = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (it) { e.preventDefault(); setPending(it.getAsFile()); }
  });
  const chat = $('chat');
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setPending(f); });
}
 
async function boot() {
  wire();
  try { const { me } = await api('GET', '/api/me'); await enter(me); }
  catch (e) { if (e.status === 401) showAuth(); else { showAuth(); formErr('login', e.message); } }
}
boot();
})();
