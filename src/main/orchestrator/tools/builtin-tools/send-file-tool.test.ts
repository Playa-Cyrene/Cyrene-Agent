import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolContext } from "../registry/tool-context";
import { sendFileTool, consumePendingSends, clearPendingSends } from "./send-file-tool";

let dir = "";

function tmpFile(name: string, data?: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data ?? "content");
  return p;
}

function ctxWith(runId?: string): ToolContext {
  return { userQuery: "发我", ...(runId ? { runId } : {}) } as ToolContext;
}

beforeEach(() => {
  clearPendingSends();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-send-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("send_file 校验", () => {
  it("文件不存在 → FILE_NOT_FOUND", async () => {
    const out = JSON.parse(await sendFileTool.execute({ path: path.join(dir, "nope.txt") }, ctxWith("r1"))) as Record<string, unknown>;
    expect(out.errorCode).toBe("FILE_NOT_FOUND");
  });

  it("目录 → NOT_A_FILE", async () => {
    const out = JSON.parse(await sendFileTool.execute({ path: dir }, ctxWith("r1"))) as Record<string, unknown>;
    expect(out.errorCode).toBe("NOT_A_FILE");
  });

  it("非绝对路径 → INVALID_PATH", async () => {
    const out = JSON.parse(await sendFileTool.execute({ path: "rel.txt" }, ctxWith("r1"))) as Record<string, unknown>;
    expect(out.errorCode).toBe("INVALID_PATH");
  });

  it("超过 100MB → FILE_TOO_LARGE", async () => {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 100 * 1024 * 1024 + 1); // 稀疏文件，秒建
    const out = JSON.parse(await sendFileTool.execute({ path: big }, ctxWith("r1"))) as Record<string, unknown>;
    expect(out.errorCode).toBe("FILE_TOO_LARGE");
  });
});

describe("send_file runId 侧存", () => {
  it("无 runId → NO_CHANNEL，不记账", async () => {
    const f = tmpFile("a.txt");
    const out = JSON.parse(await sendFileTool.execute({ path: f }, ctxWith(undefined))) as Record<string, unknown>;
    expect(out.errorCode).toBe("NO_CHANNEL");
    expect(consumePendingSends(undefined)).toEqual([]);
  });

  it("成功记账后 consume 取回并清空（二次为空）", async () => {
    const f = tmpFile("report.pdf", "%PDF fake");
    const out = JSON.parse(await sendFileTool.execute({ path: f }, ctxWith("run-A"))) as Record<string, unknown>;
    expect(out.sent).toBe(true);
    expect(out.pending).toBe(true);
    expect(out.mime).toBe("application/pdf");
    const got = consumePendingSends("run-A");
    expect(got).toHaveLength(1);
    expect(got[0]!.filePath).toBe(f);
    expect(got[0]!.name).toBe("report.pdf");
    expect(consumePendingSends("run-A")).toHaveLength(0); // 已清空
  });

  it("每轮最多 10 个，第 11 个 → TOO_MANY_FILES", async () => {
    for (let i = 0; i < 10; i++) tmpFile(`f${i}.txt`);
    for (let i = 0; i < 10; i++) {
      const out = JSON.parse(await sendFileTool.execute({ path: path.join(dir, `f${i}.txt`) }, ctxWith("run-B"))) as Record<string, unknown>;
      expect(out.sent).toBe(true);
    }
    const extra = tmpFile("f10.txt");
    const overflow = JSON.parse(await sendFileTool.execute({ path: extra }, ctxWith("run-B"))) as Record<string, unknown>;
    expect(overflow.errorCode).toBe("TOO_MANY_FILES");
    expect(consumePendingSends("run-B")).toHaveLength(10);
  });
});
