// RAG / Embedding / Reranker 面板：模型切换、状态检查
// 从 settings.ts 抽离。完全自含（IIFE 闭包 + localStorage + window.settings IPC）。
// 副作用导入：模块加载时执行事件绑定 + 状态初始化。
// 模型文件由用户自行放置到 models/ 目录（见 docs/local-models.md），应用内不再提供下载/删除。

import { showNotice, showAlert } from "../shared/modal";

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