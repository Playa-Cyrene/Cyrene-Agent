import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted 保证 mock 变量在 vi.mock 工厂里可用（vi.mock 会被提升到文件顶部）
const { sendMailMock, closeTransportMock, createTransportMock, requestUserChoiceMock, existsSyncMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const closeTransportMock = vi.fn();
  return {
    sendMailMock,
    closeTransportMock,
    createTransportMock: vi.fn(() => ({ sendMail: sendMailMock, close: closeTransportMock })),
    requestUserChoiceMock: vi.fn(),
    existsSyncMock: vi.fn(() => true),
  };
});

// mock nodemailer
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

// mock requestUserChoice —— 默认返回 "send"
vi.mock("../../user-choice", () => ({
  requestUserChoice: (...a: unknown[]) => requestUserChoiceMock(...a),
}));

// mock fs.existsSync —— 默认 true（附件存在）
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: existsSyncMock };
});

import { setEmailConfig, registerEmailTools } from "./email-tools";
import { toolRegistry } from "./registry/tool-registry";

// 注入测试配置
function injectConfig(overrides: Record<string, unknown> = {}): void {
  const cfg = {
    enabled: true,
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: "sender@qq.com",
    pass: "authcode123",
    fromName: "昔涟",
    ...overrides,
  };
  setEmailConfig(
    () => cfg.enabled as boolean,
    () => cfg.host as string,
    () => cfg.port as number,
    () => cfg.secure as boolean,
    () => cfg.user as string,
    () => cfg.pass as string,
    () => cfg.fromName as string,
  );
}

// 注册工具拿到 execute
registerEmailTools();
const tool = toolRegistry.getById("send_email")!;
const exec = tool.execute;

describe("send_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestUserChoiceMock.mockResolvedValue("send");
    sendMailMock.mockResolvedValue({ accepted: ["a@b.com"], messageId: "<test@localhost>" });
    existsSyncMock.mockReturnValue(true);
    injectConfig();
  });

  it("功能未启用 → 返回错误", async () => {
    injectConfig({ enabled: false });
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] 邮件功能未启用，请在设置里开启");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("SMTP 配置不完整 → 返回错误", async () => {
    injectConfig({ host: "" });
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] SMTP 配置不完整：缺少 主机/用户名/授权码");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("收件人邮箱格式无效 → 返回错误", async () => {
    const res = await exec({ to: ["not-an-email"], subject: "标题", body: "正文" });
    expect(res).toBe("[错误] 收件人邮箱无效：not-an-email");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("附件不存在 → 返回错误（前置校验，不进确认）", async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await exec({
      to: ["a@b.com"],
      subject: "标题",
      body: "正文",
      attachments: ["C:/nope.txt"],
    });
    expect(res).toBe("[错误] 附件不存在：C:/nope.txt");
    expect(requestUserChoiceMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("用户取消 → 返回取消，不调用 sendMail", async () => {
    requestUserChoiceMock.mockResolvedValue("cancel");
    const res = await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    expect(res).toBe("[send_email] 用户取消发送");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("用户确认 → 调 sendMail，参数正确（from 含 fromName 转义、cc undefined、attachments 映射）", async () => {
    const res = await exec({
      to: ["a@b.com", "c@d.com"],
      subject: "周报",
      body: "本周内容",
      attachments: ["C:/report.docx"],
    });
    expect(res).toBe("[send_email] 邮件已发送。");
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      auth: { user: "sender@qq.com", pass: "authcode123" },
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"昔涟" <sender@qq.com>');
    expect(mailOpts.to).toEqual(["a@b.com", "c@d.com"]);
    expect(mailOpts.cc).toBeUndefined();
    expect(mailOpts.subject).toBe("周报");
    expect(mailOpts.text).toBe("本周内容");
    expect(mailOpts.attachments).toEqual([{ filename: "report.docx", path: "C:/report.docx" }]);
    expect(closeTransportMock).toHaveBeenCalledTimes(1);
  });

  it("fromName 含双引号 → 转义后传入 from", async () => {
    injectConfig({ fromName: '她说"你好"' });
    await exec({ to: ["a@b.com"], subject: "标题", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"她说\\"你好\\"" <sender@qq.com>');
  });

  it("cc 非空 → 传入 join 后的 cc", async () => {
    await exec({ to: ["a@b.com"], cc: ["x@y.com", "z@w.com"], subject: "标题", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.cc).toEqual(["x@y.com", "z@w.com"]);
  });

  it("sendMail 抛错 → 返回结果未知且关闭传输器", async () => {
    sendMailMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(exec({ to: ["a@b.com"], subject: "标题", body: "正文" })).rejects.toMatchObject({
      code: "SMTP_SEND_RESULT_UNKNOWN",
      category: "timeout",
      retryable: false,
      effectState: "unknown",
    });
    expect(closeTransportMock).toHaveBeenCalledTimes(1);
  });
});
