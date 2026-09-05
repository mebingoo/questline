# Questline

A personal RPG-style life tracker. Grand goals are "quest lines"; daily/weekly
quests earn XP and gold; there are skill trees, a course video player, a
timetable, and an AI quiz builder for downloaded YouTube tutorials.

Single user (Phuc). Not a product — optimise for his workflow, not generality.

**Read `ROADMAP.md` before proposing work.** It holds the current phase, what
is deliberately deferred, and what is explicitly not being built. Phase 0 comes
before any new feature.

## Layout

| Path | What it is |
|---|---|
| `index.html` | **The entire app** — UI, CSS and logic in one file, ~10,500 lines. Vanilla JS, no framework, no build step. |
| `main.js` | Electron main process: windows, WebUntis/YouTube/AI proxies, course-media protocol, auto-update. |
| `preload.js` | The only bridge between page and Node. Everything exposed is explicit. |
| `server/src/worker.js` | Cloudflare Worker: serves the phone PWA, holds synced state in KV, proxies WebUntis/YouTube/AI. |
| `server/public/` | **Generated and gitignored.** Copy of `index.html` + roadmap seeds, written by `npm run predeploy` at deploy time. Never edit by hand, never commit it — 24 committed copies of a 520 KB file were half the repo. |
| `data/roadmaps/*.json` | Roadmap seeds. `*-tree.json` are skill trees (schemaVersion 2, a node graph); the others are linear milestone lists (v1). |
| `test/harness.js` | The test suite (`npm test`). Boots the real app on a temp `userData` and drives the DOM. |
| `dist/` | Build output, gitignored. |
| `ROADMAP.md` | Phased plan + priorities. Check the current phase before starting anything. |

## Commands

```bash
npm start                  # run the desktop app
npm test                   # boot it under Electron and drive the real DOM
npm run dist               # build the Windows installer into dist/
cd server && npm run deploy  # push worker + PWA (predeploy syncs public/ first)
```

Releases go to GitHub Releases; the installed app auto-updates from there.
To ship: bump `version` in `package.json`, `npm run dist`, then
`gh release create vX.Y.Z <installer> <blockmap> dist/latest.yml`.
The repo must stay **public** — a private one breaks differential updates.

**The uploaded asset name must match `latest.yml` exactly.** GitHub rewrites
spaces in a filename to dots, so uploading `Questline Setup 1.9.0.exe` stores
it as `Questline.Setup.1.9.0.exe` while `latest.yml` still points at
`Questline-Setup-1.9.0.exe` — every client then 404s and silently stays on the
old version. `build.artifactName` pins the hyphenated name so the built file is
already correct; don't remove it, and don't rename artifacts by hand. This
shipped broken twice (v1.8.1, v1.9.0) before it was noticed. After releasing,
check it actually resolves:

```bash
curl -sL https://github.com/mebingoo/questline/releases/latest/download/latest.yml
```

## Conventions

- All app JS lives in one IIFE in `index.html`. Nothing is global on purpose.
- Every colour comes from a CSS variable. Never hardcode one — a bright
  background flips the whole palette to a light theme, and hardcoded colours
  don't flip with it.
- All user text goes through `esc()` before hitting `innerHTML`. No exceptions.
- Modals render into `#modalBody`; settings tabs render into a host element
  passed as an argument. Full-screen overlays (settings, skill tree) are their
  own `*-veil` elements.
- `npm test` runs `test/harness.js`: it `require`s `main.js` for the real IPC,
  then drives the window returned by `BrowserWindow.getAllWindows()[0]`. Add to
  it rather than writing a second one. Two rules it exists to encode:
  - **`app.setPath('userData', <temp>)` before requiring `main.js`.** Otherwise
    the test writes into the real library, and stale state from the last run
    makes the next one lie.
  - **Drive the DOM, not the closure.** Everything is inside one IIFE, so
    `state` and every function are unreachable; click real elements and read
    results back from `localStorage.getItem('questline_state_v2')`.
- The harness stubs `dialog.showSaveDialog`/`showOpenDialog` before requiring
  `main.js`, which is what makes the backup round trip testable end to end.
  `main.js` destructures `dialog` from `electron` but the object is shared, so
  patching methods on it works.
