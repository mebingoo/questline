const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge — the page can look up a school, sync a timetable,
// read YouTube metadata/transcripts, and ask the configured AI for questions.
// Nothing else is exposed.
contextBridge.exposeInMainWorld('untis', {
  search: (query) => ipcRenderer.invoke('untis-search', query),
  sync: (config) => ipcRenderer.invoke('untis-sync', config)
});

// Local course folders: pick one, read its tree, re-authorise a saved one.
contextBridge.exposeInMainWorld('courses', {
  pick: () => ipcRenderer.invoke('courses-pick'),
  scan: (dir) => ipcRenderer.invoke('courses-scan', dir),
  allow: (dir) => ipcRenderer.invoke('courses-allow', dir),
  reveal: (target) => ipcRenderer.invoke('courses-reveal', target)
});

// All that is left of the Learn tab: a quest can carry a resource link, and a
// YouTube one gets its real title looked up instead of showing the raw URL.
contextBridge.exposeInMainWorld('learn', {
  meta: (videoId) => ipcRenderer.invoke('yt-meta', videoId)
});

// The AI provider layer. Ollama is the default and runs on this machine.
contextBridge.exposeInMainWorld('ai', {
  complete: (opts) => ipcRenderer.invoke('ai-complete', opts),
  models: (opts) => ipcRenderer.invoke('ai-models', opts),
  // How much the selected model can actually hold, so prompts are sized from
  // the model rather than from a constant.
  context: (opts) => ipcRenderer.invoke('ai-context', opts),
  health: (opts) => ipcRenderer.invoke('ai-health', opts),
  status: (opts) => ipcRenderer.invoke('ai-status', opts),
  unload: (opts) => ipcRenderer.invoke('ai-unload', opts),
  providers: () => ipcRenderer.invoke('ai-provider-list')
});

// The always-on-top reference board window: open/close it, and let the board
// itself control the frame it lives in (opacity, pin, minimise).
contextBridge.exposeInMainWorld('refsCtl', {
  open: () => ipcRenderer.invoke('refs-open'),
  close: () => ipcRenderer.invoke('refs-close'),
  isOpen: () => ipcRenderer.invoke('refs-is-open'),
  setOpacity: (v) => ipcRenderer.invoke('refs-set-opacity', v),
  setPinned: (p) => ipcRenderer.invoke('refs-set-pinned', p),
  minimize: () => ipcRenderer.invoke('refs-minimize')
});

// Export / import everything. The renderer builds the snapshot (state and the
// IndexedDB stores are only reachable there); this side picks the file and
// writes the bytes. onRequest is how the updater asks for one before it
// restarts the app.
contextBridge.exposeInMainWorld('backup', {
  version: () => ipcRenderer.invoke('app-version'),
  pickFolder: () => ipcRenderer.invoke('backup-pick-folder'),
  save: (name, text) => ipcRenderer.invoke('backup-save', { name, text }),
  open: () => ipcRenderer.invoke('backup-open'),
  auto: (opts) => ipcRenderer.invoke('backup-auto-write', opts),
  skip: () => ipcRenderer.invoke('backup-auto-skip'),
  onRequest: (cb) => {
    const fn = (_e, data) => { try { cb(data); } catch (err) {} };
    ipcRenderer.on('backup-request', fn);
    return () => ipcRenderer.removeListener('backup-request', fn);
  }
});

// Read-only: lists/loads the roadmap.json files bundled under data/roadmaps.
contextBridge.exposeInMainWorld('roadmaps', {
  listSeeds: () => ipcRenderer.invoke('roadmap-list-seeds'),
  loadSeed: (filename) => ipcRenderer.invoke('roadmap-load-seed', filename)
});

// Shared by both the main window (toggles/configures the widget) and the
// widget window itself (resizes its own frame, jumps back to the main window).
contextBridge.exposeInMainWorld('widgetCtl', {
  openWidget: () => ipcRenderer.invoke('widget-open'),
  closeWidget: () => ipcRenderer.invoke('widget-close'),
  isWidgetOpen: () => ipcRenderer.invoke('widget-is-open'),
  resize: (w, h) => ipcRenderer.invoke('widget-resize', { w, h }),
  openMain: () => ipcRenderer.invoke('widget-open-main'),
  getPrefs: () => ipcRenderer.invoke('prefs-get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs-set', patch)
});
