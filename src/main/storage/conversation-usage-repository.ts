/**
 * Token 用量仓储（worker 侧）：token_usage 表的全部 SQL。
 *
 * 数据按 (day, model) 聚合为一行计数器；record 是纯增量 UPSERT（单语句原子），
 * 不做读改写——hit/miss 的按调用钳制增量由主进程侧算好传入。
 * 旧 token-usage.json（v2 按天聚合）启动时一次性只读导入，源文件保留。
 */

import fs from "node:fs";
import path from "node:path";
import { ConversationDatabase } from "./conversation-database";

export interface TokenUsageDelta {
  day: string;
  model: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation: number;
  cacheUsageRequests: number;
  requests: number;
  attemptedRequests: number;
}

const USAGE_COLUMNS = "day,model,input,output,hit,miss,cache_creation,cache_usage_requests,requests,attempted_requests";

/** 导入旧 token-usage.json：day 对象直接映射为 (day, model) 行，绝对值写入。 */
export function importTokenUsage(database: ConversationDatabase): void {
  if (database.db.prepare("SELECT version FROM schema_migrations WHERE version=103").get()) return;
  const filePath = path.join(database.userDataRoot, "token-usage.json");
  let parsed: { days?: Record<string, unknown> } | null = null;
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const candidate = JSON.parse(raw) as { days?: unknown };
      if (candidate.days && typeof candidate.days === "object") parsed = candidate as { days?: Record<string, unknown> };
    }
  } catch (error) {
    console.warn("[conversation-store] 旧 token-usage.json 读取失败，保留原文件:", error);
    return;
  }
  if (!parsed) {
    database.db.prepare("INSERT INTO schema_migrations VALUES(103)").run();
    return;
  }
  database.transaction(() => {
    const upsert = database.db.prepare(`INSERT INTO token_usage(${USAGE_COLUMNS})
   VALUES(?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(day,model) DO UPDATE SET input=excluded.input, output=excluded.output, hit=excluded.hit,
   miss=excluded.miss, cache_creation=excluded.cache_creation, cache_usage_requests=excluded.cache_usage_requests,
   requests=excluded.requests, attempted_requests=excluded.attempted_requests`);
    for (const [day, value] of Object.entries(parsed!.days ?? {})) {
      if (!value || typeof value !== "object") continue;
      const dayRecord = value as Record<string, unknown>;
      const models = dayRecord.models && typeof dayRecord.models === "object"
        ? dayRecord.models as Record<string, Record<string, unknown>>
        : null;
      const entries: Array<[string, Record<string, unknown>]> = models && Object.keys(models).length > 0
        ? Object.entries(models)
        // v1 历史数据没有模型维度：整日归入「未归类」
        : [["未归类", dayRecord]];
      for (const [model, entry] of entries) {
        upsert.run(
          day, model,
          Number(entry.input) || 0, Number(entry.output) || 0,
          Number(entry.hit) || 0, Number(entry.miss) || 0,
          Number(entry.cacheCreation) || 0, Number(entry.cacheUsageRequests) || 0,
          Number(entry.requests) || 0, Number(entry.attemptedRequests) || 0,
        );
      }
    }
  });
  database.db.prepare("INSERT INTO schema_migrations VALUES(103)").run();
}

export function runUsageCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  const db = database.db;
  if (method === "usage.record") {
    const delta = args[0] as TokenUsageDelta;
    db.prepare(`INSERT INTO token_usage(${USAGE_COLUMNS})
   VALUES(?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(day,model) DO UPDATE SET
   input=input+excluded.input, output=output+excluded.output, hit=hit+excluded.hit,
   miss=miss+excluded.miss, cache_creation=cache_creation+excluded.cache_creation,
   cache_usage_requests=cache_usage_requests+excluded.cache_usage_requests,
   requests=requests+excluded.requests, attempted_requests=attempted_requests+excluded.attempted_requests`)
      .run(
        delta.day, delta.model,
        Math.max(0, delta.input), Math.max(0, delta.output),
        Math.max(0, delta.hit), Math.max(0, delta.miss),
        Math.max(0, delta.cacheCreation), Math.max(0, delta.cacheUsageRequests),
        Math.max(0, delta.requests), Math.max(0, delta.attemptedRequests),
      );
    return null;
  }
  if (method === "usage.range") {
    const dayKeys = args[0] as string[];
    if (!Array.isArray(dayKeys) || dayKeys.length === 0) return [];
    const placeholders = dayKeys.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM token_usage WHERE day IN (${placeholders}) ORDER BY day`)
      .all(...dayKeys);
  }
  if (method === "usage.clear") {
    db.exec("DELETE FROM token_usage");
    return null;
  }
  throw new Error("CONVERSATION_DATABASE_UNKNOWN_COMMAND");
}
