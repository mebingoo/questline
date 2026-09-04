# Questline

A personal RPG-style life tracker. Grand goals are quest lines; daily and
weekly quests earn XP and gold. There are skill trees, a spaced-repetition
card system, a course video player, a WebUntis timetable, a PureRef-style
reference board and an AI quiz builder for downloaded YouTube tutorials.

Runs as a real desktop window via Electron, and as a phone PWA served by a
Cloudflare Worker.

## Run it

```
npm install
npm start
```

`npm install` downloads Electron (~150 MB, once, needs internet). `npm start`
opens the Questline window. After that, `npm start` is all you need.

`Ctrl+R` inside the window reloads after an edit to `index.html`.
`Ctrl+Shift+I` opens devtools. `Ctrl+Shift+Q` toggles the pinned widget.

## Test

```
npm test
```

Boots the real app under Electron on a throwaway `userData` folder and drives
the actual DOM — completing a quest, reloading, migrating a v1 save, and doing
a full backup export → restore round trip. See `test/harness.js`.

## Build the installer

```
npm run dist
```

Writes `dist/Questline-Setup-<version>.exe`. The installed app auto-updates
itself from GitHub Releases, so shipping is: bump `version` in `package.json`,
`npm run dist`, then

```
gh release create vX.Y.Z <installer> <blockmap> dist/latest.yml
```

Do not rename the artifact by hand — the uploaded name has to match
`latest.yml` exactly or every client silently 404s and stays on the old
version. `build.artifactName` already pins the right name.

## Phone

```
cd server && npm run deploy
```

`predeploy` copies `index.html` and the skill-tree seeds into
`server/public/` (both generated, both gitignored), then wrangler pushes the
Worker and the PWA.

## Your data

Saved in the app's own storage, not next to this folder — moving or renaming
the folder is safe. Optional end-to-end encrypted sync keeps the desktop and
the phone in step through the Worker; the server only ever holds ciphertext.

**Settings → Advanced → Export** writes the lot to one file: state plus the
reference images, note screenshots, gate proofs and background media that live
in IndexedDB. Restore reads it back. The app also takes a snapshot on its own
whenever it notices it has updated itself.

Passwords, the AI key and the sync token are deliberately left out of both the
backup file and the synced blob.

## Files

- `index.html` — the entire app: UI, CSS and logic in one file, no build step.
- `main.js` — Electron main process: windows, WebUntis/YouTube/AI proxies,
  `qlmedia://` course media, backups, auto-update.
- `preload.js` — the only bridge between the page and Node.
- `server/` — the Cloudflare Worker and the phone PWA.
- `data/roadmaps/` — roadmap and skill-tree seeds.
- `test/harness.js` — the test suite.
- `ROADMAP.md` — the phased plan. Read it before starting anything.
- `CLAUDE.md` — how the code is put together and why.
