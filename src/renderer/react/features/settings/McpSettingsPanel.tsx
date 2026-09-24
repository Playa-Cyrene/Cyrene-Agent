// MCP Settings Panel — MCP 服务器配置：列表、添加（表单/JSON 双模式）、删除
// 表单字段设计与 ZCode 的 McpServerForm 对齐：名称、类型（本地进程/远程 HTTP/远程 SSE）、
// 本地填命令+参数，远程填 URL；环境变量/请求头以 JSON 文本折叠在"高级"里。
import { useEffect, useState } from "react";
import { Alert, Button, Collapse, Input, Modal, Popconfirm, Spin } from "antd";
import { MCP } from "@lobehub/icons";
import { FolderOpen, Plus, UtensilsCrossed } from "lucide-react";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSegmented, SettingsSelect, SettingsSwitch } from "../../components/ui/SettingsControls";
import type { McpServerConfigView } from "../../../settings/shared/types";

type McpTransport = "stdio" | "http" | "sse";
const MCP_TRANSPORTS: McpTransport[] = ["stdio", "http", "sse"];

interface McpFormState {
  name: string;
  transport: McpTransport;
  command: string;   // stdio：启动命令
  args: string;      // stdio：参数（空格分隔）
  url: string;       // 远程：服务地址
  env: string;       // stdio：环境变量 JSON 文本
  headers: string;   // 远程：请求头 JSON 文本
}

const MCP_FORM_DEFAULTS: McpFormState = {
  name: "", transport: "stdio", command: "", args: "", url: "", env: "", headers: "",
};

function splitArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** 解析 JSON 对象文本（环境变量/请求头）。空文本返回空对象；格式错误抛异常。 */
export function parseJsonRecord(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not an object");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = String(value);
  }
  return result;
}

/** 对象值转字符串映射；空对象或非对象返回 undefined。 */
function toOptionalRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) result[key] = String(v);
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 从名称生成服务器 id。id 会拼进工具的 function name（Kimi 等厂商只接受
 * ASCII 字母数字和短横线），因此非 ASCII 名称回退到 "mcp-" + 时间戳。
 */
export function deriveServerId(name: string, existingIds: string[]): string {
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug || "mcp-" + Date.now();
  let id = base;
  let suffix = 2;
  while (existingIds.includes(id)) {
    id = base + "-" + suffix;
    suffix++;
  }
  return id;
}

/** 判断 JSON 条目的连接类型：显式 type 优先；无 type 时有 url 无 command 按远程处理。 */
export function resolveTransport(entry: Record<string, unknown>): McpTransport {
  // 归一化 type：官方生态常见别名 streamable-http / streamableHttp 统一按 http 处理
  // （麦当劳官方示例即用 "type": "streamablehttp"）
  const declared = typeof entry.type === "string" ? entry.type.toLowerCase().replace(/-/g, "") : "";
  if (declared === "http" || declared === "streamablehttp") return "http";
  if (declared === "sse") return "sse";
  if (typeof entry.url === "string" && entry.url.trim() && !entry.command) return "http";
  return "stdio";
}

/** JSON 条目 → 后端配置对象（env/headers 已是对象，直接透传）。 */
export function entryToConfig(name: string, entry: Record<string, unknown>, existingIds: string[]): McpServerConfigView {
  const transport = resolveTransport(entry);
  const config: McpServerConfigView = { id: deriveServerId(name, existingIds), name, transport };
  if (transport === "stdio") {
    if (typeof entry.command === "string" && entry.command.trim()) config.command = entry.command.trim();
    if (Array.isArray(entry.args)) config.args = entry.args.map((v) => String(v)).filter(Boolean);
    const env = toOptionalRecord(entry.env);
    if (env) config.env = env;
  } else {
    if (typeof entry.url === "string" && entry.url.trim()) config.url = entry.url.trim();
    const headers = toOptionalRecord(entry.headers);
    if (headers) config.headers = headers;
  }
  return config;
}

/** 解析 JSON 粘贴文本，兼容 {"mcpServers": {...}} 和 {"server-name": {...}} 两种格式。 */
export function parseJsonServers(text: string): Array<{ name: string; entry: Record<string, unknown> }> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
  const root = parsed as Record<string, unknown>;
  const source = root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
    ? root.mcpServers as Record<string, unknown>
    : root;
  return Object.entries(source)
    .filter(([, value]) => value !== null && typeof value === "object" && !Array.isArray(value))
    .map(([name, value]) => ({ name, entry: value as Record<string, unknown> }));
}

