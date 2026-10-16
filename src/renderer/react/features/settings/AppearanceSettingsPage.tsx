import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Spin } from "antd";
import { ArrowLeft, Monitor, Type } from "lucide-react";
import { SETTINGS_NAV_GROUPS } from "./settingsNavItems";
import packageJson from "../../../../../package.json";
import { normalizeUiThemeChoice, type UiThemeChoice } from "../../../../shared/ui-theme";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  MESSAGE_TYPOGRAPHY_RANGES,
  normalizeMessageTypography,
  type MessageTypography,
} from "../../../../shared/message-typography";
import { useTranslation } from "../../i18n";
import { useCyreneAvatar } from "../../hooks/useCyreneAvatar";
import { SettingsSearch } from "./SettingsSearch";
import { applyMessageTypography } from "../../../ui/message-typography";
import { applyUiThemeChoice } from "../../../ui/theme";
import { WindowControls } from "../../components/ui/WindowControls";
import { Card } from "../../components/ui/Card";
import { SettingsSegmented, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import "../../components/ui/NewTaskButton.css";
import { PreferencesSettingsPanel } from "./PreferencesSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { resolveVersionTitleKey } from "./app-update-view";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { ToolSettingsPanel } from "./ToolSettingsPanel";
import { MemorySettingsPanel } from "./MemorySettingsPanel";
import { KnowledgeBaseSettingsPanel } from "./KnowledgeBaseSettingsPanel";
import { CyreneSettingsPanel } from "./CyreneSettingsPanel";
import { AsrSettingsPanel } from "./AsrSettingsPanel";
import { TtsSettingsPanel } from "./TtsSettingsPanel";
import { PluginSettingsPanel } from "./PluginSettingsPanel";
import { McpSettingsPanel } from "./McpSettingsPanel";
import { UsageStatsPanel } from "./UsageStatsPanel";
import { DisclaimerSettingsPanel } from "./DisclaimerSettingsPanel";
import { SkillSettingsPanel } from "./SkillSettingsPanel";
import { ToolToggleSettingsPanel } from "./ToolToggleSettingsPanel";
import { ChannelsSettingsPanel } from "./ChannelsSettingsPanel";
import { SubagentSettingsPanel } from "./SubagentSettingsPanel";
import { BrowserControlSettingsPanel } from "./BrowserControlSettingsPanel";
import { EmailSettingsPanel } from "./EmailSettingsPanel";
import settingsLogoUrl from "../../../settings/100.png";
import "../../components/ui/WindowControls.css";
import "./AppearanceSettingsPage.css";

interface AppearanceValues {
  uiTheme: UiThemeChoice;
  messageTypography: MessageTypography;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
}

const defaults: AppearanceValues = {
  uiTheme: "pearl-white",
  messageTypography: DEFAULT_MESSAGE_TYPOGRAPHY,
  petAlwaysOnTop: false,
  petVisible: true,
  petZoom: 1,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readAppearance(value: unknown): AppearanceValues {
  const input = objectValue(value);
  return {
    uiTheme: normalizeUiThemeChoice(input.uiTheme),
    messageTypography: normalizeMessageTypography(input.messageTypography),
    petAlwaysOnTop: typeof input.petAlwaysOnTop === "boolean" ? input.petAlwaysOnTop : defaults.petAlwaysOnTop,
    petVisible: typeof input.petVisible === "boolean" ? input.petVisible : defaults.petVisible,
    petZoom: finiteNumber(input.petZoom, defaults.petZoom),
  };
}

export type SettingsSection =
  | "appearance" | "preferences" | "models" | "usage" | "general" | "toolToggle" | "tools" | "plugins" | "memory" | "knowledge" | "cyrene" | "skill" | "subagents" | "asr" | "tts" | "mcp" | "channels" | "disclaimer" | "browser" | "email";

export interface AppearanceSettingsPageProps {
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  onBackToWorkspace: () => void;
  musicSettingsNavigation?: number;
}

interface SettingsNavItemProps {
  section: SettingsSection;
  currentSection: SettingsSection;
  icon: ReactNode;
  label: string;
  onSelect: (section: SettingsSection) => void;
}

function SettingsNavItem({ section, currentSection, icon, label, onSelect }: SettingsNavItemProps) {
  const active = section === currentSection;
  return (
    <button
      className={`cy-side-action cy-settings-nav-item ${active ? "is-active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(section)}
    >
      <span className="cy-side-action-icon">{icon}</span>
      <span className="cy-side-action-label">{label}</span>
    </button>
  );
}

export function AppearanceSettingsPage({ section, onSelectSection, onBackToWorkspace, musicSettingsNavigation = 0 }: AppearanceSettingsPageProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const cyreneAvatarUrl = useCyreneAvatar();
  // 版本称号（如 1.3.0 的"正式版"）随版本走，普通版本查不到就不显示
  const versionTitleKey = resolveVersionTitleKey(packageJson.version);
  const [avatarBusy, setAvatarBusy] = useState(false);
  // 昔涟消息字体：ref 记住最新值，松手保存时不依赖可能过期的渲染闭包
  const typographyRef = useRef<MessageTypography>(DEFAULT_MESSAGE_TYPOGRAPHY);
  // 搜索只定位当前设置内容区，避免命中侧栏结果里的同名标签。
  const contentRef = useRef<HTMLElement | null>(null);
  // 每次选择都发出新请求；同页重复搜索也要清除局部筛选，不能靠重挂载丢弃面板状态。
  const [searchReveal, setSearchReveal] = useState({ plugin: 0, tool: 0, skill: 0 });
  const [pluginSearchView, setPluginSearchView] = useState<"installed" | "market">("installed");

  useEffect(() => {
    let disposed = false;
    const settingsApi = window.settings;
    if (!settingsApi) {
      setLoadError(true);
      setLoading(false);
      return;
    }

    void settingsApi.getGeneral()
      .then((config) => {
        if (disposed) return;
        const next = readAppearance(config);
        setValues(next);
        typographyRef.current = next.messageTypography;
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setLoadError(true);
        setLoading(false);
      });

    const unsubscribeTheme = window.cyreneTheme?.onChanged(() => {
      void settingsApi.getGeneral().then((config) => {
        if (!disposed) setValues((current) => ({ ...current, uiTheme: readAppearance(config).uiTheme }));
      }).catch(() => {});
    });

    return () => { disposed = true; unsubscribeTheme?.(); };
  }, []);

  async function savePatch(patch: Record<string, unknown>, successMessage = t("settingsPage.saved")) {
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral(patch);
      setStatus(successMessage);
      return true;
    } catch {
      setStatus(t("settingsPage.saveFailed"));
      return false;
    }
  }

  async function uploadCyreneAvatar() {
    if (!window.cyreneAvatar || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const uploaded = await window.cyreneAvatar.upload();
      if (uploaded) setStatus(t("settingsPage.cyreneAvatarUploaded"));
    } catch {
      setStatus(t("settingsPage.cyreneAvatarFailed"));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function resetCyreneAvatar() {
    if (!window.cyreneAvatar || avatarBusy) return;
    setAvatarBusy(true);
    try {
      await window.cyreneAvatar.reset();
      setStatus(t("settingsPage.cyreneAvatarReset"));
    } catch {
      setStatus(t("settingsPage.cyreneAvatarFailed"));
    } finally {
      setAvatarBusy(false);
    }
  }

  function updateNumber<K extends "petZoom">(
    key: K,
    value: number,
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus(t("settingsPage.applyOnRelease"));
  }

  async function selectTheme(uiTheme: UiThemeChoice) {
    const previous = values.uiTheme;
    setValues((current) => ({ ...current, uiTheme }));
    applyUiThemeChoice(uiTheme);
    if (!await savePatch({ uiTheme })) {
      setValues((current) => ({ ...current, uiTheme: previous }));
      applyUiThemeChoice(previous);
    }
  }

  // 昔涟消息字体：拖动时实时写入 CSS 变量预览，松手由 saveTypography 落盘
  function updateTypography(key: keyof MessageTypography, value: number) {
    const next = { ...typographyRef.current, [key]: value };
    typographyRef.current = next;
    setValues((current) => ({ ...current, messageTypography: next }));
    applyMessageTypography(next);
    setStatus(t("settingsPage.applyOnRelease"));
  }

  function saveTypography() {
    void savePatch({ messageTypography: typographyRef.current });
  }

  function resetTypography() {
    typographyRef.current = DEFAULT_MESSAGE_TYPOGRAPHY;
    setValues((current) => ({ ...current, messageTypography: DEFAULT_MESSAGE_TYPOGRAPHY }));
    applyMessageTypography(DEFAULT_MESSAGE_TYPOGRAPHY);
    void savePatch({ messageTypography: DEFAULT_MESSAGE_TYPOGRAPHY }, t("settingsPage.messageTypographyReset"));
  }

  function updatePetBoolean(key: "petAlwaysOnTop" | "petVisible", checked: boolean) {
    setValues((current) => ({ ...current, [key]: checked }));
    if (key === "petAlwaysOnTop") window.settings?.setPetAlwaysOnTop(checked);
    else window.settings?.setPetVisible(checked);
    setStatus(t("settingsPage.applied"));
  }

  return (
    <div className="cy-page cy-settings-page">
      <header className="cy-page-windows cy-settings-titlebar">
        <WindowControls
          onMinimize={() => window.chat?.minimize()}
          onMaximize={() => window.chat?.toggleMaximize()}
          onClose={() => window.chat?.close()}
        />
      </header>

      <aside className="cy-page-sidebar cy-settings-sidebar">
        <div className="cy-settings-brand"><img className="cy-settings-brand__logo" src={settingsLogoUrl} alt="" aria-hidden="true" /><span>昔涟</span></div>
        <Button className="cy-settings-back" type="text" icon={<ArrowLeft size={16} />} onClick={onBackToWorkspace}>
          {t("settingsPage.backToWorkspace")}
        </Button>
        <SettingsSearch section={section} onSelectSection={onSelectSection} getContentRoot={() => contentRef.current}
          onRevealEntry={(entry) => {
            const kind = entry.kind;
            if (entry.section === "plugins") {
              setPluginSearchView(entry.settingKey === "pluginPanel.market.title" ? "market" : "installed");
              setSearchReveal((current) => ({ ...current, plugin: current.plugin + 1 }));
            } else if (kind !== "setting") setSearchReveal((current) => ({ ...current, [kind]: current[kind] + 1 }));
          }} />
        <nav className="cy-settings-sidebar__nav" aria-label={t("settingsPage.navigation")}>
        {SETTINGS_NAV_GROUPS.map((group, groupIndex) => (
          <Fragment key={group.titleKey}>
            <div className={`cy-settings-sidebar__group-title${groupIndex > 0 ? " cy-settings-sidebar__group-title--spaced" : ""}`}>{t(group.titleKey)}</div>
            {group.items.map((item) => (
              <SettingsNavItem key={item.section} section={item.section} currentSection={section} icon={item.icon} label={t(item.labelKey)} onSelect={onSelectSection} />
            ))}
          </Fragment>
        ))}
        </nav>
        <div className="cy-settings-sidebar__footer">
          v{packageJson.version}
          {versionTitleKey && ` · ${t(versionTitleKey)}`}
        </div>
      </aside>

      <main className="cy-workspace is-empty cy-settings-content" ref={contentRef}>
        <div className={`cy-settings-content__inner${section === "knowledge" ? " is-knowledge-settings" : ""}`}>
          {section === "email" ? <EmailSettingsPanel /> : section === "browser" ? <BrowserControlSettingsPanel /> : section === "preferences" ? <PreferencesSettingsPanel /> : section === "models" ? <ModelSettingsPanel /> : section === "usage" ? <UsageStatsPanel /> : section === "general" ? <GeneralSettingsPanel /> : section === "toolToggle" ? <ToolToggleSettingsPanel searchRevealRequest={searchReveal.tool} /> : section === "tools" ? <ToolSettingsPanel musicSettingsNavigation={musicSettingsNavigation} /> : section === "subagents" ? <SubagentSettingsPanel /> : section === "plugins" ? <PluginSettingsPanel searchRevealRequest={searchReveal.plugin} searchRevealView={pluginSearchView} /> : section === "memory" ? <MemorySettingsPanel /> : section === "knowledge" ? <KnowledgeBaseSettingsPanel /> : section === "cyrene" ? <CyreneSettingsPanel /> : section === "skill" ? <SkillSettingsPanel searchRevealRequest={searchReveal.skill} /> : section === "asr" ? <AsrSettingsPanel /> : section === "tts" ? <TtsSettingsPanel /> : section === "mcp" ? <McpSettingsPanel /> : section === "channels" ? <ChannelsSettingsPanel /> : section === "disclaimer" ? <DisclaimerSettingsPanel /> : <>
            <h1>{t("settingsPage.appearance")}</h1>
            <p className="cy-settings-intro">{t("settingsPage.description")}</p>

            {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.loadFailed")} />}
            {loading ? <div className="cy-settings-loading"><Spin /></div> : (
              <>
              <section className="cy-settings-section">
                <div className="cy-settings-section__heading">
                  <h2><Type size={18} />{t("settingsPage.interface")}</h2>
                  <p>{t("settingsPage.interfaceDescription")}</p>
                </div>
                <Card>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.theme")}</strong><span>{t("settingsPage.themeDescription")}</span></div>
                    <SettingsSegmented value={values.uiTheme} onChange={(value) => void selectTheme(value as UiThemeChoice)} options={[{ label: t("settingsPage.themeSystem"), value: "system" }, { label: t("settingsPage.themePearlWhite"), value: "pearl-white" }, { label: t("settingsPage.themeCharcoalPink"), value: "charcoal-pink" }]} />
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.uiFont")}</strong><span>{t("settingsPage.defaultFont")}</span></div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.cyreneAvatar")}</strong><span>{t("settingsPage.cyreneAvatarDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-avatar-control">
                      <img className="cy-settings-avatar-preview" src={cyreneAvatarUrl} alt={t("settingsPage.cyreneAvatar")} />
                      <Button disabled={avatarBusy} onClick={() => void uploadCyreneAvatar()}>{t("settingsPage.cyreneAvatarUpload")}</Button>
                      <Button disabled={avatarBusy} data-settings-search-key="settingsPage.cyreneAvatarResetButton" onClick={() => void resetCyreneAvatar()}>{t("settingsPage.cyreneAvatarResetButton")}</Button>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageTypography")}</strong><span>{t("settingsPage.messageTypographyDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-button-group">
                      <Button data-settings-search-key="settingsPage.messageTypographyResetButton" onClick={resetTypography}>{t("settingsPage.messageTypographyResetButton")}</Button>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageFontSize")}</strong><span>{t("settingsPage.messageFontSizeDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={MESSAGE_TYPOGRAPHY_RANGES.fontSize.min} max={MESSAGE_TYPOGRAPHY_RANGES.fontSize.max} step={0.5} value={values.messageTypography.fontSize} ariaLabel={t("settingsPage.messageFontSize")} onChange={(value) => updateTypography("fontSize", value)} onChangeComplete={() => saveTypography()} />
                      <span>{values.messageTypography.fontSize}px</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageLineHeight")}</strong><span>{t("settingsPage.messageLineHeightDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={MESSAGE_TYPOGRAPHY_RANGES.lineHeight.min} max={MESSAGE_TYPOGRAPHY_RANGES.lineHeight.max} step={0.05} value={values.messageTypography.lineHeight} ariaLabel={t("settingsPage.messageLineHeight")} onChange={(value) => updateTypography("lineHeight", value)} onChangeComplete={() => saveTypography()} />
                      <span>{values.messageTypography.lineHeight}</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageLetterSpacing")}</strong><span>{t("settingsPage.messageLetterSpacingDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={MESSAGE_TYPOGRAPHY_RANGES.letterSpacing.min} max={MESSAGE_TYPOGRAPHY_RANGES.letterSpacing.max} step={0.1} value={values.messageTypography.letterSpacing} ariaLabel={t("settingsPage.messageLetterSpacing")} onChange={(value) => updateTypography("letterSpacing", value)} onChangeComplete={() => saveTypography()} />
                      <span>{values.messageTypography.letterSpacing}px</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageFontWeight")}</strong><span>{t("settingsPage.messageFontWeightDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={MESSAGE_TYPOGRAPHY_RANGES.fontWeight.min} max={MESSAGE_TYPOGRAPHY_RANGES.fontWeight.max} step={50} value={values.messageTypography.fontWeight} ariaLabel={t("settingsPage.messageFontWeight")} onChange={(value) => updateTypography("fontWeight", value)} onChangeComplete={() => saveTypography()} />
                      <span>{values.messageTypography.fontWeight}</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <p className="cy-message-typography-preview">{t("settingsPage.messageTypographyPreviewText")}</p>
                  </div>
                </Card>
              </section>

              <section className="cy-settings-section">
                <div className="cy-settings-section__heading">
                  <h2><Monitor size={18} />{t("settingsPage.pet")}</h2>
                  <p>{t("settingsPage.petDescription")}</p>
                </div>
                <Card>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.petAlwaysOnTop")}</strong><span>{t("settingsPage.petAlwaysOnTopDescription")}</span></div>
                    <SettingsSwitch ariaLabel={t("settingsPage.petAlwaysOnTop")} checked={values.petAlwaysOnTop} onChange={(checked) => updatePetBoolean("petAlwaysOnTop", checked)} />
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.petVisible")}</strong><span>{t("settingsPage.petVisibleDescription")}</span></div>
                    <SettingsSwitch ariaLabel={t("settingsPage.petVisible")} checked={values.petVisible} onChange={(checked) => updatePetBoolean("petVisible", checked)} />
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.petZoom")}</strong><span>{t("settingsPage.petZoomDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={0.5} max={2} step={0.1} value={values.petZoom} ariaLabel={t("settingsPage.petZoom")} onChange={(value) => updateNumber("petZoom", value)} onChangeComplete={(zoom) => { window.settings?.setPetZoom(zoom); setStatus(t("settingsPage.applied")); }} />
                      <span>{Math.round(values.petZoom * 100)}%</span>
                    </div>
                  </div>
                </Card>
              </section>

                <div className="cy-settings-status" role="status" aria-live="polite">{status || t("settingsPage.autoApply")}</div>
              </>
            )}
          </>}
        </div>
      </main>
    </div>
  );
}
