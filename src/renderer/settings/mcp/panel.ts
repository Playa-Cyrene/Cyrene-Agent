// MCP Server 管理 UI：添加/删除/启停 MCP Server，自定义端点接入说明
// 从 settings.ts 抽离。依赖 shared/modal + shared/parse + plugins/dom + api/dom。
// 副作用导入：模块加载时执行事件绑定 + 接入说明渲染。

import { showNotice, showAlert, showHtmlModal, showInputModal } from "../shared/modal";
import { parseCommandLine } from "../shared/parse";
import { pluginAddBtn } from "../plugins/dom";
import { customEndpointGuideBtn } from "../api/dom";

// ── MCP Server 管理 UI ──────────────────────────────────────
console.log("[settings] plugin-add-btn 查询结果:", pluginAddBtn ? "找到" : "未找到");


pluginAddBtn?.addEventListener("click", async () => {
  console.log("[settings] ＋ 按钮被点击，弹出输入框…");
  const command = await showInputModal({
    title: "添加 MCP Server",
    message: "输入启动命令，例如：node C:\\my-mcp-server\\index.js",
    placeholder: "node path\\to\\server.js --flag",
  });
  if (!command || !command.trim()) {
    console.log("[settings] 用户取消或命令为空");
    return;
  }

  const nameInput = await showInputModal({
    title: "MCP Server 名称",
    message: "给这个 MCP server 起个名字（仅用于展示）",
    placeholder: "例如：天气工具",
  });
  const name = (nameInput && nameInput.trim()) || "未命名 MCP";
  const serverId = "mcp-" + Date.now();
  const parsed = parseCommandLine(command.trim());
  if (!parsed.command) {
    // 无效命令属于字段校验类反馈：用非阻塞轻提示
    showNotice({ tone: "warning", message: "请输入有效的启动命令" });
    return;
  }

  console.log("[settings] 添加 MCP server:", name, serverId, command.trim());

  try {
    const result = await window.settings?.addMcpServer?.({
      id: serverId,
      name: name,
      transport: "stdio",
      command: parsed.command,
      args: parsed.args,
    });

    if (result?.ok) {
      console.log("[settings] MCP server 添加成功，工具数:", result.toolIds?.length);
      // 添加成功属于普通成功反馈：用非阻塞轻提示
      showNotice({
        tone: "success",
        message: `"${name}" 已连接，发现 ${result.toolIds?.length || 0} 个工具`,
      });
    } else {
      console.error("[settings] MCP server 添加失败:", result?.error);
      // 失败原因可能较长，需要用户阅读：用单按钮错误模态框并附折叠详情
      await showAlert({
        tone: "error",
        title: "添加失败",
        message: result?.error || "未知错误",
        details: "详情见终端日志。",
      });
    }
  } catch (err) {
    console.error("[settings] MCP server 添加异常:", err);
    await showAlert({
      tone: "error",
      title: "添加异常",
      message: "调用过程中发生错误",
      details: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
});

export const CUSTOM_ENDPOINT_GUIDE_BODY = [
  '<section class="custom-endpoint-guide-section">',
  '  <h4>官方云端模型</h4>',
  '  <p>从列表选择已适配厂商（OpenAI、Claude、Kimi、DeepSeek、MiniMax、智谱 GLM、通义千问、豆包、小米 MiMo），填写对应平台获取的 API Key 即可。Base URL 与推荐模型 ID 已预填。</p>',
  '  <p class="custom-endpoint-guide-note">同一厂商的不同模型在结构化输出、工具调用和思考模式等能力上可能存在差异，请优先使用列表内的推荐型号。</p>',
  '</section>',
  '<section class="custom-endpoint-guide-section">',
  '  <h4>自定义端点 <span>高级</span></h4>',
  '  <p>可接入提供 OpenAI 或 Anthropic 兼容接口的云端服务、本地推理服务或第三方代理。请明确选择 API 协议，并填写 Base URL 和服务实际提供的模型 ID。</p>',
  '  <div class="custom-endpoint-guide-warning"><strong>本地模型与自定义端点不在官方技术支持范围内。</strong>实际能力取决于推理服务的具体实现，系统不会扫描端口、探测模型或自动升级能力档位。接入第三方代理前，请自行评估隐私和数据安全风险。</div>',
  '  <p>建议保存后点击“<strong>测试连接</strong>”进行基础验证。连接成功仅表示服务能够响应，不代表结构化输出、工具调用和思考模式一定可用。</p>',
  '  <p class="custom-endpoint-guide-security">🔒 你的 API Key 仅存储在本地设备，不会上传至昔涟的服务器。</p>',
  '</section>',
  '<section class="custom-endpoint-guide-section custom-endpoint-faq">',
  '  <h4>常见问题</h4>',
  '  <details>',
  '    <summary>本地模型回复格式异常</summary>',
  '    <p>许多本地推理服务缺少稳定的约束解码或完整协议实现，偶尔输出多余文本、Markdown 围栏或不完整 JSON 属于常见情况。系统会使用本地校验与自动修复兜底；如需更高稳定性，建议选择官方云端模型。</p>',
  '  </details>',
  '  <details>',
  '    <summary>MiniMax 思考模式失效</summary>',
  '    <p>MiniMax 在 JSON 模式下不建议同时启用思考。系统会依据已验证的配置自动处理这一冲突，以结构化结果的稳定性为优先。</p>',
  '  </details>',
  '  <details>',
  '    <summary>Claude 配置项比其他厂商少</summary>',
  '    <p>Claude 的接口规范与 OpenAI 兼容接口不同，部分参数和结构化输出档位并不适用，因此页面显示的配置项会更少。这属于正常差异，不影响已适配能力的使用。</p>',
  '  </details>',
  '</section>',
].join("\n");

customEndpointGuideBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: "模型服务接入说明",
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
  });
});