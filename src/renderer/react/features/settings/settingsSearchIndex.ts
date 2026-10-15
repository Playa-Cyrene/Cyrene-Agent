/**
 * 索引只确定候选设置及归属页，不保证目标已挂载；展开、定位和取消由 SettingsSearch 处理。
 *
 * 设计约束（改动前请先读）：
 * - 条目必须能唯一推出归属分区，否则宁可不收——跳错页比搜不到更糟。
 *   因此只有 SECTION_BY_NAMESPACE 里显式登记的命名空间，以及外观页的扁平 key 前缀
 *   （APPEARANCE_KEY_PREFIXES）会被收录，其余顶层杂项一律跳过。
 * - i18n 里混着大量瞬时状态文案（已保存/失败/提示…），它们不会出现在可跳转的
 *   DOM 标签上，收进来只会制造垃圾结果，所以按 key 末段后缀剔除。
 * - 含 {{插值}} 的文案也剔除：索引没有运行时参数，无法可靠还原显示文本。
 */
import type { SettingsSection } from "./AppearanceSettingsPage";

export type SettingsSearchKind = "setting" | "plugin" | "skill" | "tool";

export interface SettingsSearchEntry {
  kind: SettingsSearchKind;
  section: SettingsSection;
  /** 展示文本，已是当前语言 */
  label: string;
  /** 次要说明：设置项取描述文案，工具/技能取目录描述 */
  detail?: string;
  /** 宿主 id 同时用于检索和卡片定位；名称相同的运行时项目不能互相替代。 */
  itemId?: string;
  /** 保留翻译 key，避免同名设置合并或跳到另一条设置。 */
  settingKey?: string;
}

/** 宿主插件清单里本模块用到的字段（与 PluginListEntry 结构兼容，不反向依赖主进程类型）。 */
export interface PluginSearchSource {
  id: string;
  name: string;
  description?: string;
  author?: string;
}

/** 宿主工具/技能目录里本模块用到的字段。 */
export interface CatalogSearchSource {
  id: string;
  name: string;
  description?: string;
  /** 仅工具目录有：非空表示已废弃，不该出现在搜索结果里 */
  deprecated?: string | null;
  enabled?: boolean;
}

type Resource = Record<string, unknown>;

/**
 * i18n 命名空间前缀 → 归属分区。前缀一律带结尾点，避免
 * `settingsPage.cyrene.` 误吞外观页的扁平 key `settingsPage.cyreneAvatar*`。
 */
const SECTION_BY_NAMESPACE: ReadonlyArray<readonly [string, SettingsSection]> = [
  ["settingsPage.general.", "general"],
  ["settingsPage.preferences.", "preferences"],
  ["settingsPage.modelSettings.", "models"],
  ["settingsPage.usage.", "usage"],
  ["settingsPage.browserControl.", "browser"],
  ["settingsPage.emailSettings.", "email"],
  ["settingsPage.toolToggle.", "toolToggle"],
  ["settingsPage.tools.", "tools"],
  ["settingsPage.subagents.", "subagents"],
  ["settingsPage.plugins.", "plugins"],
  ["pluginPanel.", "plugins"],
  ["settingsPage.mcp.", "mcp"],
  ["settingsPage.memory.", "memory"],
  ["settingsPage.knowledgeBase.", "knowledge"],
  ["settingsPage.cyrene.", "cyrene"],
  ["settingsPage.skill.", "skill"],
  ["settingsPage.channels.", "channels"],
  ["settingsPage.tts.", "tts"],
  ["settingsPage.asr.", "asr"],
  ["settingsPage.disclaimer.", "disclaimer"],
];

/** 外观页的设置项是 `settingsPage.*` 的扁平 key，按前缀白名单收。 */
const APPEARANCE_KEY_PREFIXES: readonly string[] = [
  "interface", "theme", "uiFont", "defaultFont", "cyreneAvatar",
  "messageTypography", "messageFont", "messageLineHeight", "messageLetterSpacing", "pet",
];

/** 状态和提示不作为独立标题；Hint 在过滤前先尝试归入同 key 前缀标题的说明。 */
const STATUS_KEY_SUFFIX =
  /(Saved|Failed|Ok|Error|Notice|Hint|Range|Required|Applied|Opened|Uploaded|Copied|Loading|Empty|Success|Tip|Warning|Placeholder|Confirm|Unknown|Unavailable|Unsupported|Requires|Cannot|Retry)$/i;

/**
 * key 后缀不能覆盖所有正文，因此用句末标点再排除一部分非标题文案。
 * 这是候选过滤规则，不是完整的设置注册表；不以字符数限制正常的多语言长标题。
 */
const SENTENCE_LIKE = /[。！？；.!?;]$/;


/** 提供分区标题 key；侧栏和搜索分组的图标、顺序以 settingsNavItems 为准。 */
export const SECTION_LABEL_KEY: Readonly<Record<SettingsSection, string>> = {
  general: "settingsPage.general.title",
  appearance: "settingsPage.appearance",
  preferences: "settingsPage.preferencesLabel",
  models: "settingsPage.modelSettings.title",
  usage: "settingsPage.usage.title",
  browser: "settingsPage.browserControl.navLabel",
  email: "settingsPage.emailSettings.title",
  toolToggle: "settingsPage.toolToggle.title",
  tools: "settingsPage.tools.title",
  subagents: "settingsPage.subagents.title",
  plugins: "pluginPanel.title",
  mcp: "settingsPage.mcp.menuLabel",
  memory: "settingsPage.memory.title",
  knowledge: "settingsPage.knowledgeBase.title",
  cyrene: "settingsPage.cyrene.title",
  skill: "settingsPage.skill.title",
  channels: "settingsPage.channels.title",
  tts: "settingsPage.tts.title",
  asr: "settingsPage.asr.title",
  disclaimer: "settingsPage.disclaimer.navLabel",
};

