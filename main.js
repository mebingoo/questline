const { app, BrowserWindow, Menu, ipcMain, session, globalShortcut, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
ipcMain.handle('prefs-get', () => loadPrefs());
ipcMain.handle('prefs-set', (event, patch) => {
  const prefs = Object.assign(loadPrefs(), patch || {});
  savePrefs(prefs);
  try { app.setLoginItemSettings({ openAtLogin: !!prefs.autostart, path: process.execPath, args: [] }); } catch (e) { /* non-fatal */ }
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
      const res = await net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
      // Without CORS headers the video counts as cross-origin, which taints any
      // canvas it is drawn onto — and "Capture frame" is exactly that. Status and
      // Content-Range are passed through so seeking keeps working.
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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

  autoUpdater.on('update-downloaded', (info) => {
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

/* ---- Transcript: loaded inside a real (hidden) browser window.
   YouTube blocks plain HTTP clients, but this IS Chromium, with cookies
   and a real JS context, so it reads the page the way a browser does. ---- */
// YouTube is scraped in its own in-memory session, so its cookies never mix
// with the app's own session and nothing it sets survives the fetch.
const ytSession = () => session.fromPartition('yt-scrape');

async function primeConsentCookies() {
  // Germany/EU: without a consent cookie YouTube serves a wall instead of the page.
  const jar = ytSession().cookies;
  const cookies = [
    { url: 'https://www.youtube.com', name: 'CONSENT', value: 'YES+cb.20240101-00-p0.en+FX+000', domain: '.youtube.com' },
    { url: 'https://www.youtube.com', name: 'SOCS', value: 'CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.youtube.com' }
  ];
  for (const c of cookies) {
    try { await jar.set(c); } catch (e) { /* non-fatal */ }
  }
}

ipcMain.handle('yt-transcript', async (event, videoId) => {
  if (!/^[\w-]{11}$/.test(String(videoId || ''))) return { ok: false, error: 'Invalid video id.' };
  let win = null;
  try {
    await primeConsentCookies();
    // No preload here on purpose: this window loads real youtube.com, so it gets
    // no bridge, no Node, and an OS sandbox.
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true, javascript: true, images: false,
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, partition: 'yt-scrape'
      }
    });
    await win.loadURL('https://www.youtube.com/watch?v=' + videoId + '&hl=en');
    // give the page a beat to populate ytInitialPlayerResponse
    await new Promise((r) => setTimeout(r, 2500));

    const out = await win.webContents.executeJavaScript(`(async function(){
      try {
        var pr = window.ytInitialPlayerResponse;
        if (!pr) {
          var m = document.body.innerHTML.match(/ytInitialPlayerResponse\\s*=\\s*(\\{.+?\\});/);
          if (m) { try { pr = JSON.parse(m[1]); } catch(e){} }
        }
        if (!pr) return { err: 'nopr' };
        var det = pr.videoDetails || {};
        var cap = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
        var tracks = (cap && cap.captionTracks) || [];
        if (!tracks.length) return { err: 'nocaptions', duration: parseInt(det.lengthSeconds||0,10), title: det.title||'' };
        var pick = tracks.find(function(t){ return t.languageCode==='en' && t.kind!=='asr'; })
                || tracks.find(function(t){ return t.languageCode==='en'; })
                || tracks.find(function(t){ return t.languageCode==='de'; })
                || tracks[0];
        var res = await fetch(pick.baseUrl + '&fmt=json3');
        if (!res.ok) return { err: 'fetch'+res.status };
        var j = await res.json();
        var cues = (j.events||[]).filter(function(e){ return e.segs; }).map(function(e){
          return { t: Math.round((e.tStartMs||0)/1000),
                   text: e.segs.map(function(s){ return s.utf8; }).join('').replace(/\\n/g,' ').trim() };
        }).filter(function(c){ return c.text; });
        return { cues: cues, lang: pick.languageCode, auto: pick.kind==='asr',
                 duration: parseInt(det.lengthSeconds||0,10), title: det.title||'' };
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`);

    if (!out) return { ok: false, error: 'Could not read the page.' };
    if (out.err === 'nocaptions') {
      return { ok: false, error: 'This video has no captions, so there is no transcript to pull.', duration: out.duration || 0, title: out.title || '' };
    }
    if (out.err === 'nopr') return { ok: false, error: 'YouTube did not return player data (it may be age-restricted or region-blocked).' };
    if (out.err) return { ok: false, error: 'Transcript failed: ' + out.err };
    if (!out.cues || !out.cues.length) return { ok: false, error: 'Captions were empty.' };

    return { ok: true, cues: out.cues, lang: out.lang, auto: out.auto, duration: out.duration || 0, title: out.title || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
});

/* ---- AI: summary + graded multiple-choice questions from a transcript ---- */
function postJSON(host, path, headers, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      host, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers),
      timeout: 120000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('The AI request timed out.')); });
    req.write(data);
    req.end();
  });
}

