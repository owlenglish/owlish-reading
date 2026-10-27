import { readJSON, writeJSON, json } from './_lib.js';

/* Confirms the deployment can read and write its own storage. */
export default async function handler(req, res) {
  const out = { ok: true, time: new Date().toISOString(), secret: !!process.env.OWLISH_SECRET, blob: 'unknown' };
  try {
    const path = 'health/check.json';
    const stamp = Date.now();
    await writeJSON(path, { stamp });
    const back = await readJSON(path);
    out.blob = back && back.stamp === stamp ? 'read-write ok' : 'stale read';
    if (out.blob !== 'read-write ok') out.ok = false;
  } catch (err) {
    out.ok = false;
    out.blob = 'error';
    out.detail = String(err && err.message || err);
  }
  return json(res, out.ok ? 200 : 500, out);
}
