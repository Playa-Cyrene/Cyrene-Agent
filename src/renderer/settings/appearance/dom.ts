// Appearance 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const appearanceForm = document.getElementById("appearance-form") as HTMLFormElement;
export const appearanceSaveStatus = document.getElementById("appearance-save-status") as HTMLElement;
export const runtimeSyncSelect = document.getElementById("runtime-sync") as HTMLElement;
export const runtimeSyncNote = document.getElementById("runtime-sync-note") as HTMLElement;
export const windowCornerRadiusInput = document.getElementById("window-corner-radius") as HTMLInputElement;
export const windowCornerRadiusVal = document.getElementById("window-corner-radius-val") as HTMLElement;
export const petAlwaysOnTopInput = document.getElementById("pet-always-on-top") as HTMLInputElement;
export const petVisibleInput = document.getElementById("pet-visible") as HTMLInputElement;
export const petZoomInput = document.getElementById("pet-zoom") as HTMLInputElement;
export const petZoomVal = document.getElementById("pet-zoom-val") as HTMLElement;
export const chatLineHeightInput = document.getElementById("chat-line-height") as HTMLInputElement;
export const chatLineHeightVal = document.getElementById("chat-line-height-val") as HTMLElement;
export const chatParaSpacingInput = document.getElementById("chat-para-spacing") as HTMLInputElement;
export const chatParaSpacingVal = document.getElementById("chat-para-spacing-val") as HTMLElement;
export const launchAtLoginInput = document.getElementById("launch-at-login") as HTMLInputElement;
export const uiFontCurrent = document.getElementById("ui-font-current") as HTMLElement;
export const uiFontImportButton = document.getElementById("ui-font-import") as HTMLButtonElement;
export const uiFontResetButton = document.getElementById("ui-font-reset") as HTMLButtonElement;
export const uiIconSelect = document.getElementById("ui-icon-select") as HTMLElement;
export const screenshotHotkeyInput = document.getElementById("screenshot-hotkey-input") as HTMLInputElement | null;
export const openChromeGpu = document.getElementById("open-chrome-gpu") as HTMLElement;
export const disableGpuInput = document.getElementById("disable-gpu-electron") as HTMLInputElement;
export const sidebarVisibleInput = document.getElementById("sidebar-visible") as HTMLInputElement;
export const tasksVisibleInput = document.getElementById("tasks-visible") as HTMLInputElement;
export const rememberWindowStateInput = document.getElementById("remember-window-state") as HTMLInputElement;
export const toastSoundEnabledInput = document.getElementById("toast-sound-enabled") as HTMLInputElement;
