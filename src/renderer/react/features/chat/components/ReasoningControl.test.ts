// @vitest-environment jsdom

import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("antd", async () => {
  const React = await import("react");
  return {
    Popover: ({ children, content, open }: { children: React.ReactNode; content: React.ReactNode; open: boolean }) =>
      React.createElement(React.Fragment, null, children, open ? content : null),
    Segmented: () => null,
  };
});
vi.mock("./ReasoningEffortSlider", () => ({ ReasoningEffortSlider: () => null }));

import { ReasoningControl } from "./ReasoningControl";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let currentModel = "MiniMax-M2.7";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let getReasoningState: ReturnType<typeof vi.fn>;

async function renderControl(model: string) {
  currentModel = model;
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const Control = ReasoningControl as unknown as ComponentType<Record<string, unknown>>;
  await act(async () => {
    root!.render(createElement(Control, {
      sessionId: "session-1",
      modelProfileId: "profile-1",
      model,
    }));
  });
  await act(async () => {});
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  delete (window as Window & { chat?: unknown }).chat;
  vi.restoreAllMocks();
});

describe("ReasoningControl 模型切换", () => {
  it("同一会话和档案内从 M2.7 切到 M3 后重新启用 thinking", async () => {
    getReasoningState = vi.fn(async () => ({
      providerKey: "MiniMax",
      providerId: "minimax",
      model: currentModel,
      preference: { mode: "auto" as const },
      modelProfileId: "profile-1",
    }));
    Object.assign(window, {
      chat: { getReasoningState, setReasoning: vi.fn(async () => {}) },
    });

    const rendered = await renderControl("MiniMax-M2.7");
    const button = rendered.querySelector<HTMLButtonElement>(".cy-reasoning-control")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("始终开启");

    await renderControl("MiniMax-M3");

    expect(getReasoningState).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("off");
  });
});
