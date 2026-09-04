# Roadmap

Written 2026-08-30 against v1.11.0 (`9bfe43b`), covering features (Phases 0-4)
and structure/performance (see **Architecture & performance**). Full reasoning
behind each item lives in the audit; this file is the executable version.

Phuc's constraints, because they decide priority:

- **Abitur summer 2027.** eA: Mathe, Physik, Englisch. GK: Erdkunde, Informatik.
- **Target: Medieninformatik, Stuttgart.** Both options (Uni Stuttgart, HdM) are
  `zulassungsbeschränkt` and neither wants a portfolio — the Abitur average is
  the gate. Study features outrank craft features until July 2027.
- **Long game:** 3D generalist + Python tooling for the pipeline. Real, but it
  waits.

Rule for any session picking this up: **Phase 0 before anything else**, and do
not start Phase 4 work before July 2027 no matter how tempting the ticket looks.

---

## Phase 0 — Make it safe ✅ done 2026-09-05

Nothing else gets built until this is done. The app auto-updates itself, which
means it ships new `migrate()` code to the only machine holding the only copy
of the data.

- [x] **Export / import everything.** Settings → Advanced → Export writes a
      timestamped JSON: `state` plus every IndexedDB blob (gate proofs,
      reference images, note screenshots, background media) base64'd. Restore
      reads it back and reloads. Credentials are deliberately excluded.
      **The restore is tested**, on a temp `userData`, through the real buttons
      and the real IPC — assertions 8-10 in `test/harness.js`.
- [x] **Auto-backup on version change.** Two silent snapshots into
      `<video library>/Questline Backups/`, newest 5 kept: one when
      `update-downloaded` fires (the updater waits for it), and one at boot when
      the running version differs from the last one seen. The boot one backs up
      the save exactly as it sat on disk *before* `migrate()` ran.
- [x] **Commit `test/harness.js`.** `npm test`. 16 assertions: boot → complete
      a daily → XP/gold/streak/log → reload → persisted → `migrate()` over a v1
      save → export → throw it all away → restore → auto-snapshot → the timer
      still ticks. The migration one is the point.
- [x] **Fix `renderRadar()`.** Reads `--border`, `--text-dim`, `--bg` and
      `--gold` off `getComputedStyle(document.documentElement)`; the accent hull
      is `fill-opacity` rather than a baked `rgba()`. Verified against the light
      theme: grid `#262638`→`#bcc1d0`, labels `#8b93b0`→`#414761`.
- [x] **Stop the 1 Hz render in the main window** (O1 below). `if(!isWidget)
      return;` at the top of `renderWidgetUI()`.
- [x] **Only run the timer interval when a timer is running** (O2 below).
      Reconciled from `renderTimerPill()`, not from start/stop — a timer started
      in the *other* window arrives as a storage event, never as a call to
      `startTimer()`.
- [x] **Housekeeping.** `_old_scaffold_delete_me/` deleted. The roadmap JSONs
      were already committed. `README.md` rewritten (the `npm run build:win`
      script and the `dist/Questline-win32-x64/` path never existed; progress
      stopped being tied to the file location when sync shipped). CLAUDE.md's
      "~6300 lines" → ~10,500, plus the harness and backup sections.
- [x] **S3 — stop committing `server/public/index.html`.** Gitignored along with
      `server/public/data/`; `predeploy` writes them at deploy time.

**Next: Phase 1.** Start with the grade tracker — it is the one number that
decides Stuttgart and the app still cannot display it.

---

## Phase 1 — The Abitur block ✅ done 2026-09-05

Everything here has to pay for itself before summer. No architecture work.

- [x] **Grade tracker + Schnitt projection.** A section under Timetable, not a
      ninth tab. Subjects pull from the WebUntis sync. Klausur points per
      Halbjahr in, projected Abitur average out, via the KMK block scheme:
      Block I = (P/S)×40 with eA doubled, Block II = five Prüfungen ×4,
      N = 17/3 − E/180. E1 being a *ratio* is what makes it honest from the
      first Klausur — half the Halbjahre entered gives the same projection as
      all of them at the same level. The bar chart under the table prices one
      extra Notenpunkt per subject by re-running the whole projection, so it
      accounts for open Halbjahre and Prüfungsfach status rather than applying a
      rule of thumb. Weights live in `ABI_RULES`; another Bundesland is a
      settings change. **No XP anywhere**, with a test enforcing it.
