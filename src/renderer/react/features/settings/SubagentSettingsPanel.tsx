import { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import { Bot, Cpu } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { SettingsSelect, SettingsSwitch, type SettingsSelectOption } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";

const DEFAULT_PERSONA_ENABLED = true;
const FOLLOW_MAIN_MODEL = "__follow_main_model__";

interface TaskModelChoice {
  value: string;
  label: string;
  profileId: string;
  model: string;
}

function readPersonaEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object") return DEFAULT_PERSONA_ENABLED;
  const setting = (value as Record<string, unknown>).taskCharacterPersonaEnabled;
  return typeof setting === "boolean" ? setting : DEFAULT_PERSONA_ENABLED;
}

export function SubagentSettingsPanel() {
  const { t } = useTranslation();
  const [personaEnabled, setPersonaEnabled] = useState(DEFAULT_PERSONA_ENABLED);
  const [modelChoice, setModelChoice] = useState(FOLLOW_MAIN_MODEL);
  const [modelChoices, setModelChoices] = useState<TaskModelChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let disposed = false;
    if (!window.settings) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    void Promise.all([window.settings.getGeneral(), window.settings.listModelProfiles()]).then(([settings, catalog]) => {
      if (disposed) return;
      const general = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
      const choices = catalog.profiles.flatMap((profile) => {
        const models = profile.models?.length ? profile.models : [profile.model];
        return models.filter(Boolean).map((model) => ({
          value: JSON.stringify({ profileId: profile.id, model }),
          label: `${profile.displayName || profile.provider} · ${model}`,
          profileId: profile.id,
          model,
        }));
      });
      const savedChoice = choices.find((choice) => choice.profileId === general.taskModelProfileId && choice.model === general.taskModel);
      setPersonaEnabled(readPersonaEnabled(settings));
      setModelChoices(choices);
      setModelChoice(savedChoice?.value ?? FOLLOW_MAIN_MODEL);
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoadError(true);
      setLoading(false);
    });
    return () => { disposed = true; };
  }, []);

  async function updatePersonaEnabled(enabled: boolean) {
    const previous = personaEnabled;
    setPersonaEnabled(enabled);
    setSaving(true);
    setStatus(t("settingsPage.subagents.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({ taskCharacterPersonaEnabled: enabled });
      setStatus(t("settingsPage.subagents.saved"));
    } catch {
      setPersonaEnabled(previous);
      setStatus(t("settingsPage.subagents.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function updateModelChoice(value: string) {
    const previous = modelChoice;
    setModelChoice(value);
    setSaving(true);
    setStatus(t("settingsPage.subagents.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const choice = modelChoices.find((candidate) => candidate.value === value);
      await window.settings.saveGeneral({
        taskModelProfileId: choice?.profileId,
        taskModel: choice?.model,
      });
      setStatus(t("settingsPage.subagents.saved"));
    } catch {
      setModelChoice(previous);
      setStatus(t("settingsPage.subagents.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const modelOptions: SettingsSelectOption<string>[] = [
    { value: FOLLOW_MAIN_MODEL, label: t("settingsPage.subagents.followMainModel") },
    ...modelChoices.map(({ value, label }) => ({ value, label })),
  ];

  return (
    <>
      <h1>{t("settingsPage.subagents.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.subagents.description")}</p>
      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.loadFailed")} />}
      {loading ? <div className="cy-settings-loading"><Spin /></div> : (
        <>
          <section className="cy-settings-section">
            <div className="cy-settings-section__heading">
              <h2 data-settings-search-id="settingsPage.subagents.personaTitle"><Bot size={18} />{t("settingsPage.subagents.personaTitle")}</h2>
              <p>{t("settingsPage.subagents.personaDescription")}</p>
            </div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy">
                  <strong data-settings-search-id="settingsPage.subagents.personaToggle">{t("settingsPage.subagents.personaToggle")}</strong>
                  <span>{personaEnabled ? t("settingsPage.subagents.personaEnabledHint") : t("settingsPage.subagents.personaDisabledHint")}</span>
                </div>
                <SettingsSwitch
                  ariaLabel={t("settingsPage.subagents.personaToggle")}
                  checked={personaEnabled}
                  disabled={saving}
                  onChange={(enabled) => void updatePersonaEnabled(enabled)}
                />
              </div>
            </Card>
          </section>
          <section className="cy-settings-section">
            <div className="cy-settings-section__heading">
              <h2 data-settings-search-id="settingsPage.subagents.modelTitle"><Cpu size={18} />{t("settingsPage.subagents.modelTitle")}</h2>
              <p>{t("settingsPage.subagents.modelDescription")}</p>
            </div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy">
                  <strong data-settings-search-id="settingsPage.subagents.modelLabel">{t("settingsPage.subagents.modelLabel")}</strong>
                  <span>{modelChoices.length === 0 ? t("settingsPage.subagents.noModels") : t("settingsPage.subagents.modelHint")}</span>
                </div>
                <SettingsSelect
                  ariaLabel={t("settingsPage.subagents.modelLabel")}
                  value={modelChoice}
                  options={modelOptions}
                  disabled={saving || modelChoices.length === 0}
                  onChange={(value) => void updateModelChoice(value)}
                />
              </div>
            </Card>
          </section>
        </>
      )}
      <div className="cy-settings-status" role="status" aria-live="polite">{status}</div>
    </>
  );
}
