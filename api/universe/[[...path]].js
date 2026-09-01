/*
 * 凱莉愛內衣宇宙 V5 — 後端（Vercel Serverless + Postgres）
 * 部署：repo 根目錄放 package.json + api/，Vercel 自動辨識函式。
 * 前端 apiBase 設為 https://<project>.vercel.app/api/universe
 *
 * 環境變數（Vercel Postgres 連線後自動提供 POSTGRES_URL）：
 *   POSTGRES_URL      由 Vercel Postgres 自動注入
 *   LINE_CHANNEL_ID   預設 1608559038（凱莉愛內衣 LINE Login channel）
 *   EMAIL_API_KEY / EMAIL_FROM  選填，Email 驗證碼（Resend）；未設則寫入 log
 *   GA4_MEASUREMENT_ID / GA4_API_SECRET  選填，事件轉送 GA4
 * JWT_SECRET 不需設定：首次啟動自動產生並存入 settings 資料表。
 */

import postgres from 'postgres';

const sql = postgres(process.env.POSTGRES_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});

const REWARDS = {
  mission_quiz:    ['召喚券×1'],
  mission_share:   ['召喚券×1'],
  mission_checkin: ['鑰匙×1'],
  mission_guide:   ['召喚券×1'],
  mission_store:   ['鑰匙×1'],
  mission_friend:  ['召喚券×2'],
  chest_reward:    ['召喚券×3', '鑰匙×1'],
};
const TRIGGER_ALIAS = { share: 'mission_share' };
const DEFAULT_ALLOWED_ORIGINS =
  'https://www.kellylove.tw,https://universe.kellylove.tw,https://kiggd.github.io';
const JWT_TTL_SECONDS = 60 * 60 * 24 * 30;
const OTP_TTL_SECONDS = 10 * 60;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const REFERRAL_24H_LIMIT = 5;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID || '1608559038';

let jwtSecretCache = null;

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api\/universe/, '') || '/';
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') return send(res, 204, null, cors);
  if (req.method !== 'POST' && !(path === '/health' && req.method === 'GET')) {
    return send(res, 405, { error: 'method_not_allowed', message: '僅支援 POST' }, cors);
  }
  try {
    if (path === '/health') return send(res, 200, { ok: true }, cors);
    if (path === '/auth/line') return send(res, 200, await handleAuthLine(req), cors);
    if (path === '/auth/otp') return send(res, 200, await handleOtpSend(req), cors);
    if (path === '/auth/otp/verify') return send(res, 200, await handleOtpVerify(req), cors);
    if (path === '/events') return send(res, 200, await handleEvent(req), cors);
    if (path === '/rewards/claim') return send(res, 200, await handleClaim(req), cors);
    if (path === '/crm/sync') return send(res, 200, await handleCrmSync(req), cors);
    return send(res, 404, { error: 'not_found', message: '找不到端點' }, cors);
  } catch (e) {
    console.error('unhandled', e);
    const status = e.status || 500;
    return send(res, status, { error: e.code || 'internal', message: e.message || '伺服器錯誤' }, cors);
  }
}

/* ───────────── 工具函式 ───────────── */

function send(res, status, body, cors) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(cors || {})) res.setHeader(k, v);
  res.end(body === null ? '' : JSON.stringify(body));
}

function corsHeaders(req) {
  const allowed = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getJwtSecret() {
  if (jwtSecretCache) return jwtSecretCache;
  const rows = await sql`SELECT value FROM settings WHERE key = 'jwt_secret'`;
  if (rows.length) { jwtSecretCache = rows[0].value; return jwtSecretCache; }
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  await sql`INSERT INTO settings (key, value) VALUES ('jwt_secret', ${secret})
            ON CONFLICT (key) DO NOTHING`;
  const again = await sql`SELECT value FROM settings WHERE key = 'jwt_secret'`;
  jwtSecretCache = again[0].value;
  return jwtSecretCache;
}

async function signJwt(memberId) {
  const secret = await getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ member_id: memberId, iat: now, exp: now + JWT_TTL_SECONDS });
  const sig = await hmacSha256Hex(secret, header + '.' + payload);
  return `${header}.${payload}.${sig}`;
}

