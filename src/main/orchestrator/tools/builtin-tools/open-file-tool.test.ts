import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// electron 在本环境没有二进制；open_file 在 execute 内 require("electron")，这里 mock 掉。
const openPath = vi.fn(async (_p: string): Promise<string> => "");
vi.mock("electron", () => ({ shell: { openPath: (...a: unknown[]) => openPath(...(a as [string])) } }));

import { openFileTool } from "./open-file-tool";

async function run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await openFileTool.execute(args)) as Record<string, unknown>;
}

let dir = "";
let file = "";

beforeEach(() => {
  openPath.mockReset();
  openPath.mockResolvedValue("");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-open-"));
  file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "hi");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("open_file", () => {
  it("openPath 返回空串 → 成功", async () => {
    const out = await run({ path: file });
    expect(out.success).toBe(true);
    expect(out.opened).toBe(true);
    expect(openPath).toHaveBeenCalledWith(file);
  });

  it("openPath 返回错误串 → OPEN_FAILED", async () => {
    openPath.mockResolvedValue("No app associated");
    const out = await run({ path: file });
    expect(out.success).toBe(false);
    expect(out.errorCode).toBe("OPEN_FAILED");
    expect(out.error).toBe("No app associated");
  });

  it("非绝对路径 → INVALID_PATH，且不碰 shell", async () => {
    const out = await run({ path: "relative.txt" });
    expect(out.errorCode).toBe("INVALID_PATH");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("文件不存在 → FILE_NOT_FOUND", async () => {
    const out = await run({ path: path.join(dir, "missing.txt") });
    expect(out.errorCode).toBe("FILE_NOT_FOUND");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("传目录而非文件 → NOT_A_FILE", async () => {
    const out = await run({ path: dir });
    expect(out.errorCode).toBe("NOT_A_FILE");
    expect(openPath).not.toHaveBeenCalled();
  });
});
