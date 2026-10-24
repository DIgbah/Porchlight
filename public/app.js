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
  sticker: '<svg viewBox="0 0 24 24"><path d="M5 4h14v10l-6 6H5z"/><path d="M19 14h-6v6"/><path d="M9 9.5h.01M15 9.5h.01M9 13c1 1 2.4 1 3.4.3"/></svg>',
};
const put = (node, name) => { node.innerHTML = ICONS[name]; node.firstElementChild.setAttribute('class', 'ico'); };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};
const fmtCode = (c) => (c || '').slice(0, 4) + '-' + (c || '').slice(4);
const HUES = [0, 25, 50, 90, 140, 170, 195, 215, 240, 270, 300, 330];

const S = {
  me: null, spaces: [], people: new Map(), activeSid: null, activeCid: null, msgs: [], hasMore: false,
  pending: null, busy: false, pin: true, stick: true, loadingEarlier: false, pendingSelect: null,
  unread: new Set(), unreadCh: new Set(), typing: new Map(), ws: null, wsTries: 0, loadTok: 0,
  stickers: [], editColor: 230,
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
function rebuildPeople() {
  S.people = new Map();
  for (const s of S.spaces) for (const m of s.members) S.people.set(m.id, m);
  if (S.me) S.people.set(S.me.id, S.me);
}
const personOf = (id, fb) => S.people.get(id) || fb || { id, name: 'Someone', color: 230, avatarId: null };
function avatar(p, px) {
  const size = px || 24;
  const a = el('div', 'av');
  a.style.setProperty('--h', p.color == null ? 230 : p.color);
  a.style.width = size + 'px'; a.style.height = size + 'px'; a.style.fontSize = Math.round(size * 0.42) + 'px';
  const initial = (String(p.name || '?').trim()[0] || '?').toUpperCase();
  if (p.avatarId) {
    const im = el('img'); im.alt = ''; im.src = '/images/' + p.avatarId;
    im.addEventListener('error', () => { im.remove(); a.textContent = initial; });
    a.append(im);
  } else a.textContent = initial;
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
async function loadBitmap(file) {
  try { return await createImageBitmap(file); }
  catch (e) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file could not be read as a picture.')); im.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }
}
async function squareBlob(file, px, type, q) {
  const bmp = await loadBitmap(file); const iw = bmp.width, ih = bmp.height; const s = Math.min(iw, ih);
  const c = document.createElement('canvas'); c.width = px; c.height = px;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
  g.drawImage(bmp, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, px, px);
  const blob = await new Promise((r) => c.toBlob(r, type, q));
  if (!blob) throw new Error('That photo could not be prepared.');
  return blob;
}

/* ---------- auth ---------- */
function showAuth() { closeSocket(); $('app').hidden = true; $('auth').hidden = false; closeModal(); }
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
  const [{ spaces }, { me }] = await Promise.all([api('GET', '/api/spaces'), api('GET', '/api/me')]);
  S.spaces = spaces; S.me = me; rebuildPeople();
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
    const name = spaceTitle(s); const other = s.kind === 'dm' ? otherMember(s) : null;
    const b = el('button', 'tile' + (s.kind === 'dm' ? ' dm' : '') + (S.unread.has(s.id) ? ' unread' : ''));
    if (other && other.avatarId) { const im = el('img'); im.alt = ''; im.src = '/images/' + other.avatarId; b.append(im); }
    else b.textContent = (name.trim()[0] || '?').toUpperCase();
    b.style.setProperty('--h', other ? other.color : (s.id * 47) % 360);
    b.title = name; b.setAttribute('aria-label', name);
    b.setAttribute('aria-current', s.id === S.activeSid ? 'true' : 'false');
    b.addEventListener('click', () => selectSpace(s.id));
    rail.append(b);
  }
  if (list.length) rail.append(el('div', 'sep'));
  const add = el('button', 'tile add'); put(add, 'plus'); add.title = 'Start, join or message'; add.setAttribute('aria-label', 'Start, join or message');
  add.addEventListener('click', () => openModal('start', 'Start, join or message'));
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
    const sec = el('div'); const h = el('div', 'sec-h'); h.append(el('span', null, 'People'));
    const ul = el('ul', 'list');
    for (const m of sp.members) {
      const li = el('li'); const me = m.id === S.me.id; const b = el('button', 'row');
      b.append(avatar(m, 24), el('span', 'nm', m.name + (me ? ' (you)' : '')));
      if (m.id === sp.ownerId && !isDm) b.append(el('span', 'tag', 'owner'));
      b.title = 'View profile'; b.addEventListener('click', () => showProfile(m.id));
      li.append(b); ul.append(li);
    }
    sec.append(h, ul);
    if (!isDm && sp.members.length > 1) sec.append(el('p', 'hint', 'Select a person to see their profile or message them.'));
    panel.append(sec);
    if (!isDm) {
      const lv = el('button', 'leave', 'Leave ' + (sp.kind === 'group' ? 'group' : 'server')); arm(lv, 'Tap again to leave', leaveSpace); panel.append(lv);
    }
    const ch = sp.channels.find((c) => c.id === S.activeCid);
    $('topTitle').textContent = sp.kind === 'server' ? (ch ? '# ' + ch.name : title) : title;
    $('topSub').textContent = sp.kind === 'server' ? title : isDm ? (otherMember(sp) && otherMember(sp).status) || 'Direct message' : sp.members.length + (sp.members.length === 1 ? ' person' : ' people');
    $('inviteBtn').hidden = isDm;
    $('input').placeholder = sp.kind === 'server' ? 'Message #' + (ch ? ch.name : 'channel') : isDm ? 'Message ' + title : 'Message the group';
  }
  const acct = el('div', 'account');
  const pb = el('button', 'plain profile-btn'); pb.title = 'Edit your profile'; pb.setAttribute('aria-label', 'Edit your profile');
  const who = el('div', 'who'); who.append(el('b', null, S.me.name), el('span', null, '@' + S.me.username));
  pb.append(avatar(S.me, 30), who); pb.addEventListener('click', openEditProfile);
  const out = el('button', 'btn', 'Log out'); out.addEventListener('click', logout);
  acct.append(pb, out); panel.append(acct);
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
    e.append(el('b', null, 'Nothing here yet'), document.createTextNode(sp && sp.kind === 'dm' ? 'Send the first message to start the conversation.' : 'Say hello, send a sticker, or drop in a photo.'));
    box.append(e);
  }
  let lastUser = null, lastTs = 0, lastDay = '';
  for (const m of S.msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { box.append(el('div', 'day', dayLabel(m.ts))); lastDay = day; lastUser = null; }
    const p = personOf(m.userId, { id: m.userId, name: m.name, color: m.color, avatarId: m.avatarId });
    const compact = lastUser === m.userId && m.ts - lastTs < 5 * 60 * 1000;
    const row = el('div', 'msg' + (compact ? ' compact' : ''));
    const ab = el('button', 'plain avbtn'); ab.setAttribute('aria-label', 'View profile of ' + p.name); ab.append(avatar(p, 36));
    ab.addEventListener('click', () => showProfile(m.userId));
    const meta = el('div', 'meta'); const nb = el('button', 'plain', p.name); nb.addEventListener('click', () => showProfile(m.userId));
    meta.append(nb, el('time', null, timeLabel(m.ts)));
    row.append(ab, meta);
    if (m.body) row.append(el('div', 'body', m.body));
    if (m.imageId && /^\d+$/.test(String(m.imageId))) {
      const wrap = el('div', 'body'); wrap.style.whiteSpace = 'normal';
      const ph = el('img', m.sticker ? 'sticker' : 'photo'); ph.alt = m.sticker ? 'Sticker from ' + p.name : 'Photo shared by ' + p.name; ph.loading = 'lazy'; ph.src = '/images/' + m.imageId;
      ph.addEventListener('load', () => { if (S.pin) box.scrollTop = box.scrollHeight; });
      ph.addEventListener('error', () => { ph.classList.add('gone'); ph.removeAttribute('src'); ph.alt = 'Image unavailable'; });
      ph.addEventListener('click', () => { if (ph.getAttribute('src')) { $('lightImg').src = ph.src; $('lightbox').hidden = false; } });
      wrap.append(ph);
      if (m.sticker && m.userId !== S.me.id) {
        const sv = el('button', 'savest', 'Save sticker'); sv.addEventListener('click', async () => {
          sv.disabled = true;
          try { await api('POST', '/api/stickers/save', { imageId: m.imageId }); sv.textContent = 'Saved'; toast('Added to your stickers'); }
          catch (e) { sv.disabled = false; toast(e.message); }
        });
        wrap.append(sv);
      }
      row.append(wrap);
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
async function openDm(body) {
  const { spaceId } = await api('POST', '/api/dms', body);
  S.pendingSelect = spaceId; await refreshSpaces();
}
async function logout() { try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ } S.me = null; showAuth(); }

/* ---------- composer ---------- */
async function prepImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPG, GIF or WebP photo.');
  if (file.type === 'image/gif') { if (file.size > 5.5e6) throw new Error('That GIF is too large. Keep it under 5 MB.'); return file; }
  try {
    const bmp = await loadBitmap(file); const max = 1600; const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
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
function addLocal(message) {
  if (message.channelId === S.activeCid && !S.msgs.some((m) => m.id === message.id)) { S.msgs.push(message); S.stick = true; renderMsgs(); }
}
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
    input.value = ''; input.style.height = 'auto'; clearPending(); addLocal(message);
  } catch (e) { toast(e.message); }
  finally { S.busy = false; $('sendBtn').disabled = false; $('attachBtn').disabled = false; input.focus(); }
}
async function sendSticker(id) {
  if (!S.activeCid) return;
  closeModal();
  try { const { message } = await api('POST', `/api/channels/${S.activeCid}/messages`, { stickerId: id }); addLocal(message); }
  catch (e) { toast(e.message); }
}
let lastTypingSent = 0;
function sendTyping() {
  const now = Date.now();
  if (now - lastTypingSent < 2500 || !S.ws || S.ws.readyState !== 1 || !S.activeCid) return;
  lastTypingSent = now; S.ws.send(JSON.stringify({ type: 'typing', channelId: S.activeCid }));
}

