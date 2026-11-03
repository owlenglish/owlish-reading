"""Make recorded MP3 audio for every reading that asks for it.

A reading opts in by defining window.owlishAudioScript() — it returns
{ "<version-key>": [ {"text": "...", "pauseAfter": ms}, ... ], ... }
with exactly the sentences the page would speak. For each version this writes
  audio/<reading>/<version-key>.mp3
  audio/<reading>/manifest.json   (sentence start times + the text it was made from)
Versions whose text hasn't changed are skipped, so re-runs are cheap.

Run by .github/workflows/audio.yml on every push. Needs: edge-tts, playwright, ffmpeg.
"""
import asyncio, hashlib, re, json, pathlib, shutil, subprocess, sys, tempfile

import edge_tts
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
VOICE = "en-US-AvaNeural"          # natural US English voice
FALLBACK_VOICES = ["en-US-AriaNeural", "en-US-JennyNeural"]
GAP_MS = 180                       # small breath between sentences
RATE = 24000


def run(*cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], check=True,
                         capture_output=True, text=True).stdout.strip()
    return float(out)


async def synth(text, out_mp3):
    """Synthesize one sentence. Returns (voice, word start times in seconds)."""
    last = None
    for voice in [VOICE] + FALLBACK_VOICES:
        for attempt in range(3):
            try:
                words, audio = [], bytearray()
                async for ev in edge_tts.Communicate(text, voice, boundary="WordBoundary").stream():
                    if ev["type"] == "audio":
                        audio += ev["data"]
                    elif ev["type"] == "WordBoundary":
                        words.append((ev.get("text", ""), round(ev["offset"] / 1e7, 3)))   # 100-ns ticks -> seconds
                out_mp3.write_bytes(bytes(audio))
                if out_mp3.stat().st_size > 500:
                    return voice, words
            except Exception as e:          # network hiccup or voice unavailable
                last = e
            await asyncio.sleep(2 * (attempt + 1))
    raise RuntimeError(f"could not synthesize: {text[:60]!r} ({last})")


TIMING_VERSION = 2   # bump to re-record word timings for every page


def align_words(text, boundaries, total):
    """One start time per whitespace word of `text` (what the page counts).

    The voice reports a timed boundary per spoken word, but skips some (e.g. years
    written in digits) and may split others. Match boundaries to words by their
    letters; words with no match get a time between their neighbours.
    """
    norm = lambda w: re.sub(r"[^a-z0-9]", "", w.lower())
    tokens = text.split()
    times = [None] * len(tokens)
    j = 0
    for i, tok in enumerate(tokens):
        n = norm(tok)
        for k in range(j, min(len(boundaries), j + 6)):
            bt = norm(boundaries[k][0])
            if bt and n and (bt == n or n.startswith(bt) or bt.startswith(n)):
                times[i] = boundaries[k][1]; j = k + 1; break
    # fill gaps by interpolating between known neighbours
    known = [(i, t) for i, t in enumerate(times) if t is not None]
    if not known:
        return [round(total * i / max(1, len(tokens)), 3) for i in range(len(tokens))]
    for i in range(len(tokens)):
        if times[i] is None:
            prev = max((k for k in known if k[0] < i), default=(-1, 0.0), key=lambda k: k[0])
            nxt = min((k for k in known if k[0] > i), default=(len(tokens), total), key=lambda k: k[0])
            frac = (i - prev[0]) / (nxt[0] - prev[0])
            times[i] = round(prev[1] + (nxt[1] - prev[1]) * frac, 3)
    # keep times in order
    for i in range(1, len(times)):
        times[i] = max(times[i], times[i - 1])
    return times


def build_version(chunks, out_mp3, tmp):
    """Synthesize each sentence, join with silences, return sentence start times."""
    pieces, starts, words, t, used = [], [], [], 0.0, set()
    for i, c in enumerate(chunks):
        mp3 = tmp / f"s{i:03}.mp3"
        voice, wtimes = asyncio.run(synth(c["text"], mp3))
        used.add(voice)
        wav = tmp / f"s{i:03}.wav"
        run("ffmpeg", "-y", "-i", str(mp3), "-ac", "1", "-ar", str(RATE), str(wav))
        starts.append(round(t, 3))
        pieces.append(wav)
        d = duration(wav)
        words.append(align_words(c["text"], wtimes, d))
        t += d
        gap = (c.get("pauseAfter") or 0) + GAP_MS
        sil = tmp / f"g{i:03}.wav"
        run("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={RATE}:cl=mono",
            "-t", f"{gap/1000:.3f}", str(sil))
        pieces.append(sil)
        t += gap / 1000
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in pieces))
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
        "-ac", "1", "-ar", str(RATE), "-b:a", "48k", str(out_mp3))
    return starts, round(duration(out_mp3), 3), sorted(used), words


def collect_scripts():
    """Phase 1: open each reading in a headless browser and ask what it would say."""
    found = {}
    pages = sorted(p for p in list(ROOT.glob("*.html")) + list(ROOT.glob("pack/*.html"))
                   if p.name.lower() != "index.html")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for page_file in pages:
            pg = browser.new_page()
            # offline: only the local file itself, no CDNs/analytics
            pg.route("**/*", lambda r: r.continue_() if r.request.url.startswith("file:") else r.abort())
            pg.goto(page_file.as_uri())
            if pg.evaluate("typeof window.owlishAudioScript === 'function'"):
                found[page_file] = pg.evaluate("window.owlishAudioScript()")
            pg.close()
        browser.close()
    return found


def main():
    changed_any = False
    # Phase 2 (browser closed): make the audio
    for page_file, script in collect_scripts().items():
        changed = False
        base = page_file.stem
        out_dir = page_file.parent / "audio" / base     # next to the page: <dir>/audio/<page>/
        out_dir.mkdir(parents=True, exist_ok=True)
        man_path = out_dir / "manifest.json"
        manifest = json.loads(man_path.read_text()) if man_path.exists() else {"versions": {}}
        manifest.setdefault("versions", {})

        for key, chunks in script.items():
            text = "\n".join(c["text"] for c in chunks)
            old = manifest["versions"].get(key)
            mp3 = out_dir / f"{key}.mp3"
            if old and old.get("text") == text and old.get("tv") == TIMING_VERSION and mp3.exists():
                print(f"  {base}/{key}: unchanged")
                continue
            print(f"  {base}/{key}: making audio for {len(chunks)} sentences...", flush=True)
            with tempfile.TemporaryDirectory() as td:
                starts, dur, voices, words = build_version(chunks, mp3, pathlib.Path(td))
            manifest["versions"][key] = {"file": mp3.name, "starts": starts, "words": words, "tv": TIMING_VERSION,
                                         "duration": dur, "voice": ",".join(voices), "text": text}
            changed = True
        # drop versions the page no longer has
        for gone in set(manifest["versions"]) - set(script):
            (out_dir / manifest["versions"][gone]["file"]).unlink(missing_ok=True)
            del manifest["versions"][gone]
            changed = True
        if changed:
            blob = json.dumps(manifest["versions"], sort_keys=True).encode()
            manifest["build"] = hashlib.sha1(blob).hexdigest()[:10]
            man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
            changed_any = True
    print("audio changed" if changed_any else "nothing to do")


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required")
    main()
