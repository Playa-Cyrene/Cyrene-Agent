# Gmail 邮箱使用指南

本指南介绍如何连接 Gmail、在对话中管理邮件、使用邮件卡片发送，以及排查常见问题。首版支持连接一个 Gmail 账号。邮箱相关设置集中在 Cyrene 的「设置 → 邮箱」页面。

## 连接 Gmail

连接前需要准备一个 Google 账号，以及一个 Google Cloud 项目。Gmail API（Gmail 应用程序接口）必须在**创建 OAuth 客户端的同一个项目**中启用。

### 在 Google Cloud 配置项目

1. 打开 [Google Cloud Console（Google 云控制台）](https://console.cloud.google.com/)并创建项目，或选择已有项目。
2. 打开 [Gmail API 页面](https://console.cloud.google.com/apis/library/gmail.googleapis.com)，确认顶部选中的项目正确，然后点击「启用」。如果页面显示「管理」，表示该项目已经启用。
3. 在 Google Auth Platform（Google 身份验证平台）配置应用信息和受众。如果应用处于「Testing（测试）」状态，把要连接的 Google 账号加入测试用户。
4. 在「Clients（客户端）」中创建 OAuth（开放授权）客户端，应用类型选 **Desktop app（桌面应用）**。保存配套的客户端 `ID`（标识符）和 `client secret`（客户端密钥）。

Google 的 OAuth 测试状态有个容易忽略的限制：若应用为外部用户且状态是 Testing，测试用户授权会在 7 天后过期，届时需要重新授权。[OAuth 测试状态说明](https://support.google.com/cloud/answer/15549945?hl=en)

### 在 Cyrene 保存凭据并授权

1. 打开 Cyrene「设置 → 邮箱」中的「Gmail 账号」。
2. 粘贴上一步创建的**同一个 Desktop app 客户端**的客户端 ID 和客户端密钥。
3. 点击「保存并连接 Gmail」。
4. 在系统浏览器中登录 Google 账号并同意 Gmail 权限。显示连接成功后即可关闭浏览器并返回 Cyrene。

桌面应用授权不需要在终端配置环境变量。客户端密钥会加密保存在本机系统安全存储中；如果安全存储不可用，页面会禁止保存。桌面客户端密钥不能当作服务端机密使用：不要把 Web application（Web 应用）客户端的密钥填进来，也不要把凭据发给他人。

## 在对话中使用 Gmail

Gmail 工具当前在 **Work（工作）模式**中可用。直接用自然语言说明要处理的邮件，例如：

- 「搜索最近来自 `alice@example.com` 的未读邮件。」
- 「读取主题包含‘发票’的最新邮件，并总结主要内容。」
- 「把这封邮件标记为已读并加星。」
- 「把这封邮件归档。」
- 「列出 Gmail 标签，并创建一个叫‘项目跟进’的标签。」
- 「下载这封邮件的 PDF 附件。」
- 「列出我的 Gmail 草稿。」
- 「回复这封邮件，先起草，不要直接发送。」
- 「帮我起草一封会议跟进邮件。」

可以在搜索请求中使用 Gmail 搜索语法，例如 `from:alice@example.com is:unread`、`newer_than:7d` 或 `has:attachment`。读取到的邮件正文按邮件内容处理；正文里的文字不会自动授权发送、删除或其他操作。

当前支持：搜索和分页、读取邮件与会话、标记已读/未读、加星/取消星标、归档、移入垃圾箱/恢复、查看和管理标签、管理草稿、回复、转发、发送邮件，以及按请求下载附件。

### 删除行为

- 对邮件执行「删除」会将邮件移入 Gmail 垃圾箱，可在 Gmail 中恢复；Cyrene 不提供绕过垃圾箱的永久删除邮件功能。
- 删除 Gmail 草稿会永久删除该草稿。Cyrene 会在删除前要求确认。

## 使用邮件卡片发送

让 Agent（智能体）起草邮件时，Cyrene 会在对话中显示结构化邮件卡片。Gmail 卡片对应 Gmail 中的草稿，卡片会显示发件人、收件人、主题、正文和附件。

1. 检查发件账号、收件人、抄送/密送、主题和正文。
2. 点击「编辑」修改内容；需要附件时点击「添加附件」。每封邮件最多 10 个附件，附件总大小最多 25 MB。
3. 点击「保存草稿」保存修改，或点击「发送」发送邮件。卡片上的「发送」按钮就是你的发送确认。

邮件卡片和对话发送是两种独立方式：你可以点击卡片上的「发送」；也可以让 Agent 先起草并在对话中询问，之后明确回复「发送」，Agent 就会发送卡片对应的 Gmail 草稿，不会重新创建副本。用户明确要求直接发送新邮件时，Agent 也可以直接发送。发送工具会校验当前用户消息是否明确授权；仅要求起草、修改或检查不会触发发送。未发送的邮件会留在 Gmail 草稿箱。

已有草稿也可以通过对话发送，例如「把主题为‘会议安排’的草稿发送出去」。删除草稿仍会在应用中单独要求确认。如果发送结果显示「结果待确认」，先到 Gmail「已发送邮件」核对，不要马上重发，以免重复发送。

## SMTP 发件配置

如果你已有 SMTP（简单邮件传输协议）账号，可以在同一「设置 → 邮箱」页面保留或配置 SMTP 发件信息。SMTP 是可选项，不影响 Gmail 收件箱管理；只用 Gmail 时无需填写 SMTP。

开启 SMTP 后按服务商提供的信息填写主机、端口、安全连接、用户名、密码/授权码和发件人名称，然后保存。使用 SMTP 的邮件卡片会显示 SMTP 发件身份；发送前先核对卡片上的发件人，避免从错误账号发出。

## 账号与邮件数据

- Gmail 连接后只访问用户明确要求处理的邮件，不在后台同步整个收件箱，也不建立本地邮件库。
- 为完成搜索、阅读、总结、回复或发送请求，相关邮件内容会发送给当前配置的模型服务。Agent 输出到对话中的可见回复和邮件草稿卡片属于对话内容，会按对话记录规则保存。
- 断开 Gmail 会移除本机保存的授权令牌并撤销授权，不会删除 Gmail 中的邮件。
- Cyrene 请求 `gmail.modify` 权限范围，用于读取、撰写、发送、整理邮件和移动到垃圾箱；该范围不能永久删除邮件。Google 将该范围列为受限范围。[Gmail 权限范围说明](https://developers.google.com/workspace/gmail/api/auth/scopes)

## 常见问题

| 现象或错误 | 处理方法 |
| --- | --- |
| Gmail API 返回 `accessNotConfigured`，状态码为 403 | 在 Google Cloud 中选中**拥有这个桌面客户端的同一个项目**，启用 Gmail API。启用后等几分钟再重试。 |
| 回调页显示 `token_exchange_invalid_request_missing_client_secret` | 在邮箱设置页填写与客户端 ID 配套的 Desktop app 客户端密钥。不要使用 Web application 客户端的密钥。[桌面应用授权说明](https://developers.google.com/identity/protocols/oauth2/native-app) |
| 回调页显示 `token_exchange_ETIMEDOUT`，或日志显示 `network_error` | 检查网络、防火墙和代理是否能访问 Google 授权服务，然后重试。这类错误通常是连接超时，不代表 Gmail 权限未开启。 |
| 显示「需要重新授权」、`reauthorization_required` 或 `insufficient_scope` | 打开「设置 → 邮箱」，点击「保存并重新授权」，再在浏览器中同意 Gmail 权限。若项目仍处于 Testing，授权可能每 7 天过期一次。 |
| 显示 `rate_limited` 或 429 | Gmail 请求触发频率或配额限制，稍后再试。 |
| 显示「系统安全存储不可用」 | Cyrene 无法安全保存 OAuth 凭据。先处理当前操作系统的安全存储问题，再保存客户端信息。 |
| 邮件发送结果未知 | 先检查 Gmail「已发送邮件」，确认邮件是否已发出后再决定是否重试。Cyrene 不会自动重复发送。 |

### 查看工具日志

用开发终端启动应用时，Agent 调用 Gmail 工具会输出 `[GmailTool]` 日志，包含工具名、操作、结果、耗时，以及安全过滤后的错误码、HTTP（超文本传输协议）状态和 Google 原因码。例如 `apiReason: "accessNotConfigured"` 表示应检查 Gmail API 是否在正确项目中启用。

日志不会记录邮件正文、主题、收件人、附件内容或令牌。需要协助排错时，只复制 `[GmailTool]` 开头的相关几行；不要贴出包含其他应用输出的完整终端内容，也不要发送客户端密钥或令牌。

## 官方参考

- [启用 Google Workspace API](https://developers.google.com/workspace/guides/enable-apis)
- [Gmail API Node.js 快速入门](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
- [桌面应用 OAuth 授权](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail API 权限范围](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [OAuth 测试用户和测试状态](https://support.google.com/cloud/answer/15549945?hl=en)