/* ---------- profiles ---------- */
function showProfile(userId) {
  const p = S.people.get(userId); if (!p) return;
  const pane = $('pane-profile'); pane.textContent = '';
  const box = el('div', 'profile');
  box.append(avatar(p, 96), el('h4', null, p.name), el('div', 'un', '@' + p.username));
  if (p.status) box.append(el('div', 'st', p.status));
  if (p.bio) box.append(el('div', 'bio', p.bio));
  const acts = el('div', 'row2');
  if (userId === S.me.id) {
    const e = el('button', 'btn primary', 'Edit profile'); e.addEventListener('click', openEditProfile); acts.append(e);
  } else {
    const m = el('button', 'btn primary', 'Message ' + p.name.split(' ')[0]);
    m.addEventListener('click', async () => { m.disabled = true; try { await openDm({ userId }); closeModal(); } catch (e) { m.disabled = false; toast(e.message); } });
    acts.append(m);
  }
  box.append(acts); pane.append(box);
  openModal('profile', 'Profile');
}
function renderEditAvatar() {
  const box = $('editAvatar'); box.textContent = ''; box.append(avatar(S.me, 72));
  $('avClear').hidden = !S.me.avatarId;
}
function renderSwatches() {
  const box = $('swatches'); box.textContent = '';
  for (const h of HUES) {
    const b = el('button', 'swatch'); b.type = 'button'; b.style.setProperty('--h', h); b.setAttribute('aria-label', 'Colour ' + h);
    b.setAttribute('aria-pressed', String(Math.abs(S.editColor - h) < 15 || (S.editColor === h)));
    b.addEventListener('click', () => { S.editColor = h; renderSwatches(); });
    box.append(b);
  }
}
function openEditProfile() {
  S.editColor = S.me.color;
  openModal('edit', 'Your profile');
  $('editName').value = S.me.name; $('editStatus').value = S.me.status || ''; $('editBio').value = S.me.bio || '';
  $('bioCount').textContent = ($('editBio').value.length) + ' / 160';
  renderEditAvatar(); renderSwatches();
}
async function pickAvatar(file) {
  try {
    const blob = await squareBlob(file, 256, 'image/jpeg', 0.88);
    const { me } = await api('POST', '/api/me/avatar', undefined, blob);
    S.me = me; rebuildPeople(); renderEditAvatar(); renderChrome(); renderRail(); toast('Photo updated');
  } catch (e) { formErr('edit', e.message); }
}

