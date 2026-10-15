<p align="center">
  <img src="./docs/image/preview.png" alt="Cyrene Agent" width="800">
</p>

<h1 align="center">Cyrene-Agent</h1>

<p align="center">
  <a href="./README.en.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <strong>主仓库</strong>：<a href="https://github.com/Playa-Cyrene/Cyrene-Agent">GitHub</a> ・
  <strong>国内镜像</strong>：<a href="https://gitee.com/playa0/cyrene-agent">Gitee</a>
</p>


**Cyrene-Agent 是一个以《崩坏：星穹铁道》昔涟为核心角色的 Windows Live2D AI 桌面伴侣。**

> 基于 Electron + TypeScript 开发的桌面端 Live2D 智能对话 Agent。  
> 项目围绕昔涟（Cyrene）的角色设定，结合自研 CyreneHarness 引擎与 DMAE 记忆引擎，  
> 将角色化聊天、个性化记忆、语音交互、工具调用与多平台接入整合在同一个桌面 Agent 中，  
> 支持日常聊天（Chat）、辅助工作（Work）、代码协作（Code）、学习陪伴（Learn）四种对话模式。

---

## ✨ 速览

- 🌸 **趣味桌面陪伴** — Live2D 角色常驻桌面，支持表情、动作、状态、心情、气泡互动、智能表情包与多套界面主题
- 💬 **日常聊天（Chat）** — 专注角色化交流，结合会话历史、用户风格与长期记忆自然回应，不暴露任何工具
- 🛠️ **辅助工作（Work）** — 通用任务会话，支持联网搜索、右侧浏览器操作、文件处理、文档生成与生活服务等工具的串联调用
- 💻 **代码协作（Code）** — 绑定可信代码目录，提供 LSP 语义查询与受限的读写改命令执行，安全边界由权限审批统一把关
- 📚 **学习陪伴（Learn）** — 绑定 Obsidian Vault，陪伴用户理解材料、整理笔记、生成练习与维护进度
- 🧠 **个性化记忆** — 用户wiki/summary/embedding三种记忆模式，结合 DMAE Worldbook 与条目生命周期管理，沉淀长期互动
- 🔊 **语音交互** — 集成 TTS、ASR 与语音通话，让昔涟能够听见并回应用户
- 🧰 **丰富工具生态** — 覆盖联网搜索、文件处理、文档生成、生活服务、音乐与 MCP 扩展
- 🔌 **多模型厂商适配** — 针对不同厂商提供分级 Structured Output 与 Function Calling 兼容方案；当前型号、能力范围和核验状态见[模型适配清单](./docs/references/adapted-models.md)
- 🧩 **插件系统** — 本地插件包扩展 AI 工具、聊天渠道、自有窗口与语音输入，配套 npm SDK 与开发指南
- 📱 **多平台接入** — 支持桌面端、飞书、微信 iLink 与 QQ（NapCat / OneBot 11），共享角色能力与对话体验
- 🌙 **主动聊天** — 根据时间、状态与用户偏好主动发起交流，并支持多渠道定向投递

---

## ⚙️ CyreneHarness 核心引擎

> `Work / Code / Learn` 等需要工具调用的会话模式，全部跑在 **CyreneHarness** 之上。
> 源码：[`src/main/orchestrator/harness/cyrene-harness.ts`](./src/main/orchestrator/harness/cyrene-harness.ts)

CyreneHarness 是 Cyrene Agent 的核心 Agent Loop，负责把**模型决策、工具执行、副作用记账与状态恢复**串成一个可中断、可恢复、可回放的连续循环。

<details>
<summary><b>设计与实现细节</b>（点击展开）</summary>

> 会话轨迹由 **CTA（Canonical Transcript Architecture）** 承载：canonical journal 是唯一权威源，
> 模型上下文、UI 投影与渠道消息全部从 transcript 派生；压缩摘要以 checkpoint 形式持久化，
> 热日志归档到 `segments/`，支持跨进程崩溃恢复与编辑 / 重新生成回溯。
> 源码：`src/main/orchestrator/conversation-*.ts`（store / journal-service / compactor / projection 等）

**关键设计：**

