/**
 * 索引只确定候选设置及归属页，不保证目标已挂载；展开、定位和取消由 SettingsSearch 处理。
 *
 * 设计约束（改动前请先读）：
 * - 条目必须能唯一推出归属分区，否则宁可不收——跳错页比搜不到更糟。
 *   因此只收录 SECTION_BY_NAMESPACE 的命名空间、外观页扁平 key 前缀
 *   （APPEARANCE_KEY_PREFIXES），以及 resolveSection 精确登记的迁移项和导航标题。
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
  /** 技能目录已有的来源；用户目录的名称、说明和 ID 均不进入全局设置搜索。 */
  source?: string;
  /** 工具宿主明确标记含用户内容的元数据，兼容未携带该字段的内置目录。 */
  settingsSearchable?: boolean;
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
 * 省略号结尾的是进行中状态（保存中…/Loading…），平时不在 DOM 里，收进来只会产生死链。
 * 这是候选过滤规则，不是完整的设置注册表；不以字符数限制正常的多语言长标题。
 */
const SENTENCE_LIKE = /[。！？；.!?;…]$/;


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

// SMTP 已迁入邮件页，但为兼容翻译资源仍沿用 tools 下的 key；精确覆盖，不能把所有工具都迁走。
const EMAIL_TOOL_KEYS = new Set([
  "emailEnabled", "smtpHost", "smtpPort", "smtpSecure", "smtpSecureDescription",
  "smtpUser", "smtpPass", "fromName", "saveEmail",
].map((key) => `settingsPage.tools.${key}`));

/**
 * API Key、私钥、Token 等凭据字段按产品检索范围排除，连同专属说明一起过滤；
 * 用资源身份而非翻译文本，避免换语言后重新出现。
 * neteaseModal 整段排除：字段只存在于弹窗内，跳分区打不开弹窗，结果是点不开的"死链"。
 */
const EXCLUDED_SETTING_PREFIXES = [
  "settingsPage.modelSettings.apiKey", "settingsPage.modelSettings.localApiKey", "settingsPage.modelSettings.validationApiKey",
  "settingsPage.tts.apiKey", "settingsPage.asr.mosslandKey", "settingsPage.asr.minimaxKey",
  "settingsPage.tools.amapKey", "settingsPage.tools.searchKey", "settingsPage.tools.neteaseModal",
  "settingsPage.asr.appKey", "settingsPage.asr.accessKeyId", "settingsPage.asr.accessKeySecret",
  "settingsPage.emailSettings.clientSecret", "settingsPage.channels.qq.accessToken",
  // 推理控制整段只存在于"配置并添加模型"弹窗内，搜索从不打开该弹窗。
  "settingsPage.modelSettings.manual",
] as const;

/**
 * 精确排除清单（第 7 轮真实面板可达性矩阵的结论）。这些 key 的文案只会出现在
 * 搜索不负责打开的弹窗/气泡、title/aria-label/placeholder 属性、图表 tooltip 回调、
 * 瞬时状态提示里，或同页存在多个同名实例导致文本回退必然歧义，或渲染层从未使用
 * （孤儿 key）。收进索引只能制造点不开的死链；用资源身份排除，换语言也不会复活。
 */
