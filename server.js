'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { pool, init } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 60;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ---------- small helpers ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const makeCode = () => {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};
const parseCookies = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ---------- security headers and request guards ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});
// Block cross-site writes: browsers always send Origin on cross-site POST/DELETE.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* ignore */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
});
app.use(express.json({ limit: '20kb' }));

/* ---------- sessions ---------- */
async function userFromToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query(
    `select u.id, u.username, u.display_name, u.color
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.created_at > now() - ($2 || ' days')::interval`,
    [sha256(token), String(SESSION_DAYS)]
  );
  return rows[0] || null;
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('insert into sessions(token_hash, user_id) values ($1, $2)', [sha256(token), userId]);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_DAYS * 86400 * 1000,
  });
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.display_name, color: u.color });
const requireAuth = wrap(async (req, res, next) => {
  const me = await userFromToken(parseCookies(req.headers.cookie).sid);
  if (!me) throw httpError(401, 'Please log in.');
  req.me = me;
  next();
});

/* ---------- realtime ---------- */
const conns = new Map(); // userId -> Set<ws>
function sendTo(userIds, payload) {
  const text = JSON.stringify(payload);
  for (const id of userIds) {
    const set = conns.get(id);
    if (!set) continue;
    for (const ws of set) if (ws.readyState === 1) ws.send(text);
  }
}
async function memberIds(spaceId) {
  const { rows } = await pool.query('select user_id from members where space_id = $1', [spaceId]);
  return rows.map((r) => r.user_id);
}
async function channelInfo(channelId) {
  const { rows } = await pool.query(
    'select c.id, c.space_id, s.kind from channels c join spaces s on s.id = c.space_id where c.id = $1',
    [channelId]
  );
  return rows[0] || null;
}
async function isMember(spaceId, userId) {
  const { rowCount } = await pool.query('select 1 from members where space_id = $1 and user_id = $2', [spaceId, userId]);
  return rowCount > 0;
}
// Returns channel info only if the user belongs to that channel's space.
async function channelForMember(channelId, userId) {
  if (!Number.isInteger(channelId)) throw httpError(404, 'Channel not found.');
  const info = await channelInfo(channelId);
  if (!info || !(await isMember(info.space_id, userId))) throw httpError(404, 'Channel not found.');
  return info;
}
const messageRow = (r) => ({
  id: Number(r.id), channelId: r.channel_id, userId: r.user_id, name: r.name, color: r.color,
  body: r.body, imageId: r.image_id, ts: r.ts,
});
const MESSAGE_SELECT = `
  select m.id, m.channel_id, m.user_id, m.body, m.image_id,
         floor(extract(epoch from m.created_at) * 1000)::float8 as ts,
         u.display_name as name, u.color
    from messages m join users u on u.id = m.user_id`;

