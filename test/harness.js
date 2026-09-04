/* Questline test harness — `npm test`.
 *
 * There is no test suite and no build step; this is the whole of it. It boots
 * the real app under Electron and drives it the way a person would.
 *
 * Two rules, both learned the hard way:
 *
 *   1. app.setPath('userData', <temp>) BEFORE requiring main.js. Otherwise the
 *      test writes into the real library, and stale state from the last run
 *      makes the next one lie.
 *   2. Drive the DOM, not the closure. Everything in index.html lives inside
 *      one IIFE, so `state` and every function are unreachable from here.
 *      Click real elements and read results back out of localStorage.
 *
 * The migration and restore assertions are the point of the file. The app
 * auto-updates, so it ships new migrate() code to the only machine holding the
 * only copy of the data — and an export nobody has restored is not a backup.
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'questline-test-'));
app.setPath('userData', path.join(RUN_DIR, 'userData'));
app.setPath('sessionData', path.join(RUN_DIR, 'userData'));

// The backup dialogs are the only place the app waits on a human. Answering
// them here is what makes an end-to-end export/restore testable at all.
const BACKUP_FILE = path.join(RUN_DIR, 'backup.json');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: BACKUP_FILE });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BACKUP_FILE] });
dialog.showMessageBox = async () => ({ response: 1 });

require('../main.js');

/* ---------------- assertions ---------------- */
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/* ---------------- driving the window ---------------- */
let win;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (src) => win.webContents.executeJavaScript(src, true);

// Everything the test knows about the app comes back through here: the save is
// the app's own contract with itself, and it is reachable without the closure.
const save = () => js("JSON.parse(localStorage.getItem('questline_state_v2') || 'null')");

async function ready() {
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  // The IIFE renders synchronously on load, but a couple of boot paths are
  // promises (appearance media, the version check). Give them a turn.
  await wait(600);
}
async function reload() { win.webContents.reload(); await ready(); }

async function click(selector) {
  const hit = await js(`(()=>{ const el = document.querySelector(${JSON.stringify(selector)});
    if(!el) return false; el.click(); return true; })()`);
  if (!hit) throw new Error('nothing to click: ' + selector);
  await wait(250);
  return hit;
}

/* ---------------- a save from before any of this existed ----------------
 * Deliberately missing everything added since: no schemaVersion, no steps,
 * no journal/srs/refs/timeline, quests without the newer fields. If migrate()
 * drops any of the parts that ARE here, the app has eaten someone's history. */
const V1_SAVE = {
  player: { xp: 940, gold: 470, streak: 6, longestStreak: 11, lastActiveDate: '2026-08-30' },
  goals: [
    { id: 'school', name: 'Abitur', flavor: 'The gate', color: '#14e6ff', icon: 'book', xp: 600 },
    { id: 'blender', name: 'Blender', flavor: 'The long game', color: '#ff2ea6', icon: 'cube', xp: 340 }
  ],
  dailies: [{ id: 'd_legacy', goal: 'school', title: 'Mathe LK Aufgaben', xp: 30, gold: 15, lastDone: '2026-08-30' }],
  weeklies: [{ id: 'w_legacy', goal: 'blender', title: 'Finish a render', xp: 120, gold: 60, lastDoneWeek: null }],
  rewards: [{ id: 'r_legacy', name: 'One evening off', cost: 200 }],
  achievements: { first_blood: true, streak_7: true },
  log: [
    { time: '18:20', text: 'Completed <b>Mathe LK Aufgaben</b>', delta: '+30xp', type: 'complete', goalId: 'school' },
    { time: '19:05', text: 'Bought <b>One evening off</b>', delta: '-200g', type: 'buy', goalId: null }
  ],
  activeTab: 'overview'
};

