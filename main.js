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
 * YouTube downloads (yt-dlp)
 *
 * Embedded playback kept breaking — uploaders disable it, and YouTube
 * now refuses the caption endpoints to anything that isn't a real
 * browser session. yt-dlp sidesteps both: it speaks the same player
 * APIs the mobile/TV clients use, and it is maintained against
 * YouTube's changes far more aggressively than any scraper here could
 * be. So a video is downloaded once and then owned locally — the file,
 * its poster and its subtitles all land in one folder and are served
 * over the same qlmedia:// scheme as course videos.
 *
 * yt-dlp and ffmpeg are not bundled; they are looked up on PATH and
 * their absence is reported to the renderer rather than guessed at.
 * ------------------------------------------------------------------ */
const { spawn } = require('child_process');

/* Node does no PATHEXT resolution on Windows, so spawn('yt-dlp') would
   ENOENT even with yt-dlp.exe plainly on PATH. Resolve it properly. */
function whichTool(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch (e) {}
    }
  }
  return null;
}

let toolCache = null;
function findTools(refresh) {
  if (toolCache && !refresh) return toolCache;
  toolCache = { ytdlp: whichTool('yt-dlp'), ffmpeg: whichTool('ffmpeg') };
  return toolCache;
}

function runTool(exe, args, timeout) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(exe, args, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, timeout || 30000);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

ipcMain.handle('dl-check', async (event, refresh) => {
  const t = findTools(!!refresh);
  if (!t.ytdlp) {
    return {
      ok: false,
      ytdlp: null,
      ffmpeg: !!t.ffmpeg,
      error: 'yt-dlp was not found on this PC. Install it with:  winget install yt-dlp.yt-dlp'
    };
  }
  const v = await runTool(t.ytdlp, ['--version'], 20000);
  return {
    ok: true,
    ytdlp: (v.out || '').trim() || 'unknown',
    ffmpeg: !!t.ffmpeg,
    // Merging the best video with the best audio is an ffmpeg job; without it
    // yt-dlp silently drops to a lower-quality pre-muxed stream.
    warn: t.ffmpeg ? null : 'ffmpeg was not found — quality will be capped until you install it (winget install yt-dlp.FFmpeg).'
  };
});

ipcMain.handle('dl-pick-folder', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Where should downloaded videos be kept?',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  courseRoots.add(path.resolve(r.filePaths[0]));
  return { ok: true, path: r.filePaths[0] };
});

// Re-authorise the saved library folder on launch, the same way courses do.
ipcMain.handle('dl-allow', async (event, dir) => {
  if (typeof dir === 'string' && dir) {
    try {
      if (fs.statSync(dir).isDirectory()) { courseRoots.add(path.resolve(dir)); return { ok: true }; }
    } catch (e) { return { ok: false, error: 'That folder is no longer there.' }; }
  }
  return { ok: false, error: 'No folder given.' };
});

/* Subtitles come down as json3 — the same shape the old caption scraper
   produced, so everything downstream (summary, quiz, chat) is unchanged. */
function parseJson3(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cues = [];
  for (const e of (j.events || [])) {
    if (!e.segs) continue;
    const text = e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({ t: Math.round((e.tStartMs || 0) / 1000), text });
  }
  return cues;
}

/* Picks the subtitle file to actually use, in the caller's language order
   so a German learner gets the German track when the video has both. */
function pickSubs(dir, langs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const subs = names.filter(n => n.endsWith('.json3'));
  if (!subs.length) return null;
  for (const want of langs) {
    const exact = subs.find(n => n === 'video.' + want + '.json3');
    if (exact) return { file: path.join(dir, exact), lang: want };
    const loose = subs.find(n => n.startsWith('video.' + want));
    if (loose) return { file: path.join(dir, loose), lang: want };
  }
  const m = /^video\.(.+)\.json3$/.exec(subs[0]);
  return { file: path.join(dir, subs[0]), lang: m ? m[1] : 'unknown' };
}

function findByExt(dir, exts) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const hit = names.find(n => exts.includes(path.extname(n).toLowerCase()));
  return hit ? path.join(dir, hit) : null;
}

const dlJobs = new Map();      // job id -> child process, so a download can be cancelled

/* One yt-dlp run. Resolves rather than rejecting — the caller decides which
   failures matter, because for subtitles most of them don't. */
