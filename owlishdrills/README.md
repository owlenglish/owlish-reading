# Owlish Drills

Workplace English speaking drills for Owlish English, with saved progress so a student
can stop part-way through and pick up later on any device.

Live: deployed on Vercel (project `owlish-drills`).

## What's here

| Path | What it is |
|---|---|
| `index.html` | Landing page listing the drill editions |
| `finance.html` | Finance & FP&A drill — 30 chunks across 6 meeting sections |
| `api/signin.js` | Email + 4-digit code sign-in |
| `api/progress.js` | Saves and loads place, notes and marks |
| `api/audio.js` | Saves and serves voice recordings |
| `api/health.js` | Checks the deployment can read and write storage |
| `api/_lib.js` | Shared auth and storage helpers |

## How sign-in works

There are no passwords. A student types their email and a 4-digit code of their own
choosing. The first sign-in for an email registers that code.

- The storage key is derived from email + code with PBKDF2 (120,000 iterations), so the
  code is never stored anywhere.
- A separate record holds only a hash of that key, which is what lets the server tell
  "wrong code" apart from "new student".
- After 8 wrong codes an email is locked for 15 minutes.
- Sessions last 60 days and are kept in the browser's local storage.

A 4-digit code is deliberately light security: it keeps a classmate out, not a determined
attacker. Don't put anything confidential in the notes.

## Storage

Everything lives in one Vercel Blob store, all blobs private:

```
reg/<emailHash>.json     verifier + email (tells wrong code from new student)
att/<emailHash>.json     failed attempt counter / lockout
prg/<key>.json           place, notes, marks, recording index — per student
aud/<key>/<edition>/<card>.bin   one voice recording per card
roster/index.json        who is using it, for a future tutor view
```

Reads use `get(..., { useCache: false })` so a save is visible immediately on another
device, rather than waiting on CDN caching.

Recordings are capped at 2 minutes and about 3 MB, and re-recording overwrites the old
one, so storage stays bounded.

## Environment variables

| Name | Set by |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Added automatically when the Blob store was linked |
| `OWLISH_SECRET` | Set manually — **changing it locks every student out**, because their keys are derived from it |

## Adding another edition

1. Copy `finance.html`, change `EDITION` near the bottom of the script and the cards.
2. Add the name to `EDITIONS` in `api/_lib.js`.
3. Link it from `index.html`.

Progress is stored per edition, so a student's finance work and marketing work are kept
separately under the same sign-in.

## Running locally

Static files plus `api/` functions, no build step. `vercel dev` from the project root,
with `OWLISH_SECRET` and `BLOB_READ_WRITE_TOKEN` in `.env.local`.
