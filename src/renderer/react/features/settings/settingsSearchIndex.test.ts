import { describe, expect, it } from "vitest";
import zhCN from "../../i18n/zh-CN.json";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja-JP.json";
import {
  buildCatalogEntries,
  buildPluginEntries,
  buildSettingEntries,
  searchSettings,
  type SettingsSearchEntry,
} from "./settingsSearchIndex";

/**
 * 索引层的三条硬约束：够全（别把可用设置滤掉）、够干净（状态文案不进）、
 * 够准（归属页推不出来就不收）。第 3 条是"宁缺勿错跳"的取舍，改动会直接影响体验。
 */
const bundle = { settingsPage: zhCN.settingsPage, pluginPanel: zhCN.pluginPanel };
const entries = buildSettingEntries(bundle);
const labels = new Set(entries.map((entry) => entry.label));
const find = (label: string) => entries.find((entry) => entry.label === label);

describe("设置搜索索引", () => {
  it.each([['zh-CN', zhCN], ['en', en], ['ja-JP', ja]])("%s 音色描述是可检索字段标签，不是其他字段的说明", (_locale, resource) => {
    const indexed = buildSettingEntries(resource);
    const label = resource.settingsPage.tts.voiceDescription;
    const hits = searchSettings(indexed, label);
    expect(hits.some(entry => entry.settingKey === 'settingsPage.tts.voiceDescription' && entry.label === label && entry.section === 'tts')).toBe(true);
    expect(indexed.filter(entry => entry.detail?.includes(label))).toEqual([]);
  });

  it.each([['zh-CN', zhCN], ['en', en], ['ja-JP', ja]])("%s 页面介绍关联同层 title，不能成为独立结果", (_locale, resource) => {
    const indexed = buildSettingEntries(resource);
    for (const page of ['general', 'knowledgeBase', 'mcp', 'tts'] as const) {
      const key = `settingsPage.${page}.title`;
      const intro = resource.settingsPage[page].description;
      expect(indexed.find(entry => entry.settingKey === key)?.detail, key).toContain(intro);
      expect(searchSettings(indexed, intro).some(entry => entry.settingKey === key), key).toBe(true);
      expect(indexed.some(entry => entry.settingKey === `settingsPage.${page}.description`)).toBe(false);
    }
  });

  it("同层说明关联不依赖资源顺序，不借用父级或邻页标题", () => {
    const indexed = buildSettingEntries({settingsPage: {
      general: {description: '先出现的页面介绍', title: '页面标题', nested: {description: '无标题的孤立介绍'}},
      tts: {voice: '旧音色标签', voiceDescription: '音色描述字段', title: '语音页面', description: '后出现的语音介绍'},
    }});
    expect(searchSettings(indexed, '先出现的页面介绍').map(entry => entry.label)).toEqual(['页面标题']);
    expect(searchSettings(indexed, '后出现的语音介绍').map(entry => entry.label)).toEqual(['语音页面']);
    expect(searchSettings(indexed, '无标题的孤立介绍')).toEqual([]);
    expect(searchSettings(indexed, '音色描述字段').map(entry => entry.label)).toEqual(['音色描述字段']);
  });

  it.each([['zh-CN', zhCN], ['en', en], ['ja-JP', ja]])("%s 不收录 API Key 字段及其说明", (_locale, resource) => {
    const indexed = buildSettingEntries(resource);
    const excluded = ['settingsPage.modelSettings.apiKey', 'settingsPage.modelSettings.apiKeyOptional', 'settingsPage.tts.apiKey', 'settingsPage.asr.mosslandKey', 'settingsPage.asr.minimaxKey', 'settingsPage.tools.amapKey', 'settingsPage.tools.searchKey'];
    for (const key of excluded) expect(indexed.some(entry => entry.settingKey === key), key).toBe(false);
    expect(indexed.some(entry => /^api\s*key$/i.test(entry.label))).toBe(false);
    expect(indexed.some(entry => entry.settingKey === 'settingsPage.asr.engineTitle')).toBe(true);
  });

  it("API Key 排除按字段身份生效，不依赖翻译或转移说明", () => {
    const indexed = buildSettingEntries({settingsPage:{asr:{mosslandKey:'自定义翻译',mosslandKeyHint:'独有字段说明',mosslandKeyTitle:'备用标题',engineTitle:'语音引擎'},tools:{amapKey:'地图凭据',amapKeyDescription:'另一个独有说明'}}});
    expect(indexed.map(entry => entry.label)).toEqual(['语音引擎']);
    expect(searchSettings(indexed,'独有')).toEqual([]);
  });
  it("收录量足够覆盖各设置面板", () => {
    expect(entries.length).toBeGreaterThan(300);
    const sections = new Set(entries.map((entry) => entry.section));
    // 除 disclaimer/usage 这类小页外，主要分区都该有条目
    for (const section of ["appearance", "preferences", "models", "tools", "memory", "tts", "channels"]) {
      expect(sections.has(section as SettingsSearchEntry["section"]), section).toBe(true);
    }
  });

  it("剔除瞬时状态文案与含插值的文案", () => {
    expect(labels.has(String(zhCN.settingsPage.saveFailed))).toBe(false);
    expect(labels.has(String(zhCN.settingsPage.modelSettings.testOk))).toBe(false);
  });

  it("整句播报和长段落不当作可跳转标签", () => {
    const sentences = entries.filter((entry) => /[。！？；]$/.test(entry.label));
    expect(sentences.map((entry) => entry.label)).toEqual([]);
  });

  it("归属页推不出来的命名空间不入库，避免跳错页", () => {
    // 表情包管理是弹窗入口，不属于任何设置分区
    expect(labels.has(String((zhCN.settingsPage.stickerManager as Record<string, string>).title ?? "表情包管理"))).toBe(false);
  });

  it("按 key 前缀解析归属分区", () => {
    expect(find("自定义风格")?.section).toBe("preferences");
    expect(find("连接测试超时")?.section).toBe("models");
    expect(find("保持置顶")?.section).toBe("appearance");
  });

  it("描述文案回挂到同路径的标题条目上", () => {
    expect(String(find("自定义风格")?.detail)).toContain("采样");
  });

  it("关键词检索命中期望条目", () => {
    const hits = searchSettings(entries, "超时").map((entry) => entry.label);
    expect(hits).toContain("连接测试超时");
    expect(searchSettings(entries, "置顶")[0].label).toBe("保持置顶");
    expect(searchSettings(entries, "")).toEqual([]);
  });

  it("插件只按名称与 id 命中，不检索插件内部说明", () => {
    const plugins = buildPluginEntries([
      { id: "cyrene-hud", name: "昔涟桌面 HUD", description: "统计抽卡出货的内部描述", author: "someone" },
    ]);
    expect(plugins[0].section).toBe("plugins");
    expect(plugins[0].detail).toBeUndefined();
    expect(searchSettings([...entries, ...plugins], "cyrene-hud")[0].itemId).toBe("cyrene-hud");
    expect(searchSettings([...entries, ...plugins], "桌面 HUD")[0].kind).toBe("plugin");
    expect(searchSettings(plugins, "统计抽卡出货")).toEqual([]);
  });

  it("工具与技能按名称、id、描述检索，废弃工具不收", () => {
    const tools = buildCatalogEntries([
      { id: "read-file", name: "读取文件", description: "按路径读取文本文件", deprecated: null },
      { id: "old-tool", name: "旧工具", description: "已废弃", deprecated: "use read-file" },
    ], "tool", "toolToggle");
    const skills = buildCatalogEntries([
      { id: "pdf", name: "PDF 处理", description: "读取与拆分 PDF 文档" },
    ], "skill", "skill");

    expect(tools.map((entry) => entry.label)).toEqual(["读取文件"]);
    expect(skills[0].section).toBe("skill");
    expect(searchSettings([...tools, ...skills], "读取文本")[0].label).toBe("读取文件");
    expect(searchSettings([...tools, ...skills], "pdf")[0].section).toBe("skill");
  });
});
