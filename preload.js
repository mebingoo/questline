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
