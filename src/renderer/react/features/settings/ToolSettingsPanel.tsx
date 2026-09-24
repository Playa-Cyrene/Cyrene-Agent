import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { CloudSun, Files, Mail, Music2, Puzzle, Search, ShieldAlert } from "lucide-react";
import { siNeteasecloudmusic } from "simple-icons";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { SettingsInput, SettingsPasswordInput, SettingsSelect, SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";
import { MusicSettingsModal } from "./MusicSettingsModal";

type SearchEngine = "off" | "bocha" | "tavily" | "minimax" | "anySearch";
type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

interface ToolValues {
  weatherEnabled: boolean;
  weatherSource: "open-meteo" | "amap";
  amapKey: string;
  travelEnabled: boolean;
  searchEngine: SearchEngine;
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  searchAnySearchKey: string;
  emailEnabled: boolean;
  emailSmtpHost: string;
  emailSmtpPort: number;
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  emailSmtpPass: string;
  emailFromName: string;
}

const defaults: ToolValues = {
  weatherEnabled: false, weatherSource: "open-meteo", amapKey: "", travelEnabled: false,
  searchEngine: "off", searchBochaKey: "", searchTavilyKey: "", searchMinimaxKey: "", searchAnySearchKey: "",
  emailEnabled: false, emailSmtpHost: "", emailSmtpPort: 465, emailSmtpSecure: true,
  emailSmtpUser: "", emailSmtpPass: "", emailFromName: "",
};

const searchKeyFor: Record<Exclude<SearchEngine, "off">, keyof ToolValues> = {
  bocha: "searchBochaKey", tavily: "searchTavilyKey", minimax: "searchMinimaxKey", anySearch: "searchAnySearchKey",
};

function readTools(value: unknown): ToolValues {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = { ...defaults };
  for (const key of Object.keys(result) as Array<keyof ToolValues>) {
    if (typeof input[key] === typeof result[key]) {
      // The main-process settings facade validates enum values and port range.
      (result as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  return result;
}

interface MusicResult<T> { ok: boolean; data?: T; error?: string }
interface MusicApi {
  getCachedTracks: () => Promise<MusicResult<unknown[]>>;
  importLocalFolder: () => Promise<MusicResult<{ imported: number; skipped: number; cancelled?: boolean; truncated?: boolean }>>;
  importLocalTracks: () => Promise<MusicResult<{ imported: number; skipped: number; cancelled?: boolean; truncated?: boolean }>>;
  openPlayer: () => Promise<unknown>;
}

function musicApi(): MusicApi | undefined {
  return (window as Window & { music?: MusicApi }).music;
}

function ExtensionToolPanels() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [hasPanels, setHasPanels] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void import("../../../settings/plugin-panels")
      .then(({ mountPluginPanels }) => mountPluginPanels({
        containers: { plugins: containerRef.current }, signal: controller.signal,
      }))
      .then((cleanup) => {
        if (controller.signal.aborted) cleanup();
        else {
          dispose = cleanup;
          setHasPanels(Boolean(containerRef.current?.childElementCount));
        }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); dispose?.(); };
  }, []);

  return <section className="cy-settings-section" style={{ display: hasPanels || error ? undefined : "none" }}>
    <div className="cy-settings-section__heading"><h2><Puzzle size={18} />{t("settingsPage.tools.extensionPanels")}</h2><p>{t("settingsPage.tools.extensionPanelsDescription")}</p></div>
    {error && <Alert type="error" showIcon message={t("settingsPage.tools.extensionPanelsFailed")} />}
    <div ref={containerRef} className="plugin-panels cy-settings-tools__plugins" />
  </section>;
}

export function ToolSettingsPanel({ musicSettingsNavigation = 0 }: { musicSettingsNavigation?: number }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ToolValues>(defaults);
  const [permission, setPermission] = useState<PermissionLevel>("read-only");
  const [lastSearchEngine, setLastSearchEngine] = useState<Exclude<SearchEngine, "off">>("bocha");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const [fullAccessOpen, setFullAccessOpen] = useState(false);
  const [musicSettingsOpen, setMusicSettingsOpen] = useState(false);
  const [confirmSeconds, setConfirmSeconds] = useState(5);
  const [musicCount, setMusicCount] = useState<number | null>(null);
  const [musicStatus, setMusicStatus] = useState("");

  useEffect(() => {
    if (musicSettingsNavigation > 0) setMusicSettingsOpen(true);
  }, [musicSettingsNavigation]);

  useEffect(() => {
    let disposed = false;
    if (!window.settings) { setLoadError(true); setLoading(false); return; }
    void Promise.all([window.settings.getGeneral(), window.settings.getPermissionLevel()])
      .then(([config, permissionResult]) => {
        if (disposed) return;
        const next = readTools(config);
        setValues(next);
        if (next.searchEngine !== "off") setLastSearchEngine(next.searchEngine);
        if (permissionResult.level) setPermission(permissionResult.level as PermissionLevel);
        setLoading(false);
      })
      .catch(() => { if (!disposed) { setLoadError(true); setLoading(false); } });
    const api = musicApi();
    if (api) void api.getCachedTracks().then((result) => {
      if (!disposed && result.ok) setMusicCount(result.data?.length ?? 0);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!fullAccessOpen || confirmSeconds <= 0) return;
    const timer = window.setTimeout(() => setConfirmSeconds((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [fullAccessOpen, confirmSeconds]);

  async function savePatch(patch: Partial<ToolValues>): Promise<boolean> {
    if (!window.settings || saving) return false;
    setSaving(true);
    setStatus(t("settingsPage.tools.saving"));
    try {
      await window.settings.saveGeneral(patch);
      setValues((current) => ({ ...current, ...patch }));
      setStatus(t("settingsPage.saved"));
      return true;
    } catch {
      setStatus(t("settingsPage.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function setBoolean(key: "weatherEnabled" | "travelEnabled" | "emailEnabled" | "emailSmtpSecure", checked: boolean) {
    await savePatch({ [key]: checked });
  }

  async function setSearchEnabled(checked: boolean) {
    const searchEngine = checked ? lastSearchEngine : "off";
    if (await savePatch({ searchEngine }) && searchEngine !== "off") setLastSearchEngine(searchEngine);
  }

  async function setSearchEngine(searchEngine: Exclude<SearchEngine, "off">) {
    if (await savePatch({ searchEngine })) setLastSearchEngine(searchEngine);
  }

  async function setPermissionLevel(level: PermissionLevel) {
    if (saving || !window.settings || level === permission) return;
    if (level === "full") {
      setConfirmSeconds(5);
      setFullAccessOpen(true);
      return;
    }
    await applyPermission(level);
  }

  async function applyPermission(level: PermissionLevel) {
    if (!window.settings) return;
    setSaving(true);
    setStatus(t("settingsPage.tools.saving"));
    try {
      const result = await window.settings.setPermissionLevel(level);
      if (!result.ok) throw new Error(result.error);
      setPermission((result.level || level) as PermissionLevel);
      setStatus(t("settingsPage.saved"));
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setSaving(false);
      setFullAccessOpen(false);
    }
  }

  async function importMusic(kind: "folder" | "files") {
    const api = musicApi();
    if (!api) return;
    setMusicStatus(t("settingsPage.tools.musicImporting"));
    try {
      const result = await (kind === "folder" ? api.importLocalFolder() : api.importLocalTracks());
      if (!result.ok) throw new Error(result.error);
      if (result.data?.cancelled) { setMusicStatus(t("settingsPage.tools.musicCancelled")); return; }
      setMusicStatus(t("settingsPage.tools.musicImported", { count: result.data?.imported ?? 0, skipped: result.data?.skipped ?? 0 }));
      const tracks = await api.getCachedTracks();
      if (tracks.ok) setMusicCount(tracks.data?.length ?? 0);
    } catch {
      setMusicStatus(t("settingsPage.tools.musicImportFailed"));
    }
  }

  const activeSearch = values.searchEngine === "off" ? lastSearchEngine : values.searchEngine;
  const searchKey = searchKeyFor[activeSearch];
  const permissionDisplay = permission === "scoped" ? "read-only" : permission;

  return <>
    <h1>{t("settingsPage.tools.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.tools.description")}</p>
    {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.loadFailed")} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><CloudSun size={18} />{t("settingsPage.tools.information")}</h2><p>{t("settingsPage.tools.informationDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.weather")}</strong><span>{t("settingsPage.tools.weatherDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tools.weather")} checked={values.weatherEnabled} disabled={saving} onChange={(checked) => void setBoolean("weatherEnabled", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.weatherSource")}</strong></div><SettingsSelect className="cy-settings-tools__select" ariaLabel={t("settingsPage.tools.weatherSource")} value={values.weatherSource} disabled={saving} options={[{ value: "open-meteo", label: t("settingsPage.tools.openMeteo") }, { value: "amap", label: t("settingsPage.tools.amapWeather") }]} onChange={(weatherSource) => void savePatch({ weatherSource })} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.travel")}</strong><span>{t("settingsPage.tools.travelDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tools.travel")} checked={values.travelEnabled} disabled={saving} onChange={(checked) => void setBoolean("travelEnabled", checked)} /></div>
          {(values.weatherSource === "amap" || values.travelEnabled) && <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.amapKey")}</strong><span>{t("settingsPage.tools.amapKeyDescription")}</span></div><div className="cy-settings-row__control cy-settings-tools__field"><SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={values.amapKey} onChange={(event) => setValues((current) => ({ ...current, amapKey: event.target.value }))} /><Button disabled={saving} onClick={() => void savePatch({ amapKey: values.amapKey })}>{t("settingsPage.tools.save")}</Button></div></div>}
        </div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Search size={18} />{t("settingsPage.tools.search")}</h2><p>{t("settingsPage.tools.searchDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.searchEnabled")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.tools.searchEnabled")} checked={values.searchEngine !== "off"} disabled={saving} onChange={(checked) => void setSearchEnabled(checked)} /></div>
          {values.searchEngine !== "off" && <><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.searchSource")}</strong></div><SettingsSelect className="cy-settings-tools__select" ariaLabel={t("settingsPage.tools.searchSource")} value={values.searchEngine} disabled={saving} options={(["bocha", "tavily", "minimax", "anySearch"] as const).map((value) => ({ value, label: t(`settingsPage.tools.search${value}`) }))} onChange={(value) => void setSearchEngine(value)} /></div><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.searchKey", { provider: t(`settingsPage.tools.search${activeSearch}`) })}</strong></div><div className="cy-settings-row__control cy-settings-tools__field"><SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={String(values[searchKey])} onChange={(event) => setValues((current) => ({ ...current, [searchKey]: event.target.value }))} /><Button disabled={saving} onClick={() => void savePatch({ [searchKey]: values[searchKey] })}>{t("settingsPage.tools.save")}</Button></div></div></>}
        </div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Mail size={18} />{t("settingsPage.tools.email")}</h2><p>{t("settingsPage.tools.emailDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.emailEnabled")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.tools.emailEnabled")} checked={values.emailEnabled} disabled={saving} onChange={(checked) => void setBoolean("emailEnabled", checked)} /></div>
          {values.emailEnabled && <>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpHost")}</strong></div><SettingsInput className="cy-settings-tools__select" value={values.emailSmtpHost} onChange={(event) => setValues((current) => ({ ...current, emailSmtpHost: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpPort")}</strong></div><SettingsInput className="cy-settings-tools__select" type="number" min={1} max={65535} value={values.emailSmtpPort} onChange={(event) => setValues((current) => ({ ...current, emailSmtpPort: event.target.value === "" ? 465 : Number(event.target.value) }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpSecure")}</strong><span>{t("settingsPage.tools.smtpSecureDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tools.smtpSecure")} checked={values.emailSmtpSecure} disabled={saving} onChange={(checked) => void setBoolean("emailSmtpSecure", checked)} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpUser")}</strong></div><SettingsInput className="cy-settings-tools__select" value={values.emailSmtpUser} onChange={(event) => setValues((current) => ({ ...current, emailSmtpUser: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpPass")}</strong></div><SettingsPasswordInput className="cy-settings-tools__select" showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={values.emailSmtpPass} onChange={(event) => setValues((current) => ({ ...current, emailSmtpPass: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.fromName")}</strong></div><SettingsInput className="cy-settings-tools__select" value={values.emailFromName} onChange={(event) => setValues((current) => ({ ...current, emailFromName: event.target.value }))} /></div>
            <div className="cy-settings-row cy-settings-tools__actions"><Button type="primary" disabled={saving} onClick={() => void savePatch({ emailSmtpHost: values.emailSmtpHost, emailSmtpPort: values.emailSmtpPort, emailSmtpSecure: values.emailSmtpSecure, emailSmtpUser: values.emailSmtpUser, emailSmtpPass: values.emailSmtpPass, emailFromName: values.emailFromName })}>{t("settingsPage.tools.saveEmail")}</Button></div>
          </>}
        </div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Files size={18} />{t("settingsPage.tools.files")}</h2><p>{t("settingsPage.tools.filesDescription")}</p></div>
        <div className="cy-settings-card"><div className="cy-settings-row cy-settings-tools__permission"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.permission")}</strong><span>{t(`settingsPage.tools.permissionDescription.${permission}`)}</span></div><div className="cy-settings-tools__levels" role="group" aria-label={t("settingsPage.tools.permission")}>{(["project-read-only", "read-only", "per-action", "full"] as const).map((level) => <Button key={level} className={permissionDisplay === level ? "is-active" : ""} aria-pressed={permissionDisplay === level} disabled={saving} onClick={() => void setPermissionLevel(level)}>{t(`settingsPage.tools.permissionLevel.${level}`)}</Button>)}</div></div></div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Music2 size={18} />{t("settingsPage.tools.music")}</h2><p>{t("settingsPage.tools.musicDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong className="cy-settings-tools__brand-label"><BrandIcon icon={siNeteasecloudmusic} size={17} />{t("settingsPage.tools.netease")}</strong><span>{t("settingsPage.tools.neteaseDescription")}</span></div><Button onClick={() => setMusicSettingsOpen(true)}>{t("settingsPage.tools.openMusicSettings")}</Button></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.localMusic")}</strong><span>{musicStatus || (musicCount === null ? t("settingsPage.tools.musicUnknown") : t("settingsPage.tools.musicCount", { count: musicCount }))}</span></div><div className="cy-settings-row__control cy-settings-button-group"><Button onClick={() => void importMusic("folder")}>{t("settingsPage.tools.importFolder")}</Button><Button onClick={() => void importMusic("files")}>{t("settingsPage.tools.importFiles")}</Button><Button onClick={() => void musicApi()?.openPlayer()}>{t("settingsPage.tools.openPlayer")}</Button></div></div>
        </div>
      </section>
      <ExtensionToolPanels />
      <div className="cy-settings-status" role="status" aria-live="polite">{status}</div>
    </>}

    <Modal title={<><ShieldAlert size={18} /> {t("settingsPage.tools.fullAccessTitle")}</>} open={fullAccessOpen} onCancel={() => setFullAccessOpen(false)} onOk={() => void applyPermission("full")} okButtonProps={{ disabled: confirmSeconds > 0 || saving, danger: true }} okText={confirmSeconds > 0 ? t("settingsPage.tools.fullAccessWait", { count: confirmSeconds }) : t("settingsPage.tools.fullAccessConfirm")} cancelText={t("settingsPage.tools.fullAccessCancel")} destroyOnHidden>
      <p>{t("settingsPage.tools.fullAccessWarning")}</p>
    </Modal>
    <MusicSettingsModal open={musicSettingsOpen} onClose={() => setMusicSettingsOpen(false)} />
  </>;
}
