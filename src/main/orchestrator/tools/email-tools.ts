// ✉️ 邮件发送工具 —— SMTP 直发，支持附件/抄送/多收件人。
//
// 设计原则：
// - 复用 GeneralSettings 中 SMTP 配置（host/port/secure/user/pass/fromName）
// - 用 nodemailer 发送，每次 execute 新建 transport（不缓存，配置即时生效）
// - 发信前用 requestUserChoice 弹确认卡片（复用现有 ask_user_choice 机制）
// - 配置通过 setEmailConfig 注入 getter（避免 import index.ts 循环依赖）
// - 错误以 [错误]/[send_email] 字符串返回，不抛异常（流回对话）

import * as fs from "fs";
import * as path from "path";
import nodemailer from "nodemailer";
import { toolRegistry } from "./registry/tool-registry";
import { requestUserChoice, type ChoiceOption } from "../../user-choice";
import { logger, LogTag } from "../../logger";
import type { ToolContext } from "./registry/tool-context";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ══════════════════════════════════════════════════════════
// 配置注入
// ══════════════════════════════════════════════════════════

let emailEnabledGetter: (() => boolean) | null = null;
let smtpHostGetter: (() => string) | null = null;
let smtpPortGetter: (() => number) | null = null;
let smtpSecureGetter: (() => boolean) | null = null;
let smtpUserGetter: (() => string) | null = null;
let smtpPassGetter: (() => string) | null = null;
let fromNameGetter: (() => string) | null = null;

/** index.ts 启动时注入 SMTP 配置获取器（每次执行实时读 GeneralSettings）。 */
export function setEmailConfig(
  enabledGetter: () => boolean,
  hostGetter: () => string,
  portGetter: () => number,
  secureGetter: () => boolean,
  userGetter: () => string,
  passGetter: () => string,
  fromNameFn: () => string,
): void {
  emailEnabledGetter = enabledGetter;
  smtpHostGetter = hostGetter;
  smtpPortGetter = portGetter;
  smtpSecureGetter = secureGetter;
  smtpUserGetter = userGetter;
  smtpPassGetter = passGetter;
  fromNameGetter = fromNameFn;
}

/** 当前配置中的 SMTP 发件账号，未启用或未配置时不返回地址。 */
export function getSmtpSenderIdentity(): string | null {
  if (!(emailEnabledGetter?.() ?? false)) return null;
  const user = smtpUserGetter?.()?.trim() ?? "";
  return user || null;
}

// ══════════════════════════════════════════════════════════
// 工具入口
// ══════════════════════════════════════════════════════════

