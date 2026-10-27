import {
  authed, readJSON, writeJSON, P, json, readBody, blankProgress,
  validEdition, touchRoster,
} from './_lib.js';

const MAX_NOTE = 4000;

/* Keep only the shape we expect, so a bad client can't bloat the store. */
function clean(edition) {
  const out = { idx: 0, answers: {}, results: {}, revealed: {}, recs: {}, updated: Date.now() };
  if (!edition || typeof edition !== 'object') return out;
  out.idx = Number.isFinite(edition.idx) ? Math.max(0, Math.min(999, Math.floor(edition.idx))) : 0;
  out.section = typeof edition.section === 'string' ? edition.section.slice(0, 8) : 'ALL';
  for (const [k, v] of Object.entries(edition.answers || {}).slice(0, 400)) {
    if (typeof v === 'string' && v.trim()) out.answers[String(k).slice(0, 8)] = v.slice(0, MAX_NOTE);
  }
  for (const [k, v] of Object.entries(edition.results || {}).slice(0, 400)) {
    if (['check', 'slow', 'miss'].includes(v)) out.results[String(k).slice(0, 8)] = v;
  }
  for (const [k, v] of Object.entries(edition.revealed || {}).slice(0, 400)) {
    if (v === true) out.revealed[String(k).slice(0, 8)] = true;
  }
  for (const [k, v] of Object.entries(edition.recs || {}).slice(0, 400)) {
    if (v && typeof v === 'object') {
      out.recs[String(k).slice(0, 8)] = {
        ms: Number.isFinite(v.ms) ? Math.max(0, Math.floor(v.ms)) : 0,
        mime: typeof v.mime === 'string' ? v.mime.slice(0, 60) : 'audio/webm',
      };
    }
  }
  return out;
}

export default async function handler(req, res) {
  const key = authed(req);
  if (!key) return json(res, 401, { error: 'Please sign in again.' });

  try {
    if (req.method === 'GET') {
      const progress = (await readJSON(P.prg(key))) || blankProgress();
      return json(res, 200, { progress });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      const edition = String(body.edition || '');
      if (!validEdition(edition)) return json(res, 400, { error: 'Unknown drill.' });

      const progress = (await readJSON(P.prg(key))) || blankProgress();
      const next = clean(body.state);
      progress.editions = progress.editions || {};
      progress.editions[edition] = next;
      await writeJSON(P.prg(key), progress);

      const marked = Object.keys(next.results).length;
      await touchRoster(key, body.email, edition, {
        marked, written: Object.keys(next.answers).length,
        recorded: Object.keys(next.recs).length, idx: next.idx, last: next.updated,
      });

      return json(res, 200, { ok: true, saved: next.updated });
    }

    return json(res, 405, { error: 'Use GET or PUT.' });
  } catch (err) {
    return json(res, 500, { error: 'Save failed.', detail: String(err && err.message || err) });
  }
}