/* ---------- accounts ---------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many tries. Wait a few minutes and try again.' },
});

app.post('/api/signup', authLimiter, wrap(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw httpError(400, 'Usernames use 3 to 20 letters, numbers or underscores.');
  if (password.length < 8 || password.length > 72) throw httpError(400, 'Passwords need 8 to 72 characters.');
  const display = clean(req.body.displayName, 32) || username;
  const hash = await bcrypt.hash(password, 10);
  let user;
  try {
    const { rows } = await pool.query(
      'insert into users(username, display_name, password_hash, color) values ($1,$2,$3,$4) returning id, username, display_name, color',
      [username, display, hash, Math.floor(Math.random() * 360)]
    );
    user = rows[0];
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'That username is taken. Try another.');
    throw e;
  }
  await startSession(req, res, user.id);
  res.json({ me: publicUser(user) });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase();
  const password = String(req.body.password || '').slice(0, 72);
  const { rows } = await pool.query('select * from users where username = $1', [username]);
  const user = rows[0];
  // Compare against a dummy hash when the user is missing so timing does not reveal who exists.
  const ok = await bcrypt.compare(password, user ? user.password_hash : '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BcIXBlEjgDdbPYBQjC6Gz1qJ7nXe');
  if (!user || !ok) throw httpError(401, 'Wrong username or password.');
  await startSession(req, res, user.id);
  res.json({ me: publicUser({ id: user.id, username: user.username, display_name: user.display_name, color: user.color }) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, (req, res) => res.json({ me: publicUser(req.me) }));

/* ---------- spaces ---------- */
async function loadSpaces(userId) {
  const sp = await pool.query(
    `select s.id, s.kind, s.name, s.owner_id, s.invite_code
       from spaces s join members m on m.space_id = s.id
      where m.user_id = $1 order by s.id`,
    [userId]
  );
  if (!sp.rows.length) return [];
  const ids = sp.rows.map((r) => r.id);
  const ch = await pool.query('select id, space_id, name from channels where space_id = any($1::int[]) order by id', [ids]);
  const mem = await pool.query(
    `select m.space_id, u.id, u.display_name, u.username, u.color
       from members m join users u on u.id = m.user_id
      where m.space_id = any($1::int[]) order by m.joined_at, u.id`,
    [ids]
  );
  return sp.rows.map((s) => ({
    id: s.id, kind: s.kind, name: s.name, ownerId: s.owner_id,
    inviteCode: s.kind === 'dm' ? null : s.invite_code,
    channels: ch.rows.filter((c) => c.space_id === s.id).map((c) => ({ id: c.id, name: c.name })),
    members: mem.rows.filter((m) => m.space_id === s.id)
      .map((m) => ({ id: m.id, name: m.display_name, username: m.username, color: m.color })),
  }));
}
app.get('/api/spaces', requireAuth, wrap(async (req, res) => {
  res.json({ spaces: await loadSpaces(req.me.id) });
}));

app.post('/api/spaces', requireAuth, wrap(async (req, res) => {
  const kind = req.body.kind;
  if (kind !== 'server' && kind !== 'group') throw httpError(400, 'Choose a server or a group chat.');
  const name = clean(req.body.name, 40);
  if (!name) throw httpError(400, 'Give it a name.');
  const client = await pool.connect();
  let spaceId;
  try {
    await client.query('begin');
    const s = await client.query(
      'insert into spaces(kind, name, owner_id, invite_code) values ($1,$2,$3,$4) returning id',
      [kind, name, req.me.id, makeCode()]
    );
    spaceId = s.rows[0].id;
    await client.query('insert into members(space_id, user_id) values ($1,$2)', [spaceId, req.me.id]);
    await client.query('insert into channels(space_id, name) values ($1,$2)', [spaceId, kind === 'server' ? 'general' : 'chat']);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ spaceId });
}));

app.post('/api/spaces/join', requireAuth, joinLimiter, wrap(async (req, res) => {
  const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw httpError(404, 'No space uses that code. Check the 8 characters and try again.');
  const { rows } = await pool.query("select id from spaces where invite_code = $1 and kind <> 'dm'", [code]);
  if (!rows.length) throw httpError(404, 'No space uses that code. Check the 8 characters and try again.');
  const spaceId = rows[0].id;
  await pool.query('insert into members(space_id, user_id) values ($1,$2) on conflict do nothing', [spaceId, req.me.id]);
  sendTo(await memberIds(spaceId), { type: 'refresh' });
  res.json({ spaceId });
}));

app.post('/api/spaces/:id/leave', requireAuth, wrap(async (req, res) => {
  const spaceId = Number(req.params.id);
  if (!(await isMember(spaceId, req.me.id))) throw httpError(404, 'Space not found.');
  const others = (await memberIds(spaceId)).filter((id) => id !== req.me.id);
  await pool.query('delete from members where space_id = $1 and user_id = $2', [spaceId, req.me.id]);
  if (!others.length) await pool.query('delete from spaces where id = $1', [spaceId]);
  else {
    // If the owner leaves, hand the space to the longest-standing member.
    await pool.query(
      `update spaces set owner_id = (select user_id from members where space_id = $1 order by joined_at limit 1)
        where id = $1 and (owner_id is null or owner_id = $2)`,
      [spaceId, req.me.id]
    );
  }
  sendTo([req.me.id, ...others], { type: 'refresh' });
  res.json({ ok: true });
}));

