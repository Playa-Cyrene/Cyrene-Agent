// 工具开关设置面板：从聊天窗口的 ToolModePanel 迁移而来。
// 职责：各模式（Work/Code/Learn/Chat）下的工具可见性开关 + Chat 工具增强总开关；
// 与「工具配置」页（参数/密钥/权限配置）职责互补，这边只管开关。

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Braces,
  CloudSun,
  FileDiff,
  FileSearch,
  FlaskConical,
  Globe,
  History,
  Images,
  Languages,
  Regex,
  Replace,
  Search,
  Terminal,
  Wallet,
  Wrench,
} from "lucide-react";
import { siGit, siNeteasecloudmusic, type SimpleIcon } from "simple-icons";
import { useTranslation } from "../../i18n";
import "./ToolToggleSettingsPanel.css";

type ToolMode = "work" | "code" | "learn" | "chat";

type TabKey = ToolMode;

interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  modes: Array<"chat" | "work" | "code" | "learn"> | null;
  /** chat 模式内置人格工具（如朋友圈三件套）：默认对 chat 可见，不依赖总开关 */
  chatBuiltin?: boolean;
  deprecated: string | null;
}

type Overrides = Record<string, Partial<Record<string, boolean>>>;

const BASE_TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

/** Chat 模式首次开启工具增强时预勾选的白名单：音乐全量 + 幂等只读。
 *  播放类是闲聊刚需故全放（input-control 级仍受权限档位门控）；
 *  只读类无副作用。写入后完全由用户接管，后续开关不再覆盖。 */
const CHAT_TOOL_WHITELIST = [
  // 音乐工具（全量）
  "music_search",
  "music_get_daily_recommendations",
  "music_get_playback_status",
  "music_my_playlists",
  "music_playlist_detail",
  "music_play_track",
  "music_play_playlist",
  "music_stop_playback",
  "music_create_playlist",
  "music_add_to_playlist",
  "music_toggle_favorite",
  "music_remove_from_playlist",
  // 幂等只读
  "weather",
  "web_search",
  "fetch_url",
  "translate",
  "exchange_rate",
  "query_expense",
  "recall_history",
];

/** Chat 模式可见性：严格 opt-in，仅显式勾选（override.chat===true）放行；
 *  内置人格工具（chatBuiltin）默认放行——与主进程 run-capabilities 同口径，
 *  用户勾掉（override.chat===false）后关闭。 */
function isChatToolOn(tool: ToolCatalogItem, overrides: Overrides): boolean {
  const override = overrides[tool.id]?.chat;
  if (override !== undefined) return override;
  return tool.chatBuiltin === true;
}

/** 工具图标来源：simple-icons 品牌图标（保留官方形状）或 lucide 线性图标。 */
type ToolIconSpec = { brand: SimpleIcon } | { lucide: LucideIcon };

/** 关键词 → 图标规则表：按顺序用「工具 id 包含关键词」匹配，命中即返回。
 *  规则顺序有讲究——更具体的关键词必须排在通用关键词前
 *  （如 ast_grep_replace 要先于 replace、web_search 要先于 search）。
 *  以后新增工具只要 id 含已知关键词即可自动命中，无需改代码。 */
const TOOL_ICON_RULES: Array<{ keywords: string[]; spec: ToolIconSpec }> = [
  { keywords: ["git"], spec: { brand: siGit } },
  { keywords: ["music"], spec: { brand: siNeteasecloudmusic } },
  { keywords: ["moments"], spec: { lucide: Images } },
  { keywords: ["ast_grep"], spec: { lucide: Regex } },
  { keywords: ["shell"], spec: { lucide: Terminal } },
  { keywords: ["verification"], spec: { lucide: FlaskConical } },
  { keywords: ["lsp"], spec: { lucide: Braces } },
  { keywords: ["patch"], spec: { lucide: FileDiff } },
  { keywords: ["web_search"], spec: { lucide: Search } },
  { keywords: ["search"], spec: { lucide: FileSearch } },
  { keywords: ["replace"], spec: { lucide: Replace } },
  { keywords: ["fetch", "url"], spec: { lucide: Globe } },
  { keywords: ["weather"], spec: { lucide: CloudSun } },
  { keywords: ["translate"], spec: { lucide: Languages } },
  { keywords: ["exchange"], spec: { lucide: ArrowLeftRight } },
  { keywords: ["expense"], spec: { lucide: Wallet } },
  { keywords: ["history"], spec: { lucide: History } },
];

