// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import { QqModuleDiagnosticsPanel } from "./QqModuleDiagnosticsPanel";
let host: HTMLDivElement, root: Root;
const absent = { status: "absent" as const };
const diagnostics = { schemaVersion: 1, startupMode: "legacy", manualReviewRequired: false, stores: { migration: absent, firstSetup: absent, recovery: absent, driverOwnership: absent, adoption: absent } };
beforeEach(async () => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 await i18next.changeLanguage("zh-CN");
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it("reads only on explicit request and has no reset/unlock controls", async () => {
 const action = vi.fn().mockResolvedValue({ ok: true, state: "diagnostics", diagnostics });
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={action} disabled={false} />));
 expect(action).not.toHaveBeenCalled();
 await act(async () => host.querySelector("button")!.click());
 expect(action).toHaveBeenCalledExactlyOnceWith({ action: "read-diagnostics" });
 expect(host.textContent).toContain("不证明进程已停止");
 expect(host.querySelectorAll("button")).toHaveLength(1);
 expect(host.textContent).toContain("不要删除锁");
 expect(host.textContent).not.toContain("发现需要人工核查");
});
it("blocks duplicate requests and rejects unexpected secret-bearing results", async () => {
 let complete!: (v: unknown) => void;
 const action = vi.fn().mockImplementation(() => new Promise(r => { complete = r; }));
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={action} disabled={false} />));
 await act(async () => { host.querySelector("button")!.click(); host.querySelector("button")!.click(); });
 expect(action).toHaveBeenCalledOnce();
 await act(async () => complete({ ok: true, state: "diagnostics", diagnostics: { ...diagnostics, token: "must-not-display" } }));
 expect(host.textContent).toContain("诊断暂不可用"); expect(host.textContent).not.toContain("must-not-display");
});
it("disabled and unmounted panels never initiate or render late diagnostics", async () => {
 const action = vi.fn().mockResolvedValue({ ok: true, state: "diagnostics", diagnostics });
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={action} disabled />));
 await act(async () => host.querySelector("button")!.click()); expect(action).not.toHaveBeenCalled();
});
it("ignores an old action response without unlocking a newer request", async () => {
 let oldDone!: (v: unknown) => void, newDone!: (v: unknown) => void;
 const oldAction = vi.fn().mockImplementation(() => new Promise(r => { oldDone = r; }));
 const newAction = vi.fn().mockImplementation(() => new Promise(r => { newDone = r; }));
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={oldAction} disabled={false} />));
 await act(async () => host.querySelector("button")!.click());
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={newAction} disabled={false} />));
 await act(async () => host.querySelector("button")!.click());
 await act(async () => oldDone({ ok: true, state: "diagnostics", diagnostics }));
 expect(host.querySelector("button")!.disabled).toBe(true); expect(host.querySelector("ul")).toBeNull();
 await act(async () => newDone({ ok: true, state: "diagnostics", diagnostics }));
 expect(host.querySelector("button")!.disabled).toBe(false); expect(host.querySelector("ul")).not.toBeNull();
});

it("highlights an interrupted migration without offering an unsafe recovery action", async () => {
 const report = { ...diagnostics, startupMode: "blocked", manualReviewRequired: true,
  stores: { ...diagnostics.stores, migration: { status: "incomplete" } } };
 const action = vi.fn().mockResolvedValue({ ok: true, state: "diagnostics", diagnostics: report });
 await act(async () => root.render(<QqModuleDiagnosticsPanel action={action} disabled={false} />));
 await act(async () => host.querySelector("button")!.click());
 expect(host.textContent).toContain("旧驱动迁移: 未完成记录");
 expect(host.textContent).toContain("发现需要人工核查");
 expect(host.querySelectorAll("button")).toHaveLength(1);
});