app.post('/api/spaces/:id/channels', requireAuth, wrap(async (req, res) => {
  const spaceId = Number(req.params.id);
  if (!(await isMember(spaceId, req.me.id))) throw httpError(404, 'Space not found.');
  const sp = await pool.query('select kind from spaces where id = $1', [spaceId]);
  if (!sp.rows.length || sp.rows[0].kind !== 'server') throw httpError(400, 'Only servers have channels.');
  const name = clean(req.body.name, 30).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!name) throw httpError(400, 'Use letters, numbers or dashes.');
  const count = await pool.query('select count(*)::int as n from channels where space_id = $1', [spaceId]);
  if (count.rows[0].n >= 30) throw httpError(400, 'A server can have up to 30 channels.');
  const { rows } = await pool.query('insert into channels(space_id, name) values ($1,$2) returning id', [spaceId, name]);
  sendTo(await memberIds(spaceId), { type: 'refresh' });
  res.json({ channelId: rows[0].id });
}));

app.post('/api/spaces/:id/invite/regenerate', requireAuth, wrap(async (req, res) => {
  const spaceId = Number(req.params.id);
  const { rows } = await pool.query("select owner_id from spaces where id = $1 and kind <> 'dm'", [spaceId]);
  if (!rows.length || rows[0].owner_id !== req.me.id) throw httpError(403, 'Only the owner can make a new code.');
  const code = makeCode();
  await pool.query('update spaces set invite_code = $1 where id = $2', [code, spaceId]);
  sendTo(await memberIds(spaceId), { type: 'refresh' });
  res.json({ inviteCode: code });
}));

app.post('/api/dms', requireAuth, wrap(async (req, res) => {
  const other = Number(req.body.userId);
  if (!Number.isInteger(other) || other === req.me.id) throw httpError(400, 'Pick someone else to message.');
  // Only people who already share a space with you, so strangers cannot be looked up by id.
  const shared = await pool.query(
    `select 1 from members a join members b on a.space_id = b.space_id
      where a.user_id = $1 and b.user_id = $2 limit 1`,
    [req.me.id, other]
  );
  if (!shared.rowCount) throw httpError(403, 'You can only message people you share a space with.');
  const key = [req.me.id, other].sort((a, b) => a - b).join('_');
  const client = await pool.connect();
  let spaceId;
  try {
    await client.query('begin');
    const ins = await client.query(
      "insert into spaces(kind, owner_id, dm_key) values ('dm', $1, $2) on conflict (dm_key) do nothing returning id",
      [req.me.id, key]
    );
    if (ins.rows.length) {
      spaceId = ins.rows[0].id;
      await client.query('insert into members(space_id, user_id) values ($1,$2),($1,$3)', [spaceId, req.me.id, other]);
      await client.query("insert into channels(space_id, name) values ($1,'chat')", [spaceId]);
    } else {
      const ex = await client.query('select id from spaces where dm_key = $1', [key]);
      spaceId = ex.rows[0].id;
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  sendTo([req.me.id, other], { type: 'refresh' });
  res.json({ spaceId });
}));

/* ---------- messages ---------- */
app.get('/api/channels/:id/messages', requireAuth, wrap(async (req, res) => {
  const channelId = Number(req.params.id);
  await channelForMember(channelId, req.me.id);
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const { rows } = await pool.query(
    `${MESSAGE_SELECT} where m.channel_id = $1 and ($2::bigint is null or m.id < $2) order by m.id desc limit $3`,
    [channelId, Number.isFinite(before) ? before : null, limit + 1]
  );
  const hasMore = rows.length > limit;
  res.json({ messages: rows.slice(0, limit).reverse().map(messageRow), hasMore });
}));

app.post('/api/channels/:id/messages', requireAuth, wrap(async (req, res) => {
  const channelId = Number(req.params.id);
  const info = await channelForMember(channelId, req.me.id);
  const body = String(req.body.body == null ? '' : req.body.body).trim().slice(0, 4000);
  const imageId = req.body.imageId == null ? null : Number(req.body.imageId);
  if (!body && imageId == null) throw httpError(400, 'Write a message or add a photo.');
  if (imageId != null) {
    const img = await pool.query('select 1 from images where id = $1 and user_id = $2', [imageId, req.me.id]);
    if (!img.rowCount) throw httpError(400, 'That photo is not available. Upload it again.');
  }
  const ins = await pool.query(
    'insert into messages(channel_id, user_id, body, image_id) values ($1,$2,$3,$4) returning id',
    [channelId, req.me.id, body, imageId]
  );
  const { rows } = await pool.query(`${MESSAGE_SELECT} where m.id = $1`, [ins.rows[0].id]);
  const message = messageRow(rows[0]);
  sendTo(await memberIds(info.space_id), { type: 'message', spaceId: info.space_id, message });
  res.json({ message });
}));

app.delete('/api/messages/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) throw httpError(404, 'Message not found.');
  const { rows } = await pool.query(
    `delete from messages m using channels c
      where m.id = $1 and m.user_id = $2 and c.id = m.channel_id
      returning m.channel_id, m.image_id, c.space_id`,
    [id, req.me.id]
  );
  if (!rows.length) throw httpError(404, 'Message not found.');
  if (rows[0].image_id) await pool.query('delete from images where id = $1', [rows[0].image_id]);
  sendTo(await memberIds(rows[0].space_id), { type: 'delete', channelId: rows[0].channel_id, messageId: id });
  res.json({ ok: true });
}));