/* ---------- stickers ---------- */
async function openStickers() {
  openModal('stickers', 'Stickers');
  const grid = $('stickerGrid'); grid.textContent = ''; $('stickerHint').textContent = 'Loading…';
  try { S.stickers = (await api('GET', '/api/stickers')).stickers; } catch (e) { $('stickerHint').textContent = e.message; return; }
  renderStickers();
}
function renderStickers() {
  const grid = $('stickerGrid'); grid.textContent = '';
  $('stickerHint').textContent = S.stickers.length
    ? 'Tap a sticker to send it. Use × twice to delete one.'
    : 'You have no stickers yet. Make one from any photo, or save one someone sends you.';
  for (const st of S.stickers) {
    const cell = el('div', 'stk');
    const b = el('button', 'plain'); b.setAttribute('aria-label', 'Send sticker'); const im = el('img'); im.alt = ''; im.src = '/images/' + st.imageId; b.append(im);
    b.addEventListener('click', () => sendSticker(st.id));
    const x = el('button', 'x', '×'); x.setAttribute('aria-label', 'Delete sticker');
    x.addEventListener('click', async () => {
      if (!cell.classList.contains('armed')) { cell.classList.add('armed'); setTimeout(() => cell.classList.remove('armed'), 3000); return; }
      try { await api('DELETE', '/api/stickers/' + st.id); S.stickers = S.stickers.filter((s) => s.id !== st.id); renderStickers(); } catch (e) { toast(e.message); }
    });
    cell.append(b, x); grid.append(cell);
  }
}

