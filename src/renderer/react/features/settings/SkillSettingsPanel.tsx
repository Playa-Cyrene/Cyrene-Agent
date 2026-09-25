// 技能设置面板：从聊天窗口的 SkillModePanel 迁移而来。
// 功能不变（Work/Code/Learn 模式可见性开关 + 来源过滤 + 搜索），
// 外层改为设置页标准样式（h1 + intro + 卡片容器）。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Bot,
  Braces,
  Bug,
  ClipboardList,
  Compass,
  Database,
  FileCode,
  FileSearch,
  FileSpreadsheet,
  FileType,
  FileText,
  FlaskConical,
  GraduationCap,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Map,
  Mic,
  Network,
  NotebookPen,
  Paintbrush,
  Palette,
  PanelTop,
  Presentation,
  Puzzle,
  Receipt,
  Repeat,
  Ruler,
  Scissors,
  ScrollText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Workflow,
  Zap,
} from "lucide-react";
import { siGit, siObsidian, type SimpleIcon } from "simple-icons";
import { useTranslation } from "../../i18n";
import "./SkillSettingsPanel.css";

type SkillMode = "work" | "code" | "learn";
type TabKey = SkillMode;
type SkillSource = "builtin" | "user";

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: SkillSource;
  modes: SkillMode[] | null;
  version?: string;
  references: string[];
}

type Overrides = Record<string, Partial<Record<SkillMode, boolean>>>;

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

const SOURCE_OPTIONS: Array<{ key: "all" | SkillSource; labelKey: string }> = [
  { key: "all", labelKey: "skillPanel.sourceAll" },
  { key: "builtin", labelKey: "skillPanel.sourceBuiltin" },
  { key: "user", labelKey: "skillPanel.sourceUser" },
];

/** 技能图标来源：simple-icons 品牌图标或 lucide 线性图标。 */
type SkillIconSpec = { brand: SimpleIcon } | { lucide: LucideIcon };

/** 关键词 → 图标规则表：按顺序用「技能 id 包含关键词」匹配，命中即返回。
 *  更具体的关键词排在前（as-planning 命中 ClipboardList 而不是通用的 Lightbulb）。
 *  覆盖 builtin 8 个 + 第三方 39 个共 47 个技能。 */
function RefreshIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M42 8V17H33" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 关键词 → 图标规则表：按顺序用「技能 id 包含关键词」匹配，命中即返回。
 *  更具体的关键词排在前（as-planning 命中 ClipboardList 而不是通用的 Lightbulb）。
 *  覆盖 builtin 8 个 + 第三方 39 个共 47 个技能。 */