- **连续的 while + Function Calling 循环** — 每轮调用 LLM，按其返回的 `toolCalls` 进入工具派发，无 `toolCalls` 时由模型主动结束当前 turn。
- **assistantMessage 必写回** — 每轮模型返回的 assistant 消息必须无条件 `push` 进 `messages`，否则下一轮模型会看不到自己上一步的回复，loop 立即崩。
- **Ask 互斥路径** — `ask_user` / `confirm_uncertain_effect` 是用户等待类内置工具，必须独占本轮：其余同轮工具全部以 `not_executed` 协议结果写回，并 `discardProgressBuffer()` 丢弃进度文本。
- **四态 outcome 与 uncertainEffects 拦截** — 工具结果分为 `success / failure / unknown / not_executed`。当 `unknown` 且 `sideEffect === non_idempotent` 时，副作用会被记入 `state.uncertainEffects`，并 `halted = true` 暂停本轮后续同类调用，防止自动重放危险副作用。
- **失败重试** — 工具失败时根据 `classifyToolResultError` + `resolveSideEffect` 决定是否重试；`sleepWithJitter` 退避可被 `AbortSignal` 中断。
- **保守并行调度** — 默认串行，仅"显式声明并发安全的纯读工具"可并行（默认上限 4）；结果始终按模型原始 tool-call 顺序提交；halt / error / cancel 时已执行结果不丢弃，出错槽位以合成失败结果闭合 transcript。
- **双时钟超时** — 执行计时与用户等待计时分离：`ask_user` 等待用户期间暂停执行计时，用户思考多久都不消耗任务超时预算。
- **双层压缩（Mid-loop + Journal Compaction）** — harness 每轮开始时根据 token 预算判断是否需要压缩上下文，超阈值时复用 LLM 做历史摘要，保留 todo 与已确定结果，压缩后 checkpoint 失败立即熔断；构建上下文超预算时再触发 journal 级压缩——摘要以 compaction checkpoint 持久化进 transcript，热日志归档至 `segments/`，二次压缩保留前次摘要，编辑 / 重新生成不能跨压缩边界回溯。
- **前缀缓存体系** — 稳定前缀分层（stablePrefix / sessionPrefix / mode），Todo 等易变状态禁止进入前缀；工具清单在 run 期间冻结；动态事实一次性物化进 transcript 而非每轮拼接；`cacheEpoch` 缓存周期跨压缩 / 恢复推进；Kimi `prompt_cache_key` 等厂商缓存 hints 在请求层统一注入。
- **工具输出双级截断** — 大输出落盘存储（`ToolOutputRef`），模型消息只保留 preview；需要完整内容时由模型调用内置 `read_tool_result` 按需回读，大幅降低上下文占用。
- **上下文容量快照** — 每轮请求前与终态各发一次 `context_usage` 快照事件，驱动 UI 上下文环实时显示。
- **截断可见化** — 输出命中模型长度上限（`finishReason = length`）时在回复尾部追加提示，不静默截断。
- **流式优先与降级** — 仅在零增量且供应商明确不支持 stream + tools 时降级非流式，绝不重放半截流；token 用量记账区分缓存命中。
- **全程 signal-aware** — 几乎每个 `await` 都用 `raceWithSignal` 包裹，`signal.aborted` 时返回 `cancelled()`（`finalAnswer = ''`，**不发 `final_answer` 事件**）。
- **每轮 checkpoint** — 通过 `onCheckpoint` 把 `messages` + `state` + `rounds` 持久化，跨进程崩溃后可恢复；恢复时崩溃孤儿工具按运行状态归为 `unknown`（而非误判 `not_executed`），避免重放外部副作用。

**4 种终止状态：**

| 状态 | `terminated` | `terminateReason` | 触发条件 |
| :---: | :---: | :---: | --- |
| ✅ success | `false` | `undefined` | 模型不再调用工具，主动结束当前 turn |
| ⚪ cancelled | `true` | `cancelled` | `AbortSignal` 触发（`finalAnswer = ''`） |
| 🟥 error | `true` | `error` | LLM 抛错或 checkpoint 失败 |
| 🟨 timeout | `true` | `timeout` | 超过 `config.totalTimeoutMs` |

**主流程示意：**

![CyreneHarness 主循环](./docs/image/harness.png)

*（示意图：① 初始化 → ② 主循环 → ③ LLM → ④ 工具调度 → ⑤ 状态账本 → ⑥ 终态结算）*

</details>

---

## 🚀 快速开始

### 前置条件