function runYtdlp(exe, args, jobId, onLine) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, args, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, stderr: String(e.message || e) }); }
    dlJobs.set(jobId, child);

    let stderr = '', tail = '', settled = false;
    const feed = (line) => { if (line.trim() && onLine) onLine(line.trim()); };

    child.stdout.on('data', (d) => {
      tail += d.toString();
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      lines.forEach(feed);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return; settled = true;
      dlJobs.delete(jobId);
      resolve({ code: -1, stderr: String(e.message || e) });
    });
    child.on('close', (code, signal) => {
      if (settled) return; settled = true;
      dlJobs.delete(jobId);
      if (tail) feed(tail);
      resolve({ code, signal, stderr });
    });
  });
}

const lastError = (stderr) =>
  (String(stderr).split(/\r?\n/).filter(l => /ERROR/i.test(l)).pop() || '').replace(/^ERROR:\s*/i, '').trim();

/* Subtitles, one language at a time, first hit wins.
 *
 * They are fetched in a separate run from the video on purpose. yt-dlp pulls
 * subtitles BEFORE the media and treats a failed subtitle fetch as fatal, so
 * a single HTTP 429 on the second language throws away the whole video
 * download — which is exactly what kept happening. Asking for one language
 * per run, after the video is already safely on disk, means a rate-limited
 * caption server costs at most the transcript. */
async function fetchSubs(exe, url, folder, langs, jobId, onStage) {
  const out = { lang: null, error: null };
  for (const lang of langs) {
    const have = pickSubs(folder, [lang]);
    if (have && have.lang === lang) { out.lang = lang; return out; }

    if (onStage) onStage(lang);
    const r = await runYtdlp(exe, [
      '--no-update', '--no-playlist', '--newline', '--no-warnings',
      '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', lang,
      '--sub-format', 'json3',
      // A breath between requests; the caption server rate-limits eagerly.
      '--sleep-subtitles', '1',
      '-o', path.join(folder, 'video.%(ext)s'),
      url
    ], jobId, null);

    if (r.signal) { out.error = 'cancelled'; return out; }
    const got = pickSubs(folder, [lang]);
    if (got && got.lang === lang) { out.lang = lang; return out; }
    out.error = lastError(r.stderr) || out.error;
  }
  return out;
}

ipcMain.handle('dl-start', async (event, opts) => {
  const o = opts || {};
  const url = String(o.url || '').trim();
  const dir = String(o.dir || '').trim();
  const jobId = String(o.jobId || ('job' + Date.now()));
  const langs = Array.isArray(o.langs) && o.langs.length ? o.langs : ['en', 'de', 'vi'];

  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'That is not a valid link.' };
  if (!dir) return { ok: false, error: 'No download folder is set.' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'The download folder is not a folder.' };
  } catch (e) {
    return { ok: false, error: 'The download folder is no longer there — pick it again in Settings.' };
  }
  const t = findTools();
  if (!t.ytdlp) return { ok: false, error: 'yt-dlp is not installed. Install it with:  winget install yt-dlp.yt-dlp' };
  courseRoots.add(path.resolve(dir));

  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('dl-progress', Object.assign({ jobId }, payload));
  };

  // ---- Pass 1: the video itself. Subtitles are deliberately not asked for
  // here; see fetchSubs above for why they cannot share a run.
  let finalPath = null;
  const p1 = await runYtdlp(t.ytdlp, [
    '--no-update', '--no-playlist', '--newline', '--progress', '--no-simulate',
    // Highest resolution first, then framerate; h264/AAC only breaks ties, so a
    // 4K VP9 still wins over a 1080p h264 while 1080p stays hardware-decodable.
    '-f', 'bv*+ba/b',
    '-S', 'res,fps,vcodec:h264,acodec:m4a',
    '--merge-output-format', 'mp4',
    '--no-write-subs', '--no-write-auto-subs',
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '--write-info-json',
    '--retries', '5', '--fragment-retries', '5',
    '-o', path.join(dir, '%(title).80B [%(id)s]', 'video.%(ext)s'),
    '--print', 'after_move:QLFINAL %(filepath)s',
    '--progress-template', 'download:QLPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    url
  ], jobId, (s) => {
    if (s.startsWith('QLFINAL ')) { finalPath = s.slice(8).trim(); return; }
    if (s.startsWith('QLPROG ')) {
      const [pct, speed, eta] = s.slice(7).split('|');
      send({ stage: 'download', pct: parseFloat(String(pct).replace('%', '')) || 0, speed: (speed || '').trim(), eta: (eta || '').trim() });
      return;
    }
    if (/\[Merger\]|\[VideoConvertor\]/.test(s)) send({ stage: 'merging' });
  });

  if (p1.signal || p1.code === null) return { ok: false, canceled: true, error: 'Download cancelled.' };
  if (p1.code !== 0 || !finalPath) {
    return { ok: false, error: lastError(p1.stderr) || ('yt-dlp failed (exit ' + p1.code + ').') };
  }

  const folder = path.dirname(finalPath);
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(folder, 'video.info.json'), 'utf8')); } catch (e) {}

  // ---- Pass 2: subtitles. The video is already safe by this point, so
  // anything that goes wrong here is reported but never fails the download.
  const subs = await fetchSubs(t.ytdlp, url, folder, langs, jobId, (lang) => send({ stage: 'subtitles', lang }));

  let cues = [], subLang = null;
  const picked = subs.lang ? pickSubs(folder, [subs.lang]) : pickSubs(folder, langs);
  if (picked) {
    try { cues = parseJson3(picked.file); subLang = picked.lang; } catch (e) { cues = []; }
  }

  return {
    ok: true,
    folder,
    path: finalPath,
    thumb: findByExt(folder, ['.jpg', '.jpeg', '.png', '.webp']),
    title: info.title || null,
    duration: Math.round(info.duration || 0) || null,
    uploader: info.uploader || info.channel || null,
    videoId: info.id || null,
    cues,
    subLang,
    // Worth surfacing: the video is fine, only the transcript is missing, and
    // it can be retried on its own from the Transcript tab.
    subError: cues.length ? null : (subs.error || 'No subtitles were available for this video.'),
    // Auto-generated captions carry transcription errors that later confuse a
    // summary or a quiz, so they are flagged rather than passed off as clean.
    subAuto: !!(picked && info.automatic_captions && info.automatic_captions[subLang] &&
                !(info.subtitles && info.subtitles[subLang]))
  };
});

