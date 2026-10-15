# Gmail 首版接入设计

## 目标

在 Cyrene-Agent 中内置单账号 Gmail（Google 邮箱）服务。用户可以在设置页的“邮箱”标签连接账号，在对话里让 Agent（智能体）搜索、阅读和管理邮件，也可以让 Agent 起草邮件并通过邮件卡片发送。首版完成 Gmail 用户流程后，再把稳定边界整理为公开插件和 SDK（软件开发工具包）能力。

## 当前项目基础

- 当前 `send_email` 工具通过 Nodemailer（邮件发送库）的 SMTP（简单邮件传输协议）实现发送，设置保存在 `GeneralSettings` 中，密码字段当前跟随通用设置持久化。
- 设置页使用 React（界面开发框架），已存在 `ToolSettingsPanel`、插件设置和通用设置控件；新增“邮箱”设置分区需要扩展路由和导航。
- 对话支持音乐卡片这类显式结构化展示数据，但邮件卡片需要新增自己的数据校验、会话轨迹持久化和动作处理。
- 插件 SDK 可以注册工具和 HTML 设置页，但其设置表单由插件作者编写；首版按用户指定顺序不改造公开插件 SDK，也不把 Gmail 先实现成外部插件。

## 已确认的范围

- 首版只连接一个 Gmail 账号。
- 邮箱设置页负责账号连接状态、授权/断开和发件账号信息。现有 SMTP 设置迁到“邮箱”标签时保留已保存值和现有发送行为；Gmail 与 SMTP 发信身份在卡片上明确标出，避免用户误用账号。SMTP 适配后续随插件和 SDK 阶段再抽出。
- Gmail 邮件能力覆盖：搜索与分页、读取邮件和会话、按用户请求下载附件、已读/未读、星标、归档、查看与管理标签、列出/读取/新建/修改/发送/删除草稿、回复、转发、发送、移入垃圾箱和从垃圾箱恢复。
- “删除”指移入垃圾箱；首版不提供绕过垃圾箱的永久删除。
- 删除 Gmail 草稿会直接永久移除草稿，用户需在卡片或草稿列表中明确确认；不会把草稿删除误显示为可恢复的垃圾箱操作。
- 用户可以在对话中请求 Agent 起草或发送邮件，也可以在对话邮件卡片上编辑后点击发送。Agent 发信走现有用户选择确认机制；用户点击卡片的“发送”按钮就是发送确认。
- 邮件收件箱正文不做后台同步或本地邮件库缓存。Agent 只在用户发起的操作中读取所需数据。
- 首版不提供 Gmail 过滤器、自动转发规则、帐号级设置、推送同步、多账号和外部提供方插件。

## 方案与边界

已考虑三种路径：

1. 首版直接在主程序内接入 Gmail，先让用户流程完整，后续再把内部服务边界公开给插件和 SDK。
2. 现在就把 Gmail 实现为插件，并同时改造插件设置页和 SDK。
3. 要求用户自行部署 Gmail MCP（模型上下文协议）服务并连接。

采用方案 1，符合“首版先 Gmail，之后维护插件和 SDK”的顺序。方案 2 会把公开扩展接口与 Gmail 接入绑在同一阶段；方案 3 需要用户额外配置，不满足项目自带 Gmail 的要求。

首版在主进程内设 Gmail 服务，封装授权、Gmail API（Gmail 应用程序编程接口）调用、邮件数据整形及 Gmail 错误映射。工具层提供明确的邮件操作工具；界面层只通过经校验的主进程接口执行连接、读写和卡片动作。可以保留一个仅供主程序内部使用的邮件服务接口，但不发布为 SDK 契约，不改造插件加载器。

Google 官方 Node.js（JavaScript 运行环境）客户端库负责 Gmail API 请求和 OAuth（开放授权）令牌刷新。桌面授权使用系统浏览器、本机回调和 PKCE（授权码交换证明密钥），验证 `state` 状态参数和授权范围。OAuth 客户端 ID 通过项目构建配置提供；桌面应用内的客户端凭据不能当作服务端机密。访问令牌和刷新令牌使用 Electron（桌面应用框架）`safeStorage` 加密后存储；若系统安全存储不可用，则拒绝保存令牌并提示用户。

开始 Gmail 授权联调前，项目方需要在 Google Cloud 建立项目、启用 Gmail API 并创建桌面应用 OAuth 客户端，将客户端 ID 配置给开发构建。公开发布前还需要完成下文所述的范围验证流程。桌面 OAuth 客户端的密钥不能视为可保密的服务端密钥。

## 复用的成熟库

- Gmail API 调用采用 Google 官方的 `@googleapis/gmail` Node.js 客户端，使用其 TypeScript（JavaScript 类型系统）定义和 Gmail 专用接口，避免引入整个通用 `googleapis`（Google 通用 API 客户端）包。该包由 Google Node.js 团队维护并持续发布；客户端只负责 API 请求，OAuth 授权、令牌安全存储和 Google 范围审核仍由应用配置与少量适配逻辑负责。
- 邮件发送目前已有 Nodemailer，因此 Gmail 发信复用它的 `streamTransport` 生成 MIME（多用途互联网邮件扩展）内容，再调用 Gmail API 发送；不另写邮件格式组装器。收件邮件优先使用 Gmail API 的结构化消息与附件接口；需要解析原始邮件时使用 Nodemailer 项目维护的 MailParser（邮件解析库），不自行实现通用 MIME 解析器。
- 邮件卡片的 Markdown 转换复用项目已有 `marked`，再用 DOMPurify（HTML 清理库）清理邮件 HTML；收件邮件中的 HTML 同样先清理再展示。发送时同时生成纯文本和清理后的 HTML 正文。
- 自定义代码只负责 Gmail 账号状态、令牌加密、项目工具接口、错误映射、邮件卡片和会话数据边界。需要为受限范围做 OAuth 验证；客户端库本身不能消除这项发布成本。