- Small test fixtures hide real bugs (a 3-second video seeks from memory and
  never exposes broken range requests; use something ~100 MB).

## School: grades, Klausuren, Abitur

`state.grades` holds subjects, Klausur points per Halbjahr, and which
Prüfungsfach each subject is. The projection is the KMK block scheme, and the
weights are all in `ABI_RULES` so another Bundesland is a settings change:

- **Block I** every Halbjahresergebnis, eA counted twice. `E1 = (P/S) × 40`.
  It being a ratio is the whole point — a projection from two Halbjahre is as
  honest as one from eight, instead of treating the empty ones as zeros.
- **Block II** the five Abiturprüfungen, × 4.
- `N = 17/3 − E/180`, clamped to 1.0–4.0.

The marginal table re-runs the entire projection with one subject a point
higher, rather than applying "eA counts double" as a rule of thumb — that way
it prices in how many Halbjahre are still open and whether the subject is a
Prüfungsfach.

**Never award XP for grades.** It is in ROADMAP.md's "explicitly not doing" and
there is a harness assertion enforcing it: turning a bad grade into a punishment
from the app is how you stop opening it in the week you need it. Revision
*quests* do earn XP — the rule is about results, not about work.

Klausuren are timeline events with `kind:'exam'` and a `subjectId`, so they
share the bar at the top of every tab rather than needing a calendar. "Plan
revision" writes dailies backwards at expanding intervals, pinned to dates with
`plannedForDate`.

## Cards: kinds, maths, occlusion

A note has a `kind` — `vocab`, `formula`, `definition`, `occlusion` — and the
kind decides which fields the editor shows and which `CARD_TYPES` apply. The
FSRS scheduler knows nothing about any of it and never needs to.

**Maths is MathML, not KaTeX.** The CSP allows scripts from self and YouTube
only; a CDN would break formula cards offline, and vendoring KaTeX is ~300 KB
of JS plus a megabyte of fonts. Chromium has done MathML Core since 109, so
`mathML(latex, display)` converts the LaTeX subset an Abitur student writes and
hands the layout to the browser. `mathText(str)` renders `$...$` and `$$...$$`
inside prose and escapes everything else. An unknown command becomes its own
literal text rather than throwing — one odd macro should cost that macro, not
the rest of the formula.

**Occlusion** is one card per rectangle, not one per type — `makeCards()` takes
the masks for that reason, and cards carry a `maskId`. Rectangles are stored
normalised 0..1 so the editor, the card and the phone agree. The image lives in
`shotDb` with the note screenshots; only the four numbers per rectangle sync.

Each kind renders a different subset of the editor's fields, so **every field
read in `save()` goes through the optional `val()` helper**. Reaching for
`getElementById('wTr').value` directly crashed the whole save for occlusion
notes, silently, because that form has no such field.

## AI

`main.js` holds a provider layer — `AI_PROVIDERS` with `complete` / `models` /
`health`. **Ollama is the default and runs locally**, so a fresh install needs
no account and sends nothing off the machine; Anthropic and OpenAI are there for
anyone who wants them. Adding a provider means adding one object; nothing that
calls it needs to change.

**Anything that must come back as JSON passes a `format` schema.** Ollama
compiles it to a decoding grammar, so the model physically cannot emit
anything else; OpenAI gets `response_format: json_object` and Anthropic gets a
`{` prefill. Asking for JSON in the prompt alone is not equivalent — llama3.2
and qwen2.5:7b both answered with prose or a markdown fence essentially every
time, which was the whole of "the model did not return usable JSON".
Put the counts in the schema too (`minItems`/`maxItems`): they are enforced by
the grammar, whereas "exactly 8 questions" in prose gets one or two back.
See `quizSchema()` and `CARD_FILL_SCHEMA`.

Prompts live in the renderer, not in `main.js`, so every AI feature works
through whichever provider is selected. Provider choice, Ollama URL and model
are device-local (`questline_aicfg_v1`) — an address that means something on
this PC means nothing on the phone, which can only reach cloud providers.

