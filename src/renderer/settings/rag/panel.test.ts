// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

// RAG 面板迁移后的行为验证：
// 模型切换失败回滚并显示共享错误模态框（而非 window.alert）

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
});
