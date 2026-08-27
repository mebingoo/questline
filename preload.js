const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge — the page can look up a school, sync a timetable,
// read YouTube metadata/transcripts, and ask the configured AI for questions.
// Nothing else is exposed.
contextBridge.exposeInMainWorld('untis', {
  search: (query) => ipcRenderer.invoke('untis-search', query),
  sync: (config) => ipcRenderer.invoke('untis-sync', config)
});

contextBridge.exposeInMainWorld('learn', {
  meta: (videoId) => ipcRenderer.invoke('yt-meta', videoId),
  transcript: (videoId) => ipcRenderer.invoke('yt-transcript', videoId),
  generate: (opts) => ipcRenderer.invoke('ai-generate', opts)
});

// Read-only: lists/loads the roadmap.json files bundled under data/roadmaps.
contextBridge.exposeInMainWorld('roadmaps', {
  listSeeds: () => ipcRenderer.invoke('roadmap-list-seeds'),
  loadSeed: (filename) => ipcRenderer.invoke('roadmap-load-seed', filename)
});

// Local course folders: picking/scanning only ever touches a folder the user
// picked through the native dialog (or a root already saved from a past pick).
contextBridge.exposeInMainWorld('courses', {
  pickFolder: () => ipcRenderer.invoke('course-pick-folder'),
  registerRoot: (rootPath) => ipcRenderer.invoke('course-register-root', rootPath),
  scanFolder: (rootPath) => ipcRenderer.invoke('course-scan-folder', rootPath)
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
