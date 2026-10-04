"use strict";

// Test-only bridge: the hidden fixture uses the chat window's isolation settings.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chat", {
  saveGeneratedImage: (id) => ipcRenderer.invoke("preview:save-original", id),
});
