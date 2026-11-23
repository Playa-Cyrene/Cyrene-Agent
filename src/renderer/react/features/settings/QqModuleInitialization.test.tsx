// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import { QqModuleActionGateway } from "../../../../main/qq-modules/action-gateway";
import { isQqModuleLoopbackHost } from "../../../../main/qq-modules/listen-policy";
import type { QqModuleActionCommand, QqModuleActionResult } from "../../../../shared/qq-module-actions";
import { QqModuleActionsPanel } from "./QqModuleActionsPanel";
import { QqModuleConfigurationEditor } from "./QqModuleConfigurationEditor";

type Result = QqModuleActionResult;
const actions = "settingsPage.channels.qqModule.actions";
const editor = "settingsPage.channels.qqModule.configuration";
const ready: Result = { ok: true, state: "ready" };

function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>(done => { resolve = done; });
  return { promise, resolve };
}

function fixtureState(account: string, state: "configuration" | "configuration-saved" = "configuration", address = "127.0.0.1", enabled = true): Result {
  return { ok: true, state, configuration: {
    credentialAccountId: account, enabled, proposalRevision: 2,
    config: { configRevision: 1, expectedSelfId: account, listen: { host: address, port: 3001 },
      allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true },
  } };
}

function backend(execute: (command: QqModuleActionCommand) => Result | Promise<Result>) {
  const gateway = new QqModuleActionGateway({ execute });
  const owner = { key: {}, isAuthorized: () => true };
  return vi.fn((command: QqModuleActionCommand) => gateway.execute(command, owner));
}

let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await i18next.changeLanguage("zh-CN");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(key: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find(element => element.textContent === i18next.t(key));
}
function accountValue() {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${i18next.t(`${editor}.account`)}"]`)?.value;
}
const noOp = () => {};

it("reuses delayed status through StrictMode and re-reads after a settled unmount", async () => {
  const pending = deferred();
  const action = backend(() => pending.promise);
  const onReady = vi.fn();
  const renderPanel = () => <StrictMode><QqModuleActionsPanel action={action} onBusy={noOp} onReady={onReady} /></StrictMode>;
  await act(async () => root.render(renderPanel()));
  expect(action).toHaveBeenCalledExactlyOnceWith({ action: "status" });
  expect(button(`${actions}.install`)).toBeUndefined();
  await act(async () => pending.resolve(ready));
  expect(button(`${actions}.install`)?.disabled).toBe(false);
  expect(onReady).toHaveBeenLastCalledWith(true);

  await act(async () => root.render(null));
  await act(async () => root.render(renderPanel()));
  expect(action).toHaveBeenCalledTimes(2);
  expect(button(`${actions}.install`)?.disabled).toBe(false);
});

