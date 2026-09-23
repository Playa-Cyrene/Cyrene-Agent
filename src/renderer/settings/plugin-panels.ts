/**
 * 设置页插件面板挂载（cyrene-panel/1）。
 *
 * 安全模型：
 * - iframe sandbox="allow-scripts allow-same-origin"，面板 origin 为
 *   cyrene-plugin://<插件id>，与设置页结构性不同源；
 * - iframe 注册表按 contentWindow 反查归属插件——iframe 不能选择自己是谁，
 *   消息内即使携带 pluginId 也一律忽略；
 * - event.source + event.origin 双校验（后者同时拦截 iframe 被导航到其他
 *   插件 origin 的攻击）；
 * - invoke 只经 preload 的 pluginPanel 单一通道转发到主进程，主进程再做
 *   sender 窗口校验与路由器校验。
 */
import {
  PANEL_MIN_HEIGHT,
  PANEL_PROTOCOL,
  PANEL_SCHEME,
  buildPanelTheme,
  panelOriginFor,
  parsePanelMessage,
  clampPanelHeight,
} from "./panel-bridge-protocol";

/** 已挂载面板注册表：contentWindow → 归属插件 id（安全边界的锚点） */
const panelRegistry = new Map<Window, string>();

function postToPanel(contentWindow: Window, pluginId: string, payload: Record<string, unknown>): void {
  // 宿主→面板方向：allow-same-origin 修正后可用精确 targetOrigin
  contentWindow.postMessage({ protocol: PANEL_PROTOCOL, ...payload }, panelOriginFor(pluginId));
}

function findContentWindow(pluginId: string): Window | undefined {
  for (const [contentWindow, id] of panelRegistry) {
    if (id === pluginId) return contentWindow;
  }
  return undefined;
}

function findIframeByContentWindow(contentWindow: Window): HTMLIFrameElement | null {
  for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>(".plugin-panels iframe"))) {
    if (iframe.contentWindow === contentWindow) return iframe;
  }
  return null;
}

window.addEventListener("message", (event: MessageEvent) => {
  // 第一道校验：来源必须是已注册的面板 iframe（iframe 不能选择自己是谁）
  const pluginId = panelRegistry.get(event.source as Window);
  if (!pluginId) return;
  // 第二道校验：origin 必须是该插件自己的面板 origin（拦截 iframe 导航攻击）
  if (event.origin !== panelOriginFor(pluginId)) return;
  const message = parsePanelMessage(event.data);
  if (!message) return;
  const contentWindow = event.source as Window;

  if (message.kind === "invoke") {
    void window.pluginPanel
      ?.invoke(pluginId, message.channel, message.args)
      .then((result) => {
        // 主进程统一返回 { ok, data?, error? }；异常时也按失败回包，
        // 避免面板端 Promise 悬挂
        const outcome =
          result && typeof result === "object" && "ok" in result
            ? result as { ok: boolean; data?: unknown; error?: string }
            : null;
        const live = findContentWindow(pluginId);
        if (!live) return;
        if (outcome?.ok) {
          postToPanel(live, pluginId, { kind: "invoke-result", seq: message.seq, ok: true, data: outcome.data });
        } else {
          postToPanel(live, pluginId, { kind: "invoke-result", seq: message.seq, ok: false, error: outcome?.error ?? "面板调用失败" });
        }
      });
    return;
  }

  const iframe = findIframeByContentWindow(contentWindow);
  if (iframe) {
    iframe.style.height = `${clampPanelHeight(message.height)}px`;
  }
});

/** 挂载一个插件面板 iframe（外层卡片壳 + sandbox iframe + 生命周期接线） */
function mountPanel(
  container: HTMLElement,
  plugin: { id: string; name: string; version: string; settingsPanel: string },
): () => void {
  const card = document.createElement("article");
  card.className = "plugin-panel-card";

  const header = document.createElement("div");
  header.className = "plugin-panel-card__header";
  const title = document.createElement("h2");
  title.textContent = plugin.name;
  const version = document.createElement("span");
  version.className = "plugin-panel-card__version";
  version.textContent = `v${plugin.version}`;
  header.append(title, version);

  const iframe = document.createElement("iframe");
  // allow-same-origin 保留面板真实 origin，使双校验成立；
  // 跨源访问由同源策略阻挡，设置页与 cyrene-plugin:// 结构性不同源
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute("src", `${PANEL_SCHEME}://${plugin.id}/${plugin.settingsPanel}`);
  iframe.className = "plugin-panel-card__frame";
  iframe.style.height = `${PANEL_MIN_HEIGHT}px`;

  card.append(header, iframe);

  // 注册表登记与 init 下发都在 load 后（此时 contentWindow 才可寻址）
  const onLoad = () => {
    if (!iframe.contentWindow) return;
    panelRegistry.set(iframe.contentWindow, plugin.id);
    const theme = buildPanelTheme(
      document.documentElement.dataset.uiTheme || "default",
      getComputedStyle(document.documentElement),
    );
    postToPanel(iframe.contentWindow, plugin.id, { kind: "init", theme });
  };
  iframe.addEventListener("load", onLoad);
  container.append(card);
  return () => {
    iframe.removeEventListener("load", onLoad);
    if (iframe.contentWindow) panelRegistry.delete(iframe.contentWindow);
    card.remove();
  };
}

/** 设置页入口：按分区挂载所有已启用且声明了面板的插件 */
export async function mountPluginPanels(options?: {
  containers?: Partial<Record<"channels" | "plugins", HTMLElement | null>>;
  signal?: AbortSignal;
}): Promise<() => void> {
  // list() 历史返回数组、新版返回 overview 对象，两种都要接
  const overview = await window.plugins?.list();
  if (!overview || options?.signal?.aborted) return () => {};
  const entries = Array.isArray(overview) ? overview : overview.plugins;
  if (!Array.isArray(entries)) return () => {};
  const containers = options?.containers ?? {
    channels: document.getElementById("plugin-panels-channels"),
    plugins: document.getElementById("plugin-panels-plugins"),
  };
  const disposePanels: Array<() => void> = [];
  for (const plugin of entries) {
    // 局部收窄后显式传参（TS 的属性窄化不随对象参数穿透）
    const panelFile = plugin.settingsPanel;
    if (!panelFile || !plugin.enabled) continue;
    const section = plugin.settingsSection === "channels" ? "channels" : "plugins";
    const container = containers[section];
    if (container) {
      disposePanels.push(mountPanel(container, { id: plugin.id, name: plugin.name, version: plugin.version, settingsPanel: panelFile }));
    }
  }
  // 主题变化时对所有存活面板下发 theme-changed（当前仅单一白调主题，
  // 预留未来多主题；data-ui-theme 变化即触发）
  const themeObserver = new MutationObserver(() => {
    const theme = buildPanelTheme(
      document.documentElement.dataset.uiTheme || "default",
      getComputedStyle(document.documentElement),
    );
    for (const [contentWindow, pluginId] of panelRegistry) {
      postToPanel(contentWindow, pluginId, { kind: "theme-changed", theme });
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-theme"] });
  return () => {
    themeObserver.disconnect();
    for (const dispose of disposePanels) dispose();
  };
}