function flatten(value: unknown, prefix: string, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    if (prefix) out.push([prefix, value]);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Resource)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

function resolveSection(fullKey: string): SettingsSection | null {
  for (const [prefix, section] of SECTION_BY_NAMESPACE) {
    if (fullKey.startsWith(prefix)) return section;
  }
  if (!fullKey.startsWith("settingsPage.")) return null;
  const tail = fullKey.slice("settingsPage.".length);
  if (tail.includes(".")) return null;
  return APPEARANCE_KEY_PREFIXES.some((prefix) => tail.startsWith(prefix)) ? "appearance" : null;
}

/** 状态文案不能作为可定位的设置标题。 */
function isIndexable(key: string, text: string): boolean {
  if (text.trim().length < 2) return false;
  if (/\{\{/.test(text)) return false;
  return !STATUS_KEY_SUFFIX.test(key.slice(key.lastIndexOf(".") + 1));
}

/** 由当前语言的 i18n 资源树构建设置项条目。 */
export function buildSettingEntries(bundle: unknown): SettingsSearchEntry[] {
  const flat: Array<[string, string]> = [];
  flatten(bundle, "", flat);

  /** 说明仅按同路径前缀关联标题，不按显示文字猜测；因此同名设置仍保留各自的说明。 */
  const titles = new Map<string, { entry: SettingsSearchEntry; key: string }>();
  const details = new Map<string, string>();
  for (const [key, text] of flat) {
    const section = resolveSection(key);
    if (!section) continue;
    const last = key.slice(key.lastIndexOf(".") + 1);
    const suffix = last.match(/(Description|Hint)$/i)?.[0];
    if (suffix) {
      if (text.trim() && !/\{\{/.test(text)) {
        const titleKey = key.slice(0, -suffix.length);
        details.set(titleKey, [details.get(titleKey), text.trim()].filter(Boolean).join("\n"));
      }
      continue;
    }
    if (!isIndexable(key, text)) continue;
    const label = text.trim();
    // 字符数不能判断是不是标题：英文正常设置名称也常常超过 24 字符。
    if (SENTENCE_LIKE.test(label) || /[\r\n]/.test(label)) continue;
    titles.set(key, { entry: { kind: "setting", section, label, settingKey: key }, key });
  }

  const entries: SettingsSearchEntry[] = [];
  for (const { entry, key } of titles.values()) {
    const detail = details.get(key);
    if (detail) entry.detail = detail;
    entries.push(entry);
  }
  return entries;
}

/** 由宿主插件清单构建插件条目。只按名称与 id 检索：插件内部设置项由各插件自己渲染，
 *  收进索引就得跟着每次插件更新维护，v1 明确不做。 */
export function buildPluginEntries(plugins: ReadonlyArray<PluginSearchSource>): SettingsSearchEntry[] {
  return plugins
    .filter((plugin) => typeof plugin?.id === "string" && typeof plugin?.name === "string")
    .map((plugin) => ({
      kind: "plugin" as const,
      section: "plugins" as SettingsSection,
      label: plugin.name.trim() || plugin.id,
      itemId: plugin.id,
    }));
}

/**
 * 工具与技能条目。目录是运行时从宿主拉的，收录描述文案不需要人工维护，
 * 所以连描述一起检索；插件则按功能边界只检索名称与 id，连插件清单的 description 也不索引。
 */
export function buildCatalogEntries(
  items: ReadonlyArray<CatalogSearchSource>,
  kind: "skill" | "tool",
  section: SettingsSection,
): SettingsSearchEntry[] {
  // 工具面板不渲染全局停用项；不制造没有卡片可定位的结果。技能仍可显示停用项。
  return items
    .filter((item) => typeof item?.id === "string" && typeof item?.name === "string" && !item.deprecated && (kind !== "tool" || item.enabled !== false))
    .map((item) => ({
      kind,
      section,
      label: item.name.trim() || item.id,
      detail: item.description?.trim() || undefined,
      itemId: item.id,
    }));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** 标题与运行时 id 的命中优先于说明；只做普通子串匹配，不把用户输入当正则表达式。 */
function score(entry: SettingsSearchEntry, needle: string): number {
  const label = normalize(entry.label);
  if (label.startsWith(needle)) return 0;
  if (label.includes(needle)) return 1;
  if (entry.itemId && normalize(entry.itemId).includes(needle)) return 1;
  if (entry.detail && normalize(entry.detail).includes(needle)) return 2;
  return -1;
}

export function searchSettings(
  entries: ReadonlyArray<SettingsSearchEntry>,
  query: string,
  limit = 24,
): SettingsSearchEntry[] {
  const needle = normalize(query);
  if (!needle) return [];
  return entries
    .map((entry) => ({ entry, value: score(entry, needle) }))
    .filter((hit) => hit.value >= 0)
    .sort((a, b) => a.value - b.value || a.entry.label.length - b.entry.label.length)
    .slice(0, limit)
    .map((hit) => hit.entry);
}