async function verifyJwt(token) {
  const secret = await getJwtSecret();
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = await hmacSha256Hex(secret, parts[0] + '.' + parts[1]);
  if (expected !== parts[2]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function newId(prefix) {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `${prefix}-${rand}`;
}

function randomMemberId() {
  return `M-${Math.floor(100000 + Math.random() * 900000)}`;
}

function randomReferralId() {
  return 'KL' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function grantedDelta(granted) {
  let tickets = 0, keys = 0;
  for (const g of granted || []) {
    const n = parseInt(String(g).match(/\d+/)?.[0] || '1', 10) || 1;
    if (g.includes('召喚券')) tickets += n;
    if (g.includes('鑰匙')) keys += n;
  }
  return { tickets, keys };
}

async function getMember(memberId) {
  const rows = await sql`SELECT * FROM members WHERE member_id = ${memberId}`;
  return rows[0] || null;
}

async function upsertMemberIdentity({ memberId, lineUid, email, refFrom }) {
  const existing = await getMember(memberId);
  const refFromFinal = existing?.ref_from || refFrom || null;
  if (existing) {
    await sql`
      UPDATE members SET
        line_uid = COALESCE(${lineUid ?? null}, line_uid),
        email = COALESCE(${email ?? null}, email),
        ref_from = COALESCE(${refFromFinal}, ref_from),
        updated_at = ${new Date().toISOString()}
      WHERE member_id = ${memberId}`;
  } else {
    await sql`
      INSERT INTO members (member_id, line_uid, email, referral_id, ref_from, updated_at)
      VALUES (${memberId}, ${lineUid ?? null}, ${email ?? null},
              ${randomReferralId()}, ${refFromFinal}, ${new Date().toISOString()})`;
  }
  return getMember(memberId);
}

/* ───────────── LINE 登入 ───────────── */

async function verifyLineIdToken(idToken) {
  const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  return r.json();
}

async function handleAuthLine(req) {
  const body = await readBody(req);
  if (!body.id_token) throw httpError(400, 'missing_id_token', '缺少 id_token');
  const profile = await verifyLineIdToken(body.id_token);
  if (!profile?.sub) throw httpError(401, 'id_token_invalid', 'LINE id_token 驗證失敗');
  const lineUid = profile.sub;
  const existing = (await sql`SELECT * FROM members WHERE line_uid = ${lineUid}`)[0] || null;
  const memberId = existing?.member_id || randomMemberId();
  const member = await upsertMemberIdentity({
    memberId,
    lineUid,
    email: existing?.email || null,
    refFrom: body.referral_id || null,
  });
  const token = await signJwt(member.member_id);
  await processReferral(member.member_id);
  return { member_id: member.member_id, token, email: member.email || null };
}

/* ───────────── Email OTP ───────────── */

async function handleOtpSend(req) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw httpError(400, 'invalid_email', 'Email 格式錯誤');
  }
  const now = Math.floor(Date.now() / 1000);
  const row = (await sql`SELECT last_sent_at, attempts FROM otp_codes WHERE email = ${email}`)[0] || null;
  if (row?.last_sent_at && now - Number(row.last_sent_at) < OTP_RESEND_SECONDS) {
    throw httpError(429, 'too_frequent', '請 60 秒後再試');
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await sha256Hex(code);
  await sql`
    INSERT INTO otp_codes (email, code_hash, expires_at, attempts, last_sent_at)
    VALUES (${email}, ${hash}, ${now + OTP_TTL_SECONDS}, 0, ${now})
    ON CONFLICT (email) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, last_sent_at = excluded.last_sent_at`;
  await sendOtpEmail(email, code);
  return { ok: true };
}

async function sendOtpEmail(email, code) {
  if (!process.env.EMAIL_API_KEY) {
    console.log(`[OTP dev] ${email} -> ${code}`);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || '凱莉愛內衣 <no-reply@kellylove.tw>',
        to: email,
        subject: '凱莉愛內衣宇宙｜Email 驗證碼',
        html: `<p>你的驗證碼：<b>${code}</b></p><p>10 分鐘內有效。</p>`,
      }),
    });
  } catch (e) {
    console.error('otp email failed', e);
  }
}

async function handleOtpVerify(req) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!email || !code) throw httpError(400, 'missing_fields', '缺少 Email 或驗證碼');
  const now = Math.floor(Date.now() / 1000);
  const row = (await sql`SELECT * FROM otp_codes WHERE email = ${email}`)[0] || null;
  if (!row || Number(row.expires_at) < now) {
    throw httpError(401, 'otp_expired', '驗證碼已失效，請重新索取');
  }
  const hash = await sha256Hex(code);
  if (hash !== row.code_hash) {
    const attempts = Number(row.attempts || 0) + 1;
    await sql`UPDATE otp_codes SET attempts = ${attempts} WHERE email = ${email}`;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await sql`DELETE FROM otp_codes WHERE email = ${email}`;
    }
    throw httpError(401, 'otp_invalid', '驗證碼錯誤');
  }
  await sql`DELETE FROM otp_codes WHERE email = ${email}`;
  const existing = (await sql`SELECT * FROM members WHERE email = ${email}`)[0] || null;
  const memberId = existing?.member_id || randomMemberId();
  const member = await upsertMemberIdentity({
    memberId,
    lineUid: existing?.line_uid || null,
    email,
    refFrom: body.referral_id || null,
  });
  const token = await signJwt(member.member_id);
  await processReferral(member.member_id);
  return { member_id: member.member_id, token, email };
}

