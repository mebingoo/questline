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

contextBridge.exposeInMainWorld('learn', {
  meta: (videoId) => ipcRenderer.invoke('yt-meta', videoId),
  transcript: (videoId) => ipcRenderer.invoke('yt-transcript', videoId),
  generate: (opts) => ipcRenderer.invoke('ai-generate', opts),
  complete: (opts) => ipcRenderer.invoke('ai-complete', opts)
});

// The AI provider layer. Ollama is the default and runs on this machine.
contextBridge.exposeInMainWorld('ai', {
  complete: (opts) => ipcRenderer.invoke('ai-complete', opts),
  models: (opts) => ipcRenderer.invoke('ai-models', opts),
  health: (opts) => ipcRenderer.invoke('ai-health', opts),
  status: (opts) => ipcRenderer.invoke('ai-status', opts),
  unload: (opts) => ipcRenderer.invoke('ai-unload', opts),
  providers: () => ipcRenderer.invoke('ai-provider-list')
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