const SKILL_ICON_RULES: Array<{ keywords: string[]; spec: SkillIconSpec }> = [
  // builtin：用户自有技能
  { keywords: ["plugin-dev"], spec: { lucide: Puzzle } },
  { keywords: ["exam-paper"], spec: { lucide: FileText } },
  { keywords: ["learn-tutor"], spec: { lucide: GraduationCap } },
  { keywords: ["obsidian"], spec: { brand: siObsidian } },
  { keywords: ["diagram"], spec: { lucide: Network } },
  { keywords: ["plan-mode"], spec: { lucide: Map } },
  { keywords: ["work-hygiene"], spec: { lucide: ShieldCheck } },
  { keywords: ["original-voice"], spec: { lucide: Mic } },
  // 文档类（微软系品牌图标在 simple-icons v16 已删除，改用 lucide 文档图标）
  { keywords: ["docx"], spec: { lucide: FileType } },
  { keywords: ["pdf"], spec: { lucide: FileText } },
  { keywords: ["pptx"], spec: { lucide: Presentation } },
  { keywords: ["xlsx"], spec: { lucide: FileSpreadsheet } },
  { keywords: ["office-design"], spec: { lucide: LayoutDashboard } },
  { keywords: ["expense"], spec: { lucide: Receipt } },
  // Superpowers（sp-*）
  { keywords: ["brainstorming"], spec: { lucide: Lightbulb } },
  { keywords: ["dispatching"], spec: { lucide: Workflow } },
  { keywords: ["requesting-code-review"], spec: { lucide: BadgeCheck } },
  { keywords: ["subagent-driven"], spec: { lucide: Bot } },
  { keywords: ["systematic-debugging"], spec: { lucide: Bug } },
  { keywords: ["git-worktrees"], spec: { brand: siGit } },
  { keywords: ["using-superpowers"], spec: { lucide: Zap } },
  { keywords: ["verification-before-completion"], spec: { lucide: BadgeCheck } },
  { keywords: ["writing-plans"], spec: { lucide: ScrollText } },
  // 流程工程（as-*）
  { keywords: ["api-and-interface"], spec: { lucide: Layers } },
  { keywords: ["code-review"], spec: { lucide: ShieldCheck } },
  { keywords: ["code-simplification"], spec: { lucide: Scissors } },
  { keywords: ["context-engineering"], spec: { lucide: Database } },
  { keywords: ["debugging"], spec: { lucide: Bug } },
  { keywords: ["doubt-driven"], spec: { lucide: HelpCircle } },
  { keywords: ["frontend-ui"], spec: { lucide: Palette } },
  { keywords: ["git-workflow"], spec: { brand: siGit } },
  { keywords: ["incremental"], spec: { lucide: Repeat } },
  { keywords: ["planning"], spec: { lucide: ClipboardList } },
  { keywords: ["security"], spec: { lucide: ShieldCheck } },
  { keywords: ["source-driven"], spec: { lucide: FileSearch } },
  { keywords: ["spec-driven"], spec: { lucide: Ruler } },
  { keywords: ["using-agent-skills"], spec: { lucide: Compass } },
  // 自省与质量（ecc-*）
  { keywords: ["agent-introspection"], spec: { lucide: Network } },
  { keywords: ["ai-regression"], spec: { lucide: FlaskConical } },
  { keywords: ["code-tour"], spec: { lucide: Map } },
  { keywords: ["codebase-onboarding"], spec: { lucide: Compass } },
  { keywords: ["coding-standards"], spec: { lucide: Ruler } },
  { keywords: ["plan-canvas"], spec: { lucide: LayoutDashboard } },
  { keywords: ["tdd-workflow"], spec: { lucide: FlaskConical } },
  // 元技能
  { keywords: ["self-improving"], spec: { lucide: TrendingUp } },
  { keywords: ["skill-creator"], spec: { lucide: FileCode } },
];

/** 未命中任何关键词时的兜底图标。 */
const FALLBACK_SKILL_ICON: LucideIcon = Sparkles;

/** 按技能 id 从规则表自动匹配图标。 */
function iconSpecForSkill(skillId: string): SkillIconSpec {
  for (const rule of SKILL_ICON_RULES) {
    if (rule.keywords.some((keyword) => skillId.includes(keyword))) return rule.spec;
  }
  return { lucide: FALLBACK_SKILL_ICON };
}

/** 图标配色统一走主题粉（浅粉底 + 粉色图标），不做逐技能随机色。 */
function SkillIcon({ skillId }: { skillId: string; name: string }) {
  const spec = iconSpecForSkill(skillId);
  return (
    <span
      className="skill-card__icon"
      style={{ background: "var(--rb-surface-active, #fde0ed)", color: "var(--rb-accent, #ff5b8a)" }}
    >
      {"brand" in spec ? (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d={spec.brand.path} fill="currentColor" />
        </svg>
      ) : (
        <spec.lucide size={18} aria-hidden />
      )}
    </span>
  );
}

/** 与主进程 getEnabledForMode 同源的默认可见性计算（前端镜像） */
function isVisibleForMode(skill: SkillCatalogItem, mode: SkillMode, overrides: Overrides): boolean {
  const override = overrides[skill.id]?.[mode];
  if (override !== undefined) return override;
  if (!skill.modes) return true;
  return skill.modes.includes(mode);
}

