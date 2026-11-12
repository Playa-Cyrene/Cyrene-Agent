import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ready: vi.fn(() => true), fork: vi.fn() }));
vi.mock("electron", () => ({ app: { isReady: mocks.ready }, utilityProcess: { fork: mocks.fork } }));
import { createQqUtilityProcess } from "./utility-process";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qq-utility-")); mocks.ready.mockReturnValue(true); mocks.fork.mockReset(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it("uses explicit cwd, no exec flags, and a whitelist environment without inherited secrets", async () => {
  const entry = join(root, "entry.cjs"); writeFileSync(entry, "");
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); mocks.fork.mockReturnValue(child);
  vi.stubEnv("QQ_ACCESS_TOKEN", "secret"); vi.stubEnv("NODE_OPTIONS", "--inspect");
  vi.stubEnv("HTTP_PROXY", "http://user:password@example.com");
  const transport = createQqUtilityProcess(root, entry);
  const options = mocks.fork.mock.calls[0]?.[2];
  expect(options).toMatchObject({ cwd: root, execArgv: [], stdio: "ignore" });
  expect(options.env).not.toHaveProperty("QQ_ACCESS_TOKEN"); expect(options.env).not.toHaveProperty("NODE_OPTIONS"); expect(options.env).not.toHaveProperty("HTTP_PROXY");
  const listener = vi.fn(); const off = transport.onMessage(listener); child.emit("message", { test: true }); expect(listener).toHaveBeenCalledWith({ test: true });
  off(); expect(child.listenerCount("message")).toBe(0); const terminated = transport.terminate(); expect(child.kill).toHaveBeenCalledOnce(); child.emit("exit", 0); await terminated;
});
it("requires app readiness and keeps entry inside the selected directory", () => {
  const packageRoot = join(root, "package"); mkdirSync(packageRoot);
  const outside = join(root, "outside.cjs"); writeFileSync(outside, "");
  mocks.ready.mockReturnValue(false); expect(() => createQqUtilityProcess(root, outside)).toThrow("APP_NOT_READY"); mocks.ready.mockReturnValue(true);
  expect(() => createQqUtilityProcess(packageRoot, outside)).toThrow("ENTRY_OUTSIDE_PACKAGE");
  expect(() => createQqUtilityProcess("relative", outside)).toThrow("INVALID_PATH");
  expect(mocks.fork).not.toHaveBeenCalled();
});
it.skipIf(process.platform === "win32")("resolves symlinks before checking entry containment (Windows reparse smoke remains separate)", () => {
  const packageRoot = join(root, "package"); mkdirSync(packageRoot);
  const outside = join(root, "outside.cjs"); writeFileSync(outside, "");
  const link = join(packageRoot, "entry.cjs"); symlinkSync(outside, link);
  expect(() => createQqUtilityProcess(packageRoot, link)).toThrow("ENTRY_OUTSIDE_PACKAGE"); expect(mocks.fork).not.toHaveBeenCalled();
});

it("uses a nonempty environment even with no inherited allowlisted variables", () => {
  const entry = join(root, "entry.cjs"); writeFileSync(entry, "");
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); mocks.fork.mockReturnValue(child);
  for (const key of ["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG"]) vi.stubEnv(key, undefined);
  createQqUtilityProcess(root, entry);
  expect(mocks.fork.mock.calls[0]?.[2].env).toEqual({ QFCA_RUNTIME: "1" });
});
it("captures fatal process errors without leaking the raw diagnostic report", () => {
  const entry = join(root, "entry.cjs"); writeFileSync(entry, "");
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); mocks.fork.mockReturnValue(child);
  const transport = createQqUtilityProcess(root, entry); const error = vi.fn(); const detach = transport.onError!(error);
  expect(() => child.emit("error", "FatalError", "secret-location", { token: "secret" })).not.toThrow();
  expect(error).toHaveBeenCalledExactlyOnceWith(); detach();
  expect(() => child.emit("error", "FatalError", "late-secret")).not.toThrow();
});
it("does not equate a successful kill call with confirmed child exit", async () => {
  vi.useFakeTimers();
  try {
    const entry = join(root, "entry.cjs"); writeFileSync(entry, "");
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(() => true) }); mocks.fork.mockReturnValue(child);
    const transport = createQqUtilityProcess(root, entry);
    const termination = transport.terminate(); const assertion = expect(termination).rejects.toThrow("TERMINATION_FAILED");
    await vi.advanceTimersByTimeAsync(1000); await assertion;
  } finally { vi.useRealTimers(); }
});
