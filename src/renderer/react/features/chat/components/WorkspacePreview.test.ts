// @vitest-environment jsdom
import * as React from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePreviewContent, WorkspacePreviewContext, type WorkspacePreview } from "./WorkspacePreview";
import { GeneratedImageAttachments } from "./GeneratedImageAttachments";
import { MermaidBlock } from "./MermaidBlock";

vi.mock("../../../i18n", () => ({
  t: (key: string) => key,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const image: WorkspacePreview = {
  kind: "image",
  attachment: {
    kind: "image", id: "fixture", source: "model", status: "done", name: "fixture.png",
    filePath: "fixture.png", mime: "image/png", byteLength: 42,
    previewUrl: "data:image/png;base64,iVBORw0KGgo=",
  },
};
const svg: WorkspacePreview = {
  kind: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(preview: WorkspacePreview, active = true) {
  await act(async () => root.render(createElement(WorkspacePreviewContent, { preview, active })));
}
async function click(selector: string, scope: ParentNode = document) {
  const element = scope.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => element!.click());
}

describe("workspace preview lifecycle", () => {
  it.each([image, svg])("closes $kind zoom back to its workspace preview", async (preview) => {
    await render(preview);
    await click(".cy-workspace-preview__zoom", host);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await click(preview.kind === "image" ? ".cy-generated-image-preview__close" : ".ant-modal-close");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".cy-workspace-preview__zoom")).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".cy-workspace-preview__zoom"));
  });

  it.each([image, svg])("removes $kind zoom immediately when its tab becomes inactive", async (preview) => {
    await render(preview);
    await click(".cy-workspace-preview__zoom", host);
    await render(preview, false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(preview, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("replaces an expanded image with a diagram without retaining the old overlay", async () => {
    await render(image);
    await click(".cy-workspace-preview__zoom", host);
    await render(svg);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(".cy-workspace-preview__zoom", host);
    expect(document.querySelector('.cy-svg-preview')).not.toBeNull();
    expect(document.querySelector('.cy-generated-image-preview')).toBeNull();
  });

  it("removes the portal when its workspace/session is unmounted", async () => {
    await render(image);
    await click(".cy-workspace-preview__zoom", host);
    await act(async () => root.render(null));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.cy-generated-image-preview__overlay')).toBeNull();
  });

  it("opens images in the workspace, retaining the original modal outside a workspace", async () => {
    const open = vi.fn();
    if (image.kind !== "image") throw new Error("expected image fixture");
    const card = createElement(GeneratedImageAttachments, { attachments: [image.attachment] });
    await act(async () => root.render(createElement(WorkspacePreviewContext.Provider, { value: open }, card)));
    await click('[aria-label="messageList.generatedImagePreview"]', host);
    expect(open).toHaveBeenCalledWith(image);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(card));
    await click('[aria-label="messageList.generatedImagePreview"]', host);
    expect(document.querySelector('.cy-generated-image-preview')).not.toBeNull();
  });

  it("routes a real Mermaid card to the workspace and allows a centered modal without rerouting", async () => {
    const open = vi.fn();
    await act(async () => root.render(createElement(WorkspacePreviewContext.Provider, { value: open },
      createElement(MermaidBlock, { code: "graph TD\nA[Start] --> B[End]" }))));
    await click('.cy-mermaid--zoomable', host);
    expect(open).toHaveBeenCalledTimes(1);
    const preview = open.mock.calls[0][0] as WorkspacePreview;
    expect(preview.kind).toBe("svg");
    await act(async () => root.render(createElement(WorkspacePreviewContext.Provider, { value: open },
      createElement(WorkspacePreviewContent, { preview }))));
    await click('.cy-workspace-preview__zoom', host);
    expect(document.querySelector('.ant-modal-centered .cy-svg-preview')).not.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
