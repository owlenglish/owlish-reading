import {
  authed, readBinary, writeBinary, P, json, readBody, validEdition, validCard,
} from './_lib.js';

const MAX_BYTES = 3 * 1024 * 1024; // ~3 MB, roughly 3 minutes of speech

export default async function handler(req, res) {
  const key = authed(req);
  if (!key) return json(res, 401, { error: 'Please sign in again.' });

  const q = req.query || {};
  const edition = String(q.edition || '');
  const card = String(q.card || '');
  if (!validEdition(edition)) return json(res, 400, { error: 'Unknown drill.' });
  if (!validCard(card)) return json(res, 400, { error: 'Unknown card.' });

  try {
    if (req.method === 'GET') {
      const buf = await readBinary(P.aud(key, edition, card));
      if (!buf) return json(res, 404, { error: 'No recording saved for this card.' });
      return json(res, 200, { audio: buf.toString('base64') });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readBody(req);
      const b64 = String(body.audio || '');
      if (!b64) return json(res, 400, { error: 'No audio received.' });

      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return json(res, 400, { error: 'That recording came through empty.' });
      if (buf.length > MAX_BYTES) {
        return json(res, 413, { error: 'That recording is too long to save. Keep answers under about 2 minutes.' });
      }

      const mime = /^audio\/[a-z0-9.+-]{1,40}$/i.test(String(body.mime || ''))
        ? String(body.mime) : 'audio/webm';

      await writeBinary(P.aud(key, edition, card), buf, mime);
      return json(res, 200, { ok: true, bytes: buf.length });
    }

    return json(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return json(res, 500, { error: 'Could not save that recording.', detail: String(err && err.message || err) });
  }
}
