import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// vi.hoisted runs before mocks are installed, so we compute paths using
// process.env / require("path") instead of importing "os" or "path".
const { ISOLATED_ROOT, ISOLATED_HOME } = vi.hoisted(() => {
  const pathMod = require("path") as typeof import("path");
  const root = pathMod.join(
    process.env.TEMP || process.env.TMP || "/tmp",
    `cyrene-model-status-test-${process.pid}`,
  );
  return { ISOLATED_ROOT: root, ISOLATED_HOME: pathMod.join(root, "home") };
});

vi.mock("os", async () => {
  const realOs = await vi.importActual<typeof import("os")>("os");
  return {
    ...realOs,
    homedir: () => ISOLATED_HOME,
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => ISOLATED_ROOT,
  },
}));

import {
  getProjectModelsDir,
  getProjectModelsDirCandidates,
  getProjectModelBaseDir,
  getModelInstallStatusDetail,
  getModelInstallStatus,
  checkEmbeddingModelInstalled,
  checkRerankerModelInstalled,
} from "./model-status";

// checkRerankerModelInstalled now takes no arguments (only "standard" exists)
void checkRerankerModelInstalled;

const REQUIRED_FILES = ["tokenizer.json", "tokenizer_config.json", "config.json", "onnx/model_quantized.onnx"];

