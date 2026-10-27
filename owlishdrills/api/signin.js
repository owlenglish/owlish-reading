import {
  normEmail, validEmail, validCode, emailHash, deriveKey, verifierFor,
  makeToken, readJSON, writeJSON, P, lockState, noteFail, clearFails,
  json, readBody, blankProgress,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  const body = await readBody(req);
  const email = normEmail(body.email);
  const code = String(body.code || '');

  if (!validEmail(email)) return json(res, 400, { error: 'That email address does not look right.' });
  if (!validCode(code)) return json(res, 400, { error: 'Your code must be exactly 4 digits.' });

  const eh = emailHash(email);

  try {
    const lock = await lockState(eh);
    if (lock.locked) {
      return json(res, 429, { error: `Too many wrong codes. Try again in ${lock.minutes} minutes.` });
    }

    const key = deriveKey(email, code);
    const reg = await readJSON(P.reg(eh));

    if (!reg) {
      // First sign-in for this email: this code becomes their code.
      await writeJSON(P.reg(eh), { v: verifierFor(key), created: Date.now(), email });
      const progress = blankProgress();
      await writeJSON(P.prg(key), progress);
      await clearFails(eh, lock.rec);
      return json(res, 200, { token: makeToken(key), progress, isNew: true, email });
    }

    if (reg.v !== verifierFor(key)) {
      const f = await noteFail(eh, lock.rec);
      return json(res, 401, {
        error: f.locked
          ? `Too many wrong codes. Try again in ${f.minutes} minutes.`
          : 'That code does not match this email address.',
      });
    }

    await clearFails(eh, lock.rec);
    const progress = (await readJSON(P.prg(key))) || blankProgress();
    return json(res, 200, { token: makeToken(key), progress, isNew: false, email });
  } catch (err) {
    return json(res, 500, { error: 'Could not reach the save server.', detail: String(err && err.message || err) });
  }
}