## 邮件卡片和会话数据

Agent 通过主程序的结构化展示数据输出 `MailDraftCardData`，由主程序校验后渲染，而不是让模型提供 HTML（超文本标记语言）。字段包括邮件服务、收件人、抄送、密送、主题、正文、附件引用和状态；发件地址由所选账号提供。卡片包含发件身份、收件人、主题、正文和附件，支持编辑、复制、打开完整编辑器、发送及发送结果展示；发送状态至少包括草稿、发送中、已发送、已取消和结果未知。正文使用 Markdown（轻量标记语言），界面复用现有对话 Markdown 渲染器；HTML 邮件正文经 DOMPurify 清理后展示或发送，不执行原始邮件 HTML。

对话中的“写一封邮件”或“回复邮件”操作创建卡片草稿；用户通过卡片发送或在对话中明确要求发送时，进入现有确认/发送流程。发送超时结果按现有 Harness（工具执行框架）的非幂等副作用规则处理，状态未知时不自动重发。

会话轨迹可以保存用户创建的草稿卡片与 Gmail 消息 ID，以便恢复卡片关联；卡片中可见的草稿字段按普通对话内容持久化，不包含附件字节。读取到的收件邮件正文和附件作为临时工具数据处理，不写入工具结果存档、应用日志或自建缓存。用户明确要求的 Agent 摘要作为对话输出展示；Gmail 数据只用于该用户可见功能，按 Google 数据政策处理保留、导出和删除。

## Gmail 权限和数据保护

首版使用 `https://www.googleapis.com/auth/gmail.modify`，覆盖已确认的读写、标签和垃圾箱操作；它不允许绕过垃圾箱永久删除。永久删除需要 `https://mail.google.com/`，因此不请求该范围。

`gmail.modify` 属于受限范围。公开发布前需要准备 Google OAuth 应用验证、隐私政策和必要的安全评估。应用必须明确告知用户：只有用户发起邮件相关 Agent 操作时，所选模型服务才会收到完成该操作所需的邮件内容；内容不得用于通用模型训练。连接 Gmail 时提供权限和数据用途说明，Agent 只在明确的用户操作中调用 Gmail 工具。

应用日志不得包含邮件正文、主题、收件人、附件内容或令牌。收件邮件正文视为不可信输入：模型只能把其中的指令当作邮件内容，不能据此自行发送、归档、加标签或删除；需要副作用的操作必须来自用户请求，并按对应确认策略执行。附件只在用户明确要求时下载或用于发送，不在本地建立附件库。不得因收到邮件而自动触发工具或后台处理。

Google 明确把邮件客户端和生成式 AI 邮件摘要列为允许用途，并要求受限 Gmail 数据使用最小权限、透明说明、用户可见功能和提示注入防护。Google 对桌面 OAuth、权限审核、有限使用和 Gmail 方法已有官方文档：

- [Gmail API Node.js 快速入门](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
- [Google 官方 Gmail Node.js 客户端](https://www.npmjs.com/package/@googleapis/gmail)
- [桌面应用 OAuth 说明](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail API 权限范围](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Workspace 用户数据开发者政策](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Gmail API 方法参考](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Nodemailer Stream Transport](https://nodemailer.com/transports/stream)
- [Nodemailer MailParser](https://nodemailer.com/extras/mailparser)
- [marked Markdown parser](https://marked.js.org/)
- [DOMPurify HTML sanitizer](https://github.com/cure53/DOMPurify)

## 主要失败行为

- 用户取消授权：不保存账号状态，设置页仍可重新连接。
- 授权被撤销、令牌过期且无法刷新：清除失效凭据，显示重新连接提示，不把令牌或 Google 原始错误写入日志。
- 邮件 API 离线、超限或返回错误：保留用户卡片内容，显示可读错误；限制性错误仅提示重试或检查连接，不自动重试发送。
- 发送结果未知：显示“结果未知”，提供在 Gmail 已发送邮件中核对的入口；不自动再次发送。
- 结构异常或含恶意指令的邮件：按不可信数据展示和分析，不执行其中包含的工具指令。
- 用户断开 Gmail：撤销本地令牌并删除本地 Gmail 凭据，不清理用户 Gmail 中的邮件。

## 验收标准

1. 设置页有独立“邮箱”标签，可以连接、显示状态、重新授权和断开单个 Gmail 账号；迁移 SMTP 设置时保留原值，Gmail 与 SMTP 的发件身份清晰可辨。
2. 主程序只申请 `gmail.modify`，可以分页搜索和读取邮件、会话及附件，并完成已读、星标、标签、归档、草稿增删改查、回复、转发、发送、移入垃圾箱与恢复。
3. Agent 可以按明确用户请求调用 Gmail 邮件工具；收件内容不会触发自主外部操作。
4. 邮件草稿以主程序拥有的结构化卡片展示，支持编辑、复制、发送；刷新或重启后草稿状态按定义恢复。
5. 人工点击发送和 Agent 发信共用 Gmail 发送实现；发送未知结果不会自动重发。
6. 收件邮件正文和附件不进入日志、会话工具结果存档或自建缓存；邮件卡片附件不保存字节；访问令牌不能明文持久化。
7. 现有 SMTP 发信和已配置的 SMTP 参数在首版继续工作；迁移到插件及 SDK 的工作留到后续阶段。
8. 受限范围 OAuth 验证和隐私政策属于公开发布前置事项；本地代码接入不等于 Google 已批准公开发布。