function ensureFakeDir(...parts: string[]): string {
  const dir = path.join(ISOLATED_ROOT, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(dir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{}");
  }
  return dir;
}

/** Create a directory but only some of the required files (incomplete install). */
function ensurePartialFakeDir(...parts: string[]): string {
  const dir = path.join(ISOLATED_ROOT, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  // Only drop tokenizer.json — config.json + onnx/ are missing.
  fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  return dir;
}

/** Drop a fully-installed model into the simulated HF cache (~/.cache/huggingface/Xenova). */
function ensureHfCache(...parts: string[]): string {
  const dir = path.join(ISOLATED_HOME, ".cache", "huggingface", "Xenova", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(dir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{}");
  }
  return dir;
}

const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  // Restore cwd before removing tree (Windows: cannot rm cwd).
  process.chdir(ORIGINAL_CWD);
  if (fs.existsSync(ISOLATED_ROOT)) {
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(ISOLATED_ROOT, { recursive: true });
  fs.mkdirSync(ISOLATED_HOME, { recursive: true });
  // Point cwd at ISOLATED_ROOT so cwd/models points inside the isolated dir,
  // not the real project tree (which has real model dirs).
  process.chdir(ISOLATED_ROOT);
  delete process.env.CYRENE_MODELS_DIR;
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (fs.existsSync(ISOLATED_ROOT)) {
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  }
  delete process.env.CYRENE_MODELS_DIR;
});

describe("model-status: getProjectModelsDirCandidates priority", () => {
  it("returns cwd/models and app.getAppPath()/models in priority order", () => {
    const dirs = getProjectModelsDirCandidates();
    const merged = path.join(ISOLATED_ROOT, "models");
    expect(dirs).toContain(merged);
    expect(dirs.indexOf(merged)).toBe(0);
  });

  it("CYRENE_MODELS_DIR takes priority over cwd/models", () => {
    process.env.CYRENE_MODELS_DIR = path.join(ISOLATED_ROOT, "override-models");
    const dirs = getProjectModelsDirCandidates();
    expect(dirs[0]).toBe(path.join(ISOLATED_ROOT, "override-models"));
  });

  it("getProjectModelsDir() returns the highest-priority candidate", () => {
    expect(getProjectModelsDir()).toBe(path.join(process.cwd(), "models"));
  });

  it("de-duplicates candidates when multiple paths resolve to the same value", () => {
    process.env.CYRENE_MODELS_DIR = path.join(process.cwd(), "models");
    const dirs = getProjectModelsDirCandidates();
    const seen = new Set(dirs);
    expect(seen.size).toBe(dirs.length);
  });

  it("includes the directory beside the packaged executable as a model location", () => {
    expect(getProjectModelsDirCandidates()).toContain(path.join(path.dirname(process.execPath), "models"));
  });

  it("uses the directory containing the complete model instead of an earlier empty candidate", () => {
    process.env.CYRENE_MODELS_DIR = path.join(ISOLATED_ROOT, "empty-override");
    ensureFakeDir("models", "Xenova", "bge-m3");

    expect(getProjectModelBaseDir("embedding", "bgem3")).toBe(path.join(ISOLATED_ROOT, "models"));
  });
});

describe("model-status: project-side detection", () => {
  it("bgem3 installed under models/Xenova/bge-m3 → source='project'", () => {
    ensureFakeDir("models", "Xenova", "bge-m3");
    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(true);
    expect(detail.source).toBe("project");
    expect(detail.matchedAt).toBe(path.join(ISOLATED_ROOT, "models", "Xenova", "bge-m3"));
    expect(detail.existingProjectDir).toBe(path.join(ISOLATED_ROOT, "models", "Xenova", "bge-m3"));
    expect(detail.missingFiles).toEqual([]);
  });

  it("models/bge-m3 without Xenova/ prefix is NOT detected (transformers expects Xenova/bge-m3)", () => {
    // Sanity: with the canonical layout enforced, the bare 'bge-m3' dir is
    // no longer a valid candidate. transformers would look for Xenova/bge-m3
    // anyway, so detection must agree.
    ensureFakeDir("models", "bge-m3");
    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(false);
    expect(detail.existingProjectDir).toBeNull();
  });

  it("reranker-standard is detected when models/bge-reranker-base is installed", () => {
    ensureFakeDir("models", "bge-reranker-base");
    expect(checkRerankerModelInstalled()).toBe(true);
  });
});

describe("model-status: HF cache fallback semantics", () => {
  it("falls back to HF cache only when no project model directory exists", () => {
    // Project side empty
    fs.mkdirSync(path.join(ISOLATED_ROOT, "models"), { recursive: true });
    // HF cache has bgem3 fully installed
    ensureHfCache("bge-m3");

    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(true);
    expect(detail.source).toBe("hf-cache");
    expect(detail.matchedAt).toBe(
      path.join(ISOLATED_HOME, ".cache", "huggingface", "Xenova", "bge-m3"),
    );
    expect(detail.existingProjectDir).toBeNull();
  });

  it("does NOT fall back to HF cache when project Xenova/bge-m3 exists but is incomplete", () => {
    // Project has an incomplete Xenova/bge-m3 (only tokenizer.json)
    ensurePartialFakeDir("models", "Xenova", "bge-m3");
    // HF cache has full bge-m3 — must NOT mask the project-side problem
    ensureHfCache("bge-m3");

    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(false);
    expect(detail.source).toBeNull();
    expect(detail.matchedAt).toBeNull();
    expect(detail.existingProjectDir).toBe(path.join(ISOLATED_ROOT, "models", "Xenova", "bge-m3"));
    expect(detail.missingFiles).toContain("config.json");
    expect(detail.missingFiles).toContain("onnx/model_quantized.onnx");
    expect(detail.missingFiles).not.toContain("tokenizer.json");
    expect(detail.requiredFiles).toEqual(REQUIRED_FILES);
  });

  it("does NOT fall back to HF cache when bare models/bge-m3 exists (wrong layout)", () => {
    // Bare bge-m3 is NOT a valid candidate anymore — it can't satisfy
    // transformers.js either. Existing-but-incomplete status is reserved for
    // dirs that *would* be probed if their files were complete.
    ensurePartialFakeDir("models", "bge-m3");
    ensureHfCache("bge-m3");

    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    // No candidate matches → fall through to HF cache fallback
    expect(detail.installed).toBe(true);
    expect(detail.source).toBe("hf-cache");
    expect(detail.existingProjectDir).toBeNull();
  });

  it("returns installed=false with no existingProjectDir when neither project nor HF has it", () => {
    fs.mkdirSync(path.join(ISOLATED_ROOT, "models"), { recursive: true });
    // HF cache empty
    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(false);
    expect(detail.source).toBeNull();
    expect(detail.existingProjectDir).toBeNull();
    expect(detail.missingFiles).toEqual([]);
  });

  it("prefers project over HF cache even when both have a complete install", () => {
    ensureFakeDir("models", "Xenova", "bge-m3");
    ensureHfCache("bge-m3");

    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.source).toBe("project");
    expect(detail.matchedAt).toBe(path.join(ISOLATED_ROOT, "models", "Xenova", "bge-m3"));
  });
});

describe("model-status: getModelInstallStatus aggregate", () => {
  it("returns true for bgem3 when only HF cache has it but project models/ is empty", () => {
    fs.mkdirSync(path.join(ISOLATED_ROOT, "models"), { recursive: true });
    ensureHfCache("bge-m3");

    const status = getModelInstallStatus();
    expect(status.embedding.bgem3).toBe(true);
  });

  it("returns false for bgem3 when project models/Xenova/bge-m3 is incomplete (HF cache suppressed)", () => {
    ensurePartialFakeDir("models", "Xenova", "bge-m3");
    ensureHfCache("bge-m3");

    const status = getModelInstallStatus();
    expect(status.embedding.bgem3).toBe(false);
  });

  it("returns mixed installed/not-installed based on actual disk state", () => {
    ensureFakeDir("models", "Xenova", "bge-m3");
    ensureFakeDir("models", "bge-reranker-base");

    const status = getModelInstallStatus();
    expect(status.embedding.bgem3).toBe(true);
    expect(status.reranker.standard).toBe(true);
  });
});


describe("model-status: tokenizer configuration completeness", () => {
  it.each([
    { kind: "embedding" as const, key: "bgem3", parts: ["Xenova", "bge-m3"] },
    { kind: "reranker" as const, key: "standard", parts: ["bge-reranker-base"] },
  ])("rejects $kind missing only tokenizer_config.json", ({ kind, key, parts }) => {
    const dir = ensureFakeDir("models", ...parts);
    fs.unlinkSync(path.join(dir, "tokenizer_config.json"));

    const detail = getModelInstallStatusDetail(kind, key);
    expect(detail.installed).toBe(false);
    expect(detail.missingFiles).toEqual(["tokenizer_config.json"]);
    expect(detail.requiredFiles).toContain("tokenizer_config.json");
    expect(getProjectModelBaseDir(kind, key)).toBeNull();
  });

  it("recognizes a complete model in an alternate supported base directory", () => {
    const base = path.join(ISOLATED_ROOT, "override-models");
    process.env.CYRENE_MODELS_DIR = base;
    const dir = ensureFakeDir("override-models", "Xenova", "bge-m3");

    expect(getProjectModelBaseDir("embedding", "bgem3")).toBe(base);
    expect(getModelInstallStatusDetail("embedding", "bgem3").matchedAt).toBe(dir);
    // Optional tokenizer assets must not be promoted to required files.
    expect(fs.existsSync(path.join(dir, "special_tokens_map.json"))).toBe(false);
  });

  it("rejects HF cache missing only tokenizer_config.json", () => {
    const dir = ensureHfCache("bge-m3");
    fs.unlinkSync(path.join(dir, "tokenizer_config.json"));

    expect(checkEmbeddingModelInstalled("bgem3")).toBe(false);
  });

  it("does not hide a missing project tokenizer config behind a complete HF cache", () => {
    const dir = ensureFakeDir("models", "Xenova", "bge-m3");
    fs.unlinkSync(path.join(dir, "tokenizer_config.json"));
    ensureHfCache("bge-m3");

    const detail = getModelInstallStatusDetail("embedding", "bgem3");
    expect(detail.installed).toBe(false);
    expect(detail.source).toBeNull();
    expect(detail.missingFiles).toEqual(["tokenizer_config.json"]);
  });
});