export function SkillSettingsPanel() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<"all" | SkillSource>("all");
  const [tab, setTab] = useState<TabKey>("code");

  const load = useCallback(async () => {
    const api = window.settings;
    const [cat, ov] = await Promise.all([
      api?.getSkillCatalog?.() ?? Promise.resolve([]),
      api?.getSkillModeOverrides?.() ?? Promise.resolve({}),
    ]);
    setCatalog(cat as SkillCatalogItem[]);
    setOverrides(ov as Overrides);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => console.warn("[SkillSettingsPanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await window.settings?.rescanSkills?.();
      if (res && !res.ok) {
        console.warn("[SkillSettingsPanel] rescan failed:", res.error);
      }
      await load();
    } catch (err) {
      console.warn("[SkillSettingsPanel] refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const toggleMode = useCallback((skillId: string, mode: SkillMode, next: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [skillId]: { ...prev[skillId], [mode]: next },
    }));
    void window.settings
      ?.setSkillModeOverride?.(skillId, mode, next)
      ?.catch((err) => console.warn("[SkillSettingsPanel] set override failed:", err));
  }, []);

  const visibleSkills = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const candidates = catalog.filter((s) => {
      if (source !== "all" && s.source !== source) return false;
      return true;
    });
    // 展示全部启用技能：关掉的置灰保留在列表里，便于重新开启（与工具面板同口径）。
    const shown = candidates.filter((s) => s.enabled);
    const searched = kw
      ? shown.filter(
          (s) =>
            s.id.toLowerCase().includes(kw) ||
            s.name.toLowerCase().includes(kw) ||
            s.description.toLowerCase().includes(kw),
        )
      : shown;
    return [...searched].sort((a, b) => {
      const aOn = isVisibleForMode(a, tab, overrides);
      const bOn = isVisibleForMode(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [catalog, overrides, filter, source, tab]);

  return (
    <>
      <h1>{t("settingsPage.skill.title")}</h1>
      <p className="cy-settings-intro">{t("skillPanel.subtitle", { mode: TABS.find((item) => item.key === tab)?.label })}</p>

      <div className="cy-settings-card cy-skill-settings">
        <div className="skill-panel__toolbar">
          <input
            className="skill-panel__search"
            placeholder={t("skillPanel.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="skill-panel__icon-btn"
            title={t("skillPanel.rescan")}
            disabled={refreshing}
            onClick={handleRefresh}
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="skill-panel__tabs">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.key}
              type="button"
              className={"skill-panel__tab" + (tab === tabItem.key ? " is-active" : "")}
              onClick={() => setTab(tabItem.key)}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        <div className="skill-panel__filter-row">
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={
                "skill-panel__filter-tab" + (source === opt.key ? " is-active" : "")
              }
              onClick={() => setSource(opt.key)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="skill-panel__loading">{t("common.loading")}</div>
        ) : (
          <div className="skill-panel__list">
            {visibleSkills.map((skill) => {
              const isOn = isVisibleForMode(skill, tab, overrides);
              return (
                <div key={skill.id} className={"skill-card" + (isOn ? "" : " is-off")}>
                  <div className="skill-card__top">
                    <SkillIcon skillId={skill.id} name={skill.name} />
                    <div className="skill-card__body">
                      <div className="skill-card__name">
                        {skill.name}
                        {!skill.enabled && <span className="skill-card__badge">{t("skillPanel.disabledBadge")}</span>}
                      </div>
                      <div className="skill-card__meta">
                        <span className={`skill-card__source skill-card__source--${skill.source}`}>
                          {t(skill.source === "builtin" ? "skillPanel.sourceBuiltin" : "skillPanel.sourceUser")}
                        </span>
                        {skill.version ? (
                          <span className="skill-card__version">v{skill.version}</span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isOn}
                      className={"skill-card__pill" + (isOn ? " is-on" : "")}
                      onClick={() => toggleMode(skill.id, tab, !isOn)}
                    >
                      <span className="skill-card__pill-knob" />
                    </button>
                  </div>
                  <div className="skill-card__desc">
                    {skill.description.split("\n")[0] || t("skillPanel.noDescription")}
                  </div>
                </div>
              );
            })}
            {visibleSkills.length === 0 && <div className="skill-panel__empty">{t("skillPanel.noMatch")}</div>}
          </div>
        )}
      </div>
    </>
  );
}
