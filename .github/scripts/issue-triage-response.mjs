// 只处理可选的搜索/模型判断请求；不包住主流程，配置或事件文件错误仍然失败。
// 不打印响应正文、异常消息、URL 或请求头，避免接口回显凭据/Issue 私有内容。
export function warnResponseShape(stage) {
  console.warn(`[issue-triage][${stage}] JSON 响应结构不符合约定，本阶段跳过`);
}

export async function fetchJsonObject(stage, request) {
  let response;
  try {
    response = await request();
  } catch {
    console.warn(`[issue-triage][${stage}] 请求失败，本阶段跳过`);
    return null;
  }
  if (!response.ok) {
    console.warn(`[issue-triage][${stage}] HTTP ${response.status}，本阶段跳过`);
    return null;
  }
  let data;
  try {
    data = await response.json();
  } catch {
    // 包括 200 OK 文本、HTML、空响应、损坏 JSON，以及读取响应体失败。
    console.warn(`[issue-triage][${stage}] HTTP ${response.status} 响应无法解析为 JSON，本阶段跳过`);
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnResponseShape(stage);
    return null;
  }
  return data;
}
