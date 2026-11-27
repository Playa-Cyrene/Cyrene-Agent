// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../../../shared/chat-types";
import type { ChatStoreApi } from "./chat-page-bridge";
import { LAST_MODE_STORAGE_KEY } from "./chat-page-normalizers";
import { ChatPage } from "./ChatPage";

const { alert, notice } = vi.hoisted(() => ({ alert: vi.fn(async () => {}), notice: vi.fn() }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({
  useFeedback: () => ({ alert, notice }),
}));
vi.mock("../components/ChatPageNavigation", () => ({ ChatPageNavigation: () => null }));
vi.mock("../components/ChatPagePanelHost", () => ({ ChatPagePanelHost: () => null }));
vi.mock("../components/ChatMessageList", () => ({ ChatMessageList: () => null }));
vi.mock("../components/ChatComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ChatComposer")>();
  return {
    ...actual,
    ChatComposer: (props: React.ComponentProps<typeof actual.ChatComposer>) => (
      <>
        <button onClick={() => props.onSubmit("A")}>Send A</button>
        <button onClick={() => props.onQueueMessage?.("A")}>Queue A</button>
        <button onClick={() => props.onQueueMessage?.("B")}>Queue B</button>
        <button onClick={() => props.onSelectSessionModel?.("new-model")}>Switch model</button>
        {props.recentProjects?.map((project) => (
          <button key={project} onClick={() => props.onSelectRecentProject?.(project)}>{project}</button>
        ))}
        <output data-testid="workspace">{props.workspaceName}</output>
        <output data-testid="waiting">{String(props.waitingToSend)}</output>
      </>
    ),
  };
});

const session: ChatSession = {
  id: "session-1", title: "Test chat", identityId: null, mode: "chat",
  messages: [], createdAt: 1, updatedAt: 1, schemaVersion: 1,
};
const recentPath = "C:/projects/removed";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.clearAllMocks();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(activeSession: ChatSession | null) {
  const unsubscribe = () => () => {};
  const store = {
    list: vi.fn(async () => activeSession ? [{ ...activeSession, messageCount: 0 }] : []),
    get: vi.fn(async () => activeSession),
    create: vi.fn<ChatStoreApi["create"]>(),
    getSidebarOrganization: vi.fn(async () => null),
    onChanged: unsubscribe,
    onSidebarOrganizationChanged: unsubscribe,
    onReactSwitchSession: unsubscribe,
    setActiveSession: vi.fn(),
    pendingList: vi.fn(async () => []),
    pendingClaim: vi.fn<ChatStoreApi["pendingClaim"]>().mockResolvedValue({ ok: true, claimed: false }),
    pendingEnqueue: vi.fn<ChatStoreApi["pendingEnqueue"]>().mockResolvedValue({ ok: true, queue: [] }),
    setSessionModel: vi.fn<ChatStoreApi["setSessionModel"]>(),
    listRecentProjects: vi.fn<ChatStoreApi["listRecentProjects"]>().mockResolvedValue([recentPath]),
    validateWorkspacePath: vi.fn<ChatStoreApi["validateWorkspacePath"]>(),
    setWorkspace: vi.fn<ChatStoreApi["setWorkspace"]>(),
  };
  vi.stubGlobal("chatStore", store);
  await act(async () => root.render(<ChatPage />));
  return store;
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("显示等待状态，模型切换提交后才入队及认领", async () => {
  const store = await render(session);
  const change = Promise.withResolvers<Awaited<ReturnType<ChatStoreApi["setSessionModel"]>>>();
  const enqueue = Promise.withResolvers<Awaited<ReturnType<ChatStoreApi["pendingEnqueue"]>>>();
  store.setSessionModel.mockReturnValue(change.promise);
  store.pendingEnqueue.mockReturnValueOnce(enqueue.promise);
  store.pendingClaim.mockClear();
  try {
    await click("Switch model");
    await click("Send A");

    expect(store.setSessionModel).toHaveBeenCalledWith(session.id, "new-model");
    expect(container.querySelector('[data-testid="waiting"]')?.textContent).toBe("true");
    expect(store.pendingEnqueue).not.toHaveBeenCalled();
    expect(store.pendingClaim).not.toHaveBeenCalled();

    await act(async () => change.resolve({ ok: true, session: { ...session, model: "new-model" } }));
    expect(store.pendingEnqueue).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({ rawContent: "A" }));
    expect(store.pendingClaim).not.toHaveBeenCalled();

    await act(async () => enqueue.resolve({ ok: true, queue: [] }));
    expect(store.pendingClaim).toHaveBeenCalledWith(session.id);
  } finally {
    // Release both deferred replies even if an assertion fails.
    await act(async () => {
      change.resolve({ ok: true, session: { ...session, model: "new-model" } });
      enqueue.resolve({ ok: true, queue: [] });
    });
  }
});

it("最近项目失效时提示重选，并保持工作区未选中", async () => {
  localStorage.setItem(LAST_MODE_STORAGE_KEY, "work");
  const store = await render(null);
  store.validateWorkspacePath.mockResolvedValue({ ok: false, error: "目录已移走" });
  await click(recentPath);

  expect(store.validateWorkspacePath).toHaveBeenCalledExactlyOnceWith(recentPath);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe("");
  expect(store.setWorkspace).not.toHaveBeenCalled();
});

it("首条消息绑定工作区失败时清除失效选择并阻止入队", async () => {
  localStorage.setItem(LAST_MODE_STORAGE_KEY, "work");
  const store = await render(null);
  store.validateWorkspacePath.mockResolvedValue({ ok: true });
  const created = { ...session, mode: "work" as const };
  store.create.mockResolvedValue(created);
  store.get.mockResolvedValue(created);
  store.setWorkspace.mockResolvedValue({ ok: false, error: "目录已移走" });
  await click(recentPath);
  expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe("removed");
  await click("Send A");

  expect(store.setWorkspace).toHaveBeenCalledExactlyOnceWith(created.id, recentPath);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe("");
  expect(store.pendingEnqueue).not.toHaveBeenCalled();
});

it.each([false, true])("草稿去重并按序入队，首条失败时可继续（失败=%s）", async (failFirst) => {
  const store = await render(session);
  const first = Promise.withResolvers<Awaited<ReturnType<ChatStoreApi["pendingEnqueue"]>>>();
  store.pendingEnqueue.mockReturnValueOnce(first.promise);
  await click("Send A");
  await click("Queue A");
  await click("Queue B");
  expect(store.pendingEnqueue.mock.calls.map(([, entry]) => entry.rawContent)).toEqual(["A"]);

  const claim = Promise.withResolvers<Awaited<ReturnType<ChatStoreApi["pendingClaim"]>>>();
  store.pendingClaim.mockReturnValueOnce(claim.promise);
  try {
    await act(async () => first.resolve(failFirst ? { ok: false, error: "enqueue failed" } : { ok: true, queue: [] }));
    expect(store.pendingEnqueue.mock.calls.map(([, entry]) => entry.rawContent)).toEqual(["A", "B"]);
    expect(notice).toHaveBeenCalledTimes(failFirst ? 1 : 0);
  } finally {
    await act(async () => claim.resolve({ ok: true, claimed: false }));
  }
});
