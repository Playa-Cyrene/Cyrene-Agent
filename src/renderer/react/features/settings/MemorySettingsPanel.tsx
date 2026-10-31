import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Radio, Spin } from "antd";
import { Brain, Clock3, FileSearch, History, Pencil } from "lucide-react";
import { siObsidian } from "simple-icons";
import { BrandIcon } from "../../components/ui/BrandIcon";
import type { MemoryPanelPayload, MemorySummaryPayload, ModelSettings, ObsidianVaultConfig } from "../../../settings/shared/types";
import { formatDateTime } from "../../../settings/shared/format";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSwitch } from "../../components/ui/SettingsControls";
import { Card } from "../../components/ui/Card";
import { WikiKnowledgePanel } from "./WikiKnowledgePanel";

type L0 = MemoryPanelPayload["l0"];
type L1 = MemoryPanelPayload["l1"];
type Notice = { type: "success" | "error" | "info"; text: string };

export function MemorySettingsPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<MemoryPanelPayload | null>(null);
  const [vault, setVault] = useState<ObsidianVaultConfig | null>(null);
  const [draftL0, setDraftL0] = useState<L0 | null>(null);
  const [draftL1, setDraftL1] = useState<L1 | null>(null);
  const [memoryMode, setMemoryMode] = useState<ModelSettings["memoryMode"]>("vector");
  const [summaryMemory, setSummaryMemory] = useState<MemorySummaryPayload | null>(null);
  const [modeLoading, setModeLoading] = useState(true);
  const [editing, setEditing] = useState<"l0" | "l1" | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [modeSaving, setModeSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reloadData = useCallback(async () => {
    if (!window.memoryPanel) throw new Error("Memory API unavailable");
    const next = await window.memoryPanel.getData();
    setData(next);
    setDraftL0({ ...next.l0 });
    setDraftL1({ ...next.l1 });
  }, []);

  const reloadVault = useCallback(async () => {
    if (!window.memoryPanel) throw new Error("Memory API unavailable");
    setVault(await window.memoryPanel.getVaultConfig());
  }, []);

  const reloadSummaryMemory = useCallback(async () => {
    if (!window.memoryPanel) throw new Error("Memory API unavailable");
    setSummaryMemory(await window.memoryPanel.getSummaryMemory());
  }, []);

  useEffect(() => {
    let active = true;
    if (!window.memoryPanel) {
      setNotice({ type: "error", text: t("settingsPage.memory.unavailable") });
      setLoading(false);
      return;
    }
    const settingsPromise = window.settings?.getConfig() ?? Promise.reject(new Error("Settings API unavailable"));
    void Promise.allSettled([window.memoryPanel.getData(), window.memoryPanel.getVaultConfig(), settingsPromise, window.memoryPanel.getSummaryMemory()]).then(([memoryResult, vaultResult, settingsResult, summaryResult]) => {
      if (!active) return;
      if (memoryResult.status === "fulfilled") {
        setData(memoryResult.value);
        setDraftL0({ ...memoryResult.value.l0 });
        setDraftL1({ ...memoryResult.value.l1 });
      } else setNotice({ type: "error", text: t("settingsPage.memory.loadFailed") });
      if (vaultResult.status === "fulfilled") setVault(vaultResult.value);
      if (settingsResult.status === "fulfilled") {
        const mode = settingsResult.value.memoryMode;
        setMemoryMode(mode === "summary" || mode === "wiki" || mode === "off" ? mode : "vector");
      }
      else setNotice({ type: "error", text: t("settingsPage.memory.modeLoadFailed") });
      if (summaryResult.status === "fulfilled") setSummaryMemory(summaryResult.value);
      setModeLoading(false);
      setLoading(false);
    });
    return () => { active = false; };
  }, [t]);

  async function changeMemoryMode(mode: ModelSettings["memoryMode"]) {
    const api = window.settings;
    if (!api || modeLoading || modeSaving) return;
    setModeSaving(true);
    setNotice(null);
    try {
      await api.saveConfig({ memoryMode: mode });
      setMemoryMode(mode);
      if (mode === "summary") await reloadSummaryMemory();
      else setSummaryMemory(null);
      setNotice({ type: "success", text: t("settingsPage.memory.saved") });
    } catch {
      setNotice({ type: "error", text: t("settingsPage.memory.saveFailed") });
    } finally { setModeSaving(false); }
  }

  const filteredEvents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.l2 ?? []).filter((item) => !query || [item.content, item.triggerText, item.status].join(" ").toLocaleLowerCase().includes(query));
  }, [data?.l2, search]);

  async function saveTier(tier: "l0" | "l1") {
    const api = window.memoryPanel;
    const draft = tier === "l0" ? draftL0 : draftL1;
    if (!api || !draft) return;
    setBusy(tier);
    try {
      const result = tier === "l0" ? await api.saveL0(draft) : await api.saveL1(draft);
      if (!result.ok) throw new Error("Save failed");
      await reloadData();
      setEditing(null);
      setNotice({ type: "success", text: t("settingsPage.memory.saved") });
    } catch {
      setNotice({ type: "error", text: t("settingsPage.memory.saveFailed") });
    } finally { setBusy(""); }
  }

  function cancelEdit(tier: "l0" | "l1") {
    if (tier === "l0" && data) setDraftL0({ ...data.l0 });
    if (tier === "l1" && data) setDraftL1({ ...data.l1 });
    setEditing(null);
  }

  async function vaultAction(action: "bind" | "sync" | "unbind") {
    const api = window.memoryPanel;
    if (!api) return;
    setBusy(action);
    try {
      const result = action === "bind" ? await api.bindVault() : action === "sync" ? await api.syncNow() : await api.unbindVault();
      if ("canceled" in result && result.canceled) return;
      if (!result.ok) throw new Error("Vault operation failed");
      await reloadVault();
      setNotice({ type: "success", text: t(`settingsPage.memory.vault.${action}Done`) });
    } catch {
      setNotice({ type: "error", text: t("settingsPage.memory.vault.actionFailed") });
    } finally { setBusy(""); }
  }

  async function setAutoSync(checked: boolean) {
    if (!window.memoryPanel || !vault) return;
    setVault({ ...vault, autoSync: checked });
    try {
      const result = await window.memoryPanel.setAutoSync(checked);
      if (!result.ok) throw new Error("Auto-sync failed");
      setVault(result.config);
    } catch {
      setVault(vault);
      setNotice({ type: "error", text: t("settingsPage.memory.vault.actionFailed") });
    }
  }

  const l0Fields: Array<{ key: keyof L0; label: string; multiline?: boolean }> = [
    { key: "preferredName", label: t("settingsPage.memory.name") },
    { key: "occupation", label: t("settingsPage.memory.occupation") },
    { key: "longTermInterests", label: t("settingsPage.memory.interests") },
    { key: "language", label: t("settingsPage.memory.language") },
    { key: "permanentNote", label: t("settingsPage.memory.note"), multiline: true },
  ];
  const l1Fields: Array<{ key: keyof L1; label: string }> = [
    { key: "recentGoals", label: t("settingsPage.memory.goals") },
    { key: "recentPreferences", label: t("settingsPage.memory.recentPreferences") },
    { key: "currentProject", label: t("settingsPage.memory.project") },
  ];

  return <>
    <h1>{t("settingsPage.memory.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.memory.description")}</p>
    {notice && <Alert className="cy-settings-alert" showIcon type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} />}
    <section className="cy-settings-section">
      <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.modeTitle"><Brain size={18} />{t("settingsPage.memory.modeTitle")}</h2><p>{t("settingsPage.memory.modeDescription")}</p></div>
      <Card><div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.memory.modeLabel">{t("settingsPage.memory.modeLabel")}</strong><span>{t(memoryMode === "off" ? "settingsPage.memory.modeOffHint" : memoryMode === "summary" ? "settingsPage.memory.modeSummaryHint" : memoryMode === "wiki" ? "settingsPage.memory.modeWikiHint" : "settingsPage.memory.modeVectorHint")}</span></div><Radio.Group value={memoryMode} disabled={modeLoading || modeSaving} optionType="button" buttonStyle="solid" onChange={(event) => void changeMemoryMode(event.target.value as ModelSettings["memoryMode"])}><Radio.Button value="vector">{t("settingsPage.memory.vectorMode")}</Radio.Button><Radio.Button value="summary">{t("settingsPage.memory.summaryMode")}</Radio.Button><Radio.Button value="wiki">{t("settingsPage.memory.wikiMode")}</Radio.Button><Radio.Button value="off">{t("settingsPage.memory.off")}</Radio.Button></Radio.Group></div></Card>
    </section>
    {!modeLoading && memoryMode === "wiki" && <WikiKnowledgePanel />}
    {memoryMode !== "wiki" && (loading ? <div className="cy-settings-loading"><Spin /></div> : !data ? null : <>
      {!modeLoading && memoryMode === "summary" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.summaryTitle"><Brain size={18} />{t("settingsPage.memory.summaryTitle")}</h2><p>{t("settingsPage.memory.summaryDescription")}</p></div>
        {summaryMemory ? <>
          {summaryMemory.workspacePath && <Card className="cy-memory-card"><div className="cy-memory-card__top"><strong data-settings-search-id="settingsPage.memory.workspaceSummary">{t("settingsPage.memory.workspaceSummary")}</strong></div><div className="cy-memory-vault-path">{summaryMemory.workspacePath}</div>{summaryMemory.workspaceTruncated && <Alert showIcon type="warning" title={t("settingsPage.memory.summaryTruncated")} />}<Input.TextArea readOnly autoSize={{ minRows: 4, maxRows: 14 }} value={summaryMemory.workspaceContent || t("settingsPage.memory.summaryEmpty")} /></Card>}
          <Card className="cy-memory-card"><div className="cy-memory-card__top"><strong data-settings-search-id="settingsPage.memory.sessionSummary">{t("settingsPage.memory.sessionSummary")}</strong></div><div className="cy-memory-vault-path">{summaryMemory.sessionPath}</div>{summaryMemory.sessionTruncated && <Alert showIcon type="warning" title={t("settingsPage.memory.summaryTruncated")} />}<Input.TextArea readOnly autoSize={{ minRows: 4, maxRows: 14 }} value={summaryMemory.sessionContent || t("settingsPage.memory.summaryEmpty")} /></Card>
        </> : <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("settingsPage.memory.summaryNoSession")} /></Card>}
      </section>}
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.l0Title"><Brain size={18} />{t("settingsPage.memory.l0Title")}</h2><p>{t("settingsPage.memory.l0Description")}</p></div>
        <Card className="cy-memory-card">
          <div className="cy-memory-card__top"><span className="cy-memory-card__badge">L0</span><span>{t("settingsPage.memory.manualPriority")}</span></div>
          <div className="cy-memory-fields">{draftL0 && l0Fields.map(({ key, label, multiline }) => <label key={key} className={multiline ? "is-wide" : ""}><span>{label}</span>{multiline
            ? <Input.TextArea value={draftL0[key]} disabled={editing !== "l0"} rows={2} placeholder={t("settingsPage.memory.notSet")} onChange={(event) => setDraftL0((current) => current && { ...current, [key]: event.target.value })} />
            : <SettingsInput value={draftL0[key]} disabled={editing !== "l0"} placeholder={t("settingsPage.memory.notSet")} onChange={(event) => setDraftL0((current) => current && { ...current, [key]: event.target.value })} />}</label>)}</div>
          <div className="cy-memory-card__actions">{editing === "l0" ? <><Button onClick={() => cancelEdit("l0")}>{t("settingsPage.memory.cancel")}</Button><Button type="primary" loading={busy === "l0"} onClick={() => void saveTier("l0")}>{t("settingsPage.memory.save")}</Button></> : <Button icon={<Pencil size={14} />} onClick={() => setEditing("l0")}>{t("settingsPage.memory.edit")}</Button>}</div>
        </Card>
      </section>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.l1Title"><Clock3 size={18} />{t("settingsPage.memory.l1Title")}</h2><p>{t("settingsPage.memory.l1Description")}</p></div>
        <Card className="cy-memory-card"><div className="cy-memory-card__top"><span className="cy-memory-card__badge">L1</span><span>{t("settingsPage.memory.manualPriority")}</span></div>
          <div className="cy-memory-fields">{draftL1 && l1Fields.map(({ key, label }) => <label className="is-wide" key={key}><span>{label}</span><Input.TextArea value={draftL1[key]} disabled={editing !== "l1"} rows={2} placeholder={t("settingsPage.memory.notSet")} onChange={(event) => setDraftL1((current) => current && { ...current, [key]: event.target.value })} /></label>)}</div>
          <div className="cy-memory-card__actions">{editing === "l1" ? <><Button onClick={() => cancelEdit("l1")}>{t("settingsPage.memory.cancel")}</Button><Button type="primary" loading={busy === "l1"} onClick={() => void saveTier("l1")}>{t("settingsPage.memory.save")}</Button></> : <Button icon={<Pencil size={14} />} onClick={() => setEditing("l1")}>{t("settingsPage.memory.edit")}</Button>}</div>
        </Card>
      </section>
      {!modeLoading && memoryMode === "vector" && <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.l2Title"><FileSearch size={18} />{t("settingsPage.memory.l2Title")}</h2><p>{t("settingsPage.memory.l2Description")}</p></div>
        <Card className="cy-memory-card"><Input.Search value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("settingsPage.memory.searchPlaceholder")} allowClear />
          <div className="cy-memory-list">{filteredEvents.length ? filteredEvents.map((item) => <article className="cy-memory-record" key={item.id}><strong>{item.content}</strong><span>{item.triggerText || t("settingsPage.memory.noTrigger")}</span><small>{t(`settingsPage.memory.status.${item.status}`)} · {t("settingsPage.memory.weight", { weight: item.weight.toFixed(1) })} · {formatDateTime(item.createdAt)}</small></article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? t("settingsPage.memory.noMatch") : t("settingsPage.memory.noEvents")} />}</div>
        </Card>
      </section>}
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.reflectionsTitle"><History size={18} />{t("settingsPage.memory.reflectionsTitle")}</h2><p>{t("settingsPage.memory.reflectionsDescription")}</p></div>
        <Card className="cy-memory-list">{data.reflections.length ? data.reflections.map((item) => <article className="cy-memory-record" key={item.id}><strong>{item.title}</strong><span>{item.body}</span><small>{item.meta}</small></article>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("settingsPage.memory.noReflections")} />}</Card>
      </section>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.memory.vault.title"><BrandIcon icon={siObsidian} size={18} label="Obsidian" />{t("settingsPage.memory.vault.title")}</h2><p>{t("settingsPage.memory.vault.description")}</p></div>
        <Card className="cy-memory-card">{vault?.vaultPath ? <><div className="cy-memory-vault-path">{vault.vaultPath}</div><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.memory.vault.autoSync">{t("settingsPage.memory.vault.autoSync")}</strong><span>{t("settingsPage.memory.vault.autoSyncDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.memory.vault.autoSync")} checked={vault.autoSync} onChange={(checked) => void setAutoSync(checked)} /></div><div className="cy-memory-vault-actions"><span>{vault.lastSyncAt ? t("settingsPage.memory.vault.lastSync", { time: formatDateTime(vault.lastSyncAt) }) : t("settingsPage.memory.vault.neverSynced")}</span><Button loading={busy === "sync"} onClick={() => void vaultAction("sync")}>{t("settingsPage.memory.vault.sync")}</Button><Button loading={busy === "unbind"} onClick={() => void vaultAction("unbind")}>{t("settingsPage.memory.vault.unbind")}</Button></div></> : <div className="cy-memory-vault-actions"><span>{t("settingsPage.memory.vault.notBound")}</span><Button loading={busy === "bind"} onClick={() => void vaultAction("bind")}>{t("settingsPage.memory.vault.bind")}</Button></div>}</Card>
      </section>
    </>)}
  </>;
}