/** 表单状态 → JSON 条目（用于表单→JSON 模式同步）。环境变量/请求头格式有误时抛异常。 */
export function formToEntry(form: McpFormState): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (form.transport === "stdio") {
    entry.command = form.command.trim();
    const args = splitArgs(form.args);
    if (args.length > 0) entry.args = args;
    const env = parseJsonRecord(form.env);
    if (Object.keys(env).length > 0) entry.env = env;
  } else {
    entry.type = form.transport;
    entry.url = form.url.trim();
    const headers = parseJsonRecord(form.headers);
    if (Object.keys(headers).length > 0) entry.headers = headers;
  }
  return entry;
}

/** JSON 条目 → 表单补丁（用于 JSON→表单模式同步，取第一个服务器）。 */
export function entryToFormPatch(name: string, entry: Record<string, unknown>): Partial<McpFormState> {
  const transport = resolveTransport(entry);
  const patch: Partial<McpFormState> = { name, transport };
  if (transport === "stdio") {
    patch.command = typeof entry.command === "string" ? entry.command : "";
    patch.args = Array.isArray(entry.args) ? entry.args.map(String).join(" ") : "";
    patch.env = toOptionalRecord(entry.env) ? JSON.stringify(entry.env, null, 2) : "";
  } else {
    patch.url = typeof entry.url === "string" ? entry.url : "";
    patch.headers = toOptionalRecord(entry.headers) ? JSON.stringify(entry.headers, null, 2) : "";
  }
  return patch;
}

/** 添加服务器弹窗：表单/JSON 双模式，切换时双向同步（与 ZCode 行为一致）。
 * initialForm 用于推荐服务一键预填（如麦当劳的 URL 和请求头模板）。 */
