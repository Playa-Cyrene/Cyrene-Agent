import { describe, expect, it, vi } from "vitest";
import { getQqModuleInstallationStatus } from "./installation-status";
vi.mock("electron", () => { throw new Error("must not load Electron"); });
vi.mock("ws", () => { throw new Error("must not load transport"); });
vi.mock("./package-store", () => { throw new Error("must not construct installer"); });
const wsl = { "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/20" }] } as const;
describe("QQ module loopback-only preflight", () => {
  it.each(["127.0.0.1", "127.0.0.2", "127.255.255.255", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:7f00:1"])("accepts resolved loopback %s without enabling installation", (customHost) => {
    expect(getQqModuleInstallationStatus({ listenMode: "custom", customHost })).toMatchObject({ listenCompatibility: "loopback", canInstall: false });
  });
  it.each(["auto", "wsl"])("rejects %s resolving to WSL rather than silently falling back", (listenMode) => {
    const input = { listenMode };
    expect(getQqModuleInstallationStatus(input, wsl as any).listenCompatibility).toBe("unsupported-host");
    expect(input).toEqual({ listenMode });
  });
  it.each(["0.0.0.0", "::", "192.168.1.2", "172.20.0.1", "remote.example", "localhost", "[::1]", "::1%lo", "::127.0.0.1", "::ffff:192.168.1.2", "127.1", "2130706433", "0177.0.0.1"])("rejects non-loopback %s", (customHost) => {
    expect(getQqModuleInstallationStatus({ listenMode: "custom", customHost }).listenCompatibility).toBe("unsupported-host");
  });
  it("does not accept a token as remote support or a missing/invalid listen mode", () => {
    expect(getQqModuleInstallationStatus({ listenMode: "custom", customHost: "0.0.0.0", accessToken: "token" }).listenCompatibility).not.toBe("loopback");
    expect(getQqModuleInstallationStatus({ listenMode: "other" }).listenCompatibility).toBe("unresolved");
    expect(getQqModuleInstallationStatus(null).listenCompatibility).toBe("unresolved");
    expect(getQqModuleInstallationStatus({ listenMode: "custom", customHost: "" }).listenCompatibility).toBe("unresolved");
    expect(getQqModuleInstallationStatus({ listenMode: "wsl" }, {}).listenCompatibility).toBe("unresolved");
    expect(getQqModuleInstallationStatus({ listenMode: "auto" }, {}).listenCompatibility).toBe("loopback");
  });
});

it.each(["", " ", "\t\u00a0"])("reports blank decoded token without returning it", (token) => {
  expect(getQqModuleInstallationStatus({ listenMode: "loopback" }, {}, () => token)).toMatchObject({ tokenCompatibility: "required", canInstall: false });
});
it("redacts tokens and errors and does not treat presence as installation readiness", () => {
  const ready = getQqModuleInstallationStatus({ listenMode: "loopback" }, {}, () => " test-only-secret ");
  expect(ready).toMatchObject({ tokenCompatibility: "available", canInstall: false, availability: "release-unconfigured" });
  expect(JSON.stringify(ready)).not.toContain("test-only-secret");
  expect(getQqModuleInstallationStatus({}, {}, () => { throw new Error("private-secret"); }).tokenCompatibility).toBe("unresolved");
  expect(getQqModuleInstallationStatus({ listenMode: "loopback" }).tokenCompatibility).toBe("unresolved");
  for (const token of ["x".repeat(4097), "bad\r\ntoken", "bad\0token"]) {
    expect(getQqModuleInstallationStatus({ listenMode: "loopback" }, {}, () => token).tokenCompatibility).toBe("unresolved");
  }
});
