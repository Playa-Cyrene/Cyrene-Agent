import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CURRENT_DISCLAIMER_VERSION, hasCurrentDisclaimerConsent } from "../../shared/disclaimer";

const electron = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => electron.userData } }));

beforeEach(() => {
  vi.resetModules();
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-consent-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(electron.userData, { recursive: true, force: true });
});

it("does not migrate legacy or missing consent into acceptance, and persists explicit acceptance across restart", async () => {
  let settings = await import("./settings-facade");
  expect(hasCurrentDisclaimerConsent(settings.loadGeneralSettings().disclaimerAcceptedVersion)).toBe(false);
  settings.saveGeneralSettings({ disclaimerAcceptedVersion: "2026-09-27" });
  vi.resetModules();
  settings = await import("./settings-facade");
  expect(settings.loadGeneralSettings().disclaimerAcceptedVersion).toBe("2026-09-27");
  expect(hasCurrentDisclaimerConsent(settings.loadGeneralSettings().disclaimerAcceptedVersion)).toBe(false);
  settings.saveGeneralSettings({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  vi.resetModules();
  settings = await import("./settings-facade");
  expect(hasCurrentDisclaimerConsent(settings.loadGeneralSettings().disclaimerAcceptedVersion)).toBe(true);
});

it("does not advance cached or persisted consent if disk writing fails", async () => {
  const settings = await import("./settings-facade");
  settings.saveGeneralSettings({ disclaimerAcceptedVersion: "2026-09-27" });
  const { getGeneralSettingsPath } = await import("../settings-store");
  const file = getGeneralSettingsPath();
  const previousContents = fs.readFileSync(file);
  fs.rmSync(file);
  fs.mkdirSync(file);
  expect(() => settings.saveGeneralSettings({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION })).toThrow();
  expect(settings.loadGeneralSettings().disclaimerAcceptedVersion).toBe("2026-09-27");
  fs.rmdirSync(file);
  fs.writeFileSync(file, previousContents);
  vi.resetModules();
  const reloaded = await import("./settings-facade");
  expect(reloaded.loadGeneralSettings().disclaimerAcceptedVersion).toBe("2026-09-27");
});
