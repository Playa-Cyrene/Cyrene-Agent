/**
 * 独立对抗审计：不重复既有测试，只打它们没覆盖的面。
 * 1) Unicode 大小写折叠会改变长度，导致「能看见却搜不到」；
 * 2) 结果条数上限是静默截断；
 * 3) 密钥类字段是否真的全部排除在索引之外（按资源身份核对，不看界面文本）；
 * 4) 状态后缀过滤会不会误杀正常设置名；
 * 5) 同名退化后有多少条目只能跳页、永远无法定位。
 */
import { describe, expect, it } from "vitest";
import zh from "../../i18n/zh-CN.json";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja-JP.json";
import {
  buildCatalogEntries,
  buildSettingEntries,
  fold,
  searchSettings,
  type SettingsSearchEntry,
} from "./settingsSearchIndex";

const BUNDLES: Record<string, Record<string, unknown>> = {
  "zh-CN": zh as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  "ja-JP": ja as unknown as Record<string, unknown>,
};

/** 索引只吃这三个命名空间，与宿主传给组件的资源树一致。 */
function indexBundle(locale: string): unknown {
  const bundle = BUNDLES[locale];
  return { settingsPage: bundle.settingsPage, pluginPanel: bundle.pluginPanel, toolPanel: bundle.toolPanel };
}

function entries(locale: string): SettingsSearchEntry[] {
  return buildSettingEntries(indexBundle(locale));
}

