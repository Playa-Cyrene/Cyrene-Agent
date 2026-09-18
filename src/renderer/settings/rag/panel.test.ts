// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

// RAG 面板迁移后的行为验证：
// 1. 模型切换失败回滚并显示共享错误模态框（而非 window.alert）
// 2. 删除模型缓存走共享危险确认弹窗（而非私有 _showModal 副本）

function addModelCard(value: string): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "rag-model-card";
  card.dataset.value = value;
  document.body.appendChild(card);
  return card;
}

describe("RAG settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    window.localStorage.clear();
    addModelCard("bgem3");
    addModelCard("text-embedding-3");
    // 删除按钮在模块加载前就位，事件绑定才能生效
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.id = "embedding-delete-btn";
    document.body.appendChild(deleteBtn);
  });

  it("rolls back and shows a shared error alert when the embedding switch fails", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    Object.assign(window, {
      settings: {
        embeddingSetModel: vi.fn(async () => ({ ok: false, error: "维度不兼容" })),
      },
    });

    await import("./panel");
    await Promise.resolve();

    const first = document.querySelector('.rag-model-card[data-value="bgem3"]') as HTMLButtonElement;
    first.classList.add("is-active");
    const second = document.querySelector('.rag-model-card[data-value="text-embedding-3"]') as HTMLButtonElement;
    second.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalled();
    // 失败回滚：原卡片恢复激活态
    expect(first.classList.contains("is-active")).toBe(true);
    expect(second.classList.contains("is-active")).toBe(false);
    // 共享错误模态框出现并带异常详情
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("模型切换失败");
    expect(dialog!.textContent).toContain("维度不兼容");
    alertSpy.mockRestore();
  });

  it("confirms model deletion through the shared dangerous modal focused on cancel", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    Object.assign(window, {
      settings: {
        deleteEmbeddingModel: vi.fn(async () => ({ ok: true })),
      },
    });

    await import("./panel");
    await Promise.resolve();

    (document.getElementById("embedding-delete-btn") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalled();
    // 共享危险确认弹窗出现：danger 样式 + 默认聚焦取消按钮
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog).not.toBeNull();
    expect(dialog!.classList.contains("is-hidden")).toBe(false);
    const modal = dialog!.querySelector(".cy-modal");
    expect(modal!.classList.contains("cy-modal--danger")).toBe(true);
    expect(dialog!.textContent).toContain("删除模型");
    expect(document.activeElement?.textContent).toBe("取消");
    alertSpy.mockRestore();
  });
});
