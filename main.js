const { app, BrowserWindow, Menu, ipcMain, session, globalShortcut, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { pathToFileURL } = require('url');

/* ------------------------------------------------------------------ *
 * Local course media
 *
 * Course videos live wherever the user downloaded them, which the
 * renderer cannot read on its own. They are served over a private
 * qlmedia:// scheme instead of file://, so exactly one thing is
 * reachable: files underneath a folder the user picked in the dialog.
 * Registered as a standard, streaming scheme because <video> needs
 * byte-range requests to be able to seek.
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([{
  scheme: 'qlmedia',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false }
}]);

const courseRoots = new Set();          // folders the user actually chose

function isInsideRoot(target) {
  const t = path.resolve(target);
  for (const root of courseRoots) {
    const r = path.resolve(root);
    if (t === r || t.startsWith(r + path.sep)) return true;
  }
  return false;
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi']);

const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo'
};

// Downloaded videos keep their poster next to the file, served over the same
// scheme so the library grid can show it without a round trip to YouTube.
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

/* Serves a file with real byte-range support.
 *
 * Chromium decides a video is seekable from Accept-Ranges plus a 206 answer to
 * a Range request. Without them the scrub bar is dead and every seek snaps back
 * to zero, however well the file plays from the start — so the ranges are
 * handled here rather than handed off wholesale. */
function serveMedia(target, rangeHeader) {
  let size;
  try { size = fs.statSync(target).size; }
  catch (e) { return new Response('Not found', { status: 404 }); }

  const ext = path.extname(target).toLowerCase();
  const type = VIDEO_MIME[ext] || IMAGE_MIME[ext] || 'application/octet-stream';
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // The <video> is drawn onto a canvas by "Capture frame", which a response
    // without CORS headers would taint.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  };
  const toWeb = (stream) => require('stream').Readable.toWeb(stream);

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (m) {
    let start, end;
    if (m[1] === '') {                       // bytes=-N — the final N bytes
      const suffix = parseInt(m[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return new Response('Bad range', { status: 416 });
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
    }
    if (!Number.isFinite(start) || start >= size || start < 0) {
      return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    }
    end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1);
    if (end < start) end = size - 1;

    return new Response(toWeb(fs.createReadStream(target, { start, end })), {
      status: 206,
      headers: Object.assign({}, base, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Content-Length': String(end - start + 1)
      })
    });
  }

  return new Response(toWeb(fs.createReadStream(target)), {
    status: 200,
    headers: Object.assign({}, base, { 'Content-Length': String(size) })
  });
}

function scanDir(dir, depth) {
  // Deep course sets are common; a generous cap still stops a runaway symlink.
  if (depth > 8) return { folders: [], videos: [] };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { folders: [], videos: [] }; }

  const folders = [], videos = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = scanDir(full, depth + 1);
      // Keep only branches that actually contain something watchable.
      if (sub.videos.length || sub.folders.length) folders.push({ name: e.name, path: full, ...sub });
    } else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch (err) {}
      videos.push({ name: e.name, path: full, size });
    }
  }
  return { folders, videos };
}

function countVideos(node) {
  return (node.videos ? node.videos.length : 0) +
    (node.folders || []).reduce((n, f) => n + countVideos(f), 0);
}

ipcMain.handle('courses-pick', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Pick a course folder',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
});

ipcMain.handle('courses-scan', async (event, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, error: 'No folder given.' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'That is not a folder.' };
  } catch (e) {
    return { ok: false, error: 'That folder is no longer there — was it moved or unplugged?' };
  }
  courseRoots.add(path.resolve(dir));
  const tree = scanDir(dir, 0);
  const total = countVideos(tree);
  if (!total) return { ok: false, error: 'No video files found in that folder.' };
  return { ok: true, root: dir, name: path.basename(dir), tree, total };
});

// Re-authorise a saved course on launch without rescanning it.
ipcMain.handle('courses-allow', async (event, dir) => {
  if (typeof dir === 'string' && dir) courseRoots.add(path.resolve(dir));
  return true;
});

ipcMain.handle('courses-reveal', async (event, target) => {
  if (typeof target === 'string' && isInsideRoot(target)) shell.showItemInFolder(target);
  return true;
});

/* ------------------------------------------------------------------ *
 * UI scale
 *
 * The app is laid out in pixels — a thousand-odd rules of them — so making
 * it "scale with the window" by converting every size to relative units
 * would be a rewrite. Chromium already has exactly this mechanism: zoom.
 * Setting the zoom factor scales the whole page, layout included, and
 * viewport units resolve correctly against it (which is why this is done
 * here rather than with a CSS `zoom` on <body>, where 100vh would not).
 *
 * The factor is computed from the window's *content* size, which zoom does
 * not affect — computing it from innerWidth would feed its own output back
 * in and oscillate.
 * ------------------------------------------------------------------ */