/* ---------- images ---------- */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
app.post('/api/images',
  requireAuth,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], limit: '6mb' }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Choose a PNG, JPG, GIF or WebP photo.');
    const mime = sniffImage(req.body);
    if (!mime) throw httpError(400, 'That file is not a supported photo.');
    const { rows } = await pool.query('insert into images(user_id, mime, data) values ($1,$2,$3) returning id', [req.me.id, mime, req.body]);
    res.json({ id: rows[0].id });
  })
);
app.get('/images/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, 'Not found.');
  // Visible to the uploader, or to anyone in a space where the photo was posted.
  const { rows } = await pool.query(
    `select i.mime, i.data from images i
      where i.id = $1 and (i.user_id = $2 or exists (
        select 1 from messages m join channels c on c.id = m.channel_id
          join members mb on mb.space_id = c.space_id
         where m.image_id = i.id and mb.user_id = $2))`,
    [id, req.me.id]
  );
  if (!rows.length) throw httpError(404, 'Not found.');
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Disposition': 'inline' });
  res.send(rows[0].data);
}));

/* ---------- static files and errors ---------- */
app.get('/healthz', wrap(async (req, res) => { await pool.query('select 1'); res.send('ok'); }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') err = httpError(413, 'That is too large.');
  if (err.type === 'entity.parse.failed') err = httpError(400, 'Bad request.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

/* ---------- websocket server ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', async (req, socket, head) => {
  try {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return socket.destroy();
    const me = await userFromToken(parseCookies(req.headers.cookie).sid);
    if (!me) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.userId = me.id; wss.emit('connection', ws, req); });
  } catch (e) {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.lastTyping = 0;
  if (!conns.has(ws.userId)) conns.set(ws.userId, new Set());
  conns.get(ws.userId).add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'typing') return;
      const now = Date.now();
      if (now - ws.lastTyping < 2000) return;
      ws.lastTyping = now;
      const info = await channelInfo(Number(msg.channelId));
      if (!info || !(await isMember(info.space_id, ws.userId))) return;
      const others = (await memberIds(info.space_id)).filter((id) => id !== ws.userId);
      sendTo(others, { type: 'typing', channelId: info.id, userId: ws.userId });
    } catch (e) { /* ignore malformed frames */ }
  });
  ws.on('close', () => {
    const set = conns.get(ws.userId);
    if (set) { set.delete(ws); if (!set.size) conns.delete(ws.userId); }
  });
});

// Keep connections alive through proxies and drop dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

/* ---------- housekeeping ---------- */
async function cleanup() {
  try {
    await pool.query("delete from images i where i.created_at < now() - interval '1 day' and not exists (select 1 from messages m where m.image_id = i.id)");
    await pool.query("delete from sessions where created_at < now() - ($1 || ' days')::interval", [String(SESSION_DAYS)]);
  } catch (e) { console.error('Cleanup failed:', e.message); }
}

init()
  .then(() => {
    cleanup();
    setInterval(cleanup, 6 * 3600 * 1000).unref();
    server.listen(PORT, () => console.log(`Porchlight listening on port ${PORT}`));
  })
  .catch((e) => { console.error('Could not start:', e); process.exit(1); });

module.exports = { server };