/* ───────────── 事件 ───────────── */

async function handleEvent(req) {
  const body = await readBody(req);
  const event = String(body.event || '');
  if (!event) throw httpError(400, 'missing_event', '缺少事件名稱');
  const created = new Date().toISOString();
  await sql`
    INSERT INTO events (id, member_id, event, ts, payload, created_at)
    VALUES (${newId('EV')}, ${body.member_id || null}, ${event},
            ${body.ts || created}, ${JSON.stringify(body)}, ${created})`;
  if (event === 'quiz_complete' && body.member_id) {
    await processReferral(body.member_id);
  }
  if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET) {
    await forwardToGa4(body);
  }
  return { ok: true };
}

function ga4EventName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
}

async function forwardToGa4(payload) {
  try {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: payload.member_id || 'guest',
        events: [{ name: ga4EventName(payload.event), params: payload }],
      }),
    });
  } catch (e) {
    console.error('ga4 forward failed', e);
  }
}

/* ───────────── 獎勵 ───────────── */

async function handleClaim(req) {
  const payload = await verifyJwt(bearerToken(req));
  if (!payload?.member_id) throw httpError(401, 'unauthorized', '請先登入');
  const body = await readBody(req);
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) throw httpError(400, 'missing_idempotency', '缺少 X-Idempotency-Key');
  const memberId = body.member_id || payload.member_id;
  if (memberId !== payload.member_id) throw httpError(403, 'forbidden', 'member_id 不符');
  const trigger = TRIGGER_ALIAS[body.trigger] || body.trigger;
  if (!REWARDS[trigger]) throw httpError(400, 'unknown_trigger', `未知的獎勵觸發：${body.trigger}`);

  const member = await getMember(memberId);
  if (!member) throw httpError(404, 'member_not_found', '會員不存在');

  const byIdem = (await sql`SELECT * FROM ledgers WHERE idempotency_key = ${idempotencyKey}`)[0] || null;
  if (byIdem) return { granted: JSON.parse(byIdem.granted), ledger_id: byIdem.id };

  const already = (await sql`SELECT * FROM ledgers WHERE member_id = ${memberId} AND trigger = ${trigger}`)[0] || null;
  if (already) throw httpError(409, 'already_granted', '獎勵已發放過');

  if (trigger === 'mission_friend') {
    const done = (await sql`
      SELECT r.* FROM referrals r
      WHERE r.referrer_id = ${memberId} AND r.status = 'done' LIMIT 1`)[0] || null;
    if (!done) throw httpError(409, 'referral_not_completed', '好友尚未完成推薦條件');
  }
  if (trigger === 'chest_reward') {
    if (!member.friends || Number(member.friends) < 3 || Number(member.chest_opened)) {
      throw httpError(409, 'chest_not_ready', '尚未達成寶箱條件');
    }
  }

  const granted = REWARDS[trigger];
  const ledgerId = newId('R');
  const { tickets, keys } = grantedDelta(granted);
  await sql`
    INSERT INTO ledgers (id, member_id, trigger, granted, idempotency_key, created_at)
    VALUES (${ledgerId}, ${memberId}, ${trigger}, ${JSON.stringify(granted)},
            ${idempotencyKey}, ${new Date().toISOString()})`;
  await sql`
    UPDATE members SET
      tickets = tickets + ${tickets},
      keys = keys + ${keys},
      chest_opened = CASE WHEN ${trigger === 'chest_reward'} THEN 1 ELSE chest_opened END,
      updated_at = ${new Date().toISOString()}
    WHERE member_id = ${memberId}`;
  return { granted, ledger_id: ledgerId };
}

/* ───────────── CRM 同步 ───────────── */