- [x] **Formula + definition card types.** Note kinds (`vocab` / `formula` /
      `definition` / `occlusion`) drive the editor and the exercise types;
      the FSRS scheduler was untouched, as required.
      **Not KaTeX.** The CSP allows scripts from self and YouTube only, and
      widening it to a CDN would break formula cards offline — wrong trade for
      an app whose AI runs locally so it works on a train. Vendoring KaTeX costs
      ~300 KB plus a megabyte of fonts and ends "one file, no build step".
      Chromium has shipped MathML Core since 109 (this Electron is on 152), so
      the browser already does the layout; what was missing was a way to type
      it. There is now a ~200-line LaTeX→MathML converter covering \frac \sqrt
      \int \sum \lim, scripts either order, Greek, accents, \text, \left…\right,
      \mathbb and the function names, with 25 unit tests. Unknown commands
      degrade to their own text instead of throwing.
- [x] **Image-occlusion cards.** Drag rectangles over a stored image, one card
      per rectangle, each on its own schedule. Rectangles normalised 0..1;
      image in `shotDb`, so it stays device-local and out of the synced blob.
      Front covers everything and marks one box — covering only the target
      would let the neighbouring labels give it away.
- [x] **Klausur dates as timeline events.** `kind:'exam'` plus a `subjectId`
      into the grade table. Countdown strip on Tasks. "Plan revision" writes
      dailies backwards at expanding intervals (1, 2, 4, 7, 11, 16, 22 days
      before), each pinned with `plannedForDate` and titled with free time the
      timetable actually knows about.
- [x] **Seminarfacharbeit seeded.** `data/roadmaps/seminarfacharbeit-optionspreise.json`
      — eight sequential gated milestones, Sep 2026 to the Kolloquium in
      Mar 2027, with definitions-of-done that are checkable rather than
      aspirational.
- [x] **Transcript limits derive from the model.** `/api/show` reports the real
      window; **and `num_ctx` is now sent**, which was the half that mattered —
      Ollama otherwise caps at its own small default and drops the *front* of
      the prompt, where the transcript is. Over budget, the video is chunked and
      merged with each pass told which part it has, and past the pass ceiling
      the passes spread evenly rather than starting from the front. Chat keeps
      the opening plus the sections whose words match the question. The cloud
      48,000 path turned out to be unreachable (`api.aiGenerate` has no
      callers); raised and labelled rather than left as a trap.
- [x] **Encrypted blob size sits next to the sync badge**, amber past 20% of
      Cloudflare KV's 25 MB ceiling and red past 80%.

Two bugs surfaced by writing the tests, both pre-existing:
`id="goGen"` existed twice (`#summaryBox` and `#quizBox` both render it), so
one click ran the whole AI generation **twice**; and `save()` in the note editor
read `#wTr` directly, which crashes for any kind that does not render it.

**Next: Phase 2 (Dec 2026).** Deliberately not before December — the charts
would be too empty to say anything and you'd tune them against noise.

---

## Phase 2 — Insights (Dec 2026, ~10-14h)

Deliberately not earlier: before December the charts would be too empty to say
anything, and you'd end up tuning them against noise.

- [ ] **Insights tab.** Four charts, all from data already stored:
      - Hours per quest line per week — from `focusSessions`, which currently
        has exactly one consumer (`focusWeekSummary()`, returning one string).
      - Estimated vs actual minutes — `estimatedMinutes` and `actualMinutes` are
        both recorded on every quest and never compared. Estimation calibration
        is a real TD skill.
      - FSRS retention curve + forecast — `srsStats()` already computes most of
        it (`retention`, `upcoming`).
      - Hours logged against the Abitur countdown. This is the one that makes
        the app honest.
      Prefer absorbing Overview into this rather than adding a ninth tab.
- [ ] **Achievements for the mechanics that matter.** The current 11 are all
      thresholds on streak/level/gold. None reward clearing a gate with proof,
      unlocking a skill-tree node, or a week where estimate matched actual
      within 20% — i.e. none reward the parts of the app that are actually good.
- [ ] **XP curve and gold sinks.** Player levels every flat 150 XP and quest
      lines every flat 100, forever; gold is always `xp/2`. Level 40 feels the
      same as level 12 and gold outruns a five-item shop. Superlinear curve
      (`base * level^1.3`), sinks with teeth (streak insurance, a guilt-free
      skip token), XP scaled by tracked time rather than a number typed at
      creation.

---