/** 未命中任何关键词时的兜底图标。 */
const FALLBACK_TOOL_ICON: LucideIcon = Wrench;

/** 按工具 id 从规则表自动匹配图标。 */
function iconSpecForTool(toolId: string): ToolIconSpec {
  for (const rule of TOOL_ICON_RULES) {
    if (rule.keywords.some((keyword) => toolId.includes(keyword))) return rule.spec;
  }
  return { lucide: FALLBACK_TOOL_ICON };
}

/** 图标配色统一走主题粉（浅粉底 + 粉色图标），不做逐工具随机色。 */
function ToolIcon({ toolId }: { toolId: string }) {
  const spec = iconSpecForTool(toolId);
  return (
    <span
      className="tool-card__icon"
      style={{ background: "var(--rb-surface-active, #fde0ed)", color: "var(--rb-accent, #ff5b8a)" }}
    >
      {"brand" in spec ? (
        // 品牌图标用官方 path，颜色统一走主题色，保持整卡配色一致
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d={spec.brand.path} fill="currentColor" />
        </svg>
      ) : (
        <spec.lucide size={18} aria-hidden />
      )}
    </span>
  );
}

/** 与主进程 getEnabledToolsForMode 同源的默认可见性计算（前端镜像） */
function isVisibleForMode(tool: ToolCatalogItem, mode: ToolMode, overrides: Overrides): boolean {
  const override = overrides[tool.id]?.[mode];
  if (override !== undefined) return override;
  if (!tool.modes) return true;
  return tool.modes.includes(mode);
}