/* sticker maker: crop, shape, outline, erase background, all on a canvas in the browser */
const N = 512, MARGIN = 24, W = N - 2 * MARGIN;
const MK = { img: null, zoom: 1, panX: 0, panY: 0, shape: 'circle', outline: true, mode: 'move', seeds: [], tol: 35, drag: null, raf: 0 };
const mkWork = document.createElement('canvas'); mkWork.width = W; mkWork.height = W;
const mkSil = document.createElement('canvas'); mkSil.width = W; mkSil.height = W;
function roundRectPath(g, x, y, w, h, r) {
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function floodErase(data, size, sx, sy, tol) {
  const start = (sy * size + sx) * 4;
  if (data[start + 3] === 0) return;
  const r0 = data[start], g0 = data[start + 1], b0 = data[start + 2];
  const lim = (tol * 1.7) * (tol * 1.7);
  const seen = new Uint8Array(size * size); const stack = [sy * size + sx]; seen[sy * size + sx] = 1;
  while (stack.length) {
    const p = stack.pop(); const i = p * 4;
    if (data[i + 3] === 0) continue;
    const dr = data[i] - r0, dg = data[i + 1] - g0, db = data[i + 2] - b0;
    if (dr * dr + dg * dg + db * db > lim) continue;
    data[i + 3] = 0;
    const x = p % size, y = (p - x) / size;
    if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (x < size - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !seen[p - size]) { seen[p - size] = 1; stack.push(p - size); }
    if (y < size - 1 && !seen[p + size]) { seen[p + size] = 1; stack.push(p + size); }
  }
}
function mkRender() {
  const c = $('stickerCanvas'); const g = c.getContext('2d'); g.clearRect(0, 0, N, N);
  if (!MK.img) return;
  const wg = mkWork.getContext('2d'); wg.clearRect(0, 0, W, W);
  const iw = MK.img.width, ih = MK.img.height; const base = Math.max(W / iw, W / ih) * MK.zoom; const dw = iw * base, dh = ih * base;
  const maxX = Math.max(0, (dw - W) / 2), maxY = Math.max(0, (dh - W) / 2);
  MK.panX = Math.min(maxX, Math.max(-maxX, MK.panX)); MK.panY = Math.min(maxY, Math.max(-maxY, MK.panY));
  wg.drawImage(MK.img, (W - dw) / 2 + MK.panX, (W - dh) / 2 + MK.panY, dw, dh);
  if (MK.seeds.length) {
    const id = wg.getImageData(0, 0, W, W);
    for (const s of MK.seeds) floodErase(id.data, W, s.x, s.y, s.t);
    wg.putImageData(id, 0, 0);
  }
  if (MK.shape !== 'square') {
    wg.globalCompositeOperation = 'destination-in'; wg.fillStyle = '#000'; wg.beginPath();
    if (MK.shape === 'circle') wg.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2); else roundRectPath(wg, 0, 0, W, W, W * 0.2);
    wg.fill(); wg.globalCompositeOperation = 'source-over';
  }
  if (MK.outline) {
    const sg = mkSil.getContext('2d'); sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, W, W); sg.drawImage(mkWork, 0, 0);
    sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#fff'; sg.fillRect(0, 0, W, W); sg.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.drawImage(mkSil, MARGIN + Math.cos(a) * 9, MARGIN + Math.sin(a) * 9); }
  }
  g.drawImage(mkWork, MARGIN, MARGIN);
}
function mkSchedule() { if (MK.raf) return; MK.raf = requestAnimationFrame(() => { MK.raf = 0; mkRender(); }); }
function mkSetMode(mode) {
  MK.mode = mode;
  document.querySelectorAll('#pane-maker [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const erase = mode === 'erase';
  $('stickerCanvas').classList.toggle('erasing', erase);
  $('mkZoomRow').hidden = erase; $('mkTolRow').hidden = !erase; $('mkEraseBtns').hidden = !erase;
  $('mkModeHint').textContent = erase ? 'Tap the background to erase it. Tap again on any leftover bits. Moving or zooming later clears erasing.' : 'Drag the picture to reposition it.';
}
function mkReset() {
  Object.assign(MK, { zoom: 1, panX: 0, panY: 0, seeds: [], tol: 35, drag: null });
  $('mkZoom').value = '1'; $('mkTol').value = '35'; mkSetMode('move');
}
function openMaker() {
  openModal('maker', 'Make a sticker');
  MK.img = null; $('mkPick').hidden = false; $('mkEdit').hidden = true; $('err-maker').hidden = true;
}
async function mkLoad(file) {
  try {
    if (!/^image\//.test(file.type)) throw new Error('Choose a picture file.');
    MK.img = await loadBitmap(file); mkReset();
    $('mkPick').hidden = true; $('mkEdit').hidden = false; $('err-maker').hidden = true; mkRender();
  } catch (e) { formErr('maker', e.message); $('mkEdit').hidden = false; }
}
async function mkSave() {
  if (!MK.img) return;
  const btn = $('mkSave'); btn.disabled = true;
  try {
    const c = $('stickerCanvas');
    let blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (blob && blob.size > 900000) {
      const small = document.createElement('canvas'); small.width = 384; small.height = 384; small.getContext('2d').drawImage(c, 0, 0, 384, 384);
      blob = await new Promise((r) => small.toBlob(r, 'image/png'));
    }
    if (!blob) throw new Error('The sticker could not be created. Try a different photo.');
    await api('POST', '/api/stickers', undefined, blob);
    toast('Sticker added to your pack'); await openStickers();
  } catch (e) { formErr('maker', e.message); }
  finally { btn.disabled = false; }
}
function wireMaker() {
  const c = $('stickerCanvas');
  $('makeSticker').addEventListener('click', openMaker);
  $('mkChoose').addEventListener('click', () => $('stickerFile').click());
  $('mkChange').addEventListener('click', () => $('stickerFile').click());
  $('stickerFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) mkLoad(f); });
  document.querySelectorAll('#pane-maker [data-mode]').forEach((b) => b.addEventListener('click', () => mkSetMode(b.dataset.mode)));
  document.querySelectorAll('#pane-maker [data-shape]').forEach((b) => b.addEventListener('click', () => {
    MK.shape = b.dataset.shape;
    document.querySelectorAll('#pane-maker [data-shape]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); mkSchedule();
  }));
  $('mkOutline').addEventListener('change', (e) => { MK.outline = e.target.checked; mkSchedule(); });
  $('mkZoom').addEventListener('input', (e) => { MK.zoom = Number(e.target.value); MK.seeds = []; mkSchedule(); });
  $('mkTol').addEventListener('input', (e) => { MK.tol = Number(e.target.value); });
  $('mkUndo').addEventListener('click', () => { MK.seeds.pop(); mkSchedule(); });
  $('mkClear').addEventListener('click', () => { MK.seeds = []; mkSchedule(); });
  $('mkSave').addEventListener('click', mkSave);
  c.addEventListener('pointerdown', (e) => {
    if (!MK.img) return;
    const r = c.getBoundingClientRect();
    if (MK.mode === 'erase') {
      const x = Math.floor((e.clientX - r.left) * (N / r.width) - MARGIN), y = Math.floor((e.clientY - r.top) * (N / r.height) - MARGIN);
      if (x >= 0 && y >= 0 && x < W && y < W) { MK.seeds.push({ x, y, t: MK.tol }); mkSchedule(); }
      return;
    }
    if (MK.seeds.length) MK.seeds = [];
    try { c.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    MK.drag = { x: e.clientX, y: e.clientY, px: MK.panX, py: MK.panY };
  });
  c.addEventListener('pointermove', (e) => {
    if (!MK.drag) return; const r = c.getBoundingClientRect(); const k = N / r.width;
    MK.panX = MK.drag.px + (e.clientX - MK.drag.x) * k; MK.panY = MK.drag.py + (e.clientY - MK.drag.y) * k; mkSchedule();
  });
  const end = () => { MK.drag = null; };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
}

/* ---------- modal ---------- */
const PANES = ['start', 'server', 'group', 'join', 'channel', 'invite', 'dm', 'profile', 'edit', 'stickers', 'maker'];
function openModal(pane, title) {
  $('modalTitle').textContent = title;
  PANES.forEach((p) => { $('pane-' + p).hidden = p !== pane; });
  document.querySelectorAll('#modal .err').forEach((e) => { e.hidden = true; });
  if (pane === 'invite') showInvite();
  $('modal').hidden = false;
  const f = { server: 'serverName', group: 'groupName', join: 'joinCode', channel: 'channelName', dm: 'dmUser' }[pane];
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
const TITLES = { server: 'Start a server', group: 'New group chat', join: 'Join with a code', dm: 'Message someone' };
function wire() {
  put($('menuBtn'), 'menu'); put($('attachBtn'), 'clip'); put($('stickerBtn'), 'sticker'); put($('sendBtn'), 'send'); put($('chipX'), 'x'); put($('modalX'), 'x');
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
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.open; openModal(k, TITLES[k]); }));
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
  $('pane-dm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await openDm({ username: $('dmUser').value }); closeModal(); } catch (x) { formErr('dm', x.message); }
  });
  $('pane-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { channelId } = await api('POST', `/api/spaces/${S.activeSid}/channels`, { name: $('channelName').value });
      closeModal(); await refreshSpaces(); await selectChannel(channelId);
    } catch (x) { formErr('channel', x.message); }
  });
  $('pane-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { me } = await api('PATCH', '/api/me', { displayName: $('editName').value, status: $('editStatus').value, bio: $('editBio').value, color: S.editColor });
      S.me = me; closeModal(); await refreshSpaces(); toast('Profile saved');
    } catch (x) { formErr('edit', x.message); }
  });
  $('editBio').addEventListener('input', () => { $('bioCount').textContent = $('editBio').value.length + ' / 160'; });
  $('avPick').addEventListener('click', () => $('avFile').click());
  $('avFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) pickAvatar(f); });
  $('avClear').addEventListener('click', async () => {
    try { const { me } = await api('DELETE', '/api/me/avatar'); S.me = me; rebuildPeople(); renderEditAvatar(); renderChrome(); renderRail(); } catch (x) { formErr('edit', x.message); }
  });
  $('stickerBtn').addEventListener('click', openStickers);
  wireMaker();
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
