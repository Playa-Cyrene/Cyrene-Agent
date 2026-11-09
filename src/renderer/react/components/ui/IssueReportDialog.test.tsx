// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueReportDialog } from "./IssueReportDialog";

let root: Root;
let host: HTMLDivElement;
const openExternal = vi.fn();

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("system", { openExternal });
  openExternal.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  await i18next.changeLanguage("zh-CN");
});

it.each(["zh-CN", "en", "ja-JP"])("%s 报告问题显示新反馈邮箱，并向对应地址打开邮件草稿", async (locale) => {
  await i18next.changeLanguage(locale);
  await act(async () => root.render(<IssueReportDialog open onOpenChange={() => {}} />));
  await act(async () => document.querySelector<HTMLButtonElement>(".cy-issue-report__source-option")!.click());
  const contact = document.querySelector<HTMLButtonElement>(".cy-issue-report__contact button")!;
  expect(contact.textContent).toBe("Liang_zh_@outlook.com");
  expect(document.querySelector(".cy-issue-report__contacts")?.textContent).not.toContain("ky2569ly@gmail.com");
  await act(async () => contact.click());
  expect(openExternal).toHaveBeenCalledOnce();
  const mailto = new URL(openExternal.mock.calls[0][0]);
  expect(mailto.protocol).toBe("mailto:");
  expect(mailto.pathname).toBe("Liang_zh_@outlook.com");
  expect(mailto.searchParams.get("subject")).toBeTruthy();
  expect(document.querySelector('.cy-issue-report__contact a')?.getAttribute("href"))
    .toBe("https://github.com/Playa-Cyrene/Cyrene-Agent/issues");
});
