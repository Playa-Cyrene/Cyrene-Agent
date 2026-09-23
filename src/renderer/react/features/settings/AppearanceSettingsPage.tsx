import { useEffect, useState } from "react";
import { Alert, Button, Slider, Spin, Switch } from "antd";
import { ArrowLeft, Boxes, Brain, Headphones, Heart, Monitor, Palette, Settings2, Type, Wrench } from "lucide-react";
import { MCP } from "@lobehub/icons";
import { normalizeUiFont, type UiFont } from "../../../../shared/ui-font";
import { normalizeUiIcon, UI_ICON_PRESETS, type UiIcon } from "../../../../shared/ui-icon";
import { normalizeWindowCornerRadius } from "../../../../shared/window-corner-radius";
import { useTranslation } from "../../i18n";
import { applyWindowCornerRadius } from "../../../ui/window-corner-radius";
import { WindowControls } from "../../components/ui/WindowControls";
import { PreferencesSettingsPanel } from "./PreferencesSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { ToolSettingsPanel } from "./ToolSettingsPanel";
import { MemorySettingsPanel } from "./MemorySettingsPanel";
import { CyreneSettingsPanel } from "./CyreneSettingsPanel";
import { AsrSettingsPanel } from "./AsrSettingsPanel";
import { McpSettingsPanel } from "./McpSettingsPanel";
import settingsLogoUrl from "../../../settings/100.png";
import "../../components/ui/WindowControls.css";
import "./AppearanceSettingsPage.css";

interface AppearanceValues {
  windowCornerRadius: number;
  uiFont: UiFont;
  uiIcon: UiIcon;
  chatLineHeight: number;
  chatParaSpacing: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
}

const defaults: AppearanceValues = {
  windowCornerRadius: 24,
  uiFont: { kind: "source-han" },
  uiIcon: "cyrene-sun",
  chatLineHeight: 1.75,
  chatParaSpacing: 0.5,
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
    chatLineHeight: finiteNumber(input.chatLineHeight, defaults.chatLineHeight),
    chatParaSpacing: finiteNumber(input.chatParaSpacing, defaults.chatParaSpacing),
    petAlwaysOnTop: typeof input.petAlwaysOnTop === "boolean" ? input.petAlwaysOnTop : defaults.petAlwaysOnTop,
    petVisible: typeof input.petVisible === "boolean" ? input.petVisible : defaults.petVisible,
    petZoom: finiteNumber(input.petZoom, defaults.petZoom),
  };
}

export interface AppearanceSettingsPageProps {
  section: "appearance" | "preferences" | "models" | "general" | "tools" | "memory" | "cyrene" | "asr" | "mcp";
  onSelectSection: (section: "appearance" | "preferences" | "models" | "general" | "tools" | "memory" | "cyrene" | "asr" | "mcp") => void;
  onBackToWorkspace: () => void;
}

