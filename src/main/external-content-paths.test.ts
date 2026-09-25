import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  findPromptPath,
  findSkillPath,
  resolveExternalContentPaths,
  resolveSkillScanSources,
} from "./external-content-paths";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-content-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveExternalContentPaths", () => {
  it("uses repository content in development", () => {
    const repository = path.resolve("E:/repo");
    const userData = path.resolve("E:/user-data");

    const result = resolveExternalContentPaths({
      isPackaged: false,
      appPath: repository,
      executablePath: path.join(repository, "node.exe"),
      userDataPath: userData,
    });

    expect(result.promptDirectories).toEqual([path.join(repository, "prompts")]);
    expect(result.builtinSkillDirectory).toBe(path.join(repository, "skills"));
    expect(result.userSkillDirectories).toEqual([path.join(userData, "skills")]);
  });

  it("keeps user-editable content in userData and shipped content beside the executable", () => {
    const installRoot = path.resolve("E:/Cyrene");
    const userData = path.resolve("E:/user-data");

    const result = resolveExternalContentPaths({
      isPackaged: true,
      appPath: path.join(installRoot, "resources", "app.asar"),
      executablePath: path.join(installRoot, "Cyrene.exe"),
      userDataPath: userData,
    });

    expect(result.promptDirectories).toEqual([
      path.join(userData, "prompts"),
      path.join(installRoot, "prompts"),
    ]);
    expect(result.builtinSkillDirectory).toBe(path.join(installRoot, "defaults", "skills"));
    expect(result.installSkillDirectory).toBe(path.join(installRoot, "skills"));
    expect(result.userSkillDirectories).toEqual([path.join(userData, "skills")]);
  });
});

describe("macOS packaging config", () => {
  it("ships prompts/skills where the packaged resolver looks for them", () => {
    // electron-builder resolves macOS `extraFiles` destinations relative to
    // Contents/ (not the app install root), unlike Windows. installRoot on
    // macOS is path.dirname(exe) = Contents/MacOS, so `to:` must be spelled
    // relative to Contents/ to land beside the executable.
    const config = load(
      fs.readFileSync(new URL("../../electron-builder.mac.yml", import.meta.url), "utf8"),
    ) as { extraFiles: Array<{ from: string; to: string }> };

    const packagedDestination = (source: string): string => {
      const entry = config.extraFiles.find((file) => file.from === source);
      if (!entry) throw new Error(`Missing macOS extraFiles entry for "${source}"`);
      return path.join("Contents", entry.to);
    };

    const contents = "Contents";
    const result = resolveExternalContentPaths({
      isPackaged: true,
      appPath: path.join(contents, "Resources", "app.asar"),
      executablePath: path.join(contents, "MacOS", "Cyrene"),
      userDataPath: "user-data",
    });

    expect(packagedDestination("prompts")).toBe(result.promptDirectories[1]);
    expect(packagedDestination("skills")).toBe(result.builtinSkillDirectory);
  });
});

describe("external content lookup", () => {
  it("prefers a user prompt and falls back to the shipped prompt", () => {
    const root = temporaryDirectory();
    const userPrompts = path.join(root, "prompts");
    const defaultPrompts = path.join(root, "defaults", "prompts");
    fs.mkdirSync(userPrompts, { recursive: true });
    fs.mkdirSync(defaultPrompts, { recursive: true });
    fs.writeFileSync(path.join(defaultPrompts, "soul.md"), "default", "utf8");

    expect(findPromptPath("soul.md", [userPrompts, defaultPrompts])).toBe(
      path.join(defaultPrompts, "soul.md"),
    );

    fs.writeFileSync(path.join(userPrompts, "soul.md"), "user", "utf8");
    expect(findPromptPath("soul.md", [userPrompts, defaultPrompts])).toBe(
      path.join(userPrompts, "soul.md"),
    );
  });

  it("prefers a user-installed skill asset over the shipped asset", () => {
    const root = temporaryDirectory();
    const builtinSkills = path.join(root, "defaults", "skills");
    const installSkills = path.join(root, "skills");
    const userDataSkills = path.join(root, "user-data", "skills");
    const relativeAsset = path.join("styles", "default.json");

    for (const directory of [builtinSkills, installSkills, userDataSkills]) {
      fs.mkdirSync(path.join(directory, "xlsx", "styles"), { recursive: true });
      fs.writeFileSync(path.join(directory, "xlsx", relativeAsset), directory, "utf8");
    }

    expect(findSkillPath("xlsx", relativeAsset, {
      builtinSkillDirectory: builtinSkills,
      userSkillDirectories: [installSkills, userDataSkills],
    })).toBe(path.join(userDataSkills, "xlsx", relativeAsset));
  });

  it("treats the legacy packaged skills folder as builtin when defaults are absent", () => {
    const root = temporaryDirectory();
    const legacySkills = path.join(root, "skills");
    const userDataSkills = path.join(root, "user-data", "skills");
    fs.mkdirSync(legacySkills, { recursive: true });

    expect(resolveSkillScanSources({
      builtinSkillDirectory: path.join(root, "defaults", "skills"),
      installSkillDirectory: legacySkills,
      userSkillDirectories: [legacySkills, userDataSkills],
    })).toEqual([
      { directory: legacySkills, source: "builtin" },
      { directory: userDataSkills, source: "user" },
    ]);
  });
});