/* Retry just the subtitles for a video already on disk — the 429 case, where
   the video downloaded fine and only the transcript is missing. */
ipcMain.handle('dl-fetch-subs', async (event, opts) => {
  const o = opts || {};
  const folder = String(o.folder || '');
  const url = String(o.url || '').trim();
  const langs = Array.isArray(o.langs) && o.langs.length ? o.langs : ['en', 'de', 'vi'];
  const jobId = String(o.jobId || ('subs' + Date.now()));

  if (!folder || !isInsideRoot(folder)) return { ok: false, error: 'That folder is outside the library.' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'That is not a valid link.' };
  const t = findTools();
  if (!t.ytdlp) return { ok: false, error: 'yt-dlp is not installed.' };

  const subs = await fetchSubs(t.ytdlp, url, folder, langs, jobId, null);
  if (subs.error === 'cancelled') return { ok: false, canceled: true, error: 'Cancelled.' };

  const picked = subs.lang ? pickSubs(folder, [subs.lang]) : pickSubs(folder, langs);
  if (!picked) {
    return { ok: false, error: /429|Too Many/i.test(subs.error || '')
      ? 'YouTube is rate-limiting caption downloads right now. Wait a minute and try again.'
      : (subs.error || 'No subtitles were available for this video.') };
  }
  try {
    return { ok: true, cues: parseJson3(picked.file), lang: picked.lang };
  } catch (e) {
    return { ok: false, error: 'The subtitle file could not be read.' };
  }
});

ipcMain.handle('dl-cancel', async (event, jobId) => {
  const child = dlJobs.get(String(jobId));
  if (!child) return { ok: false };
  try { child.kill(); } catch (e) {}
  dlJobs.delete(String(jobId));
  return { ok: true };
});

