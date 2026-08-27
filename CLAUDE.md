# Questline

A personal RPG-style life tracker. Grand goals are "quest lines"; daily/weekly
quests earn XP and gold; there are skill trees, a course video player, a
timetable, and an AI quiz builder for YouTube tutorials.

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
  broken range requests).

## Where data lives — this matters

`state` is encrypted in the browser and pushed to Cloudflare KV. Three things
are deliberately **not** in it:

- **WebUntis credentials** (`questline_untis_v1`) and the **AI API key**
  (`questline_aikey_v1`) — device-local, so credentials never reach the server.
- **Background media, note screenshots, gate proofs** — IndexedDB, device-local.
  They'd blow past KV's size limit.

Sync is end-to-end encrypted (AES-GCM, key derived from the sync token via
PBKDF2). The server only ever sees ciphertext. If a blob won't decrypt the app
keeps local data and re-uploads rather than wiping anything.

## Not in the repo

Entered by hand, per machine: the sync token and AI key (in-app Settings),
`wrangler login`, `gh auth login`. The Worker's `SYNC_TOKEN` is a wrangler
secret.

## If another session may be running

This has already caused one messy fork. Before starting work:

```bash
git fetch origin && git status
```

Always `git pull` before committing, and never `git push --force` — another
session's work has been lost that way once already.