const EXCLUDED_SETTING_KEYS = new Set([
  // 自定义风格弹窗（偏好页）字段与按钮
  "settingsPage.preferences.customStyleModalTitle", "settingsPage.preferences.diversity", "settingsPage.preferences.followModel",
  "settingsPage.preferences.repetition", "settingsPage.preferences.light", "settingsPage.preferences.medium", "settingsPage.preferences.strong",
  "settingsPage.preferences.reset", "settingsPage.preferences.cancel",
  // 分段控件的"开启/关闭"档位在同页出现两次（手机信息分段 + 主动聊天），回退必然歧义
  "settingsPage.preferences.on", "settingsPage.preferences.off",
  // 添加服务器弹窗（MCP 页）字段；transport 文案在列表里是"本地进程 · 已连接"拼接，无法整体命中
  "settingsPage.mcp.addTitle", "settingsPage.mcp.formMode", "settingsPage.mcp.jsonMode", "settingsPage.mcp.name",
  "settingsPage.mcp.type", "settingsPage.mcp.transport.stdio", "settingsPage.mcp.transport.http", "settingsPage.mcp.transport.sse",
  "settingsPage.mcp.command", "settingsPage.mcp.args", "settingsPage.mcp.url", "settingsPage.mcp.advanced",
  "settingsPage.mcp.envLabel", "settingsPage.mcp.headersLabel", "settingsPage.mcp.jsonLabel",
  "settingsPage.mcp.confirm", "settingsPage.mcp.cancel", "settingsPage.mcp.removeConfirmTitle",
  // 侧栏分组名"MCP"不会出现在面板内容区
  "settingsPage.mcp.menuLabel",
  // 模型选项弹窗（配置并添加/修改模型）字段
  "settingsPage.modelSettings.model", "settingsPage.modelSettings.contextWindow", "settingsPage.modelSettings.multimodal",
  "settingsPage.modelSettings.modelOptionTitle", "settingsPage.modelSettings.modelOptionEditTitle", "settingsPage.modelSettings.modelOptionSave",
  // 只存在于 title/aria-label 属性
  "settingsPage.modelSettings.resetBaseUrl",
  // 瞬时状态提示（删除档案/更新默认后短暂出现）
  "settingsPage.modelSettings.deleted", "settingsPage.modelSettings.defaultUpdated",
  // 用量页：三个提示只挂在 Info 图标的 title/aria-label 上；趋势 tooltip 文案只在 chart.js 回调里拼接；
  // 清空确认弹窗标题/取消只在点击后打开
  "settingsPage.usage.requestsCoverage", "settingsPage.usage.cachePartial", "settingsPage.usage.unitRequests",
  "settingsPage.usage.trendTooltipRequests", "settingsPage.usage.trendTooltipCacheHit",
  "settingsPage.usage.trendTooltipCacheMiss", "settingsPage.usage.trendTooltipCacheCreation",
  "settingsPage.usage.clearTitle", "settingsPage.usage.cancel",
  // 孤儿 key：渲染层从未使用
  "settingsPage.usage.trendInput", "settingsPage.usage.trendOutput",
  "settingsPage.emailSettings.connect", "settingsPage.emailSettings.reconnect",
  // 记忆页 wiki 的保存/取消键在任何设置组件里都没渲染（WikiKnowledgePanel 只用了 corrected/saveFailed/deleted），
  // 且与 L0/L1 卡片的保存/取消同文案，收进索引只会制造同部同名死链
  "settingsPage.memory.wiki.save", "settingsPage.memory.wiki.cancel",
  // 仅授权进行中/动作完成后短暂出现的状态文案
  "settingsPage.emailSettings.cancelAuthorization", "settingsPage.emailSettings.notConnected", "settingsPage.emailSettings.disconnected",
  // 渠道页：清空确认弹窗与二维码 alt 文本
  "settingsPage.channels.clearTitle", "settingsPage.channels.cancel", "settingsPage.channels.wechat.qrAlt",
  // 每个渠道卡片的"未连接"徽标同页出现多次
  "settingsPage.channels.offline",
  // 免责声明页：侧栏名不出现在正文；链接与拆分段落文本无法唯一回退（a/strong 拆分 textContent）
  "settingsPage.disclaimer.navLabel",
  "settingsPage.disclaimer.section5.p1Before",
  "settingsPage.disclaimer.section6.bilibiliLink", "settingsPage.disclaimer.section6.bilibiliNote",
  "settingsPage.disclaimer.section6.githubLabel", "settingsPage.disclaimer.section6.githubLink",
  "settingsPage.disclaimer.section7.bilibiliLink", "settingsPage.disclaimer.section7.bilibiliNote",
  "settingsPage.disclaimer.section7.githubLink", "settingsPage.disclaimer.section7.githubNote",
  "settingsPage.disclaimer.section9.p1", "settingsPage.disclaimer.section9.upLink",
  "settingsPage.disclaimer.section10.p1", "settingsPage.disclaimer.section10.contributorsLink",
  // 工具页：同名"保存"按钮分布在多个条件行里；全权限确认弹窗的取消文案
  "settingsPage.tools.save", "settingsPage.tools.fullAccessCancel",
  // 语音合成页：引擎卡片角标是 <small>（不在回退标签名单里）；文件占位符与"选择音频"按钮同页多次出现
  "settingsPage.tts.tagLocal", "settingsPage.tts.tagInterface", "settingsPage.tts.tagCloud",
  "settingsPage.tts.noFile", "settingsPage.tts.optional", "settingsPage.tts.chooseFile",
  // 语音识别页：引擎分组的 aria-label
  "settingsPage.asr.engineLabel",
  // 昔涟设置页：表情包弹窗字段与按钮
  "settingsPage.cyrene.add", "settingsPage.cyrene.cancel", "settingsPage.cyrene.stickerFile",
  "settingsPage.cyrene.chooseFile", "settingsPage.cyrene.noFile", "settingsPage.cyrene.stickerId",
  "settingsPage.cyrene.stickerDescriptionField", "settingsPage.cyrene.stickerPhrases",
  // 嵌入维度输入框的占位符
  "settingsPage.cyrene.autoDetect",
  // 知识库页：新建弹窗字段与只存在于 aria-label 的启用开关
  "settingsPage.knowledgeBase.name", "settingsPage.knowledgeBase.scope", "settingsPage.knowledgeBase.cancel",
  "settingsPage.knowledgeBase.collectionEnabled",
  // 浏览器控制页：侧栏名与标题同文案（保留 title，可定位面板 h1）
  "settingsPage.browserControl.navLabel",
  // 外观页瞬时状态提示（重置后短暂出现）
  "settingsPage.cyreneAvatarReset", "settingsPage.messageTypographyReset",
]);

