import { useEffect, useState } from "react";
import { Alert, Button, Modal, Radio, Spin } from "antd";
import { FileText, SlidersHorizontal } from "lucide-react";
import {
  normalizeChatSocialContextEnabled,
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  type MobileMessageSegmentationMode,
  type ProactiveChatMode,
  type ProactiveDeliveryTarget,
} from "../../../../shared/preferences";
import {
  DEFAULT_CUSTOM_STYLE,
  normalizeCustomStyleConfig,
  type CustomStyleConfig,
  type DiversityPreference,
  type RepetitionLevel,
} from "../../../../shared/style-sampling";
import { isProactiveDeliveryTargetSelectable } from "../../../../shared/proactive-delivery";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSegmented, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";

type Liveliness = "quiet" | "natural" | "lively";

interface PreferencesValues {
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  customStyle: CustomStyleConfig;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  momentsEnabled: boolean;
  cyreneMomentsPostingEnabled: boolean;
  cyreneMomentsReactionsEnabled: boolean;
  momentsCharacterReactionsEnabled: boolean;
  momentsLiveliness: Liveliness;
  chatSocialContextEnabled: boolean;
  citaEnabled: boolean;
}

type ChannelStatus = Record<string, { phase?: string }>;

const defaults: PreferencesValues = {
  mobileMessageSegmentation: "off",
  customStyle: DEFAULT_CUSTOM_STYLE,
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  momentsEnabled: true,
  cyreneMomentsPostingEnabled: false,
  cyreneMomentsReactionsEnabled: true,
  momentsCharacterReactionsEnabled: true,
  momentsLiveliness: "quiet",
  chatSocialContextEnabled: false,
  citaEnabled: false,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readPreferences(value: unknown): PreferencesValues {
  const input = objectValue(value);
  const liveliness = input.momentsLiveliness;
  return {
    mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(input.mobileMessageSegmentation),
    customStyle: normalizeCustomStyleConfig(input.customStyle),
    proactiveChatMode: normalizeProactiveChatMode(input.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(input.proactiveDeliveryTarget),
    momentsEnabled: typeof input.momentsEnabled === "boolean" ? input.momentsEnabled : defaults.momentsEnabled,
    cyreneMomentsPostingEnabled: typeof input.cyreneMomentsPostingEnabled === "boolean" ? input.cyreneMomentsPostingEnabled : defaults.cyreneMomentsPostingEnabled,
    cyreneMomentsReactionsEnabled: typeof input.cyreneMomentsReactionsEnabled === "boolean" ? input.cyreneMomentsReactionsEnabled : defaults.cyreneMomentsReactionsEnabled,
    momentsCharacterReactionsEnabled: typeof input.momentsCharacterReactionsEnabled === "boolean" ? input.momentsCharacterReactionsEnabled : defaults.momentsCharacterReactionsEnabled,
    momentsLiveliness: liveliness === "natural" || liveliness === "lively" ? liveliness : "quiet",
    chatSocialContextEnabled: normalizeChatSocialContextEnabled(input.chatSocialContextEnabled),
    citaEnabled: input.citaEnabled === true,
  };
}

function readChannelStatus(value: unknown): ChannelStatus {
  const input = objectValue(value);
  const output: ChannelStatus = {};
  for (const key of ["wechat", "feishu"]) {
    const item = objectValue(input[key]);
    output[key] = { phase: typeof item.phase === "string" ? item.phase : undefined };
  }
  return output;
}

export function PreferencesSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [channels, setChannels] = useState<ChannelStatus>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState<CustomStyleConfig>(DEFAULT_CUSTOM_STYLE);
  const [styleSaving, setStyleSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    const api = window.settings;
    if (!api) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    void Promise.all([api.getGeneral(), api.channelsGetStatus().catch(() => ({}))])
      .then(([config, channelStatus]) => {
        if (disposed) return;
        setValues(readPreferences(config));
        setChannels(readChannelStatus(channelStatus));
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  function update<K extends keyof PreferencesValues>(key: K, value: PreferencesValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus(t("settingsPage.preferences.unsaved"));
  }

  async function savePreferences() {
    setSaving(true);
    setStatus(t("settingsPage.preferences.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const {
        citaEnabled,
        chatSocialContextEnabled,
        momentsEnabled,
        cyreneMomentsPostingEnabled,
        cyreneMomentsReactionsEnabled,
        momentsCharacterReactionsEnabled,
        momentsLiveliness,
        mobileMessageSegmentation,
        proactiveChatMode,
        proactiveDeliveryTarget,
      } = values;
      await window.settings.saveGeneral({
        citaEnabled,
        chatSocialContextEnabled,
        momentsEnabled,
        cyreneMomentsPostingEnabled,
        cyreneMomentsReactionsEnabled,
        momentsCharacterReactionsEnabled,
        momentsLiveliness,
        mobileMessageSegmentation,
        proactiveChatMode,
        proactiveDeliveryTarget,
      });
      setStatus(t("settingsPage.preferences.saved"));
    } catch {
      setStatus(t("settingsPage.preferences.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomStyle() {
    setStyleSaving(true);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const customStyle = normalizeCustomStyleConfig(styleDraft);
      await window.settings.saveGeneral({ customStyle });
      setValues((current) => ({ ...current, customStyle }));
      setStyleOpen(false);
      setStatus(t("settingsPage.preferences.customStyleSaved"));
    } catch {
      setStatus(t("settingsPage.preferences.saveFailed"));
    } finally {
      setStyleSaving(false);
    }
  }

  async function openCustomPrompt() {
    try {
      const result = objectValue(await window.settings?.openCustomStylePrompt());
      setStatus(result.ok === true
        ? t("settingsPage.preferences.promptOpened")
        : t("settingsPage.preferences.promptFailed"));
    } catch {
      setStatus(t("settingsPage.preferences.promptFailed"));
    }
  }

  function updateDiversity(driver: DiversityPreference["driver"]) {
    setStyleDraft((current) => ({
      ...current,
      diversity: driver === "model-default"
        ? { driver }
        : { driver, value: current.diversity.driver === driver ? current.diversity.value : driver === "temperature" ? 0.65 : 0.9 },
    }));
  }

  const diversity = styleDraft.diversity;
  const selectableTarget = (target: ProactiveDeliveryTarget) => isProactiveDeliveryTargetSelectable(target, channels[target]);

  return (
    <>
      <h1>{t("settingsPage.preferences.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.preferences.description")}</p>
      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.preferences.loadFailed")} />}
      {loading ? <div className="cy-settings-loading"><Spin /></div> : (
        <>
          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><SlidersHorizontal size={18} />{t("settingsPage.preferences.messaging")}</h2><p>{t("settingsPage.preferences.messagingDescription")}</p></div>
            <div className="cy-settings-card">
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.mobileSegmentation")}</strong><span>{t("settingsPage.preferences.mobileSegmentationDescription")}</span></div>
                <SettingsSegmented value={values.mobileMessageSegmentation} options={[{ label: t("settingsPage.preferences.off"), value: "off" }, { label: t("settingsPage.preferences.on"), value: "on" }]} onChange={(value) => update("mobileMessageSegmentation", value as MobileMessageSegmentationMode)} />
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.customStyle")}</strong><span>{t("settingsPage.preferences.customStyleDescription")}</span></div>
                <div className="cy-settings-row__control cy-settings-button-group">
                  <Button onClick={() => { setStyleDraft(values.customStyle); setStyleOpen(true); }} icon={<SlidersHorizontal size={15} />}>{t("settingsPage.preferences.customStyleButton")}</Button>
                  <Button onClick={() => void openCustomPrompt()} icon={<FileText size={15} />}>{t("settingsPage.preferences.openPrompt")}</Button>
                </div>
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.proactiveChat")}</strong><span>{t("settingsPage.preferences.proactiveChatDescription")}</span></div>
                <SettingsSegmented value={values.proactiveChatMode} options={[{ label: t("settingsPage.preferences.off"), value: "off" }, { label: t("settingsPage.preferences.on"), value: "on" }]} onChange={(value) => update("proactiveChatMode", value as ProactiveChatMode)} />
              </div>
              {values.proactiveChatMode === "on" && <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.deliveryTarget")}</strong><span>{t("settingsPage.preferences.deliveryTargetDescription")}</span></div>
                <SettingsSegmented
                  value={values.proactiveDeliveryTarget}
                  options={([
                    { label: t("settingsPage.preferences.local"), value: "local" },
                    { label: t("settingsPage.preferences.wechat"), value: "wechat", disabled: !selectableTarget("wechat") },
                    { label: t("settingsPage.preferences.feishu"), value: "feishu", disabled: !selectableTarget("feishu") },
                  ])}
                  onChange={(value) => update("proactiveDeliveryTarget", value as ProactiveDeliveryTarget)}
                />
              </div>}
            </div>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2>{t("settingsPage.preferences.moments")}</h2><p>{t("settingsPage.preferences.momentsDescription")}</p></div>
            <div className="cy-settings-card">
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsEnabled")}</strong><span>{t("settingsPage.preferences.momentsEnabledDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsEnabled")} checked={values.momentsEnabled} onChange={(checked) => update("momentsEnabled", checked)} /></div>
              {values.momentsEnabled && <>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsPosting")}</strong><span>{t("settingsPage.preferences.momentsPostingDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsPosting")} checked={values.cyreneMomentsPostingEnabled} onChange={(checked) => update("cyreneMomentsPostingEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsReactions")}</strong><span>{t("settingsPage.preferences.momentsReactionsDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsReactions")} checked={values.cyreneMomentsReactionsEnabled} onChange={(checked) => update("cyreneMomentsReactionsEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.characterReactions")}</strong><span>{t("settingsPage.preferences.characterReactionsDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.characterReactions")} checked={values.momentsCharacterReactionsEnabled} onChange={(checked) => update("momentsCharacterReactionsEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.liveliness")}</strong><span>{t("settingsPage.preferences.livelinessDescription")}</span></div><SettingsSegmented value={values.momentsLiveliness} options={[{ label: t("settingsPage.preferences.quiet"), value: "quiet" }, { label: t("settingsPage.preferences.natural"), value: "natural" }, { label: t("settingsPage.preferences.lively"), value: "lively" }]} onChange={(value) => update("momentsLiveliness", value as Liveliness)} /></div>
              </>}
            </div>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2>{t("settingsPage.preferences.context")}</h2><p>{t("settingsPage.preferences.contextDescription")}</p></div>
            <div className="cy-settings-card">
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.chatSocialContext")}</strong><span>{t("settingsPage.preferences.chatSocialContextDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.chatSocialContext")} checked={values.chatSocialContextEnabled} onChange={(checked) => update("chatSocialContextEnabled", checked)} /></div>
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.cita")}</strong><span>{t("settingsPage.preferences.citaDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.cita")} checked={values.citaEnabled} onChange={(checked) => update("citaEnabled", checked)} /></div>
            </div>
          </section>

          <div className="cy-settings-preferences-actions">
            <div className="cy-settings-status" role="status" aria-live="polite">{status || t("settingsPage.preferences.unsaved")}</div>
            <Button type="primary" loading={saving} onClick={() => void savePreferences()}>{t("settingsPage.preferences.save")}</Button>
          </div>
        </>
      )}

      <Modal
        rootClassName="cy-settings-theme-modal"
        title={t("settingsPage.preferences.customStyleModalTitle")}
        open={styleOpen}
        onCancel={() => setStyleOpen(false)}
        footer={[
          <Button key="reset" onClick={() => setStyleDraft(DEFAULT_CUSTOM_STYLE)}>{t("settingsPage.preferences.reset")}</Button>,
          <Button key="cancel" onClick={() => setStyleOpen(false)}>{t("settingsPage.preferences.cancel")}</Button>,
          <Button key="save" type="primary" loading={styleSaving} onClick={() => void saveCustomStyle()}>{t("settingsPage.preferences.save")}</Button>,
        ]}
      >
        <div className="cy-settings-style-section">
          <strong>{t("settingsPage.preferences.diversity")}</strong>
          <Radio.Group value={diversity.driver} onChange={(event) => updateDiversity(event.target.value)} optionType="button" buttonStyle="solid">
            <Radio.Button value="model-default">{t("settingsPage.preferences.followModel")}</Radio.Button>
            <Radio.Button value="temperature">Temperature</Radio.Button>
            <Radio.Button value="top-p">Top-P</Radio.Button>
          </Radio.Group>
          {diversity.driver !== "model-default" && <div className="cy-settings-style-value">
            <SettingsSlider min={0} max={diversity.driver === "top-p" ? 1 : 2} step={0.01} value={diversity.value} ariaLabel={t("settingsPage.preferences.diversity")} onChange={(value) => setStyleDraft((current) => ({ ...current, diversity: { ...current.diversity, value } }))} />
            <SettingsInput type="number" min={0} max={diversity.driver === "top-p" ? 1 : 2} step={0.01} value={diversity.value} aria-label={t("settingsPage.preferences.diversity")} onChange={(event) => setStyleDraft((current) => ({ ...current, diversity: { ...current.diversity, value: Number(event.target.value || 0) } }))} />
          </div>}
        </div>
        <div className="cy-settings-style-section">
          <strong>{t("settingsPage.preferences.repetition")}</strong>
          <Radio.Group value={styleDraft.repetition} onChange={(event) => setStyleDraft((current) => ({ ...current, repetition: event.target.value as RepetitionLevel }))} optionType="button" buttonStyle="solid">
            <Radio.Button value="model-default">{t("settingsPage.preferences.followModel")}</Radio.Button>
            <Radio.Button value="light">{t("settingsPage.preferences.light")}</Radio.Button>
            <Radio.Button value="medium">{t("settingsPage.preferences.medium")}</Radio.Button>
            <Radio.Button value="strong">{t("settingsPage.preferences.strong")}</Radio.Button>
          </Radio.Group>
        </div>
      </Modal>
    </>
  );
}
