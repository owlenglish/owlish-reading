import crypto from 'node:crypto';
import { put, get } from '@vercel/blob';

/* ---------- config ---------- */
export const EDITIONS = ['finance', 'marketing', 'engineering'];
const SECRET = process.env.OWLISH_SECRET || 'owlish-dev-secret-change-me';
const ITER = 120000;
const SESSION_DAYS = 60;
const MAX_FAILS = 8;
const LOCK_MIN = 15;

/* ---------- small helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 160;
export const validCode = (c) => /^\d{4}$/.test(String(c || ''));
export const validEdition = (e) => EDITIONS.includes(String(e || ''));
export const validCard = (c) => /^[A-Z]{1,3}\d{1,3}$/.test(String(c || ''));

export function emailHash(email) {
  return sha(`${SECRET}:email:${normEmail(email)}`).slice(0, 32);
}

/* Slow derivation so a stolen key can't be reversed to the 4-digit code,
   and so guessing codes online is expensive. */
export function deriveKey(email, code) {
  const salt = `${SECRET}:kdf:${emailHash(email)}`;
  return crypto.pbkdf2Sync(`${normEmail(email)}:${code}`, salt, ITER, 32, 'sha256')
    .toString('hex').slice(0, 32);
}

export const verifierFor = (key) => sha(`${SECRET}:verify:${key}`);

/* ---------- session tokens ---------- */
export function makeToken(key) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = `${key}.${exp}`;
  const sig = b64u(crypto.createHmac('sha256', SECRET).update(body).digest()).slice(0, 43);
  return `${body}.${sig}`;
}

export function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [key, exp, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(key) || !/^\d{13}$/.test(exp)) return null;
  const want = b64u(crypto.createHmac('sha256', SECRET).update(`${key}.${exp}`).digest()).slice(0, 43);
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return key;
}

export function authed(req) {
  const h = req.headers.authorization || '';
  return readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
}

/* ---------- blob storage (all private) ---------- */
const OPTS = { access: 'private', allowOverwrite: true, addRandomSuffix: false };

export async function readJSON(pathname) {
  try {
    const res = await get(pathname, { access: 'private', useCache: false });
    if (!res) return null;
    const text = typeof res.text === 'function'
      ? await res.text()
      : await new Response(res.stream ?? res.body ?? res).text();
    return JSON.parse(text);
  } catch (err) {
    if (err && (err.name === 'BlobNotFoundError' || /not ?found/i.test(err.message || ''))) return null;
    throw err;
  }
}

export async function writeJSON(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    ...OPTS, contentType: 'application/json', cacheControlMaxAge: 0,
  });
}

export async function readBinary(pathname) {
  try {
    const res = await get(pathname, { access: 'private', useCache: false });
    if (!res) return null;
    const ab = typeof res.arrayBuffer === 'function'
      ? await res.arrayBuffer()
      : await new Response(res.stream ?? res.body ?? res).arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (err && (err.name === 'BlobNotFoundError' || /not ?found/i.test(err.message || ''))) return null;
    throw err;
  }
}

export async function writeBinary(pathname, buf, contentType) {
  await put(pathname, buf, { ...OPTS, contentType, cacheControlMaxAge: 0 });
}

/* ---------- paths ---------- */
export const P = {
  reg: (eh) => `reg/${eh}.json`,
  att: (eh) => `att/${eh}.json`,
  prg: (key) => `prg/${key}.json`,
  aud: (key, edition, card) => `aud/${key}/${edition}/${card}.bin`,
  roster: () => `roster/index.json`,
};

/* ---------- lockout ---------- */
export async function lockState(eh) {
  const a = await readJSON(P.att(eh));
  if (a && a.until && a.until > Date.now()) {
    return { locked: true, minutes: Math.ceil((a.until - Date.now()) / 60000), rec: a };
  }
  return { locked: false, rec: a || { fails: 0, until: 0 } };
}

export async function noteFail(eh, rec) {
  const fails = (rec.fails || 0) + 1;
  const until = fails >= MAX_FAILS ? Date.now() + LOCK_MIN * 60000 : 0;
  await writeJSON(P.att(eh), { fails: until ? 0 : fails, until });
  return { fails, locked: !!until, minutes: LOCK_MIN };
}

export async function clearFails(eh, rec) {
  if (rec && (rec.fails || rec.until)) await writeJSON(P.att(eh), { fails: 0, until: 0 });
}

/* ---------- roster (private; lets the tutor see who is using it) ---------- */
export async function touchRoster(key, email, edition, stats) {
  try {
    const r = (await readJSON(P.roster())) || { students: {} };
    const cur = r.students[key] || { email, first: Date.now() };
    cur.email = email || cur.email;
    cur.last = Date.now();
    cur.editions = cur.editions || {};
    if (edition) cur.editions[edition] = stats || {};
    r.students[key] = cur;
    await writeJSON(P.roster(), r);
  } catch { /* roster is a convenience, never block a save */ }
}

/* ---------- response helpers ---------- */
export function json(res, status, data) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export const blankProgress = () => ({ v: 1, editions: {} });