function AddMcpServerModal({ open, initialForm, existingIds, onClose, onAdded }: {
  open: boolean;
  initialForm?: Partial<McpFormState>;
  existingIds: string[];
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [form, setForm] = useState<McpFormState>(MCP_FORM_DEFAULTS);
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  // 每次打开时重置（关闭再开不残留上次的输入），支持推荐模板预填
  useEffect(() => {
    if (open) {
      setForm({ ...MCP_FORM_DEFAULTS, ...initialForm });
      setJsonText("");
      setError("");
      setMode("form");
    }
    // initialForm 由调用方以字面量传入，仅需在开合时机应用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function updateForm(patch: Partial<McpFormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setError("");
  }

  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    setError("");
    if (next === "json") {
      // 表单 → JSON：把当前表单序列化成 mcpServers 草稿；内容为空时不覆盖
      const hasContent = form.name.trim() || form.command.trim() || form.url.trim();
      if (hasContent) {
        try {
          const draft = { mcpServers: { [form.name.trim() || "server-name"]: formToEntry(form) } };
          setJsonText(JSON.stringify(draft, null, 2));
        } catch {
          // 环境变量/请求头 JSON 格式有误时保留原文本，由 JSON 模式自行提示
        }
      }
    } else if (jsonText.trim()) {
      // JSON → 表单：解析成功时把第一个服务器填回表单；失败则保留表单现状
      try {
        const servers = parseJsonServers(jsonText);
        if (servers.length > 0) {
          setForm((current) => ({ ...current, ...entryToFormPatch(servers[0].name, servers[0].entry) }));
        }
      } catch {
        // 保留表单现状
      }
    }
    setMode(next);
  }

  async function submit() {
    const api = window.settings;
    if (!api?.addMcpServer) return;
    setError("");

    // 本地校验 + 组装配置（多服务器时 id 依次去重）
    const configs: McpServerConfigView[] = [];
    const addConfig = (name: string, entry: Record<string, unknown>) => {
      const taken = [...existingIds, ...configs.map((c) => c.id)];
      configs.push(entryToConfig(name, entry, taken));
    };
    try {
      if (mode === "form") {
        const name = form.name.trim();
        if (!name) throw new Error(t("settingsPage.mcp.nameRequired"));
        if (form.transport === "stdio") {
          if (!form.command.trim()) throw new Error(t("settingsPage.mcp.commandRequired"));
        } else if (!form.url.trim()) {
          throw new Error(t("settingsPage.mcp.urlRequired"));
        }
        let env: Record<string, string>;
        let headers: Record<string, string>;
        try {
          env = parseJsonRecord(form.env);
        } catch {
          throw new Error(t("settingsPage.mcp.envInvalid"));
        }
        try {
          headers = parseJsonRecord(form.headers);
        } catch {
          throw new Error(t("settingsPage.mcp.headersInvalid"));
        }
        const entry: Record<string, unknown> = {};
        if (form.transport === "stdio") {
          entry.command = form.command.trim();
          const args = splitArgs(form.args);
          if (args.length > 0) entry.args = args;
          if (Object.keys(env).length > 0) entry.env = env;
        } else {
          entry.type = form.transport;
          entry.url = form.url.trim();
          if (Object.keys(headers).length > 0) entry.headers = headers;
        }
        addConfig(name, entry);
      } else {
        if (!jsonText.trim()) throw new Error(t("settingsPage.mcp.jsonEmpty"));
        let servers: Array<{ name: string; entry: Record<string, unknown> }>;
        try {
          servers = parseJsonServers(jsonText);
        } catch (err) {
          throw new Error(t("settingsPage.mcp.jsonInvalid", { error: err instanceof Error ? err.message : String(err) }));
        }
        if (servers.length === 0) throw new Error(t("settingsPage.mcp.jsonEmpty"));
        for (const { name, entry } of servers) {
          const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
          const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
          if (!hasCommand && !hasUrl) throw new Error(t("settingsPage.mcp.entryInvalid", { name }));
          addConfig(name, entry);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    // 逐个连接并保存（addMcpServer 内部先连接成功才持久化）
    setAdding(true);
    try {
      let added = 0;
      let lastError = "";
      let lastAddedName = "";
      let toolCount = 0;
      for (const config of configs) {
        const result = await api.addMcpServer(config);
        if (result.ok) {
          added++;
          lastAddedName = config.name;
          toolCount = result.toolIds?.length ?? 0;
        } else {
          lastError = result.error || "unknown";
        }
      }
      if (added > 0) {
        onAdded(added === 1
          ? t("settingsPage.mcp.added", { name: lastAddedName, count: toolCount })
          : t("settingsPage.mcp.addedFromJson", { count: added }));
        onClose();
      } else {
        setError(t("settingsPage.mcp.addFailed", { error: lastError }));
      }
    } catch (err) {
      setError(t("settingsPage.mcp.addFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setAdding(false);
    }
  }

  return <Modal
    open={open}
    title={t("settingsPage.mcp.addTitle")}
    okText={t("settingsPage.mcp.confirm")}
    cancelText={t("settingsPage.mcp.cancel")}
    okButtonProps={{ loading: adding }}
    onOk={() => void submit()}
    onCancel={onClose}
    width={560}
    destroyOnHidden
    rootClassName="cy-settings-mcp-modal"
  >
    <div className="cy-settings-mcp-modal__body">
      <SettingsSegmented
        value={mode}
        onChange={(value) => switchMode(value as "form" | "json")}
        options={[
          { value: "form", label: t("settingsPage.mcp.formMode") },
          { value: "json", label: t("settingsPage.mcp.jsonMode") },
        ]}
      />
      {mode === "form" ? <>
        <div className="cy-settings-mcp-modal__field">
          <label htmlFor="cy-mcp-name">{t("settingsPage.mcp.name")}</label>
          <SettingsInput id="cy-mcp-name" value={form.name} placeholder={t("settingsPage.mcp.namePlaceholder")} onChange={(event) => updateForm({ name: event.target.value })} />
        </div>
        <div className="cy-settings-mcp-modal__field">
          <label htmlFor="cy-mcp-type">{t("settingsPage.mcp.type")}</label>
          <SettingsSelect id="cy-mcp-type" ariaLabel={t("settingsPage.mcp.type")} value={form.transport} onChange={(transport) => updateForm({ transport })} options={MCP_TRANSPORTS.map((value) => ({ value, label: t(`settingsPage.mcp.transport.${value}`) }))} />
        </div>
        {form.transport === "stdio" ? <>
          <div className="cy-settings-mcp-modal__field">
            <label htmlFor="cy-mcp-command">{t("settingsPage.mcp.command")}</label>
            <SettingsInput id="cy-mcp-command" value={form.command} placeholder={t("settingsPage.mcp.commandPlaceholder")} onChange={(event) => updateForm({ command: event.target.value })} autoComplete="off" spellCheck={false} />
          </div>
          <div className="cy-settings-mcp-modal__field">
            <label htmlFor="cy-mcp-args">{t("settingsPage.mcp.args")}</label>
            <SettingsInput id="cy-mcp-args" value={form.args} placeholder={t("settingsPage.mcp.argsPlaceholder")} onChange={(event) => updateForm({ args: event.target.value })} autoComplete="off" spellCheck={false} />
          </div>
        </> : (
          <div className="cy-settings-mcp-modal__field">
            <label htmlFor="cy-mcp-url">{t("settingsPage.mcp.url")}</label>
            <SettingsInput id="cy-mcp-url" value={form.url} placeholder={t("settingsPage.mcp.urlPlaceholder")} onChange={(event) => updateForm({ url: event.target.value })} autoComplete="off" spellCheck={false} />
          </div>
        )}
        <Collapse ghost items={[{
          key: "advanced",
          label: t("settingsPage.mcp.advanced"),
          children: form.transport === "stdio" ? (
            <div className="cy-settings-mcp-modal__field">
              <label htmlFor="cy-mcp-env">{t("settingsPage.mcp.envLabel")}</label>
              <Input.TextArea id="cy-mcp-env" rows={4} value={form.env} placeholder={t("settingsPage.mcp.envPlaceholder")} onChange={(event) => updateForm({ env: event.target.value })} spellCheck={false} />
            </div>
          ) : (
            <div className="cy-settings-mcp-modal__field">
              <label htmlFor="cy-mcp-headers">{t("settingsPage.mcp.headersLabel")}</label>
              <Input.TextArea id="cy-mcp-headers" rows={4} value={form.headers} placeholder={t("settingsPage.mcp.headersPlaceholder")} onChange={(event) => updateForm({ headers: event.target.value })} spellCheck={false} />
            </div>
          ),
        }]} />
      </> : (
        <div className="cy-settings-mcp-modal__field">
          <label htmlFor="cy-mcp-json">{t("settingsPage.mcp.jsonLabel")}</label>
          <Input.TextArea id="cy-mcp-json" rows={12} value={jsonText} placeholder={t("settingsPage.mcp.jsonPlaceholder")} onChange={(event) => { setJsonText(event.target.value); setError(""); }} spellCheck={false} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
    </div>
  </Modal>;
}

interface McpRuntimeState {
  connected: boolean;
  toolCount: number;
}

/** 麦当劳官方远程 MCP（open.mcd.cn 申请 Token 后填入请求头） */
const MCD_MCP_URL = "https://mcp.mcd.cn";

export function McpSettingsPanel() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<McpServerConfigView[] | null>(null);
  const [runtime, setRuntime] = useState<Record<string, McpRuntimeState>>({});
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addPreset, setAddPreset] = useState<Partial<McpFormState> | undefined>(undefined);
  const [removingId, setRemovingId] = useState("");
  const [fsEnabled, setFsEnabled] = useState<boolean | null>(null);

  async function refresh(): Promise<void> {
    const api = window.settings;
    if (!api?.listMcpServerConfigs) {
      setLoadError(true);
      setConfigs([]);
      return;
    }
    try {
      const [configList, runtimeList] = await Promise.all([
        api.listMcpServerConfigs(),
        api.listMcpServers?.() ?? Promise.resolve([]),
      ]);
      const runtimeMap: Record<string, McpRuntimeState> = {};
      for (const item of runtimeList) {
        runtimeMap[item.id] = { connected: item.connected, toolCount: item.toolCount };
      }
      setConfigs(configList);
      setRuntime(runtimeMap);
      setLoadError(false);
    } catch {
      setLoadError(true);
      setConfigs([]);
    }
  }

  useEffect(() => { void refresh(); }, []);

  // 内置 Filesystem MCP 开关状态（general settings）
  useEffect(() => {
    void window.settings?.getGeneral?.().then((general) => {
      // SettingsWindowApi 的 getGeneral 返回宽类型，这里只关心 filesystemMcpEnabled
      const value = (general as { filesystemMcpEnabled?: boolean } | null | undefined)?.filesystemMcpEnabled;
      setFsEnabled(Boolean(value));
    }).catch(() => setFsEnabled(false));
  }, []);

  async function toggleFilesystemMcp(checked: boolean) {
    setFsEnabled(checked);
    try {
      await window.settings?.saveGeneral?.({ filesystemMcpEnabled: checked });
      setStatus(t(checked ? "settingsPage.mcp.fsEnabled" : "settingsPage.mcp.fsDisabled"));
      await refresh();
    } catch {
      setFsEnabled(!checked);
      setStatus(t("settingsPage.mcp.fsToggleFailed"));
    }
  }

  function openAddModal(preset?: Partial<McpFormState>) {
    setAddPreset(preset);
    setAddOpen(true);
  }

  async function removeServer(server: McpServerConfigView) {
    if (!window.settings?.removeMcpServer || removingId) return;
    setRemovingId(server.id);
    try {
      await window.settings.removeMcpServer(server.id);
      setStatus(t("settingsPage.mcp.removed", { name: server.name }));
      await refresh();
    } catch {
      setStatus(t("settingsPage.mcp.removeFailed"));
    } finally {
      setRemovingId("");
    }
  }

  const loading = configs === null;

  return <>
    <h1>{t("settingsPage.mcp.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.mcp.description")}</p>
    {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.mcp.loadFailed")} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading">
          <h2><MCP size={18} />{t("settingsPage.mcp.serversTitle")}</h2>
          <p>{t("settingsPage.mcp.serversDescription")}</p>
        </div>
        <div className="cy-settings-card">
          {(configs ?? []).length === 0 && (
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><span>{t("settingsPage.mcp.empty")}</span></div></div>
          )}
          {(configs ?? []).map((server) => {
            const state = runtime[server.id];
            const connected = state?.connected === true;
            const transportLabel = t(`settingsPage.mcp.transport.${server.transport}`);
            const stateLabel = connected
              ? t("settingsPage.mcp.connectedTools", { count: state.toolCount })
              : t("settingsPage.mcp.disconnected");
            const detail = server.transport === "stdio"
              ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
              : server.url || "";
            return <div className="cy-settings-row" key={server.id}>
              <div className="cy-settings-row__copy">
                <strong>{server.name}</strong>
                <span>{transportLabel} · {stateLabel}</span>
                {detail && <span className="cy-settings-mcp__detail">{detail}</span>}
              </div>
              <div className="cy-settings-row__control">
                <Popconfirm
                  title={t("settingsPage.mcp.removeConfirmTitle")}
                  description={t("settingsPage.mcp.removeConfirm", { name: server.name })}
                  okButtonProps={{ danger: true }}
                  okText={t("settingsPage.mcp.remove")}
                  cancelText={t("settingsPage.mcp.cancel")}
                  onConfirm={() => void removeServer(server)}
                >
                  <Button danger loading={removingId === server.id} disabled={Boolean(removingId) && removingId !== server.id}>{t("settingsPage.mcp.remove")}</Button>
                </Popconfirm>
              </div>
            </div>;
          })}
          <div className="cy-settings-row cy-settings-tools__actions">
            <Button type="primary" icon={<Plus size={14} />} onClick={() => openAddModal()}>{t("settingsPage.mcp.addServer")}</Button>
          </div>
        </div>
      </section>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading">
          <h2><FolderOpen size={18} />{t("settingsPage.mcp.builtinTitle")}</h2>
          <p>{t("settingsPage.mcp.builtinDescription")}</p>
        </div>
        <div className="cy-settings-card">
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>{t("settingsPage.mcp.fsLabel")}</strong>
              <span>{t("settingsPage.mcp.fsDescription")}</span>
            </div>
            <div className="cy-settings-row__control">
              <SettingsSwitch
                ariaLabel={t("settingsPage.mcp.fsLabel")}
                checked={fsEnabled === true}
                loading={fsEnabled === null}
                onChange={(checked) => void toggleFilesystemMcp(checked)}
              />
            </div>
          </div>
        </div>
      </section>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading">
          <h2><UtensilsCrossed size={18} />{t("settingsPage.mcp.recommendedTitle")}</h2>
          <p>{t("settingsPage.mcp.recommendedDescription")}</p>
        </div>
        <div className="cy-settings-card">
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>{t("settingsPage.mcp.mcdName")}</strong>
              <span>{t("settingsPage.mcp.mcdDescription")}</span>
              <span className="cy-settings-mcp__detail">{MCD_MCP_URL}</span>
            </div>
            <div className="cy-settings-row__control">
              <Button
                disabled={(configs ?? []).some((c) => c.url === MCD_MCP_URL)}
                onClick={() => openAddModal({
                  name: t("settingsPage.mcp.mcdName"),
                  transport: "http",
                  url: MCD_MCP_URL,
                  headers: '{\n  "Authorization": "Bearer YOUR_MCP_TOKEN"\n}',
                })}
              >
                {(configs ?? []).some((c) => c.url === MCD_MCP_URL) ? t("settingsPage.mcp.alreadyAdded") : t("settingsPage.mcp.addRecommended")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>}
    <AddMcpServerModal
      open={addOpen}
      initialForm={addPreset}
      existingIds={(configs ?? []).map((c) => c.id)}
      onClose={() => setAddOpen(false)}
      onAdded={(message) => { setStatus(message); void refresh(); }}
    />
    <div className="cy-settings-status" role="status" aria-live="polite">{status}</div>
  </>;
}