export function ToolToggleSettingsPanel() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<TabKey>("code");
  // Chat 模式工具增强总开关（general-settings.chatToolsEnabled）
  const [chatToolsEnabled, setChatToolsEnabled] = useState(false);
  // 关总开关时若停在 Chat tab，回退到 Code（避免 tab 悬空）。
  const tabRef = useRef<TabKey>("code");
  tabRef.current = tab;

  useEffect(() => {
    let cancelled = false;
    const api = window.settings;
    Promise.all([
      api?.getToolCatalog?.() ?? Promise.resolve([]),
      api?.getToolModeOverrides?.() ?? Promise.resolve({}),
      api?.getGeneral?.() ?? Promise.resolve({}),
    ])
      .then(([catalog, ov, general]) => {
        if (cancelled) return;
        setTools(catalog as ToolCatalogItem[]);
        setOverrides(ov as Overrides);
        setChatToolsEnabled((general as { chatToolsEnabled?: boolean }).chatToolsEnabled === true);
      })
      .catch((err) => console.warn("[ToolToggleSettingsPanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const toggleMode = useCallback((toolId: string, mode: ToolMode, next: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [toolId]: { ...prev[toolId], [mode]: next },
    }));
    void window.settings
      ?.setToolModeOverride?.(toolId, mode, next)
      ?.catch((err) => console.warn("[ToolToggleSettingsPanel] set override failed:", err));
  }, []);

  /** 总开关切换：首次开启（尚无任何 chat override）时预勾选白名单，一次性初始化。 */
  const toggleChatTools = useCallback((next: boolean) => {
    const prevOverrides = overrides;
    const hasChatOverride = Object.values(prevOverrides).some((m) => m?.chat !== undefined);
    let payload: Record<string, unknown> = { chatToolsEnabled: next };
    let nextOverrides = prevOverrides;
    if (next && !hasChatOverride) {
      // 只预勾选目录里存在且全局启用的白名单工具，避免写入死键。
      const available = new Set(tools.filter((t) => !t.deprecated && t.enabled).map((t) => t.id));
      const initialized: Overrides = { ...prevOverrides };
      for (const toolId of CHAT_TOOL_WHITELIST) {
        if (available.has(toolId)) {
          initialized[toolId] = { ...(initialized[toolId] ?? {}), chat: true };
        }
      }
      nextOverrides = initialized;
      payload = { chatToolsEnabled: true, toolModeOverrides: initialized };
    }
    setChatToolsEnabled(next);
    setOverrides(nextOverrides);
    void window.settings
      ?.saveGeneral?.(payload)
      ?.catch((err) => console.warn("[ToolToggleSettingsPanel] save general failed:", err));
    if (next) setTab("chat");
    else if (tabRef.current === "chat") setTab("code");
  }, [overrides, tools]);

  const TABS = useMemo(
    () => (chatToolsEnabled ? [...BASE_TABS, { key: "chat" as TabKey, label: "Chat" }] : BASE_TABS),
    [chatToolsEnabled],
  );

  const isToolOn = useCallback((tool: ToolCatalogItem, mode: TabKey, ov: Overrides): boolean => {
    if (mode === "chat") return isChatToolOn(tool, ov);
    return isVisibleForMode(tool, mode, ov);
  }, []);

  const visibleTools = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const usable = tools.filter((t) => !t.deprecated);
    // 所有 tab 统一展示全部启用工具：关掉的工具置灰保留在列表里，便于重新开启。
    const shown = usable.filter((t) => t.enabled);
    const searched = kw
      ? shown.filter(
          (t) =>
            t.id.toLowerCase().includes(kw) ||
            t.name.toLowerCase().includes(kw) ||
            t.description.toLowerCase().includes(kw),
        )
      : shown;
    return [...searched].sort((a, b) => {
      const aOn = isToolOn(a, tab, overrides);
      const bOn = isToolOn(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [tools, overrides, filter, tab, isToolOn]);

  return (
    <>
      <h1>{t("settingsPage.toolToggle.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.toolToggle.description")}</p>

      <div className="cy-settings-card cy-tool-toggle">
        {/* Chat 工具增强总开关：打开后才会出现 Chat 标签页 */}
        <div className="tool-panel__master">
          <div className="tool-panel__master-text">
            <strong>{t("toolPanel.chatEnhanceTitle")}</strong>
            <span>{t("toolPanel.chatEnhanceDesc")}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={chatToolsEnabled}
            aria-label={t("toolPanel.chatEnhanceTitle")}
            className={"tool-card__pill tool-panel__master-pill" + (chatToolsEnabled ? " is-on" : "")}
            onClick={() => toggleChatTools(!chatToolsEnabled)}
          >
            <span className="tool-card__pill-knob" />
          </button>
        </div>

        <div className="tool-panel__toolbar">
          <input
            className="tool-panel__search"
            placeholder={t("toolPanel.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div className="tool-panel__tabs">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.key}
              type="button"
              className={"tool-panel__tab" + (tab === tabItem.key ? " is-active" : "")}
              onClick={() => setTab(tabItem.key)}
            >
              {tabItem.label}
            </button>
          ))}
          <span className="tool-panel__mode-hint">
            {t("toolPanel.subtitle", { mode: TABS.find((item) => item.key === tab)?.label })}
          </span>
        </div>

        {loading ? (
          <div className="tool-panel__loading">{t("common.loading")}</div>
        ) : (
          <div className="tool-panel__grid">
            {visibleTools.map((tool) => {
              const isOn = isToolOn(tool, tab, overrides);
              return (
                <div key={tool.id} className={"tool-card" + (isOn ? "" : " is-off")}>
                  <ToolIcon toolId={tool.id} />
                  <div className="tool-card__body">
                    <div className="tool-card__name">
                      {tool.name}
                      {!tool.enabled && <span className="tool-card__badge">{t("toolPanel.disabledBadge")}</span>}
                    </div>
                    <div className="tool-card__desc">{tool.description.split("\n")[0] || t("toolPanel.noDescription")}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    className={"tool-card__pill" + (isOn ? " is-on" : "")}
                    onClick={() => toggleMode(tool.id, tab, !isOn)}
                  >
                    <span className="tool-card__pill-knob" />
                  </button>
                </div>
              );
            })}
            {visibleTools.length === 0 && <div className="tool-panel__empty">{t("toolPanel.noMatch")}</div>}
          </div>
        )}
      </div>
    </>
  );
}
