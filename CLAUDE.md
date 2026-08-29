# Questline

A personal RPG-style life tracker. Grand goals are "quest lines"; daily/weekly
quests earn XP and gold; there are skill trees, a course video player, a
timetable, and an AI quiz builder for downloaded YouTube tutorials.

Single user (Phuc). Not a product — optimise for his workflow, not generality.

## Layout

| Path | What it is |
|---|---|
| `index.html` | **The entire app** — UI, CSS and logic in one file, ~6300 lines. Vanilla JS, no framework, no build step. |
| `main.js` | Electron main process: windows, WebUntis/YouTube/AI proxies, course-media protocol, auto-update. |
| `preload.js` | The only bridge between page and Node. Everything exposed is explicit. |
| `server/src/worker.js` | Cloudflare Worker: serves the phone PWA, holds synced state in KV, proxies WebUntis/YouTube/AI. |
| `server/public/` | **Generated.** Copy of `index.html` + roadmap seeds. Never edit by hand — `npm run predeploy` writes it. |
| `data/roadmaps/*.json` | Roadmap seeds. `*-tree.json` are skill trees (schemaVersion 2, a node graph); the others are linear milestone lists (v1). |
| `dist/` | Build output, gitignored. |

## Commands

```bash
npm start                  # run the desktop app
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
- There is no test suite. Verify by driving the real app with Electron and
  `webContents.executeJavaScript` — see the pattern in past commits. Small test
  fixtures hide real bugs (a 3-second video seeks from memory and never exposes
  broken range requests; use something ~100 MB).
- A test harness `require`s `main.js` for the real IPC, then drives the window
  returned by `BrowserWindow.getAllWindows()[0]`. Two things it must do:
  - **`app.setPath('userData', <temp>)` before requiring `main.js`.** Otherwise
    the test writes into the real library, and stale state from the last run
    makes the next one lie.
  - **Drive the DOM, not the closure.** Everything is inside one IIFE, so
    `state` and every function are unreachable; click real elements and read
    results back from `localStorage.getItem('questline_state_v2')`.

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
