import * as fs from "node:fs";
import { createRequire } from "node:module";
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
    expect(result.builtinSkillDirectory).toBe(path.join(installRoot, "skills"));
    expect(result.userSkillDirectories).toEqual([path.join(userData, "skills")]);
  });
});

describe("macOS packaging config", () => {
  // macOS 配置由 electron-builder.yml 派生（scripts/packaging/mac-builder-config.cjs），
  // 这里读取真实主配置做变换，主配置后续增删条目会直接反映到断言里。
  const require = createRequire(import.meta.url);
  const { buildMacConfig, loadMacBuilderConfig } = require("../../scripts/packaging/mac-builder-config.cjs") as {
    buildMacConfig: (base: Record<string, unknown>) => MacBuilderConfig;
    loadMacBuilderConfig: () => MacBuilderConfig;
  };
  type MacBuilderConfig = {
    extraFiles: Array<{ from: string; to: string }>;
    extraResources: Array<{ from: string; to: string }>;
    asarUnpack: string[];
    files: string[];
    win?: unknown;
    nsis?: unknown;
    publish?: unknown;
    mac: { target: string[]; electronLanguages?: string[] };
  };
  const base = load(fs.readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8")) as {
    asarUnpack: string[];
    files: string[];
    extraResources: Array<{ from: string }>;
    win: { electronLanguages: string[] };
  };
  const config = loadMacBuilderConfig();

  it("ships prompts/skills where the packaged resolver looks for them", () => {
    // electron-builder resolves macOS `extraFiles` destinations relative to
    // Contents/ (not the app install root), unlike Windows. installRoot on
    // macOS is path.dirname(exe) = Contents/MacOS, so `to:` must be spelled
    // relative to Contents/ to land beside the executable.
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

  it("drops Windows-only resources and installer/update sections", () => {
    const resources = config.extraResources.map((entry) => entry.from);
    expect(resources.some((from) => /\.exe$|resources\/bin\/mpv|resources\/mingit/.test(from))).toBe(false);
    expect(resources).toEqual(expect.arrayContaining(["resources/components", "vendor/cyrene-skills"]));
    expect(config.win).toBeUndefined();
    expect(config.nsis).toBeUndefined();
    expect(config.publish).toBeUndefined();
    expect(config.mac.target).toEqual(["dir"]);
    expect(config.mac.electronLanguages).toEqual(base.win.electronLanguages);
  });

  it("inherits the main config's unpack rules and file filters, adjusted for macOS", () => {
    expect(config.asarUnpack).toEqual(base.asarUnpack.filter((pattern) => !pattern.includes("vendor/srt-win")));
    expect(config.files).toContain("!vendor/srt-win/**/*");
    // 保留 macOS 的 ONNX Runtime，排除 Windows 的
    expect(config.files).not.toContain("!**/onnxruntime-node/bin/napi-v3/darwin/**/*");
    expect(config.files).toContain("!**/onnxruntime-node/bin/napi-v3/win32/**/*");
    for (const pattern of base.files.filter((item) => !item.includes("onnxruntime-node"))) {
      expect(config.files).toContain(pattern);
    }
  });

  it("picks up entries later added to the main config without editing the mac config", () => {
    const derived = buildMacConfig({
      ...base,
      asarUnpack: [...base.asarUnpack, "**/node_modules/new-native-dep/**"],
      extraFiles: [{ from: "new-folder", to: "new-folder" }],
    });
    expect(derived.asarUnpack).toContain("**/node_modules/new-native-dep/**");
    expect(derived.extraFiles).toEqual([{ from: "new-folder", to: "MacOS/new-folder" }]);
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
    const builtinSkills = path.join(root, "install", "skills");
    const userDataSkills = path.join(root, "user-data", "skills");
    const relativeAsset = path.join("styles", "default.json");

    for (const directory of [builtinSkills, userDataSkills]) {
      fs.mkdirSync(path.join(directory, "xlsx", "styles"), { recursive: true });
      fs.writeFileSync(path.join(directory, "xlsx", relativeAsset), directory, "utf8");
    }

    expect(findSkillPath("xlsx", relativeAsset, {
      builtinSkillDirectory: builtinSkills,
      userSkillDirectories: [userDataSkills],
    })).toBe(path.join(userDataSkills, "xlsx", relativeAsset));
  });

  it("scans the shipped skills folder as builtin and the userData folder as user", () => {
    const root = temporaryDirectory();
    const installSkills = path.join(root, "install", "skills");
    const userDataSkills = path.join(root, "user-data", "skills");
    fs.mkdirSync(installSkills, { recursive: true });
    fs.mkdirSync(userDataSkills, { recursive: true });

    expect(resolveSkillScanSources({
      builtinSkillDirectory: installSkills,
      userSkillDirectories: [userDataSkills],
    })).toEqual([
      { directory: installSkills, source: "builtin" },
      { directory: userDataSkills, source: "user" },
    ]);
  });
});