const UI_DESIGN_WIDTH = 1400;     // the width the layout was drawn for
const UI_MIN = 0.65, UI_MAX = 1.15;
const uiScalePrefs = new WeakMap();   // win -> { mode:'auto'|'fixed', factor }

function applyUiZoom(win) {
  if (!win || win.isDestroyed()) return;
  const pref = uiScalePrefs.get(win) || { mode: 'auto', factor: 1 };
  let z = pref.factor;
  if (pref.mode === 'auto') {
    const [w] = win.getContentSize();
    z = Math.max(UI_MIN, Math.min(UI_MAX, w / UI_DESIGN_WIDTH));
  }
  try { win.webContents.setZoomFactor(z); } catch (e) {}
  return z;
}

function trackUiZoom(win) {
  uiScalePrefs.set(win, { mode: 'auto', factor: 1 });
  const onResize = () => applyUiZoom(win);
  win.on('resize', onResize);
  win.on('maximize', onResize);
  win.on('unmaximize', onResize);
  win.webContents.on('did-finish-load', () => applyUiZoom(win));
}

ipcMain.handle('ui-scale-set', (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false };
  const o = opts || {};
  uiScalePrefs.set(win, {
    mode: o.mode === 'fixed' ? 'fixed' : 'auto',
    factor: Math.max(UI_MIN, Math.min(UI_MAX, Number(o.factor) || 1))
  });
  return { ok: true, applied: applyUiZoom(win) };
});
ipcMain.handle('ui-scale-get', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pref = (win && uiScalePrefs.get(win)) || { mode: 'auto', factor: 1 };
  let applied = 1;
  try { applied = win ? win.webContents.getZoomFactor() : 1; } catch (e) {}
  return { ok: true, mode: pref.mode, factor: pref.factor, applied };
});

// Where the automatic backups go. Somewhere the user would think to look,
// rather than buried in AppData.
ipcMain.handle('backup-pick-folder', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Where should Questline keep its backups?',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});


/* ------------------------------------------------------------------ *
 * Window hardening
 *
 * preload.js exposes the untis/learn/widget bridges to whatever page a
 * window is showing, so an app window must never end up on a remote
 * page. Anything that tries to navigate away is cancelled and handed to
 * the real browser instead.
 * ------------------------------------------------------------------ */
function hardenWindow(win) {
  const wc = win.webContents;
  const external = (url) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
  wc.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); external(url); }
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // Only what the app actually uses: copying the transcript, and letting the
  // video player go fullscreen. Camera, mic, location, notifications and the
  // rest are refused outright.
  // 'local-fonts' powers the Appearance font picker (listing fonts installed here).
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'local-fonts']);
  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */
let mainWin = null;
let widgetWin = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 940,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#12151c',
    title: 'Questline',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin = win;
  hardenWindow(win);
  trackUiZoom(win);
  win.on('closed', () => { if (mainWin === win) mainWin = null; });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Ctrl+R reloads after an edit; Ctrl+Shift+I opens devtools if something breaks.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (input.control && !input.shift && key === 'r') win.reload();
    if (input.control && input.shift && key === 'i') win.webContents.toggleDevTools();
  });
  return win;
}

/* ------------------------------------------------------------------ *
 * Backups
 *
 * The app updates itself, which means it ships new migrate() code
 * straight to the only machine holding the only copy of the data. This
 * is the undo button for that.
 *
 * The renderer builds the snapshot — `state` and all four IndexedDB
 * blob stores live there and are unreachable from this process. This
 * side only picks a file and writes the bytes.
 * ------------------------------------------------------------------ */
const BACKUP_RE = /^questline-backup-.*\.json$/;

