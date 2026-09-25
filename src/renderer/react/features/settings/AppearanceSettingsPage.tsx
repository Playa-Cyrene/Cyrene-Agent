import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Spin } from "antd";
import { ArrowLeft, AudioLines, BarChart3, Boxes, Brain, FileText, Headphones, Heart, Monitor, Palette, Power, Puzzle, Settings2, Smartphone, Sparkles, Type, Wrench } from "lucide-react";
import { MCP } from "@lobehub/icons";
import packageJson from "../../../../../package.json";
import { normalizeUiFont, type UiFont } from "../../../../shared/ui-font";
import { normalizeUiIcon, UI_ICON_PRESETS, type UiIcon } from "../../../../shared/ui-icon";
import { normalizeWindowCornerRadius } from "../../../../shared/window-corner-radius";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  MESSAGE_TYPOGRAPHY_RANGES,
  normalizeMessageTypography,
  type MessageTypography,
} from "../../../../shared/message-typography";
import { useTranslation } from "../../i18n";
import { applyWindowCornerRadius } from "../../../ui/window-corner-radius";
import { applyMessageTypography } from "../../../ui/message-typography";
import { WindowControls } from "../../components/ui/WindowControls";
import { SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import "../../components/ui/NewTaskButton.css";
import { PreferencesSettingsPanel } from "./PreferencesSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { ToolSettingsPanel } from "./ToolSettingsPanel";
import { MemorySettingsPanel } from "./MemorySettingsPanel";
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
import settingsLogoUrl from "../../../settings/100.png";
import "../../components/ui/WindowControls.css";
import "./AppearanceSettingsPage.css";

interface AppearanceValues {
  windowCornerRadius: number;
  uiFont: UiFont;
  uiIcon: UiIcon;
  messageTypography: MessageTypography;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
}

const defaults: AppearanceValues = {
  windowCornerRadius: 24,
  uiFont: { kind: "source-han" },
  uiIcon: "cyrene-sun",
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
    windowCornerRadius: normalizeWindowCornerRadius(input.windowCornerRadius),
    uiFont: normalizeUiFont(input.uiFont),
    uiIcon: normalizeUiIcon(input.uiIcon),
    messageTypography: normalizeMessageTypography(input.messageTypography),
    petAlwaysOnTop: typeof input.petAlwaysOnTop === "boolean" ? input.petAlwaysOnTop : defaults.petAlwaysOnTop,
    petVisible: typeof input.petVisible === "boolean" ? input.petVisible : defaults.petVisible,
    petZoom: finiteNumber(input.petZoom, defaults.petZoom),
  };
}

