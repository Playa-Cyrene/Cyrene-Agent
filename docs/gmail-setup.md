# Gmail 配置

## 本地开发

1. 在 Google Cloud Console 中创建或选择项目，并启用 Gmail API。
2. 配置 OAuth consent screen（开放授权同意界面）。本地联调可将自己的账号加入测试用户。
3. 创建类型为 Desktop app（桌面应用）的 OAuth 客户端，复制客户端 ID 和**同一客户端**的客户端密钥。不要使用 Web application（Web 应用）客户端密钥。
4. 在启动开发构建的同一 PowerShell 窗口中设置客户端 ID 和客户端密钥：

   ```powershell
   $env:CYRENE_GMAIL_CLIENT_ID = "你的客户端 ID"
   $env:CYRENE_GMAIL_CLIENT_SECRET = "同一桌面客户端的客户端密钥"
   pnpm run dev
   ```

构建脚本会把客户端凭据编入主进程。没有客户端 ID 时，程序和聊天仍可运行，邮箱设置页会显示 Gmail 尚未配置。修改任一凭据后需重新构建主进程。桌面客户端密钥不能作为保密边界；不要把 Web application（Web 应用）客户端密钥放进桌面程序。

桌面端授权使用系统浏览器和 `127.0.0.1` 本机随机端口回调；Google 文档建议 Windows、macOS、Linux 桌面应用使用 loopback IP（回环 IP）授权方式。[桌面应用 OAuth 文档](https://developers.google.com/identity/protocols/oauth2/native-app)

## 授权故障排查

如果回调页显示 `token_exchange_invalid_request_missing_client_secret`，设置 `CYRENE_GMAIL_CLIENT_SECRET`，值必须来自与客户端 ID 配对的 **Desktop app（桌面应用）** OAuth 客户端，然后重新构建并启动。绝不能拿 Web application（Web 应用）的客户端密钥代替。[桌面应用令牌参数](https://developers.google.com/identity/protocols/oauth2/native-app) · [Web 服务端 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)

每次修改客户端凭据后，完全退出并重新启动开发应用，让主进程重新编译并载入新值。

## 发布前

当前应用请求 `gmail.modify`，用于读取、撰写、发送、标记、归档和将邮件移入垃圾箱；它不能绕过垃圾箱永久删除邮件。Google 将该范围归类为 restricted（受限）范围。公开发布前需按 Google 当前要求完成 OAuth 应用验证、用途说明和隐私政策；如果受限数据被传输或存储在服务器，还可能需要安全评估。[Gmail API 范围说明](https://developers.google.com/workspace/gmail/api/auth/scopes) · [受限范围验证要求](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

账号令牌使用 Electron 系统安全存储加密，邮件不会同步到本地邮箱数据库。用户明确发起邮件操作后，完成该操作所需的内容会发送给当前配置的模型服务；对话中 Agent 生成的草稿卡片和可见回复会随对话记录保存。