// Nothing the renderer sends becomes a path: both separators and the rest of
// the Windows-illegal set are flattened before it is joined to the folder.
function safeFileName(name) {
  return String(name || 'questline-backup.json').replace(/[\\/:*?"<>|]/g, '-').slice(0, 140);
}

// Auto-backups go next to the videos, because that is the folder chosen for
// having room on it. Without one they fall back to userData.
function autoBackupDir(preferred) {
  let base;
  if (preferred && fs.existsSync(preferred)) base = path.join(preferred, 'Questline Backups');
  else base = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// The point is the most recent few, not a museum — these files are large.
function pruneBackups(dir, keep) {
  try {
    fs.readdirSync(dir)
      .filter((f) => BACKUP_RE.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(Math.max(1, keep || 5))
      .forEach((x) => { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* non-fatal */ } });
  } catch (e) { /* non-fatal */ }
}

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('backup-save', async (event, { name, text }) => {
  const r = await dialog.showSaveDialog({
    title: 'Save Questline backup',
    defaultPath: path.join(app.getPath('downloads'), safeFileName(name)),
    filters: [{ name: 'Questline backup', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, text); return { ok: true, path: r.filePath }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('backup-open', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Restore a Questline backup',
    properties: ['openFile'],
    filters: [{ name: 'Questline backup', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try { return { ok: true, path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Resolved by the next backup-auto-write, so the updater can wait for the
// snapshot it asked for instead of racing the restart against it.
let pendingSnapshot = null;
function settleSnapshot() { if (pendingSnapshot) { const f = pendingSnapshot; pendingSnapshot = null; f(); } }

ipcMain.handle('backup-auto-write', (event, { name, text, dir, keep }) => {
  try {
    const target = autoBackupDir(dir);
    const out = path.join(target, safeFileName(name));
    fs.writeFileSync(out, text);
    pruneBackups(target, keep || 5);
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    settleSnapshot();
  }
});

// The renderer reports a snapshot it decided not to take (nothing to back up,
// or it failed) so the updater is never left waiting on the timeout.
ipcMain.handle('backup-auto-skip', () => { settleSnapshot(); return true; });

/* The last moment the *old* code still owns the data. Bounded, because an
   update must not be blockable by a renderer that never answers. */
function snapshotBeforeUpdate(version) {
  if (!mainWin || mainWin.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingSnapshot = null; resolve(); }, 90000);
    pendingSnapshot = () => { clearTimeout(timer); resolve(); };
    mainWin.webContents.send('backup-request', { reason: 'update', version: version || '' });
  });
}

/* ------------------------------------------------------------------ *
 * Pinned widget — a second, always-on-top, frameless window that loads
 * the same index.html (with ?widget=1) so it shares the app's own
 * localStorage save. Position/size and a couple of prefs persist to
 * small JSON files in userData since there's no other storage the main
 * process can read on its own.
 * ------------------------------------------------------------------ */
const prefsPath = () => path.join(app.getPath('userData'), 'widget-prefs.json');
const boundsPath = () => path.join(app.getPath('userData'), 'widget-bounds.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* non-fatal */ }
}
function loadPrefs() { return Object.assign({ autostart: false, widgetOnly: false }, readJSON(prefsPath(), {})); }
function savePrefs(p) { writeJSON(prefsPath(), p); }
function loadWidgetBounds() { return readJSON(boundsPath(), null); }
function saveWidgetBounds(b) { writeJSON(boundsPath(), { x: b.x, y: b.y, width: b.width, height: b.height }); }

function createWidgetWindow() {
  if (widgetWin && !widgetWin.isDestroyed()) { widgetWin.show(); widgetWin.focus(); return widgetWin; }
  const saved = loadWidgetBounds();
  const win = new BrowserWindow({
    width: (saved && saved.width) || 280,
    height: (saved && saved.height) || 320,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  widgetWin = win;
  hardenWindow(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'index.html'), { query: { widget: '1' } });
  const persist = () => { if (widgetWin === win && !win.isDestroyed()) saveWidgetBounds(win.getBounds()); };
  win.on('moved', persist);
  win.on('resize', persist);
  win.on('closed', () => { if (widgetWin === win) widgetWin = null; });
  return win;
}

ipcMain.handle('widget-open', () => { createWidgetWindow(); return true; });
ipcMain.handle('widget-close', () => { if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close(); return true; });
ipcMain.handle('widget-is-open', () => !!(widgetWin && !widgetWin.isDestroyed()));
ipcMain.handle('widget-resize', (event, { w, h }) => {
  if (widgetWin && !widgetWin.isDestroyed()) {
    const [x, y] = widgetWin.getPosition();
    widgetWin.setBounds({ x, y, width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
    saveWidgetBounds(widgetWin.getBounds());
  }
  return true;
});
ipcMain.handle('widget-open-main', () => {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
  else createWindow();
  return true;
});

/* ------------------------------------------------------------------ *
 * Reference board window
 *
 * The point of a reference board is to sit on top of Blender while you
 * work, so it gets its own always-on-top window rather than living only
 * inside a tab. It loads the same page with ?refs=1; the renderer sees
 * that and draws the board alone. Both windows share one localStorage
 * and one IndexedDB, so the board is the same board in either place.
 *
 * Unlike the widget this one is resizable and keeps its frame off, so
 * it behaves like a real floating panel.
 * ------------------------------------------------------------------ */
let refsWin = null;
const refsBoundsPath = () => path.join(app.getPath('userData'), 'refs-bounds.json');

function createRefsWindow() {
  if (refsWin && !refsWin.isDestroyed()) { refsWin.show(); refsWin.focus(); return refsWin; }
  const saved = readJSON(refsBoundsPath(), null);
  const win = new BrowserWindow({
    width: (saved && saved.width) || 620,
    height: (saved && saved.height) || 520,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 260,
    minHeight: 220,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0b0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  refsWin = win;
  hardenWindow(win);
  // 'screen-saver' keeps it above full-screen apps, which is the whole point.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'index.html'), { query: { refs: '1' } });
  const persist = () => { if (refsWin === win && !win.isDestroyed()) writeJSON(refsBoundsPath(), win.getBounds()); };
  win.on('moved', persist);
  win.on('resize', persist);
  win.on('closed', () => { if (refsWin === win) refsWin = null; });
  return win;
}

ipcMain.handle('refs-open', () => { createRefsWindow(); return true; });
ipcMain.handle('refs-close', () => { if (refsWin && !refsWin.isDestroyed()) refsWin.close(); return true; });
ipcMain.handle('refs-is-open', () => !!(refsWin && !refsWin.isDestroyed()));
ipcMain.handle('refs-set-opacity', (event, value) => {
  const v = Math.max(0.2, Math.min(1, Number(value) || 1));
  if (refsWin && !refsWin.isDestroyed()) refsWin.setOpacity(v);
  return true;
});
// Lets the board window get out of the way without being closed.
ipcMain.handle('refs-set-pinned', (event, pinned) => {
  if (refsWin && !refsWin.isDestroyed()) refsWin.setAlwaysOnTop(!!pinned, 'screen-saver');
  return true;
});
ipcMain.handle('refs-minimize', () => {
  if (refsWin && !refsWin.isDestroyed()) refsWin.minimize();
  return true;
});
ipcMain.handle('prefs-get', () => loadPrefs());
ipcMain.handle('prefs-set', (event, patch) => {
  const prefs = Object.assign(loadPrefs(), patch || {});
  savePrefs(prefs);
  try {
    // In dev (npm start / electron .), process.execPath points at the bare
    // Electron binary in node_modules, which needs the app path as an arg or it
    // falls back to Electron's own default demo screen on login. Packaged builds
    // don't need this since process.execPath already points at the app's own exe.
    app.setLoginItemSettings({
      openAtLogin: !!prefs.autostart,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()]
    });
  } catch (e) { /* non-fatal */ }
  return prefs;
});

/* ------------------------------------------------------------------ *
 * Bundled roadmap seeds — the renderer is sandboxed (contextIsolation,
 * no nodeIntegration) and can't read these off disk itself. Only the
 * app's own data/roadmaps/*.json files are ever exposed here: filenames
 * the renderer asks for are checked against the real directory listing,
 * never joined onto a path straight from the renderer.
 * ------------------------------------------------------------------ */
const ROADMAPS_DIR = path.join(__dirname, 'data', 'roadmaps');
function listRoadmapSeedFiles() {
  try { return fs.readdirSync(ROADMAPS_DIR).filter((f) => f.endsWith('.json')); }
  catch (e) { return []; }
}
ipcMain.handle('roadmap-list-seeds', () => {
  return listRoadmapSeedFiles().map((filename) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ROADMAPS_DIR, filename), 'utf8'));
      return { filename, title: String(parsed.title || filename), questLineKey: parsed.questLineKey || null };
    } catch (e) { return { filename, title: filename, questLineKey: null }; }
  });
});
ipcMain.handle('roadmap-load-seed', (event, filename) => {
  if (!listRoadmapSeedFiles().includes(filename)) throw new Error('Unknown roadmap seed: ' + filename);
  return JSON.parse(fs.readFileSync(path.join(ROADMAPS_DIR, filename), 'utf8'));
});

app.whenReady().then(() => {
  // qlmedia://f/<base64url of an absolute path>. net.fetch on a file URL keeps
  // range support intact, which is what lets the user scrub through a video.
  protocol.handle('qlmedia', async (request) => {
    try {
      const u = new URL(request.url);
      const encoded = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      const target = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!isInsideRoot(target)) return new Response('Forbidden', { status: 403 });
      return serveMedia(target, request.headers.get('Range'));
    } catch (e) {
      return new Response('Bad request', { status: 400 });
    }
  });

  const prefs = loadPrefs();
  const loginInfo = app.getLoginItemSettings();
  if (loginInfo.wasOpenedAtLogin && prefs.widgetOnly) {
    createWidgetWindow();
  } else {
    createWindow();
  }
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    if (widgetWin && !widgetWin.isDestroyed()) {
      if (widgetWin.isVisible()) widgetWin.hide(); else widgetWin.show();
    } else {
      createWidgetWindow();
    }
  });
  setupAutoUpdate();
});

/* ------------------------------------------------------------------ *
 * Auto-update — checks GitHub Releases on launch and every few hours,
 * downloads silently in the background, then asks before restarting to
 * install. A no-op in dev (`npm start`), since an unpackaged app has no
 * update feed to check against.
 * ------------------------------------------------------------------ */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Public release repo: no credential needed, and blockmap-based differential
  // downloads work, so an update pulls a few hundred KB instead of the whole
  // installer.
  autoUpdater.setFeedURL({ provider: 'github', owner: 'mebingoo', repo: 'questline' });

  autoUpdater.on('update-downloaded', async (info) => {
    // Snapshot first: the update replaces migrate() on the only machine that
    // holds the data, so the pre-update save is worth having on disk.
    await snapshotBeforeUpdate(info && info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Questline ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it’ll install next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (err) => {
    console.warn('Auto-update check failed:', err && err.message ? err.message : err);
  });

  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ------------------------------------------------------------------ *
 * WebUntis JSON-RPC client
 *
 * Runs in the main process on purpose: Node's https has no CORS rules,
 * so it can talk to the school server directly. Credentials are passed
 * in per call from the renderer and never written to disk here.
 * ------------------------------------------------------------------ */
// WebUntis reports its own errors with a non-200 status AND a JSON body
// (e.g. 404 + {"error":{"code":-8500,"message":"invalid schoolname"}}), so the
// body is always parsed first — the JSON message is far more useful than the code.
const RPC_ERRORS = {
  '-8500': 'That school key is not right. Use "Find my school" above to fill it in.',
  '-8504': 'Login rejected — check your username and password.',
  '-8509': 'No permission for that data. Try your student login.',
  '-8998': 'WebUntis is busy right now. Try again in a moment.',
  '-7004': 'WebUntis returned no timetable for that date range.'
};

function post(host, path, payload, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      host, path, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Questline/1.0'
      }, cookie ? { Cookie: cookie } : {}),
      timeout: 20000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
        if (json && json.error) {
          const code = String(json.error.code);
          return reject(new Error(RPC_ERRORS[code] || json.error.message || ('WebUntis error ' + code)));
        }
        if (!json) {
          return reject(new Error(res.statusCode === 404
            ? 'Not found at ' + host + ' — check the server address.'
            : 'Server did not return JSON (HTTP ' + res.statusCode + ').'));
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' from ' + host));
        resolve(json.result);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Connection timed out.')); });
    req.on('error', (e) => {
      if (e.code === 'ENOTFOUND') return reject(new Error('Server not found: ' + host));
      if (e.code === 'ECONNREFUSED') return reject(new Error('Connection refused by ' + host));
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

/* The school password is POSTed to whatever host this resolves to, so it is
   pinned to WebUntis' own domain — a tampered or mistyped server field can
   never send the credentials somewhere else. */
function untisHost(server) {
  const h = String(server || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h)) throw new Error('That server address is not a valid hostname.');
  if (h !== 'webuntis.com' && !h.endsWith('.webuntis.com')) {
    throw new Error('For safety Questline only signs in to *.webuntis.com servers (got "' + h + '").');
  }
  return h;
}

function rpc(server, schoolQuery, method, params, cookie) {
  return post(untisHost(server), '/WebUntis/jsonrpc.do?school=' + encodeURIComponent(schoolQuery),
    { id: 'questline', method, params: params || {}, jsonrpc: '2.0' }, cookie);
}

/* Public WebUntis school directory — resolves a school name to its real
   server hostname and short login key, so neither has to be guessed. */
ipcMain.handle('untis-search', async (event, query) => {
  if (!query || String(query).trim().length < 3) {
    return { ok: false, error: 'Type at least 3 characters of your school name.' };
  }
  try {
    const result = await post('mobile.webuntis.com', '/ms/schoolquery2', {
      id: 'wu_schulsuche', method: 'searchSchool',
      params: [{ search: String(query).trim() }], jsonrpc: '2.0'
    });
    const schools = (result && result.schools) || [];
    return {
      ok: true,
      schools: schools.slice(0, 12).map((s) => ({
        server: s.server,
        loginName: s.loginName,
        displayName: s.displayName,
        address: s.address || ''
      }))
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, error: /too many/i.test(msg) ? 'Too many matches — type more of the name.' : msg };
  }
});

const byId = (list) => {
  const m = {};
  (list || []).forEach((x) => { m[x.id] = x; });
  return m;
};

ipcMain.handle('untis-sync', async (event, cfg) => {
  cfg = cfg || {};
  if (!cfg.server || !cfg.school || !cfg.user) {
    return { ok: false, error: 'Server, school and username are required.' };
  }

  let cookie = null;
  try {
    const auth = await rpc(cfg.server, cfg.school, 'authenticate', {
      user: cfg.user,
      password: cfg.password || '',
      client: 'questline'
    });
    if (!auth || !auth.sessionId) return { ok: false, error: 'Login rejected — check username and password.' };
    cookie = 'JSESSIONID=' + auth.sessionId;

    const [subjects, teachers, rooms] = await Promise.all([
      rpc(cfg.server, cfg.school, 'getSubjects', {}, cookie).catch(() => []),
      rpc(cfg.server, cfg.school, 'getTeachers', {}, cookie).catch(() => []),
      rpc(cfg.server, cfg.school, 'getRooms', {}, cookie).catch(() => [])
    ]);
    const subjMap = byId(subjects), teachMap = byId(teachers), roomMap = byId(rooms);

    const raw = await rpc(cfg.server, cfg.school, 'getTimetable', {
      id: auth.personId,
      type: auth.personType,
      startDate: cfg.startDate,
      endDate: cfg.endDate
    }, cookie);

    const lessons = (raw || []).map((l) => {
      const su = (l.su && l.su[0]) || {};
      const te = (l.te && l.te[0]) || {};
      const ro = (l.ro && l.ro[0]) || {};
      const subjName = su.name || (subjMap[su.id] && subjMap[su.id].name) || '?';
      const teachName = te.name || (teachMap[te.id] && teachMap[te.id].name) || '';
      const roomName = ro.name || (roomMap[ro.id] && roomMap[ro.id].name) || '';
      return {
        date: l.date,
        startTime: l.startTime,
        endTime: l.endTime,
        subject: subjName,
        teacher: teachName,
        room: roomName,
        cancelled: l.code === 'cancelled'
      };
    }).filter((l) => l.subject && l.subject !== '?');

    return { ok: true, lessons };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (cookie) {
      rpc(cfg.server, cfg.school, 'logout', {}, cookie).catch(() => {});
    }
  }
});

/* ================================================================== *
 * LEARN — YouTube metadata, transcripts, and AI question generation
 * ================================================================== */

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8'
      }, headers || {}),
      timeout: 20000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Connection timed out.')); });
  });
}

/* ---- Metadata via oEmbed: no login, no bot wall, just works ---- */
ipcMain.handle('yt-meta', async (event, videoId) => {
  if (!/^[\w-]{11}$/.test(String(videoId || ''))) return { ok: false, error: 'That does not look like a YouTube link.' };
  try {
    const r = await httpGet('https://www.youtube.com/oembed?url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json');
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'This video is private or embedding is blocked.' };
    if (r.status === 404) return { ok: false, error: 'Video not found — check the link.' };
    if (r.status !== 200) return { ok: false, error: 'YouTube returned HTTP ' + r.status + '.' };
    const j = JSON.parse(r.body);
    return {
      ok: true,
      meta: {
        title: j.title || 'Untitled',
        author: j.author_name || '',
        thumb: j.thumbnail_url || ('https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg')
      }
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});


/* ================================================================== *
 * AI PROVIDERS
 *
 * One interface, several backends. Ollama is the default and runs on
 * this machine, so nothing here needs a paid account or sends text off
 * the device. The cloud providers stay available for anyone who wants
 * them, behind the same three calls:
 *
 *   complete({prompt, model, ...})  -> { ok, text }
 *   models(...)                     -> { ok, models: [name] }
 *   health(...)                     -> { ok, detail }
 *
 * Adding a provider means adding one object below; nothing that calls
 * these has to know which one is in use.
 * ================================================================== */

function httpJSON(urlStr, { method = 'GET', headers = {}, body = null, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL: ' + urlStr)); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : JSON.stringify(body);
    const req = lib.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers
      ),
      timeout
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, json: parsed, raw: out });
      });
    });
    req.on('timeout', () => req.destroy(new Error('The model took too long to answer.')));
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') return reject(new Error('Nothing is listening there. Is Ollama running?'));
      reject(e);
    });
    if (data) req.write(data);
    req.end();
  });
}

