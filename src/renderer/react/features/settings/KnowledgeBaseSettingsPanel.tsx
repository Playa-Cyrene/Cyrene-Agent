import { useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Spin } from "antd";
import { BookOpen, FilePlus2, FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import type {
  KnowledgeCollection, KnowledgeDocument, KnowledgeScope, KnowledgeSearchHit,
  KnowledgeState, KnowledgeWorkspaceOption,
} from "../../../../shared/knowledge-base-types";
import { formatDateTime } from "../../../settings/shared/format";
import { Card } from "../../components/ui/Card";
import { SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";
import "./KnowledgeBaseSettingsPanel.css";

const key = "settingsPage.knowledgeBase";

export function KnowledgeBaseSettingsPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [workspaces, setWorkspaces] = useState<KnowledgeWorkspaceOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchCollection, setSearchCollection] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.knowledgeBase;
    if (!api) { setNotice({ type: "error", text: t(`${key}.unavailable`) }); setLoading(false); return; }
    void Promise.all([api.getState(), api.listWorkspaces()]).then(([current, available]) => {
      if (!active) return;
      setState(current);
      setWorkspaces(available);
      setSelectedId(current.collections[0]?.id ?? null);
      setNewScope(available.find((item) => item.active)?.workspaceId ?? "global");
      setLoading(false);
    }).catch(() => { if (active) { setNotice({ type: "error", text: t(`${key}.loadFailed`) }); setLoading(false); } });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (!state?.enabled || !state.collections.some((item) => item.scanning)) return;
    const api = window.knowledgeBase;
    const timer = setInterval(() => {
      void api?.getState().then((next) => {
        setState(next);
        if (selectedId && !next.collections.find((item) => item.id === selectedId)?.scanning) {
          void api.listDocuments(selectedId).then(setDocuments).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [state?.enabled, state?.collections.some((item) => item.scanning), selectedId]);

  useEffect(() => {
    if (!selectedId || !state?.enabled) { setDocuments([]); return; }
    let active = true;
    void window.knowledgeBase?.listDocuments(selectedId).then((items) => { if (active) setDocuments(items); })
      .catch(() => { if (active) setDocuments([]); });
    return () => { active = false; };
  }, [selectedId, state?.enabled]);

  const selected = state?.collections.find((item) => item.id === selectedId);
  const searchableCollections = state?.collections.filter((item) => item.enabled && item.paths.length > 0) ?? [];
  const canSearch = Boolean(state?.enabled && searchableCollections.some((item) => item.fileCount > 0));
  const searchIsIndexing = Boolean(state?.enabled && searchableCollections.some((item) => item.scanning));

  useEffect(() => {
    if (searchCollection && !searchableCollections.some((item) => item.id === searchCollection)) {
      setSearchCollection(undefined);
    }
  }, [searchCollection, searchableCollections]);

  async function update(action: () => Promise<KnowledgeState>, message?: string) {
    setBusy(true); setNotice(null);
    try {
      const next = await action();
      setState(next);
      setHits([]); setSearched(false);
      if (searchCollection && !next.collections.some((item) => item.id === searchCollection)) setSearchCollection(undefined);
      if (message) setNotice({ type: "success", text: message });
      if (selectedId && !next.collections.some((item) => item.id === selectedId)) {
        setSelectedId(next.collections[0]?.id ?? null);
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : t(`${key}.actionFailed`) });
    } finally { setBusy(false); }
  }

  async function createCollection() {
    const api = window.knowledgeBase;
    if (!api || !newName.trim()) return;
    const workspace = workspaces.find((item) => item.workspaceId === newScope);
    const scope: KnowledgeScope = workspace
      ? { kind: "workspace", workspaceId: workspace.workspaceId, workspaceRoot: workspace.workspaceRoot,
        workspaceName: workspace.workspaceName }
      : { kind: "global" };
    setBusy(true); setNotice(null);
    try {
      const next = await api.createCollection({ name: newName.trim(), scope });
      setState(next);
      setSelectedId(next.collections.at(-1)?.id ?? null);
      setNewName(""); setCreateOpen(false);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : t(`${key}.actionFailed`) });
    } finally { setBusy(false); }
  }

  async function addPaths(kind: "file" | "directory") {
    const api = window.knowledgeBase;
    if (!api || !selectedId) return;
    try {
      const paths = await api.pickPaths(kind);
      if (!paths.length) return;
      await update(() => api.addPaths(selectedId, paths.map((sourcePath) => ({ path: sourcePath, kind }))));
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : t(`${key}.actionFailed`) });
    }
  }

  async function search(value: string) {
    const api = window.knowledgeBase;
    const text = value.trim();
    setSearched(Boolean(text));
    if (!api || !text) { setHits([]); return; }
    setBusy(true); setNotice(null);
    try { setHits(await api.search(text, searchCollection)); }
    catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : t(`${key}.searchFailed`) }); }
    finally { setBusy(false); }
  }

  function confirmDelete(collection: KnowledgeCollection) {
    Modal.confirm({ title: t(`${key}.deleteTitle`), content: t(`${key}.deleteDescription`, { name: collection.name }),
      okText: t(`${key}.delete`), okButtonProps: { danger: true }, cancelText: t(`${key}.cancel`),
      onOk: async () => { await update(() => window.knowledgeBase!.deleteCollection(collection.id)); } });
  }

  if (loading) return <div className="cy-settings-loading"><Spin /></div>;

  return <div className="cy-knowledge-settings">
    <h1>{t(`${key}.title`)}</h1>
    <p className="cy-settings-intro">{t(`${key}.description`)}</p>
    {notice && <Alert className="cy-settings-alert" showIcon type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} />}

    <Card>
      <div className="cy-settings-row">
        <div className="cy-settings-row__copy"><strong>{t(`${key}.enabled`)}</strong><span>{t(`${key}.enabledHint`)}</span></div>
        <SettingsSwitch ariaLabel={t(`${key}.enabled`)} checked={state?.enabled ?? false} disabled={busy}
          onChange={(enabled) => void update(() => window.knowledgeBase!.setEnabled(enabled))} />
      </div>
    </Card>

    <section className="cy-settings-section">
      <div className="cy-settings-section__heading cy-knowledge-heading">
        <div><h2><BookOpen size={18} />{t(`${key}.collections`)}</h2><p>{t(`${key}.originalPathHint`)}</p></div>
        {state?.collections.length ? <Button type="primary" disabled={busy} onClick={() => setCreateOpen(true)}>{t(`${key}.create`)}</Button> : null}
      </div>
      {!state?.collections.length ? <Card><div className="cy-knowledge-empty">
        <Empty description={t(`${key}.empty`)} />
        <Button type="primary" icon={<BookOpen size={16} />} disabled={busy} onClick={() => setCreateOpen(true)}>{t(`${key}.createFirst`)}</Button>
      </div></Card> :
        <div className="cy-knowledge-layout">
          <div className="cy-knowledge-collections">
            {state.collections.map((collection) => <button key={collection.id} type="button"
              className={`cy-knowledge-collection ${selectedId === collection.id ? "is-active" : ""}`}
              onClick={() => setSelectedId(collection.id)}>
              <strong>{collection.name}</strong>
              <span>{collection.scope.kind === "global" ? t(`${key}.global`) : collection.scope.workspaceName}</span>
              <small>{t(`${key}.fileCount`, { count: collection.fileCount })} · {collection.scanning ? t(`${key}.scanning`) : collection.scanError ? t(`${key}.scanFailed`) : collection.errorCount ? t(`${key}.errorCount`, { count: collection.errorCount }) : t(`${key}.ready`)}</small>
            </button>)}
          </div>
          {selected && <Card>
            <div className="cy-knowledge-detail-header">
              <div><strong>{selected.name}</strong><small>{selected.lastScannedAt ? t(`${key}.lastScanned`, { time: formatDateTime(selected.lastScannedAt) }) : t(`${key}.notScanned`)}</small></div>
              <SettingsSwitch ariaLabel={t(`${key}.collectionEnabled`)} checked={selected.enabled} disabled={busy || !state.enabled}
                onChange={(enabled) => void update(() => window.knowledgeBase!.setCollectionEnabled(selected.id, enabled))} />
            </div>
            <div className="cy-knowledge-actions">
              <Button icon={<FilePlus2 size={15} />} disabled={busy} onClick={() => void addPaths("file")}>{t(`${key}.addFile`)}</Button>
              <Button icon={<FolderPlus size={15} />} disabled={busy} onClick={() => void addPaths("directory")}>{t(`${key}.addFolder`)}</Button>
              <Button icon={<RefreshCw size={15} />} disabled={busy || !state.enabled || !selected.enabled || selected.scanning}
                onClick={() => void update(() => window.knowledgeBase!.refreshCollection(selected.id))}>{t(`${key}.refresh`)}</Button>
              <Button danger icon={<Trash2 size={15} />} disabled={busy} onClick={() => confirmDelete(selected)}>{t(`${key}.delete`)}</Button>
            </div>
            {selected.scanWarning && <Alert className="cy-knowledge-warning" type="warning" showIcon
              title={[selected.scanWarning.truncated ? t(`${key}.scanLimit`) : "",
                selected.scanWarning.unreadableFolders ? t(`${key}.unreadableFolders`, { count: selected.scanWarning.unreadableFolders }) : ""]
                .filter(Boolean).join(" · ")} />}
            {selected.scanError && <Alert className="cy-knowledge-warning" type="error" showIcon
              title={t(`${key}.scanFailed`)} description={selected.scanError} />}
            <div className="cy-knowledge-paths">
              {selected.paths.length ? selected.paths.map((entry) => <div key={entry.path} className="cy-knowledge-path">
                <span title={entry.path}>{entry.kind === "directory" ? "📁" : "📄"} {entry.path}</span>
                <Button size="small" type="text" danger onClick={() => void update(() => window.knowledgeBase!.removePath(selected.id, entry.path))}>{t(`${key}.remove`)}</Button>
              </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(`${key}.noPaths`)} />}
            </div>
            {state.enabled && documents.length > 0 && <div className="cy-knowledge-documents">
              <strong>{t(`${key}.indexedFiles`)}</strong>
              {documents.slice(0, 100).map((document) => <div key={document.id} className="cy-knowledge-document">
                <span title={document.path}>{document.name}</span>
                <small>{t(`${key}.status.${document.status}`)}{document.error ? ` · ${document.error}` : ""}</small>
              </div>)}
              {documents.length > 100 && <small>{t(`${key}.moreFiles`, { count: documents.length - 100 })}</small>}
            </div>}
          </Card>}
        </div>}
    </section>

    {state?.collections.length ? <section className="cy-settings-section">
      <div className="cy-settings-section__heading"><h2 data-settings-search-key={`${key}.searchTitle`}>{t(`${key}.searchTitle`)}</h2><p>{t(`${key}.searchHint`)}</p></div>
      <Card>
        {canSearch ? <>
          <div className="cy-knowledge-search">
            <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} onSearch={(value) => void search(value)}
              disabled={!state?.enabled || busy} placeholder={t(`${key}.searchPlaceholder`)} enterButton={t(`${key}.search`)} />
            <div className="cy-knowledge-search__scope">
              <label htmlFor="cy-knowledge-search-scope">{t(`${key}.searchScope`)}</label>
              <Select id="cy-knowledge-search-scope" value={searchCollection ?? "all"} disabled={!state?.enabled || busy}
                onChange={(value) => setSearchCollection(value === "all" ? undefined : value)}
                options={[{ value: "all", label: t(`${key}.allCollections`) }, ...searchableCollections.map((item) => ({ value: item.id, label: item.name }))]} />
            </div>
          </div>
          {searched && (hits.length ? <div className="cy-knowledge-results">{hits.map((hit) => <div key={hit.documentId} className="cy-knowledge-result">
            <strong>{hit.name}</strong><small>{hit.collectionName} · {hit.line ? t(`${key}.line`, { line: hit.line }) : t(`${key}.titleMatch`)}</small>
            {hit.excerpt && <p>{hit.excerpt}</p>}
            <span title={hit.path}>{hit.path}</span>
            <Button size="small" onClick={() => void window.knowledgeBase?.openSource(hit.documentId).then((result) => {
              if (!result.ok) setNotice({ type: "error", text: result.error ?? t(`${key}.actionFailed`) });
            })}>{t(`${key}.openSource`)}</Button>
          </div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(`${key}.noResults`)} />)}
        </> : <div className="cy-knowledge-search-empty"><BookOpen size={18} /><span>{t(!state?.enabled ? `${key}.searchNeedsEnable` : searchIsIndexing ? `${key}.searchIndexing` : `${key}.searchNeedsFiles`)}</span></div>}
      </Card>
    </section> : null}

    <Modal title={t(`${key}.create`)} open={createOpen} confirmLoading={busy} okText={t(`${key}.create`)}
      onOk={() => void createCollection()} onCancel={() => setCreateOpen(false)} okButtonProps={{ disabled: !newName.trim() }}>
      <div className="cy-knowledge-create-form">
        <label>{t(`${key}.name`)}<Input value={newName} maxLength={100} onChange={(event) => setNewName(event.target.value)} /></label>
        <label>{t(`${key}.scope`)}<Select value={newScope} onChange={setNewScope}
          options={[{ value: "global", label: t(`${key}.global`) }, ...workspaces.map((item) => ({ value: item.workspaceId, label: item.workspaceName }))]} /></label>
      </div>
    </Modal>
  </div>;
}
