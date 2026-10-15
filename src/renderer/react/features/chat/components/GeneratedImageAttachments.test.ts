// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImageAttachment } from "../../../../../shared/generated-image";
import { GeneratedImageAttachments } from "./GeneratedImageAttachments";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const attachment: GeneratedImageAttachment = {
  id: "image-1",
  kind: "image",
  name: "generated-image.png",
  filePath: "C:\\managed\\generated-image.png",
  mime: "image/png",
  source: "model",
  byteLength: 20,
  status: "done",
};

const roots: Root[] = [];

async function renderAttachments(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(GeneratedImageAttachments, { attachments: [attachment] }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("GeneratedImageAttachments", () => {
  it("shows an unavailable state when the managed image is missing", async () => {
    Object.assign(window, {
      chat: {
        getImagePreview: vi.fn(async () => ({ ok: false, error: "file missing" })),
        saveGeneratedImage: vi.fn(async () => ({ ok: false, cancelled: true })),
      },
    });

    const host = await renderAttachments();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(host.textContent).toContain("图片文件不可用");
    expect(host.querySelector<HTMLButtonElement>(".cy-attachment__trigger")?.disabled).toBe(true);
  });

  it("opens a full preview and treats save cancellation as a quiet result", async () => {
    const getImagePreview = vi.fn(async () => ({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
    const saveGeneratedImage = vi.fn(async () => ({ ok: false, cancelled: true }));
    Object.assign(window, { chat: { getImagePreview, saveGeneratedImage } });

    const host = await renderAttachments();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trigger = host.querySelector<HTMLButtonElement>(".cy-attachment__trigger");
    expect(trigger).not.toBeNull();

    await act(async () => { trigger!.click(); });
    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe(attachment.name);

    const close = document.querySelector<HTMLButtonElement>(".cy-generated-image-preview__close");
    await act(async () => {
      close?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();

    const save = host.querySelector<HTMLButtonElement>(".cy-attachment__action");
    await act(async () => { save?.click(); });
    expect(saveGeneratedImage).toHaveBeenCalledWith(attachment.filePath, attachment.name);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