it("shows a delayed configuration after StrictMode replay and disables writes until it arrives", async () => {
  const pending = deferred();
  const action = backend(() => pending.promise);
  const onBusy = vi.fn();
  await act(async () => root.render(<StrictMode>
    <QqModuleConfigurationEditor action={action} onBusy={onBusy} onClose={noOp} onSaved={noOp} />
  </StrictMode>));
  expect(action).toHaveBeenCalledExactlyOnceWith({ action: "read-configuration" });
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(button(`${editor}.reload`)?.disabled).toBe(true);
  expect(accountValue()).toBeUndefined();
  await act(async () => pending.resolve(fixtureState("10001")));
  expect(accountValue()).toBe("10001");
  expect(button(`${editor}.save`)?.disabled).toBe(false);
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it.each(["127.0.0.1", "::1", "::ffff:127.0.0.2", "0:0:0:0:0:0:0:1"])("saves an enablement change without rewriting loopback %s", async address => {
  expect(isQqModuleLoopbackHost(address)).toBe(true);
  const action = backend(command => {
    if (command.action === "read-configuration") return fixtureState("10001", "configuration", address);
    if (command.action === "propose-configuration" && isQqModuleLoopbackHost(command.config.listen.host)) {
      return fixtureState("10001", "configuration-saved", command.config.listen.host, command.enabled);
    }
    throw new Error("unexpected command");
  });
  const onSaved = vi.fn();
  await act(async () => root.render(<QqModuleConfigurationEditor action={action} onBusy={noOp} onClose={noOp} onSaved={onSaved} />));
  const checkbox = Array.from(host.querySelectorAll("label")).find(label => label.textContent === i18next.t(`${editor}.enabled`))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.checked).toBe(true);
  await act(async () => checkbox!.click());
  expect(checkbox?.checked).toBe(false);
  expect(button(`${editor}.save`)?.disabled).toBe(false);
  await act(async () => button(`${editor}.save`)!.click());
  expect(action).toHaveBeenLastCalledWith(expect.objectContaining({
    action: "propose-configuration", expectedRevision: 2, enabled: false,
    config: expect.objectContaining({ listen: { host: address, port: 3001 } }),
  }));
  expect(onSaved).toHaveBeenCalledOnce();
});

it("ignores old editor data and busy callbacks after the action dependency changes", async () => {
  const older = deferred(), newer = deferred();
  const a = backend(() => older.promise), b = backend(() => newer.promise);
  const onBusy = vi.fn();
  const renderEditor = (action: typeof a) => <StrictMode>
    <QqModuleConfigurationEditor action={action} onBusy={onBusy} onClose={noOp} onSaved={noOp} />
  </StrictMode>;
  await act(async () => root.render(renderEditor(a)));
  await act(async () => root.render(renderEditor(b)));
  expect(a).toHaveBeenCalledExactlyOnceWith({ action: "read-configuration" });
  expect(b).toHaveBeenCalledExactlyOnceWith({ action: "read-configuration" });
  await act(async () => older.resolve(fixtureState("10001")));
  expect(accountValue()).toBeUndefined();
  expect(button(`${editor}.reload`)?.disabled).toBe(true);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await act(async () => newer.resolve(fixtureState("10002")));
  expect(accountValue()).toBe("10002");
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("reads fresh state after a pending save and ignores its result after an actual unmount", async () => {
  const pendingWrite = deferred();
  let current: Result = fixtureState("10001");
  const action = backend(command => {
    if (command.action === "read-configuration") return current;
    if (command.action === "propose-configuration") return pendingWrite.promise;
    throw new Error("unexpected command");
  });
  const onSaved = vi.fn();
  const renderEditor = () => <StrictMode>
    <QqModuleConfigurationEditor action={action} onBusy={noOp} onClose={noOp} onSaved={onSaved} />
  </StrictMode>;
  await act(async () => root.render(renderEditor()));
  expect(accountValue()).toBe("10001");
  await act(async () => {
    button(`${editor}.save`)!.click();
    button(`${editor}.save`)!.click();
  });
  expect(action.mock.calls.map(([command]) => command.action)).toEqual(["read-configuration", "propose-configuration"]);
  await act(async () => root.render(null));
  await act(async () => root.render(renderEditor()));
  expect(button(`${editor}.reload`)?.disabled).toBe(true);
  expect(action).toHaveBeenCalledTimes(2);
  current = fixtureState("10002");
  await act(async () => pendingWrite.resolve(fixtureState("10002", "configuration-saved")));
  expect(action.mock.calls.map(([command]) => command.action)).toEqual(["read-configuration", "propose-configuration", "read-configuration"]);
  expect(accountValue()).toBe("10002");
  expect(onSaved).not.toHaveBeenCalled();
});

it.each(["gateway failure", "IPC rejection"] as const)("allows reopening after %s", async failure => {
  const gatewayAction = backend(() => ({ ok: false, error: "operation-failed" }));
  const action = vi.fn((command: QqModuleActionCommand): Promise<Result> =>
    failure === "gateway failure" ? gatewayAction(command) : Promise.reject(new Error("IPC failure")));
  const onReady = vi.fn();
  const renderPanel = () => <StrictMode><QqModuleActionsPanel action={action} onBusy={noOp} onReady={onReady} /></StrictMode>;

  await act(async () => root.render(renderPanel()));
  expect(action).toHaveBeenCalledExactlyOnceWith({ action: "status" });
  expect(onReady).toHaveBeenLastCalledWith(false);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(i18next.t(`${actions}.failed`));

  await act(async () => root.render(null));
  action.mockResolvedValue(ready);
  await act(async () => root.render(renderPanel()));
  expect(action).toHaveBeenCalledTimes(2);
  expect(button(`${actions}.install`)?.disabled).toBe(false);
  expect(onReady).toHaveBeenLastCalledWith(true);
});

it("allows an explicit editor reload after a rejected initialization", async () => {
  const action = vi.fn<(command: QqModuleActionCommand) => Promise<Result>>()
    .mockRejectedValueOnce(new Error("IPC failure"))
    .mockResolvedValueOnce(fixtureState("10001"));
  const onBusy = vi.fn();
  await act(async () => root.render(<StrictMode>
    <QqModuleConfigurationEditor action={action} onBusy={onBusy} onClose={noOp} onSaved={noOp} />
  </StrictMode>));
  expect(action).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(i18next.t(`${editor}.failed`));
  expect(onBusy).toHaveBeenLastCalledWith(false);
  await act(async () => button(`${editor}.reload`)!.click());
  expect(action).toHaveBeenCalledTimes(2);
  expect(accountValue()).toBe("10001");
});

it("ignores an old panel status without clobbering the replacement status", async () => {
  const older = deferred(), newer = deferred();
  const a = backend(() => older.promise), b = backend(() => newer.promise);
  const onReady = vi.fn();
  const renderPanel = (action: typeof a) => <StrictMode>
    <QqModuleActionsPanel action={action} onBusy={noOp} onReady={onReady} />
  </StrictMode>;
  await act(async () => root.render(renderPanel(a)));
  await act(async () => root.render(renderPanel(b)));
  await act(async () => newer.resolve({ ok: true, state: "disabled" }));
  expect(button(`${actions}.reconfigure`)?.disabled).toBe(false);
  await act(async () => older.resolve(ready));
  expect(button(`${actions}.reconfigure`)?.disabled).toBe(false);
  expect(button(`${actions}.install`)).toBeUndefined();
  expect(onReady).toHaveBeenLastCalledWith(true);
});

it("waits for a pending status on actual remount, then reads a fresh status", async () => {
  const older = deferred(), newer = deferred();
  const action = backend(vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));
  const onReady = vi.fn();
  const renderPanel = () => <StrictMode><QqModuleActionsPanel action={action} onBusy={noOp} onReady={onReady} /></StrictMode>;
  await act(async () => root.render(renderPanel()));
  await act(async () => root.render(null));
  await act(async () => root.render(renderPanel()));
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => older.resolve(ready));
  expect(action).toHaveBeenCalledTimes(2);
  expect(button(`${actions}.install`)).toBeUndefined();
  expect(onReady).toHaveBeenLastCalledWith(false);
  await act(async () => newer.resolve({ ok: true, state: "disabled" }));
  expect(button(`${actions}.reconfigure`)?.disabled).toBe(false);
  expect(onReady).toHaveBeenLastCalledWith(true);
});
