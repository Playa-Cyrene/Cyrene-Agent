/**
 * 跨语言数据审计（第 7 轮独立复测新增）：
 * 对 zh-CN / en / ja-JP 三个 bundle 分别构建静态索引，从"数据可达性"角度找问题——
 * 每条目必须能用自身标题搜到自己、折叠后必须仍有可匹配字符、标题不得以句末标点结尾；
 * 同时输出命名空间覆盖、同名分组、分区分部等诊断，供可达性矩阵与人工核对使用。
 */
import { describe, expect, it } from "vitest";
import zh from "../../i18n/zh-CN.json";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja-JP.json";
import { buildSettingEntries, fold, searchSettings, type SettingsSearchEntry } from "./settingsSearchIndex";

const LOCALES = [
  ["zh-CN", zh],
  ["en", en],
  ["ja-JP", ja],
] as const;

function flatten(value: unknown, prefix: string, out: string[]): void {
  if (typeof value === "string") {
    if (prefix) out.push(prefix);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

const SENTENCE_END = /[。！？；.!?;…]$/;

describe("跨语言索引数据审计", () => {
  const facts: Array<[string, SettingsSearchEntry[]]> = LOCALES.map(([locale, bundle]) => [locale, buildSettingEntries(bundle)]);

  it("每个语言的每条目都能用自己的标题搜到自己（前 40 条内）", () => {
    const failures: string[] = [];
    for (const [locale, entries] of facts) {
      for (const entry of entries) {
        const hits = searchSettings(entries, entry.label, 40);
        if (!hits.some((hit) => hit.kind === "setting" && hit.settingKey === entry.settingKey)) {
          failures.push(`[${locale}] ${entry.settingKey} label=${JSON.stringify(entry.label)}`);
        }
      }
    }
    expect(failures, `自搜失败 ${failures.length} 条`).toEqual([]);
  });

  it("条目标题折叠后仍有可匹配字符（否则任何查询都搜不到它）", () => {
    const failures: string[] = [];
    for (const [locale, entries] of facts) {
      for (const entry of entries) {
        if (fold(entry.label).length === 0) {
          failures.push(`[${locale}] ${entry.settingKey} label=${JSON.stringify(entry.label)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("句末标点与省略号结尾的文案不会被收成标题", () => {
    const failures: string[] = [];
    for (const [locale, entries] of facts) {
      for (const entry of entries) {
        if (SENTENCE_END.test(entry.label)) failures.push(`[${locale}] ${entry.settingKey} label=${JSON.stringify(entry.label)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("诊断输出：命名空间覆盖、同名分组、分区分部", () => {
    for (const [locale, bundle] of LOCALES) {
      const keys: string[] = [];
      flatten(bundle, "", keys);
      const namespaces = new Set<string>();
      const topLevel = new Set<string>();
      for (const key of keys) {
        topLevel.add(key.split(".")[0]);
        if (key.startsWith("settingsPage.")) namespaces.add(key.slice("settingsPage.".length).split(".")[0]);
      }
      console.log(`[${locale}] 条目=${buildSettingEntries(bundle).length} 命名空间=${[...namespaces].sort().join(",")}`);
      console.log(`[${locale}] 顶层=${[...topLevel].sort().join(",")}`);
    }
    for (const [locale, entries] of facts) {
      const bySection = new Map<string, number>();
      for (const entry of entries) bySection.set(entry.section, (bySection.get(entry.section) ?? 0) + 1);
      console.log(`[${locale}] 分部=${JSON.stringify([...bySection.entries()].sort())}`);
      const groups = new Map<string, Map<string, number>>();
      for (const entry of entries) {
        const section = groups.get(entry.section) ?? new Map<string, number>();
        section.set(entry.label, (section.get(entry.label) ?? 0) + 1);
        groups.set(entry.section, section);
      }
      const duplicated = [...groups.entries()]
        .flatMap(([section, labels]) => [...labels.entries()].filter(([, count]) => count > 1).map(([label, count]) => `${section}/${label}x${count}`));
      console.log(`[${locale}] 同部同名组=${duplicated.length ? duplicated.join(" | ") : "无"}`);
    }
    expect(true).toBe(true);
  });
});
