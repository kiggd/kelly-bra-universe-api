-- 凱莉愛內衣宇宙 V5 — Vercel Postgres 資料表
CREATE TABLE IF NOT EXISTS members (
  member_id    TEXT PRIMARY KEY,
  line_uid     TEXT,
  email        TEXT,
  referral_id  TEXT,
  ref_from     TEXT,
  role_id      TEXT,
  fit_result   TEXT,
  fit_scores   TEXT DEFAULT '{}',
  collection   TEXT DEFAULT '[]',
  squad        TEXT DEFAULT '{}',
  streak       INTEGER DEFAULT 0,
  last_checkin TEXT,
  tickets      INTEGER DEFAULT 0,
  keys         INTEGER DEFAULT 0,
  friends      INTEGER DEFAULT 0,
  boss_hp      INTEGER DEFAULT 100,
  tags         TEXT DEFAULT '[]',
  chest_opened INTEGER DEFAULT 0,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_line_uid  ON members(line_uid);
CREATE INDEX IF NOT EXISTS idx_members_email     ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_ref_from  ON members(ref_from);

CREATE TABLE IF NOT EXISTS otp_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT,
  expires_at   BIGINT,
  attempts     INTEGER DEFAULT 0,
  last_sent_at BIGINT
);

CREATE TABLE IF NOT EXISTS ledgers (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  granted         TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_member_trigger ON ledgers(member_id, trigger);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_idem ON ledgers(idempotency_key);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  member_id  TEXT,
  event      TEXT NOT NULL,
  ts         TEXT,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_member ON events(member_id);
CREATE INDEX IF NOT EXISTS idx_events_name   ON events(event);

CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT NOT NULL,
  referrer_id TEXT,
  friend_id   TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_pair ON referrals(ref_code, friend_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