const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
const cleanBase = (u) => String(u || OLLAMA_DEFAULT_URL).trim().replace(/\/+$/, '');

/* How long Ollama should hold the model in VRAM after answering.
 * Ollama does this itself — a duration string, seconds as a number, 0 to unload
 * as soon as the reply is done, or a negative number to keep it forever. Every
 * request carries the value, and Ollama restarts the countdown each time, so
 * the idle timer resets without anything here having to track it. */
function normalizeKeepAlive(v) {
  if (v === 0 || v === '0') return 0;                       // unload immediately
  if (v === -1 || v === '-1' || v === 'always') return -1;   // keep loaded
  const str = String(v == null ? '10m' : v).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);           // plain seconds
  if (/^\d+(\.\d+)?[smh]$/.test(str)) return str;            // 5m, 30m, 2h
  return '10m';
}

const AI_PROVIDERS = {
  ollama: {
    label: 'Ollama (local)',
    needsKey: false,
    local: true,
    async complete(o) {
      const base = cleanBase(o.baseUrl);
      const model = String(o.model || '').trim() || 'llama3.2';
      const body = {
        model,
        prompt: o.prompt,
        stream: false,
        keep_alive: normalizeKeepAlive(o.keepAlive),
        options: {
          temperature: o.temperature == null ? 0.7 : o.temperature,
          num_predict: Math.max(128, Math.min(8192, parseInt(o.maxTokens, 10) || 1200))
        }
      };
      /* Ollama defaults num_ctx to a few thousand tokens no matter how big the
         model's window is, and silently drops whatever does not fit — from the
         *front*, which is where the transcript lives. Asking for the window is
         the difference between "128K context" being true and being a spec
         sheet. Only sent when the caller worked out a size. */
      if (o.numCtx) body.options.num_ctx = Math.max(2048, parseInt(o.numCtx, 10) || 0);
      /* Constrained decoding. Given a JSON schema, Ollama compiles it to a
         grammar and the model physically cannot emit anything that doesn't
         match — which is the difference between a 3B model being useless here
         and being reliable. Asking politely in the prompt is not equivalent:
         small models answer with prose or a markdown fence most of the time. */
      if (o.format) body.format = o.format;
      const r = await httpJSON(base + '/api/generate', { method: 'POST', body });
      if (r.status === 404) {
        return { ok: false, error: 'Model "' + model + '" is not pulled yet. Run:  ollama pull ' + model };
      }
      if (r.status !== 200) return { ok: false, error: 'Ollama HTTP ' + r.status + (r.raw ? ' — ' + r.raw.slice(0, 160) : '') };
      const text = r.json && typeof r.json.response === 'string' ? r.json.response : '';
      if (!text) return { ok: false, error: 'Ollama returned nothing.' };
      return { ok: true, text };
    },
    async models(o) {
      const r = await httpJSON(cleanBase(o.baseUrl) + '/api/tags', { timeout: 8000 });
      if (r.status !== 200 || !r.json) return { ok: false, error: 'Could not list models (HTTP ' + r.status + ').' };
      return { ok: true, models: (r.json.models || []).map((m) => m.name || m.model).filter(Boolean) };
    },
    /* How much context this model can actually hold. /api/show reports it under
       an architecture-prefixed key — llama.context_length, qwen2.context_length,
       gemma3.context_length — so the key is found by suffix rather than named. */
    async context(o) {
      const model = String(o.model || '').trim();
      if (!model) return { ok: false, error: 'No model selected.' };
      const r = await httpJSON(cleanBase(o.baseUrl) + '/api/show', {
        method: 'POST', body: { model }, timeout: 8000
      });
      if (r.status !== 200 || !r.json) return { ok: false, error: 'Could not read the model card (HTTP ' + r.status + ').' };
      const info = r.json.model_info || {};
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const n = key ? parseInt(info[key], 10) : 0;
      if (!n) return { ok: false, error: 'The model card does not say how much context it holds.' };
      return { ok: true, contextTokens: n, model };
    },
    async health(o) {
      const r = await httpJSON(cleanBase(o.baseUrl) + '/api/version', { timeout: 6000 });
      if (r.status !== 200 || !r.json) return { ok: false, error: 'Ollama did not answer on ' + cleanBase(o.baseUrl) };
      return { ok: true, detail: 'Ollama ' + (r.json.version || '') };
    },
    /* /api/ps lists what is actually resident in memory right now, with the
       moment each model is due to be dropped. Facts only — the renderer decides
       how to label them. */
    async status(o) {
      const r = await httpJSON(cleanBase(o.baseUrl) + '/api/ps', { timeout: 6000 });
      if (r.status !== 200 || !r.json) return { ok: false, error: 'Ollama is not reachable.' };
      const wanted = String(o.model || '').trim();
      const list = (r.json.models || []).map((m) => ({
        name: m.name || m.model || '',
        vram: m.size_vram || 0,
        expiresAt: m.expires_at || null
      }));
      // "llama3.2" should match the resident "llama3.2:latest".
      const mine = wanted
        ? list.find((m) => m.name === wanted || m.name.split(':')[0] === wanted.split(':')[0])
        : list[0];
      return {
        ok: true,
        loaded: !!mine,
        model: mine ? mine.name : wanted,
        vram: mine ? mine.vram : 0,
        expiresAt: mine ? mine.expiresAt : null,
        others: list.filter((m) => !mine || m.name !== mine.name).map((m) => m.name)
      };
    },
    /* Drop it now: a zero-token generate with keep_alive 0 tells Ollama to
       release the weights. The daemon itself keeps running. */
    async unload(o) {
      const model = String(o.model || '').trim();
      if (!model) return { ok: false, error: 'No model selected.' };
      const r = await httpJSON(cleanBase(o.baseUrl) + '/api/generate', {
        method: 'POST', timeout: 20000,
        body: { model, prompt: '', keep_alive: 0, stream: false }
      });
      if (r.status !== 200) return { ok: false, error: 'Ollama HTTP ' + r.status };
      // Ollama answers before the weights are actually evicted, so poll /api/ps
      // briefly — otherwise the UI reports "Loaded" straight after an unload.
      for (let i = 0; i < 12; i++) {
        const ps = await httpJSON(cleanBase(o.baseUrl) + '/api/ps', { timeout: 4000 });
        const still = ((ps.json && ps.json.models) || []).some(
          (m) => (m.name || m.model || '').split(':')[0] === model.split(':')[0]);
        if (!still) return { ok: true };
        await new Promise((res) => setTimeout(res, 250));
      }
      return { ok: true, slow: true };
    }
  },

  anthropic: {
    label: 'Anthropic (cloud, paid)',
    needsKey: true,
    async complete(o) {
      const r = await httpJSON('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        body: {
          model: String(o.model || '').trim() || 'claude-3-5-haiku-latest',
          max_tokens: Math.max(128, Math.min(8192, parseInt(o.maxTokens, 10) || 1200)),
          messages: [{ role: 'user', content: o.prompt }],
          // No JSON mode here, so prefill the opening brace instead: the reply
          // then continues the object rather than introducing it with prose.
          ...(o.format ? { messages: [
            { role: 'user', content: o.prompt },
            { role: 'assistant', content: '{' }
          ] } : {})
        }
      });
      const j = r.json;
      if (j && j.error) return { ok: false, error: j.error.message || 'Anthropic error' };
      if (r.status !== 200) return { ok: false, error: 'Anthropic HTTP ' + r.status };
      const out = (j.content || []).map((c) => c.text || '').join('');
      // The prefilled "{" is not echoed back in the reply, so restore it.
      return { ok: true, text: o.format ? '{' + out : out };
    },
    async models() { return { ok: true, models: ['claude-3-5-haiku-latest', 'claude-sonnet-4-5', 'claude-opus-4-1'] }; },
    async health(o) { return o.apiKey ? { ok: true, detail: 'Key present' } : { ok: false, error: 'No API key set.' }; }
  },

  openai: {
    label: 'OpenAI (cloud, paid)',
    needsKey: true,
    async complete(o) {
      const r = await httpJSON('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + o.apiKey },
        body: {
          model: String(o.model || '').trim() || 'gpt-4o-mini',
          max_tokens: Math.max(128, Math.min(8192, parseInt(o.maxTokens, 10) || 1200)),
          messages: [{ role: 'user', content: o.prompt }],
          // OpenAI has its own JSON mode; the schema itself stays in the prompt.
          ...(o.format ? { response_format: { type: 'json_object' } } : {})
        }
      });
      const j = r.json;
      if (j && j.error) return { ok: false, error: j.error.message || 'OpenAI error' };
      if (r.status !== 200) return { ok: false, error: 'OpenAI HTTP ' + r.status };
      return { ok: true, text: ((j.choices || [])[0] || {}).message ? j.choices[0].message.content : '' };
    },
    async models() { return { ok: true, models: ['gpt-4o-mini', 'gpt-4o'] }; },
    async health(o) { return o.apiKey ? { ok: true, detail: 'Key present' } : { ok: false, error: 'No API key set.' }; }
  }
};