async function run() {
  win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('main.js opened no window');
  await ready();

  /* ---- 1. boot ---- */
  let s = await save();
  check('1  boot writes a save with a player', !!(s && s.player && typeof s.player.xp === 'number'));

  /* ---- 2-5. completing a daily ---- */
  // The list is filtered to today's study focus, and a fresh save has no focus
  // set — so flip the toggle until there is actually something on screen.
  const HAVE_DAILY = "!!document.querySelector('#dailyList .quest-item .qcheck[data-action=\"complete\"]')";
  for (let i = 0; i < 2 && !(await js(HAVE_DAILY)); i++) await click('#focusToggle');

  const before = await save();
  const target = await js(`(()=>{ const el = document.querySelector('#dailyList .quest-item .qcheck[data-action="complete"]');
    if(!el) return null; return el.closest('.quest-item').dataset.id; })()`);
  if (!target) throw new Error('no completable daily on screen');
  const quest = before.dailies.find((q) => q.id === target);

  await click(`#dailyList .quest-item[data-id="${target}"] .qcheck[data-action="complete"]`);
  s = await save();
  const done = s.dailies.find((q) => q.id === target);

  eq('2  completing a daily grants its XP', s.player.xp, before.player.xp + quest.xp);
  eq('3  completing a daily grants its gold', s.player.gold, before.player.gold + quest.gold);
  eq('4  the first completion starts the streak', s.player.streak, 1);
  check('5  the completion is written to the log',
    s.log.some((l) => l.type === 'complete' && l.text.includes(quest.title)));

  /* ---- 6. it survives a reload ---- */
  const xpAfterQuest = s.player.xp;
  const todayStr = await js("(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()");
  await reload();
  s = await save();
  eq('6  the completion survives a reload', (s.dailies.find((q) => q.id === target) || {}).lastDone, todayStr);

  /* ---- 7. migrate() over a v1 save ---- */
  await js(`(()=>{ localStorage.removeItem('questline_state_v2');
    localStorage.setItem('questline_state_v1', ${JSON.stringify(JSON.stringify(V1_SAVE))}); })()`);
  await reload();
  const m = await save();
  const kept =
    m.player.xp === V1_SAVE.player.xp &&
    m.player.gold === V1_SAVE.player.gold &&
    m.player.longestStreak === V1_SAVE.player.longestStreak &&
    V1_SAVE.goals.every((g) => {
      const found = (m.goals || []).find((x) => x.id === g.id);
      return found && found.name === g.name && found.xp === g.xp && found.color === g.color;
    }) &&
    (m.dailies || []).some((d) => d.id === 'd_legacy' && d.title === 'Mathe LK Aufgaben' && d.lastDone === '2026-08-30') &&
    (m.weeklies || []).some((w) => w.id === 'w_legacy' && w.xp === 120) &&
    (m.rewards || []).some((r) => r.id === 'r_legacy' && r.cost === 200) &&
    m.achievements.first_blood === true && m.achievements.streak_7 === true &&
    (m.log || []).length === V1_SAVE.log.length &&
    m.log[0].text === V1_SAVE.log[0].text;
  check('7  migrate() drops nothing from a v1 save', kept, 'got ' + JSON.stringify(m.player) +
    ', ' + (m.goals || []).length + ' goals, ' + (m.dailies || []).length + ' dailies, ' + (m.log || []).length + ' log rows');
  check('7b migrate() fills in what v1 never had',
    !!(m.journal && m.srs && m.refs && m.timeline && Array.isArray(m.focusSessions) && m.schemaVersion === 2));
  // The one field that is *meant* to change: reconcile() breaks a streak whose
  // last active day is more than a day old. The record of it survives.
  check('7c a stale streak breaks, but longestStreak is kept',
    m.player.streak === 0 && m.player.longestStreak === V1_SAVE.player.longestStreak);

  /* ---- 8-10. export, throw it away, restore ----
   * An export nobody has restored is not a backup, so this drives the real
   * buttons: the file is written by main.js through the same IPC the user's
   * click uses, and read back the same way. */
  // A blob in IndexedDB, so the restore has something other than JSON to prove.
  const MARKER = 'harness-marker-' + Date.now();
  await js(`(async ()=>{
    const db = await new Promise((res,rej)=>{ const r = indexedDB.open('questline-refs',1);
      r.onupgradeneeded = ()=>{ if(!r.result.objectStoreNames.contains('images')) r.result.createObjectStore('images'); };
      r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
    await new Promise(res=>{ const tx = db.transaction('images','readwrite');
      tx.objectStore('images').put(new Blob([${JSON.stringify(MARKER)}], {type:'text/plain'}), 'harness');
      tx.oncomplete = ()=>res(); tx.onerror = ()=>res(); });
  })()`);

  const beforeBackup = await save();
  await js("(()=>{ document.getElementById('settingsBtn').click(); })()");
  await wait(200);
  await click('.set-tab[data-tab="advanced"]');
  await click('#bkExport');
  await wait(1500);

  let file = null;
  try { file = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch (e) { /* asserted below */ }
  const refStore = file && file.stores && file.stores['questline-refs/images'];
  check('8  export writes a backup carrying the state and the blob stores',
    !!(file && file.app === 'questline' && file.state && file.state.player.xp === beforeBackup.player.xp &&
       refStore && refStore.some((e) => e.key === 'harness' && e.value && e.value.__blob === 1)),
    'file at ' + BACKUP_FILE);
  check('8b the backup carries no credentials',
    !!(file && JSON.stringify(file.local || {}).indexOf('password') < 0 &&
       !(file.local || {}).syncToken && !(file.local || {}).apiKey));

  // Throw the lot away — the state and the blob both.
  await js(`(async ()=>{
    localStorage.setItem('questline_state_v2', JSON.stringify(Object.assign(
      JSON.parse(localStorage.getItem('questline_state_v2')), {player:{xp:0,gold:0,streak:0,longestStreak:0,lastActiveDate:null}})));
    const db = await new Promise(res=>{ const r = indexedDB.open('questline-refs',1); r.onsuccess = ()=>res(r.result); });
    await new Promise(res=>{ const tx = db.transaction('images','readwrite');
      tx.objectStore('images').delete('harness'); tx.oncomplete = ()=>res(); tx.onerror = ()=>res(); });
  })()`);
  await reload();

  await js("(()=>{ document.getElementById('settingsBtn').click(); })()");
  await wait(200);
  await click('.set-tab[data-tab="advanced"]');
  await click('#bkImport');
  await wait(1200);
  await click('#mConfirm');          // "Restore and reload"
  await wait(1500);
  await ready();

  const restored = await save();
  eq('9  restore puts back the state that was thrown away', restored.player.xp, beforeBackup.player.xp);
  check('9b restore puts back gold and streak too',
    restored.player.gold === beforeBackup.player.gold && restored.player.streak === beforeBackup.player.streak);

  const blobBack = await js(`(async ()=>{
    const db = await new Promise(res=>{ const r = indexedDB.open('questline-refs',1); r.onsuccess = ()=>res(r.result); });
    const b = await new Promise(res=>{ const tx = db.transaction('images','readonly');
      const q = tx.objectStore('images').get('harness');
      q.onsuccess = ()=>res(q.result||null); q.onerror = ()=>res(null); });
    return b ? await b.text() : null;
  })()`);
  eq('10 restore puts back the IndexedDB blob', blobBack, MARKER);

  /* ---- 11. the snapshot the app takes on its own ----
   * The one that matters most, because nobody asks for it: an update lands,
   * the app notices the version moved, and the old save goes to disk first. */
  await js("localStorage.setItem('questline_lastver_v1','0.0.0')");
  await reload();
  await wait(1500);
  const autoDir = path.join(app.getPath('userData'), 'backups');
  const auto = fs.existsSync(autoDir) ? fs.readdirSync(autoDir).filter((f) => f.includes('from-0.0.0')) : [];
  let autoOk = false;
  if (auto.length) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(autoDir, auto[0]), 'utf8'));
      autoOk = d.app === 'questline' && !!d.state && !!d.state.player;
    } catch (e) { /* asserted below */ }
  }
  check('11 a version change writes a snapshot on its own', autoOk, 'looked in ' + autoDir);

  /* ---- 12. the tick still runs when there is something to tick ----
   * The 1 Hz interval is now started on demand rather than at boot, so the
   * thing worth proving is that a running timer still counts. */
  await js("document.getElementById('timerPill').click()");
  await wait(200);
  await click('#tpFreeform');
  const t0 = await js("document.getElementById('timerVal').textContent");
  await wait(2200);
  const t1 = await js("document.getElementById('timerVal').textContent");
  check('12 a running timer still ticks once a second', t0 !== t1, 'stuck at ' + t1);
  await click('#tcStop');
}

app.whenReady().then(async () => {
  console.log('\nQuestline harness — userData: ' + app.getPath('userData') + '\n');
  try {
    await run();
  } catch (err) {
    failed++;
    console.log('  FAIL harness threw: ' + (err && err.stack ? err.stack : err));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) { /* windows keeps a lock; harmless */ }
  app.exit(failed ? 1 : 0);
});