## Phase 3 — Feature freeze (Jan–Jun 2027)

**No new features. Bugfixes only.** This is the window the app exists to
protect; rebuilding it during the window defeats the whole point.

- Keep an `IDEAS.md` and dump every temptation into it. Writing it down is what
  makes it possible to stop thinking about it.
- Six months of real data is worth more than anything on this list.

If a session is asked for a feature during this window, say no and point here.

---

## Phase 4 — The craft block (Jul 2027 →)

The audience changes from "me" to "an admissions office, and eventually a
studio."

- [ ] **Blender time-tracking add-on.** ~150 lines of `bpy`: an app handler
      detecting activity in a file, posting start/stop + filename to a small
      localhost endpoint in `main.js`, so `focusSessions` fills itself while
      modelling. No self-reporting, honest numbers. Desktop app + DCC add-on +
      a designed IPC boundary — the most Medieninformatik-shaped thing here,
      and the exact shape of a TD's day job.
- [ ] **Shot log / portfolio view.** Every finished piece: a render, the skill
      tree node(s) it proves, hours from `focusSessions`, a link. Gates already
      support proof upload, so this is largely a view over existing data. Turns
      the app from a scoreboard into a portfolio pipeline — the reel assembles
      itself over a year.
- [ ] **Tools shelf.** Every script and add-on written, registered against the
      `python-td-tree.json` nodes it demonstrates.
- [ ] **Extract FSRS into its own public repo** with tests and a README. ~200
      lines, correct, self-contained. "I implemented and tested a spaced-
      repetition scheduler" is verifiable in thirty seconds by someone who
      won't install an .exe; "I built an app" isn't.
- [ ] **Do the S-items from Architecture & performance** that are marked `[P4]`
      — the module split, the shared proxy layer, the CSS layering.
- [ ] **Split `index.html` into modules with a build step** — now, and only
      because someone else will read it. One file with no build step is why this
      project ships weekly; that trade is right up until the moment it isn't.

---

## Architecture & performance

Added 2026-08-30 after a structural pass over `index.html`, `main.js` and
`server/src/worker.js`. Tags say which phase each belongs in. None of this is
urgent correctness work — it is the stuff that decides whether the app still
feels good in month eighteen.

### Structure

**S1 — `renderAll()` renders everything, always. `[P2]`**
19 render functions called unconditionally from 62 call sites. Completing one
daily rebuilds the timetable grid (~90 cells through `cellHtml`), the radar SVG,
the journal, the SRS dashboard, the reference board, the video library, courses,
achievements, rewards and the log — nearly all of it on tabs that aren't
visible. Fix: `renderAll()` renders the header and the *active* tab; other tabs
go into a `dirtyTabs` set and render lazily in `setTab()`. This one change also
fixes startup, which currently renders all eight tabs before the window is
interactive.

**S2 — the proxy layer is implemented twice. `[P4]`**
WebUntis RPC (including `RPC_ERRORS`), YouTube meta/transcript, and the AI layer
(`buildPrompt`, `extractJSON`) exist in **both** `main.js` and
`server/src/worker.js`. Two runtimes, one behaviour contract, no shared source —
so a prompt tweak or a new WebUntis error code has to be made twice, and drift
is silent: the phone quietly starts behaving differently from the desktop.
Fix: extract the runtime-agnostic parts (prompt building, JSON extraction, error
maps, response shaping) into `shared/` as plain ES modules both sides import.
Keep only the transport (`https` vs `fetch`) runtime-specific.

**S3 — a 523 KB generated file is committed. `[P0]` ✅ done 2026-09-05**
`server/public/index.html` is a byte-copy of `index.html`, regenerated by
`npm run predeploy`, and committed on every release — 24 commits so far, and
roughly half of `.git` (4.1 MB) is copies of the same file. CLAUDE.md already
says "Generated. Never edit by hand"; the missing half is "and never commit it."
Fix: gitignore `server/public/index.html` and `server/public/data/`, and let
`predeploy` produce them at deploy time.

**S4 — the CSS has hit the ceiling before the JS has. `[P4]`**
1,478 lines / 100 KB of CSS, 979 rules, and **39 `!important`** — which is the
measurable symptom of exactly the specificity fights the Conventions section
warns about. Worth fixing before the JS split because it's self-contained:
adopting `@layer base, components, utilities` would let most of those
`!important`s go away with no restructuring at all.