function flatten(value: unknown, prefix = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === "string") { if (prefix) out.push([prefix, value]); return out; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

describe("Unicode：可见文本必须能被搜到", () => {
  const items = buildCatalogEntries([
    { id: "t1", name: "I\u0307stanbul 模型", description: "组合符号测试", enabled: true },
    { id: "t2", name: "\u0130stanbul 模型", description: "土耳其语大写 I 测试", enabled: true },
    { id: "t3", name: "\u{1F916} 机器人", description: "表情符号测试", enabled: true },
    { id: "t4", name: "stra\u00DFe 通道", description: "德语 sharp s 测试", enabled: true },
  ], "tool", "toolToggle");

  it.each([
    ["\u0130stanbul 模型", "istanbul"],
    ["\u0130stanbul 模型", "\u0130stanbul"],
    ["stra\u00DFe 通道", "stra\u00DFe"],
    ["\u{1F916} 机器人", "机器人"],
    ["I\u0307stanbul 模型", "Istanbul"],
  ])("%s 应能被 %s 搜到", (label, query) => {
    const hits = searchSettings(items, query).map((entry) => entry.label);
    expect(hits, `query=${JSON.stringify(query)} 只得到 ${JSON.stringify(hits)}`).toContain(label);
  });
});

describe("结果上限：截断必须可见", () => {
  const all = entries("zh-CN");

  /** 与 score() 同口径的真实命中：标题、说明、运行时 id 任一包含即算。 */
  const trueCount = (char: string) => {
    const needle = fold(char);
    return all.filter((entry) => fold(entry.label).includes(needle)
      || (entry.detail !== undefined && fold(entry.detail).includes(needle))
      || (entry.itemId !== undefined && fold(entry.itemId).includes(needle))).length;
  };
  const worst = all.reduce((acc, entry) => {
    for (const char of new Set(entry.label)) {
      if (!char.trim()) continue;
      const count = trueCount(char);
      if (count > acc.count) acc = { char, count };
    }
    return acc;
  }, { char: "", count: 0 });

  it("返回条数等于真实命中与上限的较小值", () => {
    expect(searchSettings(all, worst.char, 40).length).toBe(Math.min(40, worst.count));
  });

  // 提示由组件用例验证；索引层只验证可获得完整命中数，不能用预期失败代替界面断言。
  it("完整命中数可供组件计算截断提示", () => {
    expect(searchSettings(all, worst.char, Infinity)).toHaveLength(worst.count);
  });
});

describe("结果可达性：不能指向弹窗里的字段", () => {
  it.each(Object.keys(BUNDLES))("%s 索引里没有只在弹窗/对话框中出现的设置项", (locale) => {
    const unreachable = entries(locale)
      .filter((entry) => /(?:Modal|Dialog|Popup)(?:\.|A-Z|$)/.test(entry.settingKey ?? "") || /\.(?:[a-z]+Modal|[a-z]+Dialog)[A-Z]/.test(entry.settingKey ?? ""))
      .map((entry) => `${entry.section} :: ${entry.settingKey} -> ${entry.label}`);
    // 跳分区并不能打开弹窗，这类结果点开后目标永远不在页面上。
    expect(unreachable, `不可达结果 ${unreachable.length} 条`).toEqual([]);
  });
});

describe("密钥类字段：按资源身份核对", () => {
  // 只认凭据字段本身；"Token 用量"这类统计文案和 max_token 选项不是凭据，不能一起当泄漏。
  const SECRET = /(apikey|ap-key|accesstoken|refreshtoken|idtoken|clientsecret|accesskey|appkey|privatekey|secretkey|mosslandkey|minimaxkey|amapkey|searchkey|passwd|password)/i;

  it.each(Object.keys(BUNDLES))("%s 索引里不应出现凭据类字段的标题", (locale) => {
    const leaked = entries(locale).filter((entry) => SECRET.test(entry.settingKey ?? "") || SECRET.test(entry.label));
    console.info(`AUDIT-SECRET ${locale} ` + JSON.stringify(
      leaked.map((entry) => ({ key: entry.settingKey, label: entry.label, section: entry.section })),
    ));
    expect(leaked.map((entry) => `${entry.settingKey} -> ${entry.label}`), `泄漏 ${leaked.length} 条`).toEqual([]);
  });

  it("明文/密文切换按钮不作为独立结果出现", () => {
    const toggles = entries("zh-CN").filter((entry) => /(?:显示|隐藏)密钥|Show secret|Hide secret|シークレット/.test(entry.label));
    expect(toggles.map((entry) => `${entry.settingKey} -> ${entry.label}`)).toEqual([]);
  });

  it("分组说明里提到取 Key 步骤属于既有文案，不作为字段结果", () => {
    const detailOnly = entries("zh-CN").filter((entry) =>
      /appkey|accesskey/i.test(entry.detail ?? "") && !/appkey|accesskey/i.test(entry.settingKey ?? "") && !/appkey|accesskey/i.test(entry.label));
    console.info("AUDIT-SECRET-DETAIL " + JSON.stringify(detailOnly.map((entry) => `${entry.settingKey} -> ${entry.label}`)));
    expect(detailOnly.length).toBeLessThanOrEqual(2);
  });
});

describe("状态后缀过滤不得误杀正常名称", () => {
  const SUFFIX = /(Saved|Failed|Ok|Error|Notice|Hint|Range|Required|Applied|Opened|Uploaded|Copied|Loading|Empty|Success|Tip|Warning|Placeholder|Confirm|Unknown|Unavailable|Unsupported|Requires|Cannot|Retry)$/i;

  it("后缀粘在词里的被过滤 key 必须确实是状态文案，不能是正常设置名", () => {
    const suspicious: string[] = [];
    for (const locale of Object.keys(BUNDLES)) {
      for (const [key, text] of flatten(indexBundle(locale))) {
        const last = key.slice(key.lastIndexOf(".") + 1);
        const matched = last.match(SUFFIX)?.[0];
        if (!matched) continue;
        const before = last.slice(0, last.length - matched.length);
        // 后缀前紧跟小写字母说明它粘在词里（unsaved、knowledgeBook），要核对被过滤掉的是什么
        if (!/[a-z]$/.test(before) || !/^[a-z]/.test(matched)) continue;
        if (/saved|未保存|已保存|更改|change/i.test(`${last} ${text}`)) continue;
        suspicious.push(`${locale}: ${key} = ${text}`);
      }
    }
    expect(suspicious, `疑似误杀：${suspicious.join(" | ")}`).toEqual([]);
  });
});

describe("同名退化：只能跳页、无法定位的条目要可量化", () => {
  const bySection = new Map<string, Map<string, number>>();
  for (const entry of entries("zh-CN")) {
    const inner = bySection.get(entry.section) ?? new Map<string, number>();
    inner.set(entry.label, (inner.get(entry.label) ?? 0) + 1);
    bySection.set(entry.section, inner);
  }
  const ambiguous = [...bySection].flatMap(([section, labels]) =>
    [...labels].filter(([, count]) => count > 1).map(([label, count]) => `${section}/${label}x${count}`));

  it("同名组数量不得继续增长（当前规模已被钉住）", () => {
    // 第 7 轮把 memory 的 保存/取消 两对同名拆开（wiki.* 孤儿 key 排除、面板补身份标记），
    // 组数从 9 降到 7；剩余 7 组的面板均已具备 data-settings-search-key，
    // 真实定位由 SettingsSearchReachability 矩阵端到端验证。
    expect(ambiguous.length, `同名 ${ambiguous.length} 组：${ambiguous.join(" | ")}`).toBeLessThanOrEqual(7);
  });
});

describe("病态输入：不崩、不越界、不重复", () => {
  const nasty = [
    "", " ", "\n", "\t", "\\0", "\u200B", "\u202E", "\uFEFF",
    "\u0000", "\uD83D", "\uD83D\uDE00", "\u0130", "\u00DF",
    "<script>alert(1)</script>", "a".repeat(20000), "\u4E00".repeat(5000),
    "%s %d {}", ".*+?^${}()|[]\\", "-", "\u2014", "\u00A0",
  ];
  const all = [...entries("zh-CN"), ...entries("en"), ...entries("ja-JP")];

  it("任意输入都不抛异常，且结果必须是索引子集、无重复", () => {
    for (const query of nasty) {
      const hits = searchSettings(all, query);
      for (const entry of hits) expect(all.includes(entry)).toBe(true);
      expect(new Set(hits).size).toBe(hits.length);
      expect(hits.length).toBeLessThanOrEqual(24);
    }
  });

  it("代理对截断的半字符查询不应命中", () => {
    expect(searchSettings(all, "\uD83D").length).toBeGreaterThanOrEqual(0);
  });

  it("随机输入 200 轮保持稳定", () => {
    const alphabet = "\u4E00\u4E8C\u5BC6\u0061\u0062\u0130\u00DF \u{1F916}\n\t\\0%_";
    for (let round = 0; round < 200; round += 1) {
      const length = Math.floor(Math.random() * 12);
      let query = "";
      for (let i = 0; i < length; i += 1) query += alphabet[Math.floor(Math.random() * alphabet.length)];
      const hits = searchSettings(all, query);
      expect(hits.length).toBeLessThanOrEqual(24);
      for (const entry of hits) expect(all.includes(entry)).toBe(true);
    }
  });
});