function pickProvider(name) {
  return AI_PROVIDERS[name] || AI_PROVIDERS.ollama;
}
function guardKey(prov, o) {
  if (prov.needsKey && !String(o.apiKey || '').trim()) {
    return { ok: false, error: 'That provider needs an API key. Ollama runs locally and needs none.' };
  }
  return null;
}

ipcMain.handle('ai-complete', async (event, opts) => {
  const o = opts || {};
  const prov = pickProvider(o.provider);
  if (!String(o.prompt || '')) return { ok: false, error: 'Nothing to ask.' };
  const bad = guardKey(prov, o);
  if (bad) return bad;
  try { return await prov.complete(o); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai-context', async (event, opts) => {
  const p = AI_PROVIDERS[(opts && opts.provider) || 'ollama'];
  if (!p || !p.context) return { ok: false, error: 'That provider does not report a context size.' };
  try { return await p.context(opts || {}); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('ai-models', async (event, opts) => {
  const o = opts || {};
  try { return await pickProvider(o.provider).models(o); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai-health', async (event, opts) => {
  const o = opts || {};
  try { return await pickProvider(o.provider).health(o); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai-status', async (event, opts) => {
  const o = opts || {};
  const prov = pickProvider(o.provider);
  if (!prov.status) return { ok: true, loaded: null, unsupported: true };
  try { return await prov.status(o); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai-unload', async (event, opts) => {
  const o = opts || {};
  const prov = pickProvider(o.provider);
  if (!prov.unload) return { ok: false, error: 'That provider has nothing to unload.' };
  try { return await prov.unload(o); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai-provider-list', async () => {
  return {
    ok: true,
    providers: Object.keys(AI_PROVIDERS).map((k) => ({
      id: k, label: AI_PROVIDERS[k].label, needsKey: !!AI_PROVIDERS[k].needsKey, local: !!AI_PROVIDERS[k].local
    }))
  };
});

