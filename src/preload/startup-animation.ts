// Dedicated sandbox preload; no application settings, file access or general IPC bridge.
import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  const video = document.querySelector("video");
  if (!video) return; // The same window can fall back to the original Loading page.
  const report = (message: string) => ipcRenderer.send("startup-animation:event", message);
  video.muted = true;
  video.addEventListener("ended", () => report("ended"));
  video.addEventListener("error", () => report("failed"));
  document.querySelector("button")?.addEventListener("click", () => report("skip"));
  void ipcRenderer.invoke("startup-animation:config").then(async ({ video: source, reopen }) => {
    if (reopen) document.querySelector("button")?.remove();
    video.src = source;
    await video.play();
    report("playing");
  }).catch(() => report("failed"));
});