- **Windows 10 / 11 64 位**
- **Node.js 24 LTS**、**pnpm 10.33.0**（首次可运行 `npm install --global pnpm@10.33.0` 安装）
- **[Rust stable](https://www.rust-lang.org/tools/install)** + **[Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)**（源码构建截图功能必需；Build Tools 勾选「使用 C++ 的桌面开发」工作负载即可）

> 飞书、微信 iLink、`nut-js` 键鼠自动化及原生截图功能依赖 Windows 环境。
>
> 如果直接安装 Releases 中的打包版本，无需另外安装 Rust 和 Visual Studio Build Tools。

### 1. 克隆并安装依赖

```bash
git clone https://github.com/Playa-Cyrene/Cyrene-Agent.git
# 或 Gitee（国内镜像）：git clone https://gitee.com/playa0/cyrene-agent.git
cd Cyrene-Agent
pnpm install --frozen-lockfile
```

首次安装会下载 Electron、Pixi.js、Live2D 等相关依赖，具体耗时取决于网络环境。

### 2. 构建并启动

首次从源码运行时，需要先构建 Rust 原生截图助手：

```bash
pnpm run build:screenshot-helper
pnpm run build
pnpm start
```

> [!IMPORTANT]
>
> 原生截图助手不会以 `.exe` 形式提交到 Git 仓库，因此首次克隆后必须执行一次 `pnpm run build:screenshot-helper`。
>
> **Windows 用户**也可以直接双击项目根目录的 `setup.bat` 完成依赖安装、构建和全局命令链接，之后双击 `start.bat` 即可启动。运行前需安装 pnpm 10.33.0。

开发模式：

```bash
pnpm run build:screenshot-helper
pnpm run dev
```

构建 Windows 可分发版本（自动构建 Electron 应用和 Rust 截图助手）：

```bash
pnpm run package:win:dir
```

### 3. 安装 BGE-M3

Cyrene 无需本地大语言模型即可正常聊天，但建议安装 **BGE-M3 Embedding 模型**：

[前往 Releases 下载 BGE-M3](https://github.com/Playa-Cyrene/Cyrene-Agent/releases)

> [!IMPORTANT]
>
> 未安装 BGE-M3 不会影响基础聊天，依赖 Embedding 的增强功能会自动关闭或降级。

### 4. 命令行入口（可选）

项目附带 `cyrene` 命令行入口，执行 `pnpm run build:cli && pnpm link --global` 后即可在任意目录使用，提供 `version`、`run` 等子命令，详见 `cyrene --help`。

> `pnpm run build` 已包含 `build:cli`，但 `pnpm link --global` 仍需单独运行。正式安装版的 `cyrene desktop` 入口将在 1.x 提供。

---

## 🔑 配置 API Key

应用启动后，**点击系统托盘图标 → 打开设置**，完成以下基础配置：

1. **🔑 模型设置**：选择 LLM 厂商预设，填写 API Key、Base URL 与模型名称。  
   这是 Cyrene 正常聊天和运行 Agent 的必要配置。

2. **🎙️ TTS 设置**（可选）：选择 Mossland、MiniMax、MiMo、GPT-SoVITS 或自定义云端语音合成服务。

3. **🎧 ASR 设置**（可选）：如需使用语音通话，可配置阿里云实时 ASR 的 AppKey 与 AccessKey，或填写 Mossland 共用 API Key、MiniMax ASR API Key。

4. **📱 外部渠道**（可选）：根据需要连接飞书或微信 iLink，在手机端与 Cyrene 对话。

5. **🎵 音乐**（可选）：配置网易云音乐 OpenAPI 凭据后可启用音乐工具；播放器已内置，无需安装网易云客户端。

相关配置会保存在应用的 `<userData>/` 目录中，修改后通常无需重启应用。

---

## ✨ 功能

### 核心功能

#### 🌸 桌面陪伴

- **Live2D 桌面角色** — 基于 `pixi-live2d-display` 与 Cubism Core 渲染，支持桌面置顶、鼠标交互、自然待机与嘴型同步。
- **表情与动作联动** — 根据对话内容触发表情、动作、状态、心情与桌面气泡，让角色反馈不只停留在文字层面。
- **智能表情包** — 内置贴纸面板，并可通过语义匹配自动选择符合当前语境的表情包。
- **多窗口交互** — 桌宠、聊天、设置、任务、通话和贴纸管理等界面相互独立，又共享统一运行状态。
- **个性化外观** — 支持界面主题、聊天样式与字体选择。

#### 🎨 主题外观

Cyrene 提供亮 / 暗两套界面主题，覆盖聊天、设置等主要界面：

**🌙 暗色主题**

<table>
  <tr>
    <td><img src="./docs/image/dark1.png" alt="暗色主题界面 1" width="400"></td>
    <td><img src="./docs/image/dark2.png" alt="暗色主题界面 2" width="400"></td>
  </tr>
</table>

**☀️ 亮色主题**

<table>
  <tr>
    <td><img src="./docs/image/light1.png" alt="亮色主题界面 1" width="400"></td>
    <td><img src="./docs/image/light2.png" alt="亮色主题界面 2" width="400"></td>
  </tr>
</table>

#### 💬 日常聊天（Chat）

- **独立角色聊天流程** — Chat 模式专注于角色化交流，不暴露、不调用也不执行任何工具。
- **人格化回复** — 结合昔涟角色设定、近期会话、社交上下文、用户风格与个性化记忆生成回复。
- **多会话历史** — 不同会话独立保存，可自动生成标题、排序和重命名。
- **多端聊天风格** — 桌面聊天、手机渠道和语音通话可使用不同的表达风格。
- **回复分段** — 可选择「全部分段 / 仅 Chat 分段 / 关闭」，长回复能够按语义拆分为多个聊天气泡。

下面各会话模式是 Harness 的"消费者"：

#### 🛠️ 辅助工作（Work）

<img src="./docs/image/work.png" alt="Work 模式示意" width="800">

- **CyreneHarness 主循环驱动** — 单条消息进入 [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) 的 while 循环：每轮调用 LLM → 写回 assistant 消息 → 派发工具 → 写回 tool result → 检查不确定副作用 → 继续或结束。预处理器（CITA 上下文理解）在 Harness 入口前完成；循环内每轮携带精简执行人设（[`prompts/cyrene_harness.md`](./prompts/cyrene_harness.md)，只约束表达风格、不污染工具参数，冲突时按「任务正确性 > 信息清晰 > 昔涟风格」取舍）；完整人设层（Soul）在 Harness 出口后生成回复文本。
- **工具自由串联** — 支持联网搜索、网页读取、文件读写、文档生成、生活服务等工具按需组合调用；模型可自行决定下一个工具，无需预先编排流程。
- **人设与流程并存** — 在保留昔涟人格回复的同时承载工具调用。
- **右侧浏览器控制** — Cyrene 可以在应用内打开网址、读取页面元素，并按需点击、填写普通文本、滚动或截图检查。浏览器页面始终显示在右侧面板，操作结果可直接观察；控制权在同一对话的多轮消息间保持，任务完成后由 Cyrene 显式退出。页面内容只作为网页数据处理，密码、验证码与支付信息由用户亲自输入。

<img src="./docs/image/browser%20use.png" alt="Cyrene 在右侧浏览器中查看并操作网页" width="800">

#### 💻 代码协作（Code）

<img src="./docs/image/code.png" alt="Code 模式示意" width="800">

- **在 Work 基础上叠加代码专属工具** — 复用 [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) 主循环，额外注册代码专用工具集（读写改、命令执行、LSP 查询等）；工具执行前由权限审批（checkPermission）过滤不安全调用，Execution Policy 决定是否需要用户二次确认。
- **绑定可信工作目录** — 所有读写、命令执行与 LSP 查询必须落在用户预先绑定的目录内；模型无法指定或切换工作目录，越权访问（包括 `..` 与符号链接逃逸）会被直接拒绝。
- **代码语义查询（LSP）** — Code 模式可在已绑定工作目录中查询定义、引用、悬停、符号与诊断；不会修改文件。
- **外部服务由用户管理** — Cyrene 只提供 LSP 客户端，不随应用捆绑、下载、升级或静默安装语言服务器；请自行安装所需服务，也可以明确要求昔涟通过现有、受权限控制的工具协助安装。
- **安全边界** — 语言服务进程以 `stdio: "pipe"` 启动，`shell: false`，`cwd` 强制为绑定工作目录；模型不能指定命令、服务 ID 或工作目录。

<details>
<summary><b>LSP 支持的语言与自定义配置</b>（点击展开）</summary>

**内置支持的语言** — TypeScript / JavaScript / JSON、Python、Go、Rust、C / C++、Java、C#、PHP、Ruby、Kotlin、Lua、Vue、YAML（13 种，详见 `src/main/lsp/server-catalog.ts`）。

**启动顺序** — 先按命令是否为绝对路径定位，否则在工作区 `node_modules/.bin` 中查找，最后回退到系统 PATH 逐目录遍历（Windows 还会按 `PATHEXT` 追加 `.exe` / `.cmd` 等扩展名）。

**安装与排障** — 常见服务如 `typescript-language-server`、`pyright-langserver`、`gopls`、`rust-analyzer`、`clangd`、`jdtls`、`OmniSharp`、`intelephense`、`ruby-lsp`、`kotlin-language-server`、`lua-language-server`、`vue-language-server`、`yaml-language-server`；Windows 可用 `where pyright-langserver`，macOS/Linux 可用 `which pyright-langserver` 检查是否可发现。

**自定义服务命令** — 在应用数据目录的 `general-settings.json` 中配置 `lspServerOverrides`，只覆盖 builtin 服务的 `command` / `args` / `extensions` / `initializationOptions`，不接受模型在对话中传入的启动命令。例如：

```json
{
  "lspServerOverrides": [
    {
      "id": "python-pyright",
      "command": "basedpyright-langserver",
      "args": ["--stdio"]
    }
  ]
}
```

**进程复用与释放** — 同一 serverId 的 LSP 进程在同一工作区内复用，避免反复冷启动；应用退出时统一释放。

</details>

#### 📚 学习陪伴（Learn）

<img src="./docs/image/learn.png" alt="Learn 模式示意" width="800">

- **Obsidian Vault 工作区** — 绑定一个 Vault 作为学习工作区，约定 `materials/`、`notes/`、`exercises/`、`templates/` 与 `learn/progress.md` 目录结构，详见 [Learn 模式指南](docs/user-guide/learn-mode.md)。
- **基于 RAG 与个性化记忆** — 学习材料通过 [RAG 文档知识库](#-rag-文档知识库) 索引后参与检索，学习进度与偏好进入 L2 长期记忆，跨会话保持连续。
- **陪伴式理解** — 通过提问、拆解、类比和讨论帮助用户理解材料，而非代替用户完成学习任务。
- **笔记与练习** — 在 Vault 内共同整理概念、生成练习与记录复盘，并自动维护学习进度总览。
- **尊重学习节奏** — 用户没懂时换种方式解释，用户已懂时推进到下一步，不因答错而责备。

#### 📝 富文本与代码渲染

- **Markdown 渲染** — 支持标题、列表、引用、表格、链接、代码块等常见 Markdown 内容。
- **代码高亮** — 支持多种常用编程语言的代码块语法高亮和代码复制。
- **数学公式** — 支持行内公式与块级公式渲染。
- **流式兼容** — 生成过程中保持稳定输出，消息完成后再渲染为完整富文本内容。

#### 🎵 音乐陪伴

<img src="./docs/image/music.png" alt="Cyrene Music 播放界面" width="800">

- **Cyrene Music 独立窗口** — 桌面端内置「Cyrene Music」播放器，支持歌单标签切换、本地缓存与播放列表管理，沉浸感更强。
- **网易云音乐数据源** — 通过自研 `NeteaseOpenapiProvider` 调用网易云 OpenAPI，提供搜索歌曲 / 艺人 / 专辑、每日推荐、我的歌单与收藏等能力。
- **mpv 内置播放** — 由 `MpvController` 控制打包内置的 mpv 进程，实现加载、播放、暂停、跳转、音量、停止等控制，无需唤起外部客户端。
- **多工具串联** — 在 `Work / Learn` 模式中可与其他工具（联网搜索、文件、文档等）组合完成「搜歌 → 加入歌单 → 播放」等连续任务。
- **懒启动 + 可降级** — 音乐后端在首次真实音乐操作时才建立网络会话，空闲时不会占用资源；mpv 缺失时不影响聊天与其他核心功能。

#### 🧠 个性化记忆

- **L0 / L1 / L2 分层记忆** — 分别管理核心用户画像、近期状态和长期经历。
- **记忆证据链** — 记忆内容保留来源与上下文，减少无依据的画像推断。
- **冲突检测与解决** — 对旧记忆与新信息进行召回、评分和语义判断，区分语境变化、偏好演变与直接冲突。
- **自研 DMAE Worldbook** — 通过触发词、优先级、内在价值、连带触发与 Active / Dormant / Archived 状态管理角色知识和长期互动内容。
- **关系与风格沉淀** — 根据长期交互逐步形成用户偏好、交流习惯与关系上下文。

#### 🔊 语音交互

- **多 TTS 引擎** — 支持 Mossland、MiniMax、MiMo、GPT-SoVITS 与自定义云端语音服务。
- **ASR** — 支持阿里云实时语音识别，以及 Mossland、MiniMax 在每轮说话结束后的完整音频转写。
- **完整语音通话** — 通过 `LISTENING → THINKING → SPEAKING` 状态流完成连续语音交流。
- **VAD 静默检测** — 自动判断用户是否结束说话并触发回复。

#### 🧰 工具生态

Cyrene 内置和扩展的工具较多，主要覆盖以下类别：

- **文档与办公** — 生成 Word、Excel、PDF 和 Markdown 文档。
- **联网能力** — 网页搜索、网页读取、内容提取和信息整理。
- **文件处理** — 读取、写入、浏览本地文件及识别图片内容。
- **生活服务** — 天气、地图、翻译、汇率、记账和行程规划等。
- **音乐能力** — 搜索歌曲、获取推荐并调用本地音乐客户端播放。
- **任务协作** — 任务清单、用户选择卡片、任务委派与子任务处理。
- **MCP 扩展** — 通过 Model Context Protocol 接入额外的外部工具与服务。

<details>
<summary><b>🧩 高级功能</b>（点击展开）</summary>

#### 📚 RAG 文档知识库

- 支持 `txt`、`md`、`pdf`、`docx`、`xlsx`、`pptx`、`csv`、`json` 等格式导入。
- 支持向量检索、BM25 与 Reranker 组成的混合检索流程。
- 支持本地 Embedding 与 OpenAI-compatible 云端 Embedding。
- 检索结果保留来源信息，方便追溯原始文档。
- 支持实体关系信息与自定义分词词典。

#### 🔌 MCP（Model Context Protocol）

- 支持 `stdio`、SSE 与 HTTP Transport。
- 支持在设置页面管理和启停 MCP Server。
- MCP 工具会统一接入 Cyrene 的工具注册、权限审批与 Execution Policy。
- 第三方 MCP Server 的实际稳定性取决于其自身实现。

#### 📱 外部渠道

- **飞书 Lark** — 通过官方 SDK 和 WebSocket 长连接接入，无需公网服务器或内网穿透，详见 [飞书接入指南](docs/user-guide/feishu.md)。
- **微信 iLink** — 支持长轮询消息接收、文本发送和部分媒体处理。
- **QQ / NapCat** — 通过 OneBot 11 反向 WebSocket 接入，支持白名单私聊、群内 @、引用及多媒体消息；详见 [NapCat 接入指南](docs/user-guide/napcat-onebot.md)。
- **多渠道统一人格** — 桌面端、飞书、微信与 QQ 共享角色设定和记忆能力。
- **渠道独立风格** — 可针对手机聊天与桌面聊天使用不同表达方式。

#### ✨ Skill 系统

- 支持内置 Skill 与用户自定义 Skill。
- 用户目录中的同名 Skill 可以整体覆盖内置版本。
- 支持 `invoke_skill`、参考资料读取与 Slash Command。
- 包含路径防护、重复读取限制与大文本截断机制。

#### 🧩 插件系统

- **本地插件包** — 一个文件夹（`manifest.json` + JS 入口文件）就是一个插件，在设置页统一管理启停；支持 ZIP 导入，安装走 staging 隔离校验 + 原子替换 + 失败自动回滚，内置路径穿越与压缩炸弹防护。
- **开放能力** — 插件可以注册 AI 工具、弹出自有窗口、调用宿主 LLM、接入新聊天渠道、监听生命周期事件、注入每轮动态上下文，并可申请私有存储、安全密钥、只读会话分页、自有定时任务与语音输入租约等宿主服务。
- **信任边界** — 用户插件首次发现一律停用，需在设置页手动启用；插件创建的定时任务必须用户核对配置后才生效；语音输入通过独占租约避免双输入源冲突。
- **开发者工具链** — npm 包 [`@playa0v0/cyrene-plugin-sdk`](https://www.npmjs.com/package/@playa0v0/cyrene-plugin-sdk) 提供全部公开类型、Manifest 校验与 Mock Context 测试工具，运行时仅依赖 `ajv`；配套《[插件开发指南](docs/plugins/plugin-dev-guide.md)》与 `cyrene-plugin-dev` Skill，无需阅读宿主源码即可完成开发。
- **官方示例** — 仓库 [`examples/`](./examples) 提供天气查询、长期记忆、定时自动化、系统状态与本地 ASR 契约五个示例，均可直接作为开发起点。
- **插件收录仓库** — [Cyrene-Plugins](https://github.com/Playa-0v0/Cyrene-Plugins)（[Gitee 镜像](https://gitee.com/playa0/cyrene-plugins)）收录经安全审核的社区插件，用户可直接下载 ZIP 导入；想让你的插件被更多人看到，欢迎提 PR 收录。

#### 🌙 主动聊天

- **状态感知** — 根据时间、用户活跃状态、会话状态和角色心情判断是否适合主动交流。
- **不打扰策略** — 深夜、用户正在聊天或连续未回应时降低或停止主动消息。
- **多渠道投递** — 可选择桌面、微信或飞书作为主动消息目标。
- **渠道失败保护** — 指定手机渠道不可用时取消发送，不会擅自改投桌面端。

</details>

---

<details>
<summary><b>🔧 开发功能</b>（点击展开）</summary>

#### 🧪 单元测试

- Vitest 5 覆盖 asr / tts / channels / chats / memory / orchestrator / plugins / rag / skills 等核心模块。
- `pnpm test` 一次性 / `pnpm run test:watch` 监听模式。
- 插件开发：`pnpm run check:plugin-sdk` 校验 SDK 打包，`pnpm run test:plugin-examples` 端到端验证官方示例。

#### 🎬 场景模拟

- `pnpm run sim` 默认场景，`sim:coffee` / `sim:mix` / `sim:rescue` 单场景调试，产物输出到 `sim-result/`。
- `pnpm run sim:sweep --rewardGain=3,5,7,10` 跑 Worldbook 评分参数 sweep。

</details>

---

## 🧱 技术栈

| 层级 | 技术 |
|---|---|
| 运行环境 | Node.js 24 LTS + Electron 44 |
| 开发语言 | TypeScript 6.0 |
| 构建工具 | Vite 8 |
| 界面渲染 | HTML / CSS + React 19 + Tailwind CSS 4 + Pixi.js 7 + Ant Design X / Mantine + Chart.js |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| Agent 核心 | [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) 主循环 + CTA 会话轨迹 + Structured Output / Native Function Calling |
| Agent 事件协议 | AG-UI（`@ag-ui/core`、`@ag-ui/client`）— 通过 `RUN_STARTED / STEP_* / TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED` 等事件与渲染进程解耦 |
| 工具与沙箱 | 自研工具调度 + 副作用记账 + 重试策略 + 权限审批；Windows 命令沙箱 `@anthropic-ai/sandbox-runtime` |
| 代码协作 | 自研 `LspManager` + `vscode-jsonrpc`（LSP 客户端）、`@ast-grep/napi`（结构化代码搜索）、`simple-git`（git 集成） |
| 工具扩展 | `@modelcontextprotocol/sdk`（stdio / SSE / HTTP Transport） |
| 插件系统 | [`@playa0v0/cyrene-plugin-sdk`](https://www.npmjs.com/package/@playa0v0/cyrene-plugin-sdk)（公开类型 + Manifest Schema 校验 + Mock Context 测试工具） |
| 记忆与检索 | Embedding（`@xenova/transformers`）+ BM25 + 自研 Cross-Encoder Reranker + DMAE V5.1（关键词命中召回 + 激活度衰减 + 三态可逆）+ `@node-rs/jieba` |
| 浏览器与桌面自动化 | Playwright + `@nut-tree-fork/nut-js` |
| 富文本渲染 | Streamdown + Shiki + KaTeX（Markdown / 代码高亮 / 公式） |
| 语音与媒体 | 多引擎 TTS / ASR + `silk-wasm` |
| 原生截图助手 | Rust + DXGI Desktop Duplication / Direct2D + WIC PNG + NDJSON IPC |
| 文档与邮件 | ExcelJS、docx、PDFKit、Nodemailer |
| 测试 | Vitest 5 |

---

## 📦 项目结构

```
models/                # 本机 AI 模型（用户放置，见 MODEL_LICENSE.md）
└── Xenova/bge-m3/     # Embedding 模型（贴纸语义 + 场景识别，~570MB）

src/
├── cli/               # 命令行入口（cyrene 命令）
├── main/              # Electron 主进程
│   ├── orchestrator/  # Agent 核心：CyreneHarness 主循环 + CTA 会话轨迹 + 工具调度 + 权限审批
│   │   ├── harness/   # CyreneHarness（while 循环 + compaction + retry + uncertainty）
│   │   ├── tools/     # 工具注册表与内置工具（含 Code 模式工具、ast-grep 搜索）
│   │   ├── vendors/   # 多模型厂商适配（分级 Structured Output + Function Calling）
│   │   ├── sandbox/   # Windows 命令执行沙箱
│   │   ├── review/    # 计划审批（plan review）
│   │   └── structured-output/  # 统一 Structured Output 管线
│   ├── channels/      # 外部渠道适配（飞书 / 微信 iLink / QQ OneBot 11）
│   ├── memory/        # L0/L1/L2 记忆引擎 + DMAE Worldbook + 实体关系图
│   ├── rag/           # 检索增强生成 + Worldbook 注入
│   ├── lsp/           # LSP 客户端（manager / client / server-catalog）
│   ├── code-git/      # Code 模式 git 服务（status / commit / branch / push）
│   ├── learn/         # Learn 模式（Obsidian Vault 绑定 + 进度总览）
│   ├── tasks/         # 任务面板（任务执行 / 委派 / 子 Agent 运行时）
│   ├── music/         # 音乐陪伴（播放 / 推荐 / 会话）
│   ├── moments/       # 动态 / 社交信息流
│   ├── news/          # 消息公告
│   ├── permission/    # 权限审批（checkPermission / risk 等级）
│   ├── plugin-host/   # 插件宿主服务
│   ├── proactive/     # 主动对话（模型 / 策略 / 路由）
│   ├── skills/        # Skill 系统（内置 + 用户自定义）
│   ├── asr/ tts/ call/ # 语音识别 / 合成 / 通话
│   ├── cita/          # CITA 上下文理解与建议引擎
│   ├── relationship/ social-context/  # 用户关系画像 / 社交上下文
│   ├── scheduler/     # 定时任务（提醒 / 日程）
│   ├── updater/       # 应用自动更新
│   └── ...            # prompts / protocols / services / settings / startup / windows 等
├── plugins/           # 插件系统核心（manifest 校验 / 加载器 / 生命周期）
├── preload/           # Electron preload 桥接
├── renderer/          # Vite 渲染层（React 19 组件库 + Live2D 渲染 + 各窗口入口）
└── shared/            # 主进程与渲染进程共享代码

examples/              # 插件开发示例（weather-tool / long-term-memory / system-status / ...）
packages/plugin-sdk/   # @playa0v0/cyrene-plugin-sdk 源码
```

> 静态资源源文件见 `src/renderer/public/`（音频 / 头像 / Cubism Core / 贴纸等），
> Live2D 模型见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)。

---

## ⚠️ 免责声明

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、
背书或赞助关系**。

《崩坏：星穹铁道》、"昔涟"角色及其相关美术，世界观、商标等知识产权
归 **HoYoverse / 米哈游**所有。

**关于授权范围的说明**：

- **源代码**采用 [MIT License](./LICENSE)，仅约束本仓库的源代码。
- **角色 IP、Live2D 模型、美术资产** 不属于 MIT 授权范围，分别遵循
  [MODEL_LICENSE.md](./MODEL_LICENSE.md) 与米哈游同人创作规范处理。
- 因底层角色 IP 涉及米哈游同人创作规范，**本项目内包含昔涟 IP、Live2D 模型和美术资产的衍生物禁止商业使用。**（售卖、付费社群、含广告变现、打包销售等）。

---

## 📄 许可证

本仓库的**源代码**遵循 [MIT License](./LICENSE)，Copyright (c) 2026 Playa。
MIT 仅约束本仓库的源代码，不适用于角色、Live2D 模型与美术资产。

角色 IP（《崩坏：星穹铁道》"昔涟" 等）、Live2D 模型（`models/cyrene/`）、
美术资产遵循各自对应的授权：

- **Live2D 模型** — 详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)，
  模型作者 [@是依七哒](https://space.bilibili.com/457683484) 授权使用、
  修改，再分发。
- **角色 IP / 美术** — 归 **HoYoverse / 米哈游**所有。

---

## 🙏 致谢

- **昔涟角色**：© HoYoverse / 米哈游
- **Live2D 模型**：由 [@是依七哒](https://space.bilibili.com/457683484) 制作 —
  详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**：© Live2D Cubism
- **贡献者名单**：详见 [docs/CONTRIBUTORS.md](./docs/CONTRIBUTORS.md)

<!-- 贡献者头像列表由 .github/workflows/contributors.yml 自动维护，请勿手动修改这对标记之间的内容 -->
<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/Playa-0v0">
                    <img src="https://avatars.githubusercontent.com/u/300061045?v=4" width="48;" alt="Playa-0v0"/>
                    <br />
                    <sub><b>Playa</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/lll69">
                    <img src="https://avatars.githubusercontent.com/u/60803753?v=4" width="48;" alt="lll69"/>
                    <br />
                    <sub><b>lll69</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/LZhWi">
                    <img src="https://avatars.githubusercontent.com/u/306725149?v=4" width="48;" alt="LZhWi"/>
                    <br />
                    <sub><b>LZhWi</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Unknownuserfrommars">
                    <img src="https://avatars.githubusercontent.com/u/163658509?v=4" width="48;" alt="Unknownuserfrommars"/>
                    <br />
                    <sub><b>Tianzzi</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/yuxingyuzhong">
                    <img src="https://avatars.githubusercontent.com/u/240125557?v=4" width="48;" alt="yuxingyuzhong"/>
                    <br />
                    <sub><b>雨行雨中</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/lucifergzsz414">
                    <img src="https://avatars.githubusercontent.com/u/286201321?v=4" width="48;" alt="lucifergzsz414"/>
                    <br />
                    <sub><b>lucifergzsz414</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/liyi3068238601-oss">
                    <img src="https://avatars.githubusercontent.com/u/289515629?v=4" width="48;" alt="liyi3068238601-oss"/>
                    <br />
                    <sub><b>梨衣、</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/modusensus">
                    <img src="https://avatars.githubusercontent.com/u/286686549?v=4" width="48;" alt="modusensus"/>
                    <br />
                    <sub><b>Modusensus</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/boring9720">
                    <img src="https://avatars.githubusercontent.com/u/20534568?v=4" width="48;" alt="boring9720"/>
                    <br />
                    <sub><b>chuxuan</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Tobi1chi">
                    <img src="https://avatars.githubusercontent.com/u/49900770?v=4" width="48;" alt="Tobi1chi"/>
                    <br />
                    <sub><b>Tobi1chi</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/proobker">
                    <img src="https://avatars.githubusercontent.com/u/89506631?v=4" width="48;" alt="proobker"/>
                    <br />
                    <sub><b>proobker</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/ahwhshen">
                    <img src="https://avatars.githubusercontent.com/u/317654555?v=4" width="48;" alt="ahwhshen"/>
                    <br />
                    <sub><b>ahwhshen</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

特别感谢模型原作者慷慨授权本项目使用、修改并再分发其作品。

---

## 💌 联系

欢迎通过 GitHub Issues / PR 交流。请保持讨论的礼貌与主题相关性。

---

## 💰 随缘支持

本项目由个人独立开发，所有功能免费开放。

如果 Cyrene 陪伴你的日子还不错，可以扫码请作者喝杯咖啡 ☕ —— 完全随缘，不支持也完全不影响使用。

你的支持会帮助我承担项目开发和维护中的一些开销（模型 API、测试、社群维护等），让 Cyrene 能够持续迭代。

不方便扫码也没关系 —— 随手点一个 Star ⭐，或者把 Cyrene 分享给同样喜欢音游的朋友，就已经是很好的支持了。

<table>
  <tr>
    <td align="center"><img src="./docs/image/微信.png" alt="微信收款码" width="400"></td>
    <td align="center"><img src="./docs/image/支付宝.png" alt="支付宝收款码" width="400"></td>
  </tr>
</table>

---

⭐ 如果你喜欢这个项目，欢迎点一个 Star。这会帮助更多喜欢昔涟的人发现它。