function buildPrompt(title, transcript, count) {
  return 'You are helping a student actively learn from a video tutorial.\n\n' +
    'VIDEO TITLE: ' + title + '\n\n' +
    'TRANSCRIPT (each line starts with its timestamp in seconds):\n' + transcript + '\n\n' +
    'Produce a JSON object with EXACTLY this shape and nothing else:\n' +
    '{\n' +
    '  "summary": "3-5 sentence plain-English summary of what the video teaches",\n' +
    '  "keyPoints": ["4-7 short bullet points of the main takeaways"],\n' +
    '  "questions": [\n' +
    '    {"difficulty":"easy","q":"question text","options":["A","B","C","D"],"correct":0,"why":"one sentence on why that answer is right","t":123}\n' +
    '  ]\n' +
    '}\n\n' +
    'Rules for the questions:\n' +
    '- Exactly ' + count + ' questions, ordered from easiest to hardest.\n' +
    '- Use these difficulty values in order: start with "easy", then "medium", then "hard", ending with at least two "expert".\n' +
    '- Easy = simple recall of something stated outright. Medium = understanding a concept in your own terms.\n' +
    '  Hard = applying it to a slightly new situation. Expert = reasoning about edge cases, trade-offs, or what would\n' +
    '  break if you did it differently. Expert questions may require combining two separate parts of the video.\n' +
    '- Every question must have exactly 4 options, with "correct" being the 0-based index of the right one.\n' +
    '- Wrong options must be genuinely plausible to someone who half-watched. Never use "all of the above" or joke options.\n' +
    '- "t" is the timestamp in seconds where the answer is covered, so the student can jump back.\n' +
    '- Base everything strictly on the transcript. Do not invent facts that are not in it.\n' +
    'Return ONLY the raw JSON object. No markdown fences, no commentary.';
}

function extractJSON(text) {
  if (!text) throw new Error('The AI returned an empty response.');
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('The AI did not return JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

ipcMain.handle('ai-generate', async (event, opts) => {
  opts = opts || {};
  const key = String(opts.apiKey || '').trim();
  const title = opts.title || 'Untitled video';
  const count = Math.max(3, Math.min(20, parseInt(opts.count, 10) || 8));
  if (!key) return { ok: false, error: 'No API key set. Add one in the Learn tab settings.' };
  if (!opts.transcript) return { ok: false, error: 'No transcript to work from.' };

  // Keep the request affordable on long tutorials.
  let transcript = String(opts.transcript);
  const LIMIT = 48000;
  if (transcript.length > LIMIT) {
    const head = transcript.slice(0, Math.floor(LIMIT * 0.6));
    const tail = transcript.slice(-Math.floor(LIMIT * 0.4));
    transcript = head + '\n...[middle of transcript trimmed for length]...\n' + tail;
  }
  const prompt = buildPrompt(title, transcript, count);
  const isAnthropic = key.startsWith('sk-ant-');
  const model = String(opts.model || '').trim() || (isAnthropic ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');

  try {
    let res, text;
    if (isAnthropic) {
      res = await postJSON('api.anthropic.com', '/v1/messages', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }, { model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
      let j = null;
      try { j = JSON.parse(res.body); } catch (e) {}
      if (j && j.error) return { ok: false, error: j.error.message || 'Anthropic error' };
      if (res.status !== 200) return { ok: false, error: 'Anthropic HTTP ' + res.status };
      text = (j.content || []).map((c) => c.text || '').join('');
    } else {
      res = await postJSON('api.openai.com', '/v1/chat/completions', {
        'Authorization': 'Bearer ' + key
      }, {
        model, max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      });
      let j = null;
      try { j = JSON.parse(res.body); } catch (e) {}
      if (j && j.error) return { ok: false, error: j.error.message || 'OpenAI error' };
      if (res.status !== 200) return { ok: false, error: 'OpenAI HTTP ' + res.status };
      text = ((j.choices || [])[0] || {}).message ? j.choices[0].message.content : '';
    }

    const parsed = extractJSON(text);
    const questions = (parsed.questions || []).filter((q) =>
      q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4
    ).map((q) => ({
      difficulty: ['easy', 'medium', 'hard', 'expert'].includes(q.difficulty) ? q.difficulty : 'medium',
      q: String(q.q), options: q.options.map(String), correct: q.correct,
      why: String(q.why || ''), t: parseInt(q.t, 10) || 0
    }));
    if (!questions.length) return { ok: false, error: 'The AI returned no usable questions. Try again.' };

    return {
      ok: true,
      summary: String(parsed.summary || ''),
      keyPoints: (parsed.keyPoints || []).map(String).slice(0, 10),
      questions
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