/** 明文/密文切换按钮属于凭据字段的一部分，不单独作为设置结果出现。 */
const SECRET_TOGGLE_KEY = /(?:^|\.)(?:show|hide)Secret$/;

function resolveSection(fullKey: string): SettingsSection | null {
  if (EXCLUDED_SETTING_PREFIXES.some((prefix) => fullKey.startsWith(prefix))) return null;
  if (EXCLUDED_SETTING_KEYS.has(fullKey)) return null;
  if (SECRET_TOGGLE_KEY.test(fullKey)) return null;
  // 状态资源树不是设置分组；按路径段排除，避免误伤 stateStyle、statusBar 等真实设置名。
  if (/(^|\.)(status|state)\./i.test(fullKey)) return null;
  // 插件页只有两个可导航的标题；卡片动作、市场安装提示和旧 settingsPage.plugins 文案不作设置。
  if (fullKey === "pluginPanel.title" || fullKey === "pluginPanel.market.title") return "plugins";
  if (EMAIL_TOOL_KEYS.has(fullKey)) return "email";
  // 旧邮件分组的标题和说明已被 emailSettings.smtpTitle / smtpDescription 替代，不再生成幽灵结果。
  if (fullKey === "settingsPage.tools.email" || fullKey === "settingsPage.tools.emailDescription") return null;
  // toolPanel 还含模式、状态等文案，只登记实际可跳转的总开关及其说明。
  if (fullKey === "toolPanel.chatEnhanceTitle" || fullKey === "toolPanel.chatEnhanceDesc") return "toolToggle";
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

// 同一前缀可能同时用于按钮和分组标题；按真实面板登记歧义说明的目标，不能仅凭 key 长短猜测。
const DETAIL_TITLE_KEYS: Readonly<Record<string, string>> = {
  "settingsPage.knowledgeBase.searchHint": "settingsPage.knowledgeBase.searchTitle",
};

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
    const suffix = last.match(/(Description|Hint|Desc)$/i)?.[0];
    if (suffix) {
      if (text.trim() && !/\{\{/.test(text)) {
        const titleKey = DETAIL_TITLE_KEYS[key] ?? key.slice(0, -suffix.length);
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
    // 精确登记的说明直接存于目标 key；其余兼容 foo / fooDescription 与 fooTitle / fooDescription。
    const detail = details.get(key) ?? (key.endsWith("Title") && !titles.has(key.slice(0, -5)) ? details.get(key.slice(0, -5)) : undefined);
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
 * 目录来源不等于固定文案：用户技能的 frontmatter 和 MCP 的服务器名称也会出现在目录中。
 * 排除用户来源及宿主标记的条目后才收录名称、ID 和说明；不改变目录面板自身的显示或开关。
 */
export function buildCatalogEntries(
  items: ReadonlyArray<CatalogSearchSource>,
  kind: "skill" | "tool",
  section: SettingsSection,
): SettingsSearchEntry[] {
  // 工具面板不渲染全局停用项；不制造没有卡片可定位的结果。技能面板同样隐藏全局停用项；模式开关关闭与全局停用不同。
  return items
    .filter((item) => typeof item?.id === "string" && typeof item?.name === "string" && !item.deprecated && item.enabled !== false
      && item.settingsSearchable !== false && !(kind === "skill" && item.source === "user"))
    .map((item) => ({
      kind,
      section,
      label: item.name.trim() || item.id,
      detail: item.description?.trim() || undefined,
      itemId: item.id,
    }));
}

/**
 * 大小写折叠缓存。折叠会改变长度（İ → i + 组合点上点），所以匹配用折叠串，
 * 但标注切片必须回到原文下标——见 foldWithMap。缓存避免每次按键都重算整份索引。
 */
const foldCache = new Map<string, string>();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function foldSegment(segment: string): string {
  // 匹配和高亮必须用同一变换。统一希腊词尾 sigma；只对拉丁字母去重音，保留假名浊点等语义标记。
  const lowered = segment.toLowerCase().normalize("NFD").replace(/ς/g, "σ");
  return lowered.replace(/(\p{Script=Latin})\p{M}+/gu, "$1");
}

export function fold(value: string): string {
  const cached = foldCache.get(value);
  if (cached !== undefined) return cached;
  const folded = foldSegment(value.trim());
  if (foldCache.size > 4000) foldCache.clear();
  foldCache.set(value, folded);
  return folded;
}

/**
 * 折叠文本并记录每个折叠字符对应的原文下标，供调用方把命中区间映射回原文。
 * 每个 UTF-16 单元映射至完整字素的起止位置，支持一对多展开而不拆开代理对。
 */
export function foldWithMap(text: string): { folded: string; source: number[]; ends: number[] } {
  const units: string[] = [];
  const source: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const folded = foldSegment(segment);
    units.push(folded);
    // indexOf 返回 UTF-16 下标；每个 code unit 都映射到完整字素区间，避免拆开表情或组合字符。
    for (let unit = 0; unit < folded.length; unit += 1) {
      source.push(index);
      ends.push(index + segment.length);
    }
  }
  return { folded: units.join(""), source, ends };
}

/** 标题与运行时 id 的命中优先于说明；只做普通子串匹配，不把用户输入当正则表达式。 */
function score(entry: SettingsSearchEntry, needle: string): number {
  const label = fold(entry.label);
  if (label.startsWith(needle)) return 0;
  if (label.includes(needle)) return 1;
  if (entry.itemId && fold(entry.itemId).includes(needle)) return 1;
  if (entry.detail && fold(entry.detail).includes(needle)) return 2;
  return -1;
}

export function searchSettings(
  entries: ReadonlyArray<SettingsSearchEntry>,
  query: string,
  limit = 24,
): SettingsSearchEntry[] {
  const needle = fold(query);
  if (!needle) return [];
  return entries
    .map((entry) => ({ entry, value: score(entry, needle) }))
    .filter((hit) => hit.value >= 0)
    .sort((a, b) => a.value - b.value || a.entry.label.length - b.entry.label.length)
    .slice(0, limit)
    .map((hit) => hit.entry);
}
