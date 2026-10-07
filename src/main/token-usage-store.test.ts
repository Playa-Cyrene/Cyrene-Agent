import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUsageToDay,
  clearUsage,
  getUsageReport,
  recordRequest,
  recordUsage,
  type TokenUsageDay,
} from "./token-usage-store";
import { closeConversationDatabases } from "./storage/conversation-database-client";

const mocks = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userDataDir },
}));

const temporaryRoots: string[] = [];

afterEach(async () => {
  // 先关 DB worker（Windows 下打开的 sqlite 文件不能删），再清临时目录。
  await closeConversationDatabases().catch(() => {});
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("usage store round-trip", () => {
  it("imports legacy JSON, records usage, and reports per-model aggregates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-token-usage-"));
    temporaryRoots.push(root);
    mocks.userDataDir = root;
    // 旧 v2 JSON：含模型维度的一天 + 无模型维度的历史天（日期相对今天，保证落在查询窗口内）
    const dayKey = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    fs.writeFileSync(path.join(root, "token-usage.json"), JSON.stringify({
      schemaVersion: 2,
      days: {
        [dayKey(3)]: {
          input: 100, output: 20, hit: 40, miss: 60, cacheCreation: 0, requests: 2,
          cacheUsageRequests: 1, attemptedRequests: 3,
          models: { "glm-a": { input: 100, output: 20, hit: 40, miss: 60, cacheCreation: 0, requests: 2, cacheUsageRequests: 1, attemptedRequests: 3 } },
        },
        [dayKey(5)]: { input: 50, output: 10, hit: 0, miss: 0, cacheCreation: 0, requests: 1 },
      },
    }), "utf8");

    recordUsage(30, 6, 1, 8, "glm-b", 4);
    recordRequest("glm-b");
    // UPSERT 增量在同一 worker 队列内串行；等待落库完成后再查报表
    await closeConversationDatabases();

    const report = await getUsageReport(7);
    const byModel = new Map(report.models.map((item) => [item.model, item]));
    // 导入的旧数据（含无模型维度的历史天归入未归类）
    expect(byModel.get("glm-a")).toMatchObject({ input: 100, output: 20, hit: 40, miss: 60, requests: 2, attemptedRequests: 3 });
    expect(byModel.get("未归类")).toMatchObject({ input: 50, output: 10, requests: 1 });
    // 新记录的按调用钳制增量（cachedInput 8 钳到 input 30 → hit 8 / miss 22）
    expect(byModel.get("glm-b")).toMatchObject({ input: 30, output: 6, hit: 8, miss: 22, cacheCreation: 4, requests: 1, attemptedRequests: 1 });

    // 清空后归零
    await clearUsage();
    await closeConversationDatabases();
    const cleared = await getUsageReport(7);
    expect(cleared.models).toEqual([]);
    expect(cleared.days.every((day) => day.input === 0 && day.requests === 0)).toBe(true);
  });
});

describe("applyUsageToDay", () => {
  it("tracks cache coverage for a model only when the provider reports cached input", () => {
    const day: TokenUsageDay = {
      input: 0,
      output: 0,
      hit: 0,
      miss: 0,
      cacheCreation: 0,
      requests: 0,
    };

    applyUsageToDay(day, 20, 4, 1, 8, "test-model");
    applyUsageToDay(day, 10, 2, 1, undefined, "test-model");

    expect(day.models?.["test-model"]).toEqual({
      input: 30,
      output: 6,
      hit: 8,
      miss: 12,
      cacheCreation: 0,
      requests: 2,
      cacheUsageRequests: 1,
    });
  });
});

describe("clearUsage", () => {
  it("removes every stored day and model record", () => {
    const days: Record<string, TokenUsageDay> = {
      "2026-08-16": {
        input: 20,
        output: 4,
        hit: 8,
        miss: 12,
        cacheCreation: 0,
        requests: 1,
        cacheUsageRequests: 1,
        models: {
          "test-model": { input: 20, output: 4, hit: 8, miss: 12, cacheCreation: 0, requests: 1, cacheUsageRequests: 1 },
        },
      },
    };

    clearUsage(days);

    expect(days).toEqual({});
  });
});