// Deletes one downloaded video's folder. Refuses anything outside a folder the
// user actually chose, so a corrupted path can never take out a wider tree.
ipcMain.handle('dl-remove', async (event, folder) => {
  const target = String(folder || '');
  if (!target || !isInsideRoot(target)) return { ok: false, error: 'Refusing to delete outside the library folder.' };
  try {
    if (!fs.statSync(target).isDirectory()) return { ok: false, error: 'Not a folder.' };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Re-reads subtitles for an already-downloaded video, so a transcript can be
// recovered without downloading the video a second time.
ipcMain.handle('dl-subs', async (event, opts) => {
  const o = opts || {};
  const folder = String(o.folder || '');
  const langs = Array.isArray(o.langs) && o.langs.length ? o.langs : ['en', 'de', 'vi'];
  if (!folder || !isInsideRoot(folder)) return { ok: false, error: 'That folder is outside the library.' };
  const picked = pickSubs(folder, langs);
  if (!picked) return { ok: false, error: 'No subtitle file was saved with this video.' };
  try {
    return { ok: true, cues: parseJson3(picked.file), lang: picked.lang };
  } catch (e) {
    return { ok: false, error: 'The subtitle file could not be read.' };
  }
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
        // Priority order, then every remaining track as a last resort — a
        // specific track's caption server can be empty even when others on
        // the same video work fine, so one bad track should not be fatal.
        var order = [];
        [tracks.find(function(t){ return t.languageCode==='en' && t.kind!=='asr'; }),
         tracks.find(function(t){ return t.languageCode==='en'; }),
         tracks.find(function(t){ return t.languageCode==='de'; }),
         tracks[0]].forEach(function(t){ if (t && order.indexOf(t)===-1) order.push(t); });
        tracks.forEach(function(t){ if (order.indexOf(t)===-1) order.push(t); });

        var lastErr = 'unknown';
        for (var i = 0; i < order.length; i++) {
          var t = order[i];
          try {
            var res = await fetch(t.baseUrl + '&fmt=json3');
            if (!res.ok) { lastErr = 'fetch'+res.status; continue; }
            var bodyText = await res.text();
            if (!bodyText || !bodyText.trim()) { lastErr = 'empty response'; continue; }
            var j;
            try { j = JSON.parse(bodyText); } catch (e) { lastErr = 'unparseable response'; continue; }
            var cues = (j.events||[]).filter(function(e){ return e.segs; }).map(function(e){
              return { t: Math.round((e.tStartMs||0)/1000),
                       text: e.segs.map(function(s){ return s.utf8; }).join('').replace(/\\n/g,' ').trim() };
            }).filter(function(c){ return c.text; });
            if (!cues.length) { lastErr = 'track had no usable cues'; continue; }
            return { cues: cues, lang: t.languageCode, auto: t.kind==='asr',
                     duration: parseInt(det.lengthSeconds||0,10), title: det.title||'' };
          } catch (e) { lastErr = String(e && e.message || e); }
        }
        return { err: 'alltracks', detail: lastErr, duration: parseInt(det.lengthSeconds||0,10), title: det.title||'' };
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`);

    if (!out) return { ok: false, error: 'Could not read the page.' };
    if (out.err === 'nocaptions') {
      return { ok: false, error: 'This video has no captions, so there is no transcript to pull.', duration: out.duration || 0, title: out.title || '' };
    }
    if (out.err === 'nopr') return { ok: false, error: 'YouTube did not return player data (it may be age-restricted or region-blocked).' };
    if (out.err === 'alltracks') {
      return { ok: false, error: 'YouTube’s caption server did not return usable captions for this video (' + out.detail + '). This is usually transient — try again in a moment.', duration: out.duration || 0, title: out.title || '' };
    }
    if (out.err) return { ok: false, error: 'Transcript failed: ' + out.err };
    if (!out.cues || !out.cues.length) return { ok: false, error: 'Captions were empty.' };

    return { ok: true, cues: out.cues, lang: out.lang, auto: out.auto, duration: out.duration || 0, title: out.title || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
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
      const r = await httpJSON(base + '/api/generate', {
        method: 'POST',
        body: {
          model,
          prompt: o.prompt,
          stream: false,
          keep_alive: normalizeKeepAlive(o.keepAlive),
          options: {
            temperature: o.temperature == null ? 0.7 : o.temperature,
            num_predict: Math.max(128, Math.min(4096, parseInt(o.maxTokens, 10) || 1200))
          }
        }
      });
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
          max_tokens: Math.max(128, Math.min(4096, parseInt(o.maxTokens, 10) || 1200)),
          messages: [{ role: 'user', content: o.prompt }]
        }
      });
      const j = r.json;
      if (j && j.error) return { ok: false, error: j.error.message || 'Anthropic error' };
      if (r.status !== 200) return { ok: false, error: 'Anthropic HTTP ' + r.status };
      return { ok: true, text: (j.content || []).map((c) => c.text || '').join('') };
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
          max_tokens: Math.max(128, Math.min(4096, parseInt(o.maxTokens, 10) || 1200)),
          messages: [{ role: 'user', content: o.prompt }]
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