**How much transcript fits is asked of the model, not hardcoded.**
`/api/show` reports the window under an architecture-prefixed key
(`llama.context_length`, `qwen3.context_length`), found by suffix. Then —
this is the half that actually matters — **every request carries `num_ctx`**.
Ollama otherwise caps the window at its own small default however capable the
model is, and drops what does not fit from the *front*, which is where the
transcript is. A 128K model without `num_ctx` is a spec sheet.

Over budget, the transcript is chunked and the results merged: each pass is
told which part of the video it has, and questions are merged in timestamp
order. A chunked pass reserves room for three questions rather than the whole
quiz, which is what keeps the chunk count sane. Past the pass ceiling the
passes spread evenly across the video — taking the first N would just move the
old "deleted the middle" bug to the end. Chat cannot merge answers, so it keeps
the opening plus the sections whose words overlap the question.

## Learn videos — downloaded, not embedded

Embedding failed too often: uploaders disable it, and since mid-2026 YouTube
refuses caption requests from anything that isn't a real browser session
(`timedtext` answers 200 with an empty body, `get_transcript` answers
`FAILED_PRECONDITION`, and the watch page's SPA never hydrates in an automated
window). All three were verified dead before this was rebuilt — don't try to
revive them.

So a Learn video is **downloaded** with `yt-dlp` and owned locally:

- `main.js` shells out to `yt-dlp` and `ffmpeg`, both looked up on PATH and
  reported as missing rather than assumed (`whichTool` — Node does no PATHEXT
  resolution on Windows, so `spawn('yt-dlp')` alone would ENOENT).
- One folder per video under the library folder: `video.mp4`, `video.jpg`,
  `video.<lang>.json3`, `video.info.json`.
- Format choice is `-f "bv*+ba/b" -S "res,fps,vcodec:h264,acodec:m4a"`:
  resolution wins first, so 4K VP9 beats 1080p h264, but h264/AAC breaks ties
  and stays hardware-decodable.
- **Subtitles are the transcript.** They arrive with the download in `json3`,
  which parses to the same `{t, text}` cues the old scraper produced, so
  summary/quiz/chat needed no changes.
- **Subtitles are fetched in a second yt-dlp run, never with the video.**
  yt-dlp pulls captions *before* the media and treats a failed caption fetch as
  fatal, so one HTTP 429 on the second language throws the whole video download
  away. Pass 1 gets the video; pass 2 asks one language at a time and stops at
  the first hit, so a rate limit costs at most the transcript. `dl-fetch-subs`
  retries just the captions afterwards.
- Ask for few subtitle languages. `--sub-langs "en.*"` pulls dozens of machine
  translations at once and YouTube answers **HTTP 429**.
- yt-dlp goes stale fast. A version a few months old fails with 403 on the
  media stream while still listing formats — if downloads break, update it
  first (`python -m pip install --upgrade yt-dlp`).

Playback reuses the course path exactly: `qlmedia://` with real byte ranges.
Videos added before this rebuild have no local file and still use the old
embed, so nothing that already worked broke.

Notes are one system, not two. `noteCtx()` resolves which video is being
annotated (Courses item vs Learn video) and every note function works off it.
Theater mode pins the stage with a CSS class and never re-parents the
`<video>` — moving one drops its buffer and orphans every listener.

## Statistics

`state.history` is a small row per day (`xp`, `gold`, `dailies`, `weeklies`,
`done`, per-goal xp), written by `logDay()` and kept forever — the same shape
`srs.daily` already used. Quests previously stored only `lastDone`, so there
was no way to ask what a month looked like; that history therefore starts at
v1.12 and cannot be backfilled.

**Only what is not already dated goes in `history`.** Flashcards
(`srs.daily`), focus sessions and journal entries carry their own dates, so
`statsByDay()` reads those at source. Keeping a second copy would drift.
Because of that, the grid shows real history for those three from day one.

`grant()` is the single hook for everything paying XP outside the quest
lists. Dailies and weeklies do their XP inline, so they call `logDay()`
themselves — including in their undo paths, or an undone quest still counts.

Beware `dayKeyOf` — it already exists and returns a *weekday* from a date
string. The stats helper is `tsDayKey`, and day offsets reuse `dateStrPlus`.
A second `function dayKeyOf` silently replaced the first (declarations hoist,
last one wins) and broke the whole tab; that is the third time this file has
been bitten by a duplicate top-level name.

## Reference board

