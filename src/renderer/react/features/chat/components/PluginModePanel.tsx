import { AppstoreOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MarketPluginEntry,
  MarketSourceStatus,
  PluginListEntry,
  PluginManagementApi,
  PluginOverview,
  PluginRuntimeStatus,
} from "../../../../../shared/plugin-management";
import { isNewerVersion } from "../../../../../shared/version";
import { useTranslation } from "../../../i18n";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import pluginIconUrl from "../../../assets/plugin.png?url";
import "./PluginModePanel.css";

interface PluginModePanelProps {
  api?: PluginManagementApi;
}

// Cyrene 官方插件收录仓库（GitHub 为主，Gitee 为国内镜像），面板内展示并可在系统浏览器打开
const PLUGIN_REGISTRY_URL = "https://github.com/Playa-0v0/Cyrene-Plugins";

/** 从索引源地址推导展示名：认识的源走 i18n 友好名，其余直接显示主机名 */
function marketSourceLabel(url: string, t: (key: string) => string): string {
  if (url.includes("gitee.com")) return t("pluginPanel.market.sourceGitee");
  if (url.includes("github")) return t("pluginPanel.market.sourceGithub");
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type HeaderAction = "refresh" | "import" | null;
type PanelView = "installed" | "market";

interface MarketState {
  phase: "idle" | "loading" | "ready" | "error";
  plugins: MarketPluginEntry[];
  error?: string;
  /** 各索引源的实时死活（含拉取失败时的全死状态），用于头部徽章展示 */
  sources?: MarketSourceStatus[];
}

const STATUS_ORDER: Record<PluginRuntimeStatus, number> = {
  running: 0,
  starting: 1,
  failed: 2,
  stopping: 3,
  disabled: 4,
};

export function normalizePluginOverview(
  value: PluginOverview | PluginListEntry[],
): PluginOverview {
  return Array.isArray(value) ? { plugins: value, issues: [] } : value;
}

export function pluginToggleTarget(plugin: PluginListEntry): boolean {
  return plugin.status !== "running";
}

/** 市场卡片按钮的展示形态：由本地安装情况推导，渲染端只做展示判断，安装安全校验全在主进程 */
type MarketCardAction =
  | { kind: "install" }
  | { kind: "update" }
  | { kind: "replace" }
  | { kind: "installed"; version: string }
  | { kind: "installedLocalNewer"; version: string };

export function resolveMarketAction(
  entry: MarketPluginEntry,
  installed: PluginListEntry | undefined,
): MarketCardAction {
  if (!installed) return { kind: "install" };
  // 市场来源的已装插件才提供"更新"，本地来源（含内置）一律走替换确认
  if (installed.origin === "market") {
    if (isNewerVersion(entry.version, installed.version)) return { kind: "update" };
    if (isNewerVersion(installed.version, entry.version)) {
      return { kind: "installedLocalNewer", version: installed.version };
    }
    return { kind: "installed", version: installed.version };
  }
  return { kind: "replace" };
}

export function PluginModePanel({ api: providedApi }: PluginModePanelProps) {
  const { t } = useTranslation();
  // 统一反馈入口：删除插件走危险确认
  const feedback = useFeedback();
  const api = providedApi ?? window.plugins;
  const [overview, setOverview] = useState<PluginOverview>({ plugins: [], issues: [] });
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [headerAction, setHeaderAction] = useState<HeaderAction>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<PanelView>("installed");
  const [market, setMarket] = useState<MarketState>({ phase: "idle", plugins: [] });
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketNotice, setMarketNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api) throw new Error(t("pluginPanel.apiUnavailable"));
    setOverview(normalizePluginOverview(await api.list()));
  }, [api, t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    reload()
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [reload]);

  // 每次切入市场视图都重新拉取列表；preferred 指定偏好源时把它提到探测首位；不监听不轮询
  const loadMarket = useCallback(async (preferred?: string) => {
    if (!api) return;
    setMarket({ phase: "loading", plugins: [] });
    setMarketError(null);
    setMarketNotice(null);
    try {
      const result = await api.marketList(preferred);
      if (!result.ok) {
        setMarket({ phase: "error", plugins: [], error: result.error ?? t("pluginPanel.unknownError"), sources: result.sources });
      } else {
        setMarket({ phase: "ready", plugins: result.plugins, sources: result.sources });
      }
    } catch (cause) {
      setMarket({
        phase: "error",
        plugins: [],
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [api, t]);

  useEffect(() => {
    if (view === "market") void loadMarket();
  }, [view, loadMarket]);

  const visiblePlugins = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const filtered = keyword
      ? overview.plugins.filter((plugin) =>
          plugin.name.toLowerCase().includes(keyword)
          || plugin.description.toLowerCase().includes(keyword)
          || plugin.author.toLowerCase().includes(keyword)
          || plugin.id.toLowerCase().includes(keyword))
      : overview.plugins;
    return [...filtered].sort((left, right) => {
      const statusDiff = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      return statusDiff || left.name.localeCompare(right.name, "zh-CN");
    });
  }, [filter, overview.plugins]);

  const refreshPlugins = useCallback(async () => {
    if (!api) return;
    setHeaderAction("refresh");
    setError(null);
    try {
      setOverview(normalizePluginOverview(await api.rescan()));
    } catch (cause) {
      setError(t("pluginPanel.refreshFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setHeaderAction(null);
    }
  }, [api, t]);

  const importPlugin = useCallback(async () => {
    if (!api) return;
    setHeaderAction("import");
    setError(null);
    try {
      const result = await api.importZip();
      if (!result.ok && !result.canceled) {
        setError(t("pluginPanel.importFailed", { error: result.error ?? t("pluginPanel.unknownError") }));
      } else if (result.ok) {
        if (result.overview) setOverview(normalizePluginOverview(result.overview));
        else await reload();
      }
    } catch (cause) {
      setError(t("pluginPanel.importFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setHeaderAction(null);
    }
  }, [api, reload, t]);

  const installFromMarket = useCallback(async (entry: MarketPluginEntry) => {
    if (!api) return;
    setInstallingId(entry.id);
    setMarketError(null);
    setMarketNotice(null);
    try {
      const result = await api.marketInstall(entry.id);
      if (!result.ok) {
        setMarketError(t("pluginPanel.market.installFailed", { error: result.error ?? t("pluginPanel.unknownError") }));
      } else {
        setMarketNotice(t("pluginPanel.market.installSuccess", { name: result.plugin.name }));
        // 刷新本地列表，让卡片按钮状态（更新/已安装）立即跟上
        await reload();
      }
    } catch (cause) {
      setMarketError(t("pluginPanel.market.installFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setInstallingId(null);
    }
  }, [api, reload, t]);

  const openPlugin = useCallback(async (plugin: PluginListEntry) => {
    if (!api) return;
    const action = `${plugin.id}:open`;
    setBusyAction(action);
    setError(null);
    try {
      const result = await api.open(plugin.id);
      if (!result.ok) setError(t("pluginPanel.openFailed", { error: result.error ?? t("pluginPanel.unknownError") }));
    } catch (cause) {
      setError(t("pluginPanel.openFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusyAction(null);
    }
  }, [api, t]);

  const togglePlugin = useCallback(async (plugin: PluginListEntry) => {
    if (!api) return;
    const action = `${plugin.id}:toggle`;
    setBusyAction(action);
    setError(null);
    try {
      const result = await api.setEnabled(plugin.id, pluginToggleTarget(plugin));
      if (!result.ok) {
        setError(t("pluginPanel.toggleFailed", { error: result.error ?? t("pluginPanel.unknownError") }));
      }
      await reload();
    } catch (cause) {
      setError(t("pluginPanel.toggleFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusyAction(null);
    }
  }, [api, reload, t]);

  const deletePlugin = useCallback(async (plugin: PluginListEntry) => {
    if (!api || plugin.source !== "user") return;
    // 删除插件程序目录：危险确认，默认聚焦取消
    const confirmed = await feedback.confirm({
      title: t("pluginPanel.delete"),
      message: t("pluginPanel.deleteConfirm", { name: plugin.name }),
      confirmText: t("pluginPanel.delete"),
      cancelText: t("common.cancel"),
      dangerous: true,
    });
    if (!confirmed) return;
    const action = `${plugin.id}:delete`;
    setBusyAction(action);
    setError(null);
    try {
      const result = await api.uninstall(plugin.id);
      if (!result.ok) {
        setError(t("pluginPanel.deleteFailed", { error: result.error ?? t("pluginPanel.unknownError") }));
      } else if (result.overview) {
        setOverview(normalizePluginOverview(result.overview));
      } else {
        await reload();
      }
    } catch (cause) {
      setError(t("pluginPanel.deleteFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusyAction(null);
    }
  }, [api, feedback, reload, t]);

  const inMarket = view === "market";
  const marketToggleLabel = inMarket ? t("pluginPanel.market.back") : t("pluginPanel.market.toggle");

  return (
    <div className="plugin-panel">
      <header className="plugin-panel__header">
        <div className="plugin-panel__heading">
          <img className="plugin-panel__heading-icon" src={pluginIconUrl} alt="" />
          <h1 className="plugin-panel__title">{inMarket ? t("pluginPanel.market.title") : t("pluginPanel.title")}</h1>
          <p className="plugin-panel__subtitle">{inMarket ? t("pluginPanel.market.subtitle") : t("pluginPanel.subtitle")}</p>
          <p className="plugin-panel__subtitle plugin-panel__registry">
            {t("pluginPanel.registryPrefix")}
            <a
              className="plugin-panel__registry-link"
              href={PLUGIN_REGISTRY_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("pluginPanel.registryLink")}
            </a>
            {t("pluginPanel.registrySuffix")}
          </p>
        </div>
        <div className="plugin-panel__header-actions">
          <button
            type="button"
            className={`plugin-panel__icon-button${inMarket ? " is-accent" : ""}`}
            onClick={() => setView(inMarket ? "installed" : "market")}
            disabled={!api}
            aria-label={marketToggleLabel}
            title={marketToggleLabel}
          >
            <img className="plugin-panel__market-icon" src={pluginIconUrl} alt="" />
          </button>
          <button
            type="button"
            className="plugin-panel__icon-button"
            onClick={() => void refreshPlugins()}
            disabled={!api || headerAction !== null}
            aria-label={t("pluginPanel.refresh")}
            title={t("pluginPanel.refresh")}
          >
            <ReloadOutlined spin={headerAction === "refresh"} />
          </button>
          <button
            type="button"
            className="plugin-panel__icon-button is-accent"
            onClick={() => void importPlugin()}
            disabled={!api || headerAction !== null}
            aria-label={t("pluginPanel.add")}
            title={t("pluginPanel.add")}
          >
            <PlusOutlined />
          </button>
        </div>
      </header>

      {!inMarket && (
        <div className="plugin-panel__search-row">
          <input
            className="plugin-panel__search"
            placeholder={t("pluginPanel.searchPlaceholder")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      {inMarket ? (
        <>
          {market.sources && market.sources.length > 0 && (
            <div className="plugin-panel__source-switch" role="group" aria-label={t("pluginPanel.market.sourceSection")}>
              <span className="plugin-panel__source-switch-label">{t("pluginPanel.market.sourceSection")}</span>
              {market.sources.map((source) => {
                const stateLabel = source.used
                  ? t("pluginPanel.market.sourceUsed")
                  : source.ok
                    ? t("pluginPanel.market.sourceStandby")
                    : t("pluginPanel.market.sourceDead");
                return (
                  <button
                    type="button"
                    key={source.url}
                    className={`plugin-panel__source-chip${source.used ? " is-used" : source.ok ? " is-standby" : " is-dead"}`}
                    onClick={() => void loadMarket(source.url)}
                    disabled={!api || market.phase === "loading"}
                    title={`${marketSourceLabel(source.url, t)} · ${stateLabel}`}
                  >
                    {marketSourceLabel(source.url, t)}
                  </button>
                );
              })}
            </div>
          )}
          {(marketError || marketNotice) && (
            <div className="plugin-panel__notices" role="status">
              {marketError && <div className="plugin-panel__notice is-error">{marketError}</div>}
              {marketNotice && <div className="plugin-panel__notice">{marketNotice}</div>}
            </div>
          )}
          {market.phase === "loading" ? (
            <div className="plugin-panel__loading">{t("common.loading")}</div>
          ) : market.phase === "error" ? (
            <div className="plugin-panel__empty">
              {t("pluginPanel.market.loadFailed", { error: market.error ?? t("pluginPanel.unknownError") })}
            </div>
          ) : market.plugins.length === 0 ? (
            <div className="plugin-panel__empty">{t("pluginPanel.market.emptyHint")}</div>
          ) : (
            <div className="plugin-panel__grid">
              {market.plugins.map((entry) => {
                const installed = overview.plugins.find((plugin) => plugin.id === entry.id);
                const action = resolveMarketAction(entry, installed);
                const installingThis = installingId === entry.id;
                const installBlocked = installingId !== null;
                let label: string;
                let primary = false;
                let disabled = false;
                let hint: string | undefined;
                switch (action.kind) {
                  case "install":
                    label = t("pluginPanel.market.install");
                    primary = true;
                    break;
                  case "update":
                    label = t("pluginPanel.market.update");
                    primary = true;
                    break;
                  case "replace":
                    label = t("pluginPanel.market.replaceInstall");
                    hint = t("pluginPanel.market.replaceHint");
                    break;
                  case "installed":
                    label = t("pluginPanel.market.installed", { version: action.version });
                    disabled = true;
                    break;
                  case "installedLocalNewer":
                    label = t("pluginPanel.market.installedLocalNewer", { version: action.version });
                    disabled = true;
                    break;
                }
                return (
                  <article className="plugin-card-ui" key={entry.id}>
                    <div className="plugin-card-ui__main">
                      <span className="plugin-card-ui__icon" aria-hidden="true">
                        <img src={pluginIconUrl} alt="" />
                      </span>
                      <div className="plugin-card-ui__body">
                        <div className="plugin-card-ui__name-row">
                          <strong className="plugin-card-ui__name">{entry.name}</strong>
                          <span className="plugin-card-ui__version">v{entry.version}</span>
                        </div>
                        <p className="plugin-card-ui__description" title={entry.description}>{entry.description}</p>
                        <p className="plugin-card-ui__developer">
                          {t("pluginPanel.developer", { author: entry.author.trim() || t("pluginPanel.unknownDeveloper") })}
                          <span className="plugin-card-ui__meta-sep"> · </span>
                          <span className="plugin-card-ui__downloads">
                            {t("pluginPanel.market.downloads", { downloads: entry.downloads })}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="plugin-card-ui__actions">
                      <button
                        type="button"
                        className={`plugin-card-ui__button${primary ? " is-enabled" : ""}`}
                        onClick={() => void installFromMarket(entry)}
                        disabled={disabled || installBlocked}
                        title={hint}
                      >
                        {installingThis && <LoadingOutlined spin />}
                        {installingThis ? ` ${t("pluginPanel.market.installing")}` : label}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {(error || overview.issues.length > 0) && (
            <div className="plugin-panel__notices" role="status">
              {error && <div className="plugin-panel__notice is-error">{error}</div>}
              {overview.issues.map((issue, index) => (
                <div className="plugin-panel__notice" key={`${issue.path ?? issue.root}:${index}`}>{issue.message}</div>
              ))}
            </div>
          )}

          {loading ? (
            <div className="plugin-panel__loading">{t("common.loading")}</div>
          ) : (
            <div className="plugin-panel__grid">
              {overview.plugins.length === 0 ? (
                <div className="plugin-panel__empty">{t("pluginPanel.emptyHint")}</div>
              ) : visiblePlugins.map((plugin) => {
                const transitioning = plugin.status === "starting" || plugin.status === "stopping";
                const cardBusy = busyAction?.startsWith(`${plugin.id}:`) === true;
                const canOpen = plugin.status === "running" && plugin.canOpen;
                const canDelete = plugin.source === "user" && !transitioning;
                const toggleText = plugin.status === "failed"
                  ? t("common.retry")
                  : plugin.status === "running"
                    ? t("pluginPanel.disable")
                    : t("pluginPanel.enable");
                return (
                  <article className={`plugin-card-ui is-${plugin.status}`} key={plugin.id}>
                    <div className="plugin-card-ui__main">
                      <span className="plugin-card-ui__icon" aria-hidden="true">
                        {plugin.icon
                          ? <img src={plugin.icon} alt="" />
                          : <AppstoreOutlined />}
                      </span>
                      <div className="plugin-card-ui__body">
                        <div className="plugin-card-ui__name-row">
                          <strong className="plugin-card-ui__name">{plugin.name}</strong>
                          <span className="plugin-card-ui__version">v{plugin.version}</span>
                          <span className={`plugin-card-ui__status is-${plugin.status}`}>
                            {t(`pluginPanel.status.${plugin.status}`)}
                          </span>
                        </div>
                        <p className="plugin-card-ui__description" title={plugin.description}>{plugin.description}</p>
                        <p className="plugin-card-ui__developer">
                          {t("pluginPanel.developer", { author: plugin.author.trim() || t("pluginPanel.unknownDeveloper") })}
                        </p>
                        {plugin.error && <p className="plugin-card-ui__error" title={plugin.error}>{plugin.error}</p>}
                      </div>
                    </div>
                    <div className="plugin-card-ui__actions">
                      {plugin.canOpen && (
                        <button
                          type="button"
                          className="plugin-card-ui__button"
                          onClick={() => void openPlugin(plugin)}
                          disabled={!canOpen || cardBusy}
                          title={!canOpen ? t("pluginPanel.openRequiresRunning") : t("pluginPanel.open")}
                        >
                          {t("pluginPanel.open")}
                        </button>
                      )}
                      <button
                        type="button"
                        className={`plugin-card-ui__button${plugin.status === "running" ? " is-enabled" : ""}`}
                        onClick={() => void togglePlugin(plugin)}
                        disabled={transitioning || cardBusy}
                      >
                        {toggleText}
                      </button>
                      <button
                        type="button"
                        className="plugin-card-ui__button is-danger"
                        onClick={() => void deletePlugin(plugin)}
                        disabled={!canDelete || cardBusy}
                        title={plugin.source === "builtin" ? t("pluginPanel.builtinCannotDelete") : t("pluginPanel.delete")}
                      >
                        {t("pluginPanel.delete")}
                      </button>
                    </div>
                  </article>
                );
              })}
              {overview.plugins.length > 0 && visiblePlugins.length === 0 && (
                <div className="plugin-panel__empty">{t("pluginPanel.noMatch")}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default PluginModePanel;
