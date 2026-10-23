'use strict';
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See README.md for how to set it.');
  process.exit(1);
}
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: isLocal || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 10,
});
pool.on('error', (e) => console.error('Database pool error:', e.message));

const SCHEMA = `
create table if not exists users (
  id            serial primary key,
  username      text not null unique,
  display_name  text not null,
  password_hash text not null,
  color         int  not null default 230,
  created_at    timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id    int not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);
create table if not exists spaces (
  id          serial primary key,
  kind        text not null check (kind in ('server','group','dm')),
  name        text,
  owner_id    int references users(id) on delete set null,
  invite_code text unique,
  dm_key      text unique,
  created_at  timestamptz not null default now()
);
create table if not exists members (
  space_id  int not null references spaces(id) on delete cascade,
  user_id   int not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index if not exists members_user_idx on members(user_id);
create table if not exists channels (
  id         serial primary key,
  space_id   int not null references spaces(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index if not exists channels_space_idx on channels(space_id);
create table if not exists images (
  id         serial primary key,
  user_id    int not null references users(id) on delete cascade,
  mime       text not null,
  data       bytea not null,
  created_at timestamptz not null default now()
);
create table if not exists messages (
  id         bigserial primary key,
  channel_id int not null references channels(id) on delete cascade,
  user_id    int not null references users(id) on delete cascade,
  body       text not null default '',
  image_id   int references images(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_idx on messages(channel_id, id desc);
`;

async function init() {
  await pool.query(SCHEMA);
}

module.exports = { pool, init };