async function executeSendEmail(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  // 1. 读配置 + 启用检查
  const enabled = emailEnabledGetter?.() ?? false;
  if (!enabled) {
    return "[错误] 邮件功能未启用，请在设置里开启";
  }
  const host = smtpHostGetter?.() ?? "";
  const user = smtpUserGetter?.() ?? "";
  const pass = smtpPassGetter?.() ?? "";
  if (!host || !user || !pass) {
    return "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码";
  }
  const port = smtpPortGetter?.() ?? 465;
  const secure = smtpSecureGetter?.() ?? (port === 465);
  const fromName = fromNameGetter?.() ?? "";

  // 2. 校验收件人
  const to = (args.to as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  if (to.length === 0) {
    return "[错误] 收件人列表为空";
  }
  const invalidTo = to.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidTo) {
    return `[错误] 收件人邮箱无效：${invalidTo}`;
  }
  const cc = (args.cc as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  const invalidCc = cc.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidCc) {
    return `[错误] 抄送邮箱无效：${invalidCc}`;
  }

  // 3. 正文
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  const html = args.html ? String(args.html) : undefined;
  if (!subject) {
    return "[错误] 邮件主题不能为空";
  }
  if (!body && !html) {
    return "[错误] 邮件正文不能为空";
  }

  // 4. 【前置校验】附件存在性
  const attachments = (args.attachments as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  for (const p of attachments) {
    if (!fs.existsSync(p)) {
      return `[错误] 附件不存在：${p}`;
    }
  }

  // 5. 确认卡片（实现注意点 12.4：摘要只取 body 纯文本，不截取 html）
  const bodyPreview = body.length > 100 ? body.slice(0, 100) + "…" : body;
  const attachNames = attachments.length > 0
    ? attachments.map(p => path.basename(p)).join(", ")
    : "（无）";
  const question = [
    "确认发送邮件？",
    `收件人：${to.join(", ")}`,
    cc.length > 0 ? `抄送：${cc.join(", ")}` : null,
    `主题：${subject}`,
    `正文摘要：${bodyPreview}`,
    `附件：${attachNames}`,
  ].filter(Boolean).join("\n");
  const options: ChoiceOption[] = [
    { label: "发送", value: "send" },
    { label: "取消", value: "cancel" },
  ];
  const choice = await requestUserChoice(question, options, "cancel", {
    sensitive: true,
    suppressToast: true,
    signal: context?.signal,
    runId: context?.runId,
  });
  if (choice !== "send") {
    return "[send_email] 用户取消发送";
  }

  // 6. 发送（实现注意点 12.2：fromName 转义；12.3：cc 空数组传 undefined；12.5：每次新建 transport）
  try {
    // 实现注意点 12.5：每次 execute 新建 transport，不缓存模块级实例
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    // 实现注意点 12.2：fromName 双引号转义（RFC 5322）
    const safeName = fromName.replace(/"/g, '\\"');
    const from = fromName ? `"${safeName}" <${user}>` : user;
    // 实现注意点 12.3：cc 为空数组时传 undefined，避免空 CC 头
    const ccField = cc.length > 0 ? cc.join(", ") : undefined;
    const info = await transport.sendMail({
      from,
      to: to.join(", "),
      cc: ccField,
      subject,
      text: body,
      html,
      attachments: attachments.map(p => ({ filename: path.basename(p), path: p })),
    });
    return "[send_email] 邮件已发送。";
  } catch {
    return "[错误] 邮件发送失败，请检查 SMTP 配置或网络后重试。";
  }
}

// ══════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════

/** 注册邮件工具。index.ts startup 调一次。 */
export function registerEmailTools(): void {
  toolRegistry.register({
    id: "send_email",
    name: "发送邮件",
    description:
      "通过 SMTP 发送邮件给指定收件人，支持附件、抄送。\n\n" +
      "何时用：\n" +
      "- 用户要求发邮件给某人（如「把这份报告发给 xxx@xxx.com」）\n" +
      "- 配合 write_word/excel/pdf 工具，把生成的文件作为附件发送\n" +
      "- 发送正式邮件、周报、通知等\n\n" +
      "不要用于：\n" +
      "- 群发营销邮件（每次只能发少量收件人）\n" +
      "- 不带任何正文内容的空邮件\n" +
      "- 未在设置里配置 SMTP 的情况（会返回配置缺失错误提示）\n\n" +
      "参数：to（收件人数组）、subject（主题）、body（纯文本正文）、" +
      "html（可选 HTML 正文，提供则覆盖 body）、cc（可选抄送）、" +
      "attachments（可选附件绝对路径数组）。",
    enabled: true,
    risk: "network",
    modes: ["work"],
    effectKind: "external_side_effect" as const,
    sensitiveArgs: true,
    sensitiveOutput: true,
    ledgerPolicy: "bypass",
    inputSchema: {
      type: "object",
      properties: {
        to:          { type: "array", items: { type: "string" }, description: "收件人邮箱地址数组" },
        cc:          { type: "array", items: { type: "string" }, description: "抄送（可选）" },
        subject:     { type: "string", description: "邮件主题" },
        body:        { type: "string", description: "邮件正文（纯文本）" },
        html:        { type: "string", description: "HTML 正文（可选，提供则覆盖 body）" },
        attachments: { type: "array", items: { type: "string" }, description: "附件绝对路径数组（agent 生成文件或本地文件路径）" },
      },
      required: ["to", "subject", "body"],
    },
    execute: executeSendEmail,
  });

  logger.info(LogTag.EmailTools, "registered: send_email");
}