async function handleCrmSync(req) {
  const payload = await verifyJwt(bearerToken(req));
  if (!payload?.member_id) throw httpError(401, 'unauthorized', '請先登入');
  const b = await readBody(req);
  const memberId = b.member_id || payload.member_id;
  if (memberId !== payload.member_id) throw httpError(403, 'forbidden', 'member_id 不符');
  const now = new Date().toISOString();
  const existing = await getMember(memberId);
  const refFromFinal = existing?.ref_from || b.ref_from || null;
  const referralIdFinal = existing?.referral_id || b.referral_id || randomReferralId();

  await sql`
    INSERT INTO members (
      member_id, line_uid, email, referral_id, ref_from, role_id, fit_result,
      fit_scores, collection, squad, streak, last_checkin, tickets, keys,
      friends, boss_hp, tags, updated_at)
    VALUES (
      ${memberId}, ${b.line_uid || null}, ${b.email || null}, ${referralIdFinal},
      ${refFromFinal}, ${b.role_id || null}, ${b.fit_result || null},
      ${JSON.stringify(b.fit_scores || {})}, ${JSON.stringify(b.collection || [])},
      ${JSON.stringify(b.squad || {})}, ${b.streak ?? 0}, ${b.last_checkin || null},
      ${b.tickets ?? 0}, ${b.keys ?? 0}, ${b.friends ?? 0}, ${b.boss_hp ?? 100},
      ${JSON.stringify(b.tags || [])}, ${now})
    ON CONFLICT (member_id) DO UPDATE SET
      line_uid = COALESCE(excluded.line_uid, members.line_uid),
      email = COALESCE(excluded.email, members.email),
      referral_id = COALESCE(excluded.referral_id, members.referral_id),
      ref_from = COALESCE(excluded.ref_from, members.ref_from),
      role_id = COALESCE(excluded.role_id, members.role_id),
      fit_result = COALESCE(excluded.fit_result, members.fit_result),
      fit_scores = COALESCE(excluded.fit_scores, members.fit_scores),
      collection = COALESCE(excluded.collection, members.collection),
      squad = COALESCE(excluded.squad, members.squad),
      streak = COALESCE(excluded.streak, members.streak),
      last_checkin = COALESCE(excluded.last_checkin, members.last_checkin),
      tickets = COALESCE(excluded.tickets, members.tickets),
      keys = COALESCE(excluded.keys, members.keys),
      friends = COALESCE(excluded.friends, members.friends),
      boss_hp = COALESCE(excluded.boss_hp, members.boss_hp),
      tags = COALESCE(excluded.tags, members.tags),
      updated_at = excluded.updated_at`;

  await processReferral(memberId);
  const m = await getMember(memberId);
  return {
    member_id: m.member_id,
    tickets: m.tickets, keys: m.keys, friends: m.friends, streak: m.streak,
    collection: JSON.parse(m.collection || '[]'),
    chest_opened: !!m.chest_opened,
  };
}

/* ───────────── 推薦引擎 ───────────── */

async function processReferral(memberId) {
  const member = await getMember(memberId);
  if (!member || !member.ref_from) return;
  const hasIdentity = !!(member.line_uid || member.email);
  if (!hasIdentity) return;

  const referrer = (await sql`SELECT * FROM members WHERE referral_id = ${member.ref_from}`)[0] || null;
  if (!referrer || referrer.member_id === memberId) return;

  const quizCount = (await sql`
    SELECT COUNT(*) AS c FROM events WHERE member_id = ${memberId} AND event = 'quiz_complete'`)[0];
  const quizDone = Number(quizCount?.c || 0) > 0;

  const nowIso = new Date().toISOString();
  const row = (await sql`
    SELECT * FROM referrals WHERE ref_code = ${member.ref_from} AND friend_id = ${memberId}`)[0] || null;
  if (!row) {
    await sql`
      INSERT INTO referrals (id, ref_code, referrer_id, friend_id, status, created_at, updated_at)
      VALUES (${newId('RF')}, ${member.ref_from}, ${referrer.member_id}, ${memberId},
              'qualified', ${nowIso}, ${nowIso})`;
  }
  if (!quizDone) return;

  const doneRow = (await sql`
    SELECT * FROM referrals WHERE ref_code = ${member.ref_from} AND friend_id = ${memberId} AND status = 'done'`)[0] || null;
  if (doneRow) return;

  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = (await sql`
    SELECT COUNT(*) AS c FROM referrals
    WHERE referrer_id = ${referrer.member_id} AND status = 'done' AND updated_at >= ${dayAgo}`)[0];
  if (Number(recent?.c || 0) >= REFERRAL_24H_LIMIT) {
    await sql`
      UPDATE referrals SET status = 'rejected', updated_at = ${nowIso}
      WHERE ref_code = ${member.ref_from} AND friend_id = ${memberId}`;
    return;
  }

  const key = `ref:${memberId}`;
  const already = (await sql`SELECT * FROM ledgers WHERE idempotency_key = ${key}`)[0] || null;
  if (!already) {
    const granted = REWARDS.mission_friend;
    await sql`
      INSERT INTO ledgers (id, member_id, trigger, granted, idempotency_key, created_at)
      VALUES (${newId('R')}, ${referrer.member_id}, 'mission_friend',
              ${JSON.stringify(granted)}, ${key}, ${nowIso})`;
    await sql`
      UPDATE members SET tickets = tickets + 2, friends = friends + 1, updated_at = ${nowIso}
      WHERE member_id = ${referrer.member_id}`;
  }
  await sql`
    UPDATE referrals SET status = 'done', updated_at = ${nowIso}
    WHERE ref_code = ${member.ref_from} AND friend_id = ${memberId}`;
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
