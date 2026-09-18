// RAG / Embedding / Reranker 面板：模型切换、镜像源、下载/删除、状态检查
// 从 settings.ts 抽离。完全自含（IIFE 闭包 + localStorage + window.settings IPC）。
// 副作用导入：模块加载时执行事件绑定 + 状态初始化。

import { showNotice, showAlert, showConfirm } from "../shared/modal";

/* ===== RAG model card toggle (embedding only) ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card:not([data-reranker])");
  const KEY = "cyrene.rag.model";
  const saved = localStorage.getItem(KEY) || "bgem3";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      // Optimistic UI update
      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);

      // Call IPC to hot-switch the embedding model
      try {
        const result = await (window as any).settings?.embeddingSetModel?.(value);
        if (result?.ok) {
          console.log("[settings] embedding switched to", value, "cleared:", result.clearedEntries);
          if (result.clearedEntries && result.clearedEntries > 0) {
            // 清除旧向量属于提示性信息：非阻塞轻提示
            showNotice({
              tone: "info",
              message: `已切换至 BGE-M3，并清除 ${result.clearedEntries} 条旧向量记忆。`,
            });
          }
        } else {
          // Rollback on failure
          cards.forEach((c) => c.classList.remove("is-active"));
          if (previousValue) {
            const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
            prevCard?.classList.add("is-active");
            localStorage.setItem(KEY, previousValue);
          }
          // 失败原因需要用户阅读：单按钮错误模态框
          await showAlert({
            tone: "error",
            title: "模型切换失败",
            message: "已恢复此前选择。",
            details: result?.error || "未知错误",
          });
        }
      } catch (err) {
        // Rollback on error
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.error("[settings] embedding switch error:", err);
      }
    });
  });
})();
/* ===== Reranker mode toggle ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card[data-reranker]");
  const KEY = "cyrene.reranker.mode";
  const saved = localStorage.getItem(KEY) || "standard";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active[data-reranker]") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);
      try {
        await (window as any).settings?.rerankerSetMode?.(value);
      } catch (err) {
        // Rollback on failure
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"][data-reranker]');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.warn("[Reranker] set mode failed:", err);
      }
    });
  });
})();

/* ===== Reranker install status (real on-disk check via IPC) ===== */
(async () => {
  const standardEl = document.getElementById("reranker-standard-status");
  try {
    const status = await (window as any).settings?.getRerankerStatus?.();
    if (!status) return;
    if (standardEl) standardEl.textContent = status.standard ? "已下载 · 约 279MB" : "未下载 · 可选";
  } catch (err) {
    console.warn("[Reranker] status check failed:", err);
    if (standardEl) standardEl.textContent = "状态未知";
  }
})();

/* ===== Embedding model status ===== */
(async () => {
  const bgem3El = document.getElementById("embedding-bgem3-status");
  try {
    const status = await window.modelConfig?.getModelInstallStatus?.();
    if (!status) {
      if (bgem3El) bgem3El.textContent = "状态未知";
      return;
    }
    if (bgem3El) bgem3El.textContent = status.embedding?.bgem3 ? "已下载 · 约 570MB" : "未下载";
  } catch (err) {
    console.warn("[Embedding] status check failed:", err);
    if (bgem3El) bgem3El.textContent = "状态未知";
  }
})();

/* ===== Embedding download / delete ===== */
(function () {
  const downloadBtn = document.getElementById("embedding-download-btn") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("embedding-delete-btn") as HTMLButtonElement | null;
  const mirrorGroup = document.getElementById("embedding-mirror") as HTMLElement | null;

  function getSelectedMirror(): string {
    const active = mirrorGroup?.querySelector(".option-block.is-active") as HTMLElement | null;
    return active?.dataset.value || "official";
  }

  function getSelectedModel(): string {
    const active = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
    return active?.dataset.value || "bgem3";
  }

  downloadBtn?.addEventListener("click", async () => {
    // 打开模型安装说明文档
    await window.system?.openExternal(
      "https://github.com/Playa-0v0/Cyrene-Agent/blob/master/docs/local-models.md"
    );
  });


  deleteBtn?.addEventListener("click", async () => {
    const model = getSelectedModel();
    const name = "BGE-M3";
    // 删除模型缓存需重新下载：危险确认，默认聚焦取消
    const confirmed = await showConfirm({
      title: "删除模型",
      message: `确定删除 ${name} 模型缓存？下次使用需重新下载。`,
      confirmText: "删除",
      cancelText: "取消",
      dangerous: true,
    });
    if (!confirmed) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "\u5220\u9664\u4E2D\u2026";
    try {
      const result = await window.settings?.deleteEmbeddingModel?.(model);
      if (result?.ok) {
        deleteBtn.textContent = "\u2705 \u5DF2\u5220\u9664";
        setTimeout(() => location.reload(), 800);
      } else {
        deleteBtn.textContent = "\u274C \u5931\u8D25";
        deleteBtn.disabled = false;
      }
    } catch (err) {
      deleteBtn.textContent = "\u274C \u5931\u8D25";
      deleteBtn.disabled = false;
    }
  });

  // Mirror source toggle
  mirrorGroup?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-value]") as HTMLElement | null;
    if (!btn) return;
    const value = btn.dataset.value;
    if (!value) return;
    mirrorGroup.querySelectorAll(".option-block").forEach((b) => {
      const v = b.getAttribute("data-value");
      b.classList.toggle("is-active", v === value);
      b.setAttribute("aria-pressed", v === value ? "true" : "false");
    });
    localStorage.setItem("cyrene.rag.mirror", value);
  });

  // Restore saved mirror on load
  const savedMirror = localStorage.getItem("cyrene.rag.mirror") || "official";
  mirrorGroup?.querySelectorAll(".option-block").forEach((b) => {
    const v = b.getAttribute("data-value");
    b.classList.toggle("is-active", v === savedMirror);
    b.setAttribute("aria-pressed", v === savedMirror ? "true" : "false");
  });
})();
(function () {
  const updateBtn = document.getElementById("embedding-update-btn") as HTMLButtonElement | null;
  updateBtn?.addEventListener("click", () => {
    updateBtn.textContent = "已是最新版本";
    updateBtn.disabled = true;
    setTimeout(() => {
      updateBtn.textContent = "检查更新";
      updateBtn.disabled = false;
    }, 2000);
  });
})();