**S5 — four IndexedDB databases, a fresh connection per operation. `[P2]`**
`proofDb()`, `refDb()`, `shotDb()` and `bgDb()` are identical apart from their
names, and every `*Put`/`*Get`/`*Delete` calls `indexedDB.open()` again and
never `.close()`s. Building the reference board opens one connection per image.
Fix: one `idb(name)` helper that caches the open promise per database; better,
one `questline-blobs` DB with four object stores.

### Optimization

**O1 — `renderWidgetUI()` runs every second in the main window, forever. `[P0]` ✅ done 2026-09-05**
`#widgetUI` is in the shared DOM (line ~1520) and merely `display:none` in the
main window, so the `if(!el) return;` guard never fires. `timerTick` therefore
rebuilds `#widgetBody`'s innerHTML — string concat, `icon()` SVG generation,
`esc()` per row — at 1 Hz into a hidden subtree, whether or not a timer is
running and whether or not the widget is even open. Fix: `if(!isWidget) return;`
at the top of `renderWidgetUI()`.

**O2 — the tick interval is unconditional. `[P0]` ✅ done 2026-09-05**
`setInterval(timerTick, 1000)` runs for the whole session. Start it in
`startTimer()`/`resumeTimer()`, clear it in `stopTimer()`/`pauseTimer()`.

**O3 — `saveState()` serialises the whole state synchronously on every mutation. `[P2]`**
Ticking one checkbox does a full `JSON.stringify(state)` plus a synchronous
`localStorage.setItem` on the main thread. The *push* is debounced 1.5s; the
local write isn't debounced at all. Fix: debounce the localStorage write ~300ms
too, and once the blob is big enough to notice, move serialisation to a worker.

**O4 — the journal re-counts every word on every render. `[P2]`**
`renderJournal()` does `all.reduce((a,e)=>a+jrWordCount(e.body),0)`, regex-
splitting every entry body — 62 times a session, usually on a tab you can't see.
Fix: store the word count on the entry when it's saved.

**O5 — `srsStats()` makes a dozen full passes over cards and reviews. `[P2]`**
Seven filters over `cards`, plus a seven-iteration `upcoming` loop that filters
`cards` again each time, plus reductions over `daily`. Called from `renderSrs()`
inside `renderAll()`. Fix: one pass that fills every bucket, memoised against a
state-version counter.

**O6 — nothing is virtualised. `[P4]`**
`log` renders a capped 40 rows (good), but `openSrsBrowse()` builds a DOM row
for *every* note and `renderJournal()` for every entry. Fine today; this is what
will make the app feel broken in year two. Cheap interim fix: cap the list and
add a "show more".

**O7 — sync re-encrypts and re-uploads the entire blob, and `putState` isn't atomic. `[P2]`**
Every push runs AES-GCM over the whole state. Worse, Cloudflare KV has **no
compare-and-swap** and is eventually consistent, so `putState()`'s
read-then-write means two devices inside the propagation window can both pass
the `rev` check, and the later write silently wins. KV also rate-limits writes
to ~1/sec on the same key, and the save debounce is 1.5s. Low probability at one
user with two devices — but it is the one real correctness hole in sync.
Fix, in order of effort: raise and coalesce the debounce; then move the state key
to a **Durable Object**, which gives genuine single-threaded atomicity.

### Not a problem (checked, don't "fix" these)

- **Event listener hygiene is fine.** The `document.getElementById('dayPick')`
  / `'agenda'` handlers sit at module scope, not inside `renderDayView()`, and
  `renderPlanNudge()` reassigns `innerHTML` before re-binding, so nothing
  accumulates. Delegation via `closest('[data-action=...]')` is used correctly
  throughout.
- **`effectiveLuminance()` reads a cached `bgLuminance`** — it does not sample
  canvas pixels per render.
- **The service worker is well built.** Network-first for the shell so a
  redeploy lands immediately, `/api/*` never cached, old caches purged on
  activate. Leave it alone.
- **`esc()` is applied consistently** at every interpolation site.

---

## Explicitly not doing

- **A ninth tab.** Eight is already past the point where you scan instead of
  read. Every tab taxes every launch.
- **A React rewrite.** No build step is the reason releases happen. Refactor
  post-Abitur, for a reason, not for tidiness.
- **Phone parity.** The phone is for reviewing cards and ticking dailies. The
  rest is desk work.
- **XP for grades.** Track Klausur results; never award XP for them. Turning a
  bad grade into a punishment from the app is how you stop opening it in the
  exact week you need it.
