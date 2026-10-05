const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gptPort", {
  showPanel: () => ipcRenderer.invoke("show-panel"),
  showLogin: () => ipcRenderer.invoke("show-login"),
  loginStatus: () => ipcRenderer.invoke("login-status"),
  ask: (prompt, continueConversation) =>
    ipcRenderer.invoke("ask", { prompt, continueConversation: !!continueConversation }),
  newChat: () => ipcRenderer.invoke("new-chat"),
  setTheme: (t) => ipcRenderer.invoke("set-theme", t),
});
