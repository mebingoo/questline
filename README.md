# Questline

A personal RPG-style quest tracker: your grand goals as quest lines, daily
and weekly quests, XP and levels, streaks, achievements, and a gold reward
shop. Runs as a real desktop window via Electron.

## Run it (first time)

Open this folder in VS Code, open a terminal (`` Ctrl+` ``), and run:

```
npm install
npm start
```

`npm install` downloads Electron (~150MB, one time, needs internet) directly
onto your machine — no more chat uploads. `npm start` opens the Questline
window. After that, you only need `npm start` to launch it again.

## Everyday use

- Your progress is saved in the app's local storage, tied to this exact
  `index.html` file's location — don't move or rename this folder if you
  want to keep your save.
- If Claude updates `index.html` for you, press **Ctrl+R** inside the
  Questline window (or restart `npm start`) to load the changes.

## Build a standalone .exe (optional)

If you want a `Questline.exe` you can double-click without running `npm
start` (e.g. to pin to your taskbar or share with someone else):

```
npm run build:win
```

The finished app appears in `dist/Questline-win32-x64/Questline.exe`.

## Files

- `index.html` — the entire app: UI, styling, and logic (single file, no
  build step needed to edit it).
- `main.js` — the small Electron launcher that opens `index.html` in a
  window.
- `package.json` — project config and the two npm scripts above.
