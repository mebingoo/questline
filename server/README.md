# Questline sync server

A single Cloudflare Worker that does three jobs:

1. **Serves the app** (`public/`) — so your PC and phone always run the same
   version, and a deploy updates both at once.
2. **Stores your progress** in KV — one shared blob, so XP, quests, timetable
   and videos stay in step across devices.
3. **Proxies WebUntis, YouTube and the AI provider** — a phone browser is
   blocked from calling those directly (CORS); the desktop app isn't, and
   still calls them natively.

## One-time setup (~5 minutes)

You need a free Cloudflare account (no card required).

```bash
cd server
npm install
npx wrangler login          # opens your browser once
```

**1. Create the storage namespace**

```bash
npx wrangler kv namespace create STATE
```

It prints something like `id = "abc123..."`. Open `wrangler.toml` and replace
`PASTE_YOUR_KV_ID_HERE` with that id.

**2. Set your sync password**

```bash
npx wrangler secret put SYNC_TOKEN
```

Type any passphrase you like. This is what keeps your data private — the
server URL is public, the token is not. You'll enter the same one on each device.

**3. Deploy**

```bash
npm run deploy
```

It prints your URL, e.g. `https://questline.<your-name>.workers.dev`.

## Connecting your devices

On **each** device, open Questline → **Device sync** (bottom of the page) →
paste the URL and the token → Connect.

- The first device to connect uploads what it already has.
- Every device after that pulls it down.
- After that they stay in step: changes push a second or two after you make
  them, and each device re-checks when you switch back to it.

## On the phone

Open the URL in Chrome → menu → **Add to Home screen**. It installs with its
own icon, opens fullscreen with no browser bars, and works offline for
everything that doesn't need the network.

## Updating

`npm run deploy` copies the current `../index.html` into `public/` and ships
it. Your phone picks it up next time you open the app; the desktop app reads
its own local copy, so it's already current.