A PureRef-style board (`Refs` tab) plus an always-on-top window meant to sit
over Blender. Both are the *same* board: `makeRefSurface()` builds one
controller and is called once per surface, so the canvas is written once.

- The floating window is `index.html?refs=1`, the same trick the pinned widget
  uses. Both windows share one localStorage **and one IndexedDB**, which is
  what makes a move in one appear in the other.
- The canvas is one CSS transform on `.ref-world`; items are positioned in
  board coordinates and never do zoom maths themselves. Handles are drawn at
  `1/zoom` so they stay a constant size on screen.
- Images go to IndexedDB (`questline-refs`), only geometry goes in `state` —
  a board of 40 references would blow past KV's limit many times over.
  Anything over 3000px or 5 MB is re-encoded to WebP once, on import.
- Items carry `kind`: `'img'` or `'text'`. Notes are small enough to live in
  `state`, so unlike the images they *do* sync between devices.
- An open note blocks the rebuild (it would tear out the box being typed in),
  so that guard self-heals: if the `.editing` element is gone, the id is
  cleared rather than freezing the board forever. Ending an edit calls
  `commitEdit()` directly from every path — blur alone is not dependable, a
  window can lose focus without dispatching one.
- `addFiles` re-resolves the board after each `await`. The other window can
  swap `state` out mid-encode, and pushing into the board captured beforehand
  puts the image into an orphan that vanishes at the next reload.
- A drag writes straight to the DOM and only saves on pointerup, then marks
  the new geometry as already-drawn. Skipping that makes the app's own save
  bounce back through `renderAll()` as a full rebuild, mid-drag.

## Where data lives — this matters

`state` is encrypted in the browser and pushed to Cloudflare KV. Three things
are deliberately **not** in it:

- **WebUntis credentials** (`questline_untis_v1`) and the **AI API key**
  (`questline_aikey_v1`) — device-local, so credentials never reach the server.
- **The video library folder** (`questline_vidlib_v1`) — a path that means
  something on this PC means nothing on the phone, same as the Ollama URL.
- **Background media, note screenshots, gate proofs** — IndexedDB, device-local.
  They'd blow past KV's size limit.

Sync is end-to-end encrypted (AES-GCM, key derived from the sync token via
PBKDF2). The server only ever sees ciphertext. If a blob won't decrypt the app
keeps local data and re-uploads rather than wiping anything.

## Backups

The app auto-updates, so it ships new `migrate()` code straight to the only
machine holding the only copy of the data. Settings → Advanced → Export writes
one JSON with `state` plus every IndexedDB store, base64'd; Restore reads it
back and reloads. The harness proves the round trip, because an export nobody
has restored is not a backup.

- The renderer builds the snapshot — `state` and the four blob stores are only
  reachable there. `main.js` just picks the file and writes bytes.
- **Credentials are deliberately not in it** (WebUntis password, AI key, sync
  token), for the same reason they are not in `state`. Restore therefore
  `Object.assign`s over the current config and leaves this device's secrets
  alone.
- Two automatic snapshots, both silent, both into `<video library>/Questline
  Backups/` (or userData when no library folder is set), keeping the newest 5:
  when `update-downloaded` fires — the updater *waits* for it, so the renderer
  must always answer, hence `backup.skip()` on failure — and at boot when the
  running version differs from `questline_lastver_v1`. The boot one backs up
  `bootRawSave`, the save exactly as it sat on disk **before** `migrate()` ran,
  which is the only copy worth having at that moment.
- A restore sets `questline_restored_v1`, and boot force-**pushes** instead of
  pulling. Pulling first would hand the server's newer copy straight back and
  quietly undo the restore.

## Not in the repo

Entered by hand, per machine: the sync token and AI key (in-app Settings),
`wrangler login`, `gh auth login`. The Worker's `SYNC_TOKEN` is a wrangler
secret. `yt-dlp` and `ffmpeg` are expected on PATH
(`winget install yt-dlp.yt-dlp` / `yt-dlp.FFmpeg`) — not bundled, and the app
says so plainly when they are missing.

## If another session may be running

This has already caused one messy fork. Before starting work:

```bash
git fetch origin && git status
```

Always `git pull` before committing, and never `git push --force` — another
session's work has been lost that way once already.
