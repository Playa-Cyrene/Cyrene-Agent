// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DragEvent } from "react";
import { useComposerAttachments, type ComposerAttachmentsApi } from "./useComposerAttachments";
import type { ComposerAttachment } from "../components/ChatComposer";
import { t } from "../../../i18n";

// 统一反馈入口的稳定 spy：断言附件链路的提示/失败走语义化反馈而非浏览器默认弹窗
const feedbackSpies = vi.hoisted(() => ({
  notice: vi.fn(),
  alert: vi.fn(() => Promise.resolve()),
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../../components/feedback/FeedbackProvider", () => ({
  useFeedback: () => feedbackSpies,
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: ComposerAttachmentsApi;
let insertCallback: ((data: { mime: "image/png"; filePath: string; previewUrl: string; hasAnnotations: boolean }) => void) | undefined;
let activeScope = "other";
const patchMessageAttachments = vi.fn();

const chatMock = {
  ingestDroppedFiles: vi.fn(),
  saveScreenshotTemp: vi.fn(),
  startScreenshot: vi.fn(),
  onScreenshotInsert: vi.fn((cb: typeof insertCallback) => {
    insertCallback = cb;
    return () => {};
  }),
  getImageSendStrategy: vi.fn(),
  captionImage: vi.fn(),
};

function mountProbe() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  function Probe() {
    // 固定输入：scopeKey 指向 s1，截图插入目标由 activeScope 变量控制
    latest = useComposerAttachments({
      scopeKey: "s1",
      getActiveScope: () => activeScope,
      patchMessageAttachments: (sessionId, messageId, updater) => patchMessageAttachments(sessionId, messageId, updater),
    });
    return null;
  }
  act(() => {
    root!.render(createElement(Probe));
  });
}

function dragEvent(types: string[], files: File[] = []) {
  return {
    dataTransfer: { types, files, dropEffect: "" },
    preventDefault: vi.fn(),
  } as unknown as DragEvent<HTMLElement>;
}

beforeEach(() => {
  insertCallback = undefined;
  activeScope = "other";
  patchMessageAttachments.mockClear();
  chatMock.ingestDroppedFiles.mockReset();
  chatMock.saveScreenshotTemp.mockReset();
  chatMock.startScreenshot.mockReset();
  chatMock.onScreenshotInsert.mockClear();
  chatMock.getImageSendStrategy.mockReset();
  chatMock.captionImage.mockReset();
  vi.stubGlobal("chat", chatMock);
  feedbackSpies.notice.mockClear();
  feedbackSpies.alert.mockClear().mockReturnValue(Promise.resolve());
  feedbackSpies.confirm.mockClear().mockReturnValue(Promise.resolve(true));
  let blobSeq = 0;
  (URL as unknown as { createObjectURL: (o: unknown) => string }).createObjectURL = vi.fn(() => `blob:${++blobSeq}`);
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountProbe();
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
  vi.unstubAllGlobals();
});

describe("useComposerAttachments", () => {
  it("粘贴超限图片直接拒绝且不落临时文件", async () => {
    const big = new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" });
    await act(async () => {
      await latest.handlePastedImage(big);
    });
    // 超限走非阻塞警告轻提示，而不是浏览器默认弹窗
    expect(feedbackSpies.notice).toHaveBeenCalledWith(expect.objectContaining({
      tone: "warning",
      message: t("chatPage.pastedImageTooLargeSkipped"),
    }));
    expect(chatMock.saveScreenshotTemp).not.toHaveBeenCalled();
    expect(latest.attachments).toHaveLength(0);
    expect(latest.attachmentBusy).toBe(false);
  });

  it("chooseFiles 摄入失败走错误轻提示且附件不追加", async () => {
    chatMock.ingestDroppedFiles.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await latest.chooseFiles([new File(["x"], "a.png", { type: "image/png" })]);
    });
    expect(feedbackSpies.notice).toHaveBeenCalledWith(expect.objectContaining({
      tone: "error",
      message: expect.stringContaining("boom"),
    }));
    expect(latest.attachments).toHaveLength(0);
    expect(latest.attachmentBusy).toBe(false);
  });

  it("粘贴图片落临时文件后追加进当前 scope", async () => {
    chatMock.saveScreenshotTemp.mockResolvedValue({ filePath: "C:/tmp/shot.png" });
    const file = new File(["x"], "paste.png", { type: "image/png" });
    await act(async () => {
      await latest.handlePastedImage(file);
    });
    expect(latest.attachments).toHaveLength(1);
    expect(latest.attachments[0]).toMatchObject({
      kind: "image",
      name: "paste.png",
      filePath: "C:/tmp/shot.png",
      mime: "image/png",
      previewUrl: "blob:1",
    });
    expect(latest.attachmentBusy).toBe(false);
  });

  it("chooseFiles 只给图片配本地预览，非图片附件保持原样", async () => {
    chatMock.ingestDroppedFiles.mockResolvedValue([
      { kind: "image", name: "photo.png" },
      { kind: "document", name: "report.txt" },
    ]);
    const photo = new File(["x"], "photo.png", { type: "image/png" });
    const notes = new File(["x"], "notes.txt", { type: "text/plain" });
    await act(async () => {
      await latest.chooseFiles([photo, notes]);
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(latest.attachments).toHaveLength(2);
    expect(latest.attachments[0]).toMatchObject({ kind: "image", name: "photo.png", previewUrl: "blob:1" });
    expect(latest.attachments[1]).toMatchObject({ kind: "document", name: "report.txt" });
    expect(latest.attachments[1].previewUrl).toBeUndefined();
  });

  it("chooseFiles 全程忙碌态正确翻转", async () => {
    let resolveIngest!: (value: ComposerAttachment[]) => void;
    chatMock.ingestDroppedFiles.mockImplementation(
      () => new Promise<ComposerAttachment[]>((resolve) => { resolveIngest = resolve; }),
    );
    const pending = latest.chooseFiles([new File(["x"], "a.png", { type: "image/png" })]);
    await act(async () => {});
    expect(latest.attachmentBusy).toBe(true);
    resolveIngest([]);
    await act(async () => {
      await pending;
    });
    expect(latest.attachmentBusy).toBe(false);
  });

  it("direct 策略一次性标记直传完成，不请求视觉描述", async () => {
    chatMock.getImageSendStrategy.mockResolvedValue({ mode: "direct" });
    await act(async () => {
      await latest.prepareImageAttachments("sess-1", "msg-1", [
        { kind: "image", name: "a.png", filePath: "a.png" },
        { kind: "document", name: "b.txt" },
      ]);
    });
    expect(chatMock.captionImage).not.toHaveBeenCalled();
    expect(patchMessageAttachments).toHaveBeenCalledTimes(1);
    const [sessionId, messageId, updater] = patchMessageAttachments.mock.calls[0];
    expect(sessionId).toBe("sess-1");
    expect(messageId).toBe("msg-1");
    const next = updater([
      { kind: "image", name: "a.png", filePath: "a.png" },
      { kind: "document", name: "b.txt" },
    ]);
    expect(next[0]).toMatchObject({ imageSendMode: "direct", status: "done" });
    expect(next[1]).toMatchObject({ kind: "document" });
  });

  it("caption 策略逐图走 processing/done/error 三态", async () => {
    chatMock.getImageSendStrategy.mockResolvedValue({ mode: "caption" });
    chatMock.captionImage
      .mockResolvedValueOnce({ ok: true, caption: "一只猫" })
      .mockResolvedValueOnce({ ok: false });
    await act(async () => {
      await latest.prepareImageAttachments("sess-1", "msg-1", [
        { kind: "image", name: "a.png", filePath: "a.png" },
        { kind: "image", name: "b.png", filePath: "b.png" },
      ]);
    });
    // 每张图两次 patch（processing + 终态），共 4 次
    expect(patchMessageAttachments).toHaveBeenCalledTimes(4);
    const apply = (index: number) => {
      const updater = patchMessageAttachments.mock.calls[index][2] as (list: ComposerAttachment[]) => ComposerAttachment[];
      return updater([{ kind: "image", name: "x.png", filePath: index < 2 ? "a.png" : "b.png" }])[0];
    };
    expect(apply(0)).toMatchObject({ status: "processing", imageSendMode: "caption" });
    expect(apply(1)).toMatchObject({ status: "done", imageSendMode: "caption", caption: "一只猫" });
    expect(apply(2)).toMatchObject({ status: "processing", imageSendMode: "caption" });
    // 失败且无 error 时回退到固定文案 key
    expect(apply(3)).toMatchObject({ status: "error", reason: t("chatPage.imageCaptionFailed") });
  });

  it("拖拽深度计数：嵌套 enter/leave 不误关，drop 复位", () => {
    const { onDragEnter, onDragLeave, onDrop, onDragOver } = latest.dragHandlers;
    const filesEvt = () => dragEvent(["Files"]);
    act(() => { onDragEnter(filesEvt()); });
    act(() => { onDragEnter(filesEvt()); });
    expect(latest.isDraggingFiles).toBe(true);
    act(() => { onDragLeave(filesEvt()); });
    expect(latest.isDraggingFiles).toBe(true);
    act(() => { onDragLeave(filesEvt()); });
    expect(latest.isDraggingFiles).toBe(false);
    // 非文件拖拽完全忽略
    act(() => { onDragEnter(dragEvent(["text/plain"])); });
    expect(latest.isDraggingFiles).toBe(false);
    const over = dragEvent(["Files"]);
    act(() => { onDragOver(over); });
    expect(over.preventDefault).toHaveBeenCalled();
    act(() => {
      onDragEnter(filesEvt());
      onDrop(dragEvent(["Files"], [new File(["x"], "d.png", { type: "image/png" })]));
    });
    expect(latest.isDraggingFiles).toBe(false);
  });

  it("截图插入监听按激活 scope 追加，clear/delete 语义互不越界", () => {
    expect(chatMock.onScreenshotInsert).toHaveBeenCalledTimes(1);
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/s1.png", previewUrl: "shot-preview", hasAnnotations: true });
    });
    // 插入目标是 activeScope（other），不属于当前 scopeKey（s1）
    expect(latest.attachments).toHaveLength(0);
    activeScope = "s1";
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/s2.png", previewUrl: "shot-preview-2", hasAnnotations: false });
    });
    expect(latest.attachments).toHaveLength(1);
    expect(latest.attachments[0]).toMatchObject({ filePath: "C:/tmp/s2.png", previewUrl: "shot-preview-2", hasAnnotations: false });
    // 按下标移除
    act(() => { latest.removeAttachment(0); });
    expect(latest.attachments).toHaveLength(0);
    // 清空当前 scope：写入的是空数组而非删除键（快照传入当前全部附件）
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/s3.png", previewUrl: "p3", hasAnnotations: false });
    });
    act(() => { latest.clearScopeAttachments(latest.attachments.map((attachment) => ({ ...attachment }))); });
    expect(latest.attachments).toHaveLength(0);
    // 删除整个 mode scope（键消失，与清空不同）
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/s4.png", previewUrl: "p4", hasAnnotations: false });
    });
    act(() => { latest.deleteScopeAttachments("mode:chat"); });
    expect(latest.attachments).toHaveLength(1);
  });

  it("clearScopeAttachments 带快照只移除随消息发送的附件，期间新加的保留", () => {
    // 截图插入目标切换到当前 scope（s1）后依次插入两张
    activeScope = "s1";
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/a.png", previewUrl: "pa", hasAnnotations: false });
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/b.png", previewUrl: "pb", hasAnnotations: false });
    });
    const sent = latest.attachments.map((attachment) => ({ ...attachment }));
    // 入队请求期间用户又加了一张
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/c.png", previewUrl: "pc", hasAnnotations: false });
    });
    expect(latest.attachments).toHaveLength(3);
    // 只清随消息发送的 a/b：请求期间新加的 c 保留
    act(() => { latest.clearScopeAttachments(sent); });
    expect(latest.attachments).toHaveLength(1);
    expect(latest.attachments[0]).toMatchObject({ filePath: "C:/tmp/c.png" });
  });

  it("clearScopeAttachments 空快照不清任何附件：发送时无附件，请求期间新加的必须保留", () => {
    activeScope = "s1";
    // 发送瞬间没有任何附件（空快照）
    const sent: ComposerAttachment[] = [];
    // 入队请求期间用户加了两张
    act(() => {
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/x.png", previewUrl: "px", hasAnnotations: false });
      insertCallback!({ mime: "image/png", filePath: "C:/tmp/y.png", previewUrl: "py", hasAnnotations: false });
    });
    // 空快照清理后：期间新加的附件原样保留
    act(() => { latest.clearScopeAttachments(sent); });
    expect(latest.attachments).toHaveLength(2);
    expect(latest.attachments.map((attachment) => attachment.filePath)).toEqual(["C:/tmp/x.png", "C:/tmp/y.png"]);
  });

  it("卸载时释放全部本地 objectURL", async () => {
    chatMock.ingestDroppedFiles.mockResolvedValue([{ kind: "image", name: "a.png" }]);
    await act(async () => {
      await latest.chooseFiles([new File(["x"], "a.png", { type: "image/png" })]);
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  });
});