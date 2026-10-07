const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelDock', {
  // ChatGPT panel controls (inherited from ChatDock)
  showPanel: () => ipcRenderer.invoke('show-panel'),
  showLogin: () => ipcRenderer.invoke('show-login'),
  toggleLogin: () => ipcRenderer.invoke('toggle-login'),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  ask: (prompt, continueConversation) =>
    ipcRenderer.invoke('ask', { prompt, continueConversation: !!continueConversation }),
  newChat: () => ipcRenderer.invoke('new-chat'),
  setTheme: (t) => ipcRenderer.invoke('set-theme', t),
  setTemporaryChat: (temporary) => ipcRenderer.invoke('set-temporary-chat', !!temporary),

  // Multi-model credential sync (ModelDock extension)
  syncGeminiCookies: () => ipcRenderer.invoke('sync-gemini-cookies'),
  syncDeepSeekToken: () => ipcRenderer.invoke('sync-deepseek-token'),
  switchBrowserTab: (provider) => ipcRenderer.invoke('switch-browser-tab', provider),
});
