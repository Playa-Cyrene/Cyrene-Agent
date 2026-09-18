// 截图热键 + 表情包管理：热键捕获/录入、表情包列表渲染、添加/删除表情包
// 从 settings.ts 抽离。依赖 preferences/appearance DOM + shared/save-status + shared/shell。
// 副作用导入：模块加载时执行事件绑定 + 表情包列表加载。

import { setPreferencesSaveStatus } from "../shared/save-status";
import { screenshotHotkeyInput } from "../appearance/dom";
import { preferencesState } from "./state";
import { stickerAddError, stickerAddConfirm, stickerAddCancel, stickerAddPickBtn, stickerAddFileName, stickerAddId, stickerAddDesc, stickerAddPhrases, stickerAddOverlay } from "./dom";
import { addStickerBtn, openStickerManagerBtn } from "../shared/shell";
import { showAlert } from "../shared/modal";

// ── 截图热键捕获 ──
// 聚焦时临时挂起全局快捷键（防止录入时触发截图），失焦恢复。
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

screenshotHotkeyInput?.addEventListener("focus", async () => {
  await window.settings!.beginScreenshotHotkeyCapture();
});

screenshotHotkeyInput?.addEventListener("blur", async () => {
  await window.settings!.endScreenshotHotkeyCapture();
});

screenshotHotkeyInput?.addEventListener("keydown", (e) => {
  e.preventDefault();

  if (e.key === "Escape") {
    screenshotHotkeyInput!.blur();
    return;
  }
  if (e.key === "Enter") {
    screenshotHotkeyInput!.blur();
    return;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  // 纯修饰键不提交
  if (MODIFIER_KEYS.has(e.key)) return;

  const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(keyName);

  // 至少需要一个修饰键
  if (parts.length < 2) return;

  screenshotHotkeyInput!.value = parts.join("+");
  setPreferencesSaveStatus("有未保存的更改");
});

openStickerManagerBtn.addEventListener("click", async () => {
  console.log("[settings] open sticker manager clicked");
  try {
    const result = await window.settings?.openStickerManager();
    if (!result?.ok) {
      console.error("[settings] open sticker manager failed", result?.error);
      // 打开失败需要用户阅读错误详情：单按钮错误模态框
      await showAlert({
        tone: "error",
        title: "表情包管理窗口打开失败",
        message: "请查看终端日志后重试。",
        details: result?.error || undefined,
      });
    }
  } catch (error) {
    console.error("[settings] open sticker manager error", error);
    await showAlert({
      tone: "error",
      title: "表情包管理窗口打开失败",
      message: "请查看终端日志后重试。",
      details: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});

// ── 添加表情包弹窗 ──


function openStickerAddModal(): void {
  preferencesState.stickerAddPickedPath = null;
  stickerAddFileName.textContent = "未选择";
  stickerAddId.value = "";
  stickerAddDesc.value = "";
  stickerAddPhrases.value = "";
  stickerAddError.classList.add("is-hidden");
  stickerAddOverlay.classList.remove("is-hidden");
}

function closeStickerAddModal(): void {
  stickerAddOverlay.classList.add("is-hidden");
}

addStickerBtn.addEventListener("click", openStickerAddModal);
stickerAddCancel.addEventListener("click", closeStickerAddModal);

stickerAddPickBtn.addEventListener("click", async () => {
  const filePath = await window.settings?.stickerPickFile?.();
  if (filePath) {
    preferencesState.stickerAddPickedPath = filePath;
    const name = filePath.split(/[\\/]/).pop() || filePath;
    stickerAddFileName.textContent = name;
    if (!stickerAddId.value) {
      const baseName = name.replace(/\.[^.]+$/, "");
      stickerAddId.value = baseName.replace(/[^a-zA-Z0-9_-]/g, "");
    }
  }
});

stickerAddConfirm.addEventListener("click", async () => {
  stickerAddError.classList.add("is-hidden");

  if (!preferencesState.stickerAddPickedPath) {
    stickerAddError.textContent = "请先选择图片文件";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const id = stickerAddId.value.trim();
  if (!id) {
    stickerAddError.textContent = "请填写英文名称";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    stickerAddError.textContent = "名称只能用英文字母、数字、下划线和连字符";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const description = stickerAddDesc.value.trim();
  if (!description) {
    stickerAddError.textContent = "请填写图片描述";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const phrases = stickerAddPhrases.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (phrases.length === 0) {
    stickerAddError.textContent = "请至少写一行相近语义";
    stickerAddError.classList.remove("is-hidden");
    return;
  }

  try {
    await window.settings?.stickerAdd?.({ sourcePath: preferencesState.stickerAddPickedPath, id, description, phrases });
    closeStickerAddModal();
  } catch (err) {
    stickerAddError.textContent = "添加失败：" + (err as Error).message;
    stickerAddError.classList.remove("is-hidden");
  }
});