export type SettingsSection =
  | "appearance" | "preferences" | "models" | "usage" | "general" | "toolToggle" | "tools" | "plugins" | "memory" | "cyrene" | "skill" | "asr" | "tts" | "mcp" | "channels" | "disclaimer";

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
  const [fontBusy, setFontBusy] = useState(false);
  // 昔涟消息字体：ref 记住最新值，松手保存时不依赖可能过期的渲染闭包
  const typographyRef = useRef<MessageTypography>(DEFAULT_MESSAGE_TYPOGRAPHY);

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
        applyWindowCornerRadius(next.windowCornerRadius);
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setLoadError(true);
        setLoading(false);
      });

    return () => { disposed = true; };
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

  function updateNumber<K extends "windowCornerRadius" | "petZoom">(
    key: K,
    value: number,
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "windowCornerRadius") applyWindowCornerRadius(value);
    setStatus(t("settingsPage.applyOnRelease"));
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

  async function changeFont() {
    setFontBusy(true);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const sourcePath = await window.settings.pickUiFont();
      if (!sourcePath) return;
      setStatus(t("settingsPage.importingFont"));
      const uiFont = await window.settings.importUiFont(sourcePath);
      setValues((current) => ({ ...current, uiFont }));
      setStatus(t("settingsPage.fontApplied"));
    } catch {
      setStatus(t("settingsPage.fontImportFailed"));
    } finally {
      setFontBusy(false);
    }
  }

  async function resetFont() {
    setFontBusy(true);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const uiFont = await window.settings.resetUiFont();
      setValues((current) => ({ ...current, uiFont }));
      setStatus(t("settingsPage.fontReset"));
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setFontBusy(false);
    }
  }

  async function selectIcon(uiIcon: UiIcon) {
    if (uiIcon === values.uiIcon) return;
    const saved = await savePatch({ uiIcon }, t("settingsPage.iconApplied"));
    if (saved) setValues((current) => ({ ...current, uiIcon: normalizeUiIcon(uiIcon) }));
  }

  function updatePetBoolean(key: "petAlwaysOnTop" | "petVisible", checked: boolean) {
    setValues((current) => ({ ...current, [key]: checked }));
    if (key === "petAlwaysOnTop") window.settings?.setPetAlwaysOnTop(checked);
    else window.settings?.setPetVisible(checked);
    setStatus(t("settingsPage.applied"));
  }

  const fontName = values.uiFont.kind === "custom" ? values.uiFont.displayName : t("settingsPage.defaultFont");

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
        <nav className="cy-settings-sidebar__nav" aria-label={t("settingsPage.navigation")}>
        <div className="cy-settings-sidebar__group-title">{t("settingsPage.basicSettings")}</div>
        <SettingsNavItem section="general" currentSection={section} icon={<Settings2 size={18} strokeWidth={1.8} />} label={t("settingsPage.general.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="appearance" currentSection={section} icon={<Palette size={18} strokeWidth={1.8} />} label={t("settingsPage.appearance")} onSelect={onSelectSection} />
        <SettingsNavItem section="preferences" currentSection={section} icon={<Monitor size={18} strokeWidth={1.8} />} label={t("settingsPage.preferencesLabel")} onSelect={onSelectSection} />
        <SettingsNavItem section="models" currentSection={section} icon={<Boxes size={18} strokeWidth={1.8} />} label={t("settingsPage.modelSettings.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="usage" currentSection={section} icon={<BarChart3 size={18} strokeWidth={1.8} />} label={t("settingsPage.usage.title")} onSelect={onSelectSection} />
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.agentAbilities")}</div>
        <SettingsNavItem section="toolToggle" currentSection={section} icon={<Power size={18} strokeWidth={1.8} />} label={t("settingsPage.toolToggle.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="tools" currentSection={section} icon={<Wrench size={18} strokeWidth={1.8} />} label={t("settingsPage.tools.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="plugins" currentSection={section} icon={<Puzzle size={18} strokeWidth={1.8} />} label={t("pluginPanel.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="mcp" currentSection={section} icon={<MCP size={18} />} label={t("settingsPage.mcp.menuLabel")} onSelect={onSelectSection} />
        <SettingsNavItem section="memory" currentSection={section} icon={<Brain size={18} strokeWidth={1.8} />} label={t("settingsPage.memory.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="cyrene" currentSection={section} icon={<Heart size={18} strokeWidth={1.8} />} label={t("settingsPage.cyrene.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="skill" currentSection={section} icon={<Sparkles size={18} strokeWidth={1.8} />} label={t("settingsPage.skill.title")} onSelect={onSelectSection} />
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.externalChannels")}</div>
        <SettingsNavItem section="channels" currentSection={section} icon={<Smartphone size={18} strokeWidth={1.8} />} label={t("settingsPage.channels.title")} onSelect={onSelectSection} />
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.voiceAbilities")}</div>
        <SettingsNavItem section="tts" currentSection={section} icon={<AudioLines size={18} strokeWidth={1.8} />} label={t("settingsPage.tts.title")} onSelect={onSelectSection} />
        <SettingsNavItem section="asr" currentSection={section} icon={<Headphones size={18} strokeWidth={1.8} />} label={t("settingsPage.asr.title")} onSelect={onSelectSection} />
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.usageNotice")}</div>
        <SettingsNavItem section="disclaimer" currentSection={section} icon={<FileText size={18} strokeWidth={1.8} />} label={t("settingsPage.disclaimer.navLabel")} onSelect={onSelectSection} />
        </nav>
        <div className="cy-settings-sidebar__footer">v{packageJson.version}</div>
      </aside>

      <main className="cy-workspace is-empty cy-settings-content">
        <div className="cy-settings-content__inner">
          {section === "preferences" ? <PreferencesSettingsPanel /> : section === "models" ? <ModelSettingsPanel /> : section === "usage" ? <UsageStatsPanel /> : section === "general" ? <GeneralSettingsPanel /> : section === "toolToggle" ? <ToolToggleSettingsPanel /> : section === "tools" ? <ToolSettingsPanel musicSettingsNavigation={musicSettingsNavigation} /> : section === "plugins" ? <PluginSettingsPanel /> : section === "memory" ? <MemorySettingsPanel /> : section === "cyrene" ? <CyreneSettingsPanel /> : section === "skill" ? <SkillSettingsPanel /> : section === "asr" ? <AsrSettingsPanel /> : section === "tts" ? <TtsSettingsPanel /> : section === "mcp" ? <McpSettingsPanel /> : section === "channels" ? <ChannelsSettingsPanel /> : section === "disclaimer" ? <DisclaimerSettingsPanel /> : <>
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
                <div className="cy-settings-card">
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.windowRadius")}</strong><span>{t("settingsPage.windowRadiusDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <SettingsSlider min={0} max={40} step={1} value={values.windowCornerRadius} ariaLabel={t("settingsPage.windowRadius")} onChange={(value) => updateNumber("windowCornerRadius", value)} onChangeComplete={(value) => void savePatch({ windowCornerRadius: value })} />
                      <span>{values.windowCornerRadius}px</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.uiFont")}</strong><span>{fontName}</span></div>
                    <div className="cy-settings-row__control cy-settings-button-group">
                      <Button loading={fontBusy} onClick={() => void changeFont()}>{t("settingsPage.importFont")}</Button>
                      {values.uiFont.kind === "custom" && <Button disabled={fontBusy} onClick={() => void resetFont()}>{t("settingsPage.resetFont")}</Button>}
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.messageTypography")}</strong><span>{t("settingsPage.messageTypographyDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-button-group">
                      <Button onClick={resetTypography}>{t("settingsPage.messageTypographyResetButton")}</Button>
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
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.desktopIcon")}</strong><span>{t("settingsPage.desktopIconDescription")}</span></div>
                    <div className="cy-settings-icon-options" role="radiogroup" aria-label={t("settingsPage.desktopIcon")}>
                      {UI_ICON_PRESETS.map((preset) => (
                        <button key={preset.id} type="button" className={`cy-settings-icon-option ${values.uiIcon === preset.id ? "is-active" : ""}`} aria-pressed={values.uiIcon === preset.id} aria-label={preset.label} onClick={() => void selectIcon(preset.id)}>
                          <img src={`/icons/${preset.fileName}`} alt="" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="cy-settings-section">
                <div className="cy-settings-section__heading">
                  <h2><Monitor size={18} />{t("settingsPage.pet")}</h2>
                  <p>{t("settingsPage.petDescription")}</p>
                </div>
                <div className="cy-settings-card">
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
                </div>
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