export function AppearanceSettingsPage({ section, onSelectSection, onBackToWorkspace }: AppearanceSettingsPageProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const [fontBusy, setFontBusy] = useState(false);

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
        applyWindowCornerRadius(next.windowCornerRadius);
        document.documentElement.style.setProperty("--rb-chat-line-height", String(next.chatLineHeight));
        document.documentElement.style.setProperty("--rb-chat-para-spacing", `${next.chatParaSpacing}em`);
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

  function updateNumber<K extends "windowCornerRadius" | "chatLineHeight" | "chatParaSpacing" | "petZoom">(
    key: K,
    value: number,
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "windowCornerRadius") applyWindowCornerRadius(value);
    if (key === "chatLineHeight") document.documentElement.style.setProperty("--rb-chat-line-height", String(value));
    if (key === "chatParaSpacing") document.documentElement.style.setProperty("--rb-chat-para-spacing", `${value}em`);
    setStatus(t("settingsPage.applyOnRelease"));
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
        <div className="cy-settings-sidebar__group-title">{t("settingsPage.basicSettings")}</div>
        <Button
          className={`cy-settings-nav-item ${section === "models" ? "is-active" : ""}`}
          type="text"
          icon={<Boxes size={16} />}
          aria-current={section === "models" ? "page" : undefined}
          onClick={() => onSelectSection("models")}
        >
          {t("settingsPage.modelSettings.title")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "appearance" ? "is-active" : ""}`}
          type="text"
          icon={<Palette size={16} />}
          aria-current={section === "appearance" ? "page" : undefined}
          onClick={() => onSelectSection("appearance")}
        >
          {t("settingsPage.appearance")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "preferences" ? "is-active" : ""}`}
          type="text"
          icon={<Monitor size={16} />}
          aria-current={section === "preferences" ? "page" : undefined}
          onClick={() => onSelectSection("preferences")}
        >
          {t("settingsPage.preferencesLabel")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "general" ? "is-active" : ""}`}
          type="text"
          icon={<Settings2 size={16} />}
          aria-current={section === "general" ? "page" : undefined}
          onClick={() => onSelectSection("general")}
        >
          {t("settingsPage.general.title")}
        </Button>
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.agentAbilities")}</div>
        <Button
          className={`cy-settings-nav-item ${section === "memory" ? "is-active" : ""}`}
          type="text"
          icon={<Brain size={16} />}
          aria-current={section === "memory" ? "page" : undefined}
          onClick={() => onSelectSection("memory")}
        >
          {t("settingsPage.memory.title")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "cyrene" ? "is-active" : ""}`}
          type="text"
          icon={<Heart size={16} />}
          aria-current={section === "cyrene" ? "page" : undefined}
          onClick={() => onSelectSection("cyrene")}
        >
          {t("settingsPage.cyrene.title")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "tools" ? "is-active" : ""}`}
          type="text"
          icon={<Wrench size={16} />}
          aria-current={section === "tools" ? "page" : undefined}
          onClick={() => onSelectSection("tools")}
        >
          {t("settingsPage.tools.title")}
        </Button>
        <Button
          className={`cy-settings-nav-item ${section === "mcp" ? "is-active" : ""}`}
          type="text"
          icon={<MCP size={16} />}
          aria-current={section === "mcp" ? "page" : undefined}
          onClick={() => onSelectSection("mcp")}
        >
          {t("settingsPage.mcp.menuLabel")}
        </Button>
        <div className="cy-settings-sidebar__group-title cy-settings-sidebar__group-title--spaced">{t("settingsPage.voiceAbilities")}</div>
        <Button
          className={`cy-settings-nav-item ${section === "asr" ? "is-active" : ""}`}
          type="text"
          icon={<Headphones size={16} />}
          aria-current={section === "asr" ? "page" : undefined}
          onClick={() => onSelectSection("asr")}
        >
          {t("settingsPage.asr.title")}
        </Button>
        <div className="cy-settings-sidebar__footer">{t("settingsPage.moreSettingsLater")}</div>
      </aside>

      <main className="cy-workspace is-empty cy-settings-content">
        <div className="cy-settings-content__inner">
          {section === "preferences" ? <PreferencesSettingsPanel /> : section === "models" ? <ModelSettingsPanel /> : section === "general" ? <GeneralSettingsPanel /> : section === "tools" ? <ToolSettingsPanel /> : section === "memory" ? <MemorySettingsPanel /> : section === "cyrene" ? <CyreneSettingsPanel /> : section === "asr" ? <AsrSettingsPanel /> : section === "mcp" ? <McpSettingsPanel /> : <>
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
                      <Slider min={0} max={40} step={1} value={values.windowCornerRadius} tooltip={{ formatter: (value) => `${value}px` }} onChange={(value) => updateNumber("windowCornerRadius", Number(value))} onChangeComplete={(value) => void savePatch({ windowCornerRadius: Number(value) })} />
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
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.chatLineHeight")}</strong><span>{t("settingsPage.chatLineHeightDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <Slider min={1.2} max={2} step={0.05} value={values.chatLineHeight} tooltip={{ formatter: (value) => Number(value).toFixed(2) }} onChange={(value) => updateNumber("chatLineHeight", Number(value))} onChangeComplete={(value) => void savePatch({ chatLineHeight: Number(value) })} />
                      <span>{values.chatLineHeight.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.chatParagraphSpacing")}</strong><span>{t("settingsPage.chatParagraphSpacingDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <Slider min={0.2} max={1.2} step={0.05} value={values.chatParaSpacing} tooltip={{ formatter: (value) => `${Number(value).toFixed(2)}em` }} onChange={(value) => updateNumber("chatParaSpacing", Number(value))} onChangeComplete={(value) => void savePatch({ chatParaSpacing: Number(value) })} />
                      <span>{values.chatParaSpacing.toFixed(2)}em</span>
                    </div>
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
                    <Switch checked={values.petAlwaysOnTop} onChange={(checked) => updatePetBoolean("petAlwaysOnTop", checked)} />
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.petVisible")}</strong><span>{t("settingsPage.petVisibleDescription")}</span></div>
                    <Switch checked={values.petVisible} onChange={(checked) => updatePetBoolean("petVisible", checked)} />
                  </div>
                  <div className="cy-settings-row">
                    <div className="cy-settings-row__copy"><strong>{t("settingsPage.petZoom")}</strong><span>{t("settingsPage.petZoomDescription")}</span></div>
                    <div className="cy-settings-row__control cy-settings-slider">
                      <Slider min={0.5} max={2} step={0.1} value={values.petZoom} tooltip={{ formatter: (value) => `${Math.round(Number(value) * 100)}%` }} onChange={(value) => updateNumber("petZoom", Number(value))} onChangeComplete={(value) => { const zoom = Number(value); window.settings?.setPetZoom(zoom); setStatus(t("settingsPage.applied")); }} />
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
