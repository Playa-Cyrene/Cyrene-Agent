<div align="center">

<img src="./docs/image/preview.png" alt="Cyrene Agent" width="800">

# Cyrene-Agent

**English** | [中文](./README.md)

**Primary repo**: [GitHub](https://github.com/Playa-0v0/Cyrene-Agent) ・ **Mirror for China**: [Gitee](https://gitee.com/playa0/cyrene-agent)

</div>



**Cyrene-Agent is a Windows Live2D AI desktop companion centered around Cyrene from _Honkai: Star Rail_.**

> A desktop Live2D conversational Agent built with Electron and TypeScript.  
> Centered around Cyrene's character design and powered by the self-developed Cyrene_Harness&DMAE memory engine,  
> it brings character-driven conversation, personalized memory, voice interaction, tool use, and multi-platform access into a single desktop Agent,  
> supporting four conversation modes: Chat, Work, Code, and Learn.

---

## ✨ At a Glance

- 🌸 **Playful Desktop Companion** — A persistent Live2D character with expressions, actions, status, mood, speech bubbles, and intelligent stickers
- 💬 **Casual Conversation (Chat)** — Focused on character-driven interaction, with responses shaped by conversation history, user style, and long-term memory
- 🛠️ **Assisted Work (Work)** — General-purpose task session that chains together web search, file processing, document generation, and lifestyle tools through the [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) main loop
- 💻 **Code Collaboration (Code)** — Binds a trusted code directory, provides LSP semantic queries (definitions / references / hover / symbols / diagnostics) plus restricted read/write/exec commands; safety is enforced by Harness's permission approval (Permission Policy) and Execution Policy
- 📚 **Learning Companion (Learn)** — Binds an Obsidian Vault, accompanies users in understanding materials, organizing notes, generating exercises, and tracking progress
- 🧠 **Personalized Memory** — L0 / L1 / L2 layered memory combined with the self-developed DMAE Worldbook for long-term interaction continuity
- 🔊 **Voice Interaction** — Integrated TTS, ASR, and voice calls so Cyrene can listen and respond
- 🧰 **Rich Tool Ecosystem** — Web search, file processing, document generation, everyday services, music, and MCP extensions
- 🔌 **Multi-Provider Model Support** — Tiered Structured Output and Function Calling compatibility profiles for different model providers
- 🎨 **Customizable Appearance** — Multiple interface styles, themes, and chat font options
- 📱 **Multi-Platform Access** — Desktop, Feishu/Lark, WeChat iLink, and QQ through NapCat/OneBot 11
- 🌙 **Proactive Chat** — Starts conversations according to time, status, and user preferences, with targeted multi-channel delivery

---

## ⚙️ CyreneHarness Core Engine

> `Work / Code / Learn` and any session mode that requires tool invocation runs on top of **CyreneHarness**.  
> Source: [`src/main/orchestrator/harness/cyrene-harness.ts`](./src/main/orchestrator/harness/cyrene-harness.ts)

CyreneHarness is the core Agent Loop of Cyrene Agent. It chains **model decisions, tool execution, side-effect accounting, and state recovery** into a continuous loop that is interruptible, recoverable, and replayable.

**Key design points:**

- **Continuous while + Function Calling loop** — Each round calls the LLM, dispatches the returned `toolCalls`, and lets the model end the turn when it returns no tool calls.
- **assistantMessage must be written back** — Every assistant message is pushed into `messages` unconditionally after each LLM response. Skipping this step breaks the loop on the next round.
- **Exclusive Ask path** — `ask_user` / `confirm_uncertain_effect` are user-waiting built-in tools that monopolize the round: other co-round tools return `not_executed`, and the progress buffer is discarded before continuing.
- **Four-state outcome with uncertainEffect interception** — Tool results fall into `success / failure / unknown / not_executed`. When `unknown` is paired with `sideEffect === non_idempotent`, the side effect is recorded into `state.uncertainEffects` and `halted = true` blocks further automatic replays of the same dangerous call within the round.
- **Failure retry** — Failed tools decide whether to retry based on `classifyToolResultError` + `resolveSideEffect`; the `sleepWithJitter` backoff is interruptible via `AbortSignal`.
- **Conservative parallel scheduling** — Serial by default; only explicitly concurrency-safe read-only tools run in parallel (default limit 4). Results are always committed in the original tool-call order; on halt / error / cancel, already-executed results are never dropped, and failed slots are closed with synthetic failure results so the transcript stays consistent.
- **Dual-clock timeout** — Execution time and user-wait time are tracked separately: while `ask_user` is waiting for the user, the execution clock is paused, so user thinking time never consumes the task timeout budget.
- **Mid-loop Compaction** — Each round checks the token budget and triggers an LLM-driven summary when over the threshold, preserving todos and confirmed results; if the post-compaction checkpoint fails, the run aborts immediately without issuing another model request.
- **Prefix-cache discipline** — Stable prefix layering (stablePrefix / sessionPrefix / mode); volatile state such as Todos is kept out of the prefix; the tool list is frozen for the whole run; dynamic facts are materialized into the transcript once instead of being re-appended every round; `cacheEpoch` advances across compaction / recovery; vendor cache hints such as Kimi's `prompt_cache_key` are injected uniformly at the request layer.
- **Two-tier tool output truncation** — Large outputs are persisted to disk (`ToolOutputRef`) while model messages only keep a preview; the model can call the built-in `read_tool_result` tool to read the full output on demand, drastically reducing context usage.
- **Context-usage snapshots** — A `context_usage` snapshot event is emitted before each model request and at terminal settlement, powering the live context-ring UI.
- **Truncation made visible** — When the output hits the model's length limit (`finishReason = length`), a notice is appended to the reply instead of failing silently.
- **Stream-first with fallback** — Falls back to non-streaming only when zero deltas were received and the vendor explicitly rejects stream + tools; a half-replayed stream never happens; token accounting distinguishes cache hits.
- **Signal-aware throughout** — Almost every `await` is wrapped with `raceWithSignal`; `signal.aborted` returns `cancelled()` (with `finalAnswer = ''` and **no `final_answer` event emitted**).
- **Per-round checkpoint** — `onCheckpoint` persists `messages + state + rounds` so execution can resume after a cross-process crash.

**Four terminal states:**

| Status | `terminated` | `terminateReason` | Trigger |
| :---: | :---: | :---: | --- |
| ✅ success | `false` | `undefined` | Model ends the turn without invoking any tool |
| ⚪ cancelled | `true` | `cancelled` | `AbortSignal` fires (`finalAnswer = ''`) |
| 🟥 error | `true` | `error` | LLM throws or checkpoint fails |
| 🟨 timeout | `true` | `timeout` | `config.totalTimeoutMs` exceeded |

**Main flow:**

![CyreneHarness main loop](./docs/image/harness.png)

*(① Init → ② Main loop → ③ LLM → ④ Tool dispatch → ⑤ State ledger → ⑥ Terminal settlement)*

---

## 🚀 Quick Start

### Prerequisites

- **Windows 10 / 11 64-bit**
- **Node.js 24 LTS**
- **npm 10+** (npm 11 recommended)
- **[Rust stable](https://www.rust-lang.org/tools/install)** (required for building the screenshot helper from source)
- **[Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)**

When installing Visual Studio Build Tools, select:

- **Desktop development with C++**
- **MSVC v143**
- **Windows 10 / 11 SDK**

After installing Rust, it is recommended to confirm the MSVC toolchain:

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

> Feishu, WeChat iLink, `nut-js` keyboard/mouse automation, and the native screenshot feature depend on the Windows environment.
>
> If you install a packaged release directly, you do not need to install Rust or Visual Studio Build Tools.

### macOS (experimental)

Cyrene is developed for Windows. The Electron/TypeScript core (Live2D UI, chat, memory) builds and runs unmodified on macOS, but full feature parity — including agent shell execution — is not there yet. After `npm install`, use:

```bash
npm run dev            # run in dev mode
npm run package:mac:dir # build an unsigned Cyrene.app under release/mac-arm64 (or mac/ on Intel)
```

Known gaps versus Windows:

- **Agent shell execution (`run_shell`)** — unsupported on macOS: the default shell resolves to `cmd.exe`, and the `bash` option only searches for `bash.exe` (Git Bash on Windows), never macOS's `/bin/bash`. Agent tasks that need shell commands will fail with `BASH_UNAVAILABLE`. POSIX shell resolution isn't implemented yet.
- **Screenshot tool** — `native/cyrene-screenshot` is a Rust helper built entirely on DXGI/GDI/Direct2D/Win32 clipboard APIs; it is not spawned on macOS and the feature is disabled (fails gracefully).
- **Music playback (mpv)** — the current `MpvController` playback backend looks for a system-installed `mpv` on macOS/Linux (e.g. via Homebrew: `brew install mpv`); `npm run prepare:mpv` only bundles a Windows `mpv.exe`, so nothing is pre-packaged for macOS. Without a system `mpv`, the music tool returns `client_unavailable`.
- **Feishu / WeChat iLink / global hotkeys (`nut-js`)** — untested on macOS.

The build is unsigned (no Apple Developer ID), so Gatekeeper will warn on first launch; right-click → Open to bypass.

### 1. Clone the Project

```bash
# GitHub (primary repo)
git clone https://github.com/Playa-0v0/Cyrene-Agent.git

# Or via the Gitee mirror (China)
git clone https://gitee.com/playa0/cyrene-agent.git

cd Cyrene-Agent
```

### 2. Install Dependencies

```bash
npm install
```

The first installation downloads Electron, Pixi.js, Live2D, and related dependencies. The time required depends on your network connection.

### 3. Command-line Entry

The project ships a `cyrene` command-line entry point for the first-time greeting, version checks, and launching the desktop app. From the project root:

```bash
npm run build:cli
npm link
```

You can then use `cyrene` from any directory:

```bash
cyrene            # First run shows the welcome banner; later runs stay quiet
cyrene hello      # Show the full welcome banner again
cyrene about      # Banner plus project metadata
cyrene version    # Print the version
cyrene --help     # List all subcommands
cyrene run        # Launch the desktop app from a project root (dev mode)
```

> The first-time greeting appears only once; the state is recorded in `~/.cyrene/state.json`. Subsequent default invocations print only `Cyrene Agent <version>` and `Ready.`. `cyrene run` is dev-only in v0.9 and requires a `package.json` in the current directory; the production `cyrene desktop` entry will arrive in 1.x.
>
> `npm run build` already includes `npm run build:cli`, so you do not need to run `build:cli` separately after building the project. However, `npm link` is still required to use the `cyrene` command from any directory.

### 4. Install BGE-M3 (Recommended)

Cyrene can chat normally without running a local large language model. However, installing the **BGE-M3 Embedding model** is recommended for the complete semantic-enhancement experience:

- Semantic sticker matching
- Scene tone enhancement
- Worldbook semantic retrieval
- RAG retrieval

[Download BGE-M3 from Releases](https://github.com/Playa-0v0/Cyrene-Agent/releases)

> [!IMPORTANT]
>
> Not installing BGE-M3 does not affect basic chat. Features that depend on Embedding will be disabled or degraded automatically.

### 5. Music Feature (Optional)

The music tool is integrated via [Code-MonkeyZhang/cloud-music-mcp](https://github.com/Code-MonkeyZhang/cloud-music-mcp). To use the NetEase Cloud Music feature, install the following additional dependencies:

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — A Python package manager that will automatically download Python and install all dependencies when the music tool is first used
- **[NetEase Cloud Music Desktop Client](https://music.163.com/)** — Required for music playback; the `orpheus://` protocol must be registered

> [!NOTE]
>
> The music feature is optional and does not affect chat or other core features. If `uv` is not installed, the music tool will be skipped automatically with a UI prompt.

### 6. Build and Start

When running from source for the first time, you need to build the Rust native screenshot helper:

```bash
npm run build:screenshot-helper
npm run build
npm start
```

> [!IMPORTANT]
>
> The native screenshot helper is not committed to the Git repository as an `.exe` file. You must run `npm run build:screenshot-helper` once after cloning.
>
> **Windows users** can also double-click `setup.bat` in the project root to install dependencies, build, and run `npm link`, then double-click `start.bat` to launch.

Development mode:

```bash
npm run build:screenshot-helper
npm run dev
```

After modifying the Rust screenshot helper code, re-run:

```bash
npm run build:screenshot-helper
```

Development mode starts the Electron main process, Preload compilation, the Vite renderer, and the Electron application together.

Changes to the main process automatically restart Electron, while renderer changes are applied through Vite HMR.

Building a distributable Windows version:

```bash
npm run package:win:dir
```

The packaging command automatically builds both the Electron application and the Rust screenshot helper.

---

## 🔑 Configure API Keys

After starting the application, **click the system tray icon → Open Settings**, then complete the basic configuration:

1. **🔑 Model Settings**: Select an LLM provider preset and enter the API Key, Base URL, and model name.  
   This configuration is required for Cyrene to chat and run the Agent.

2. **🎙️ TTS Settings** (optional): Select Mossland, MiniMax, MiMo, GPT-SoVITS, or a custom cloud-based speech synthesis service.

3. **🎧 ASR Settings** (optional): To use voice calls, configure Alibaba Cloud real-time ASR credentials or the API key shared with Mossland TTS.

4. **📱 External Channels** (optional): Connect Feishu, WeChat iLink, or QQ through NapCat/OneBot 11.

Configuration is stored in the application's `<userData>/` directory. Most changes do not require a restart.

---

## 📊 Current Status

| Module | Status | Description |
| --- | :---: | --- |
| 🌸 Live2D Desktop Companion | ✅ Available | Always-on-top companion, multiple windows, expressions, actions, mood and status, speech bubbles, and intelligent stickers |
| 💬 Casual Conversation (Chat) | ✅ Available | Independent character-chat flow that neither exposes nor executes tools, using recent messages, social context, and user style |
| 🛠️ Assisted Work (Work) | ✅ Available | Driven by [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) |
| 💻 Code Collaboration (Code) | ✅ Available | Binds a trusted code directory; Coding Agent reads, modifies, verifies code, and runs commands |
| 📚 Learning Companion (Learn) | ✅ Available | Binds an Obsidian Vault to accompany understanding, take notes, generate exercises, and track progress |
| 🧠 Personalized Memory | ✅ Available | L0 / L1 / L2 layered memory, self-developed DMAE Worldbook, relationship profile, and long-term interaction continuity |
| 🔊 Voice Interaction | ✅ Available | Multiple TTS engines, real-time ASR, voice calls, and VAD silence detection; some features require additional configuration |
| 🧰 Built-in Tools | ✅ Available | Web search, webpage reading, file operations, document generation, everyday services, music, and more |
| 🔌 Multi-Provider Model Support | ✅ Available | A / B / M / D tiered Structured Output and Function Calling profiles based on provider capabilities |
| ✨ Skill System | ✅ Available | Built-in Skills, user-defined Skills, slash commands, and reference reading |
| 📚 RAG Document Knowledge Base | 🧪 Experimental | Multi-format document import, vector + BM25 hybrid retrieval, Reranker, and source traceability |
| 🔌 MCP Extension Ecosystem | 🧪 Experimental | Supports stdio, SSE, and HTTP transports; actual compatibility depends on the third-party MCP Server |
| 📱 Feishu / Lark | ✅ Available | Long-connection message access and multiple media types |
| 📱 WeChat iLink | 🧪 Experimental | Long-poll message exchange, media handling, and mobile chat |
| 📱 QQ / NapCat | 🧪 Experimental | OneBot 11 reverse WebSocket, private/group allowlists, replies, mentions, and cross-WSL media |
| 🌙 Proactive Chat | 🧪 Experimental | Status evaluation, do-not-disturb policies, and delivery through desktop, Feishu, and WeChat |

> ✅ **Available**: The core workflow is implemented and suitable for everyday use.  
> 🧪 **Experimental**: The feature is integrated, but compatibility, edge cases, or user experience are still being refined.

---

## ❓ FAQ

### Local AI Models

### Does Cyrene Support Local LLMs and Other Third-Party Model Platforms?

Cyrene only provides basic generic compatibility and fault-tolerance handling for local models, custom endpoints, and third-party model platforms that are not listed in the compatibility matrix.

Because these endpoints have not been tested through the complete Work workflow:

- Stable operation is not guaranteed
- Structured Output and Function Calling support is not guaranteed
- Completion of the full Agent toolchain is not guaranteed
- Configuration guidance, compatibility troubleshooting, and error diagnosis are currently not provided

Unknown models, local models, and custom endpoints use the generic **Tier D** profile by default. Users must verify actual compatibility themselves.

> [!NOTE]
>
> Cyrene is currently developed independently by a single developer. Time, hardware, and API testing budgets are limited. At this stage, compatibility maintenance and technical support are only provided for the major model providers that have been explicitly adapted and verified. The testing scope may expand as the project develops.

The primary model providers currently covered include:

- Doubao Seed
- Kimi
- DeepSeek
- Qwen
- GLM
- MiMo
- MiniMax
- OpenAI
- Anthropic Claude

Verification status varies by provider and model. Refer to the project's compatibility matrix and benchmark report for authoritative details.

> BGE-M3, `ms-marco-MiniLM-L-6-v2`, and `bge-reranker-base` are local Embedding / Reranker enhancement models used by the project. They are not local large language models for chat.

### Are API Keys Secure?

> [!WARNING]
>
> The current version is not recommended for use on shared computers or in other untrusted environments.

Credentials for the LLM, separate vision model, ASR, TTS, and other third-party services are stored in the application's `<userData>/` directory:

- `<userData>/model-settings.json`: LLM and vision model configuration (plaintext)
- `<userData>/app-settings.json`: ASR, TTS, maps, search, email, and other configuration (plaintext)
- `<userData>/weixin/credentials.json`: WeChat iLink Bot credentials (plaintext)
- `<userData>/mcp-servers.json`: MCP Server configuration, including `env` environment variables (plaintext)
- `<userData>/channels-settings.json`: Channel settings; Feishu `appSecret` and QQ `accessToken` use `safeStorage`
- `<userData>/music/netease/account.enc`: NetEase Cloud Music login cookie (`safeStorage` encrypted)

Most credentials are currently stored as plaintext local files and are primarily protected by operating-system permissions on the user data directory.

Feishu channel credentials and the NetEase Cloud Music login cookie are encrypted with Electron `safeStorage`:

- Windows: DPAPI
- macOS: Keychain
- Linux: libsecret
- If the system keyring is unavailable, the application falls back to a weaker local obfuscation method

Do not share or upload `<userData>/`, settings files, or log files. Do not synchronize them to a public cloud drive or commit them to a Git repository.

To clear credentials and application configuration, delete the following files and restart the application:

```text
<userData>/model-settings.json
<userData>/app-settings.json
<userData>/weixin/credentials.json
<userData>/mcp-servers.json
<userData>/channels-settings.json
<userData>/music/netease/account.enc
```

### Can It Run on macOS or Linux?

Cyrene currently targets and is primarily tested on **Windows 10 / 11**.

| Platform | Status | Description |
|---|:---:|---|
| Windows 10 / 11 | ✅ Tested | Primary supported platform |
| macOS | ⚠️ Not fully verified | The Electron application may run, but transparent windows, mouse passthrough, and window layering may have compatibility issues |
| Linux | ⚠️ Not fully verified | Differences in desktop environments and system keyrings may affect some features |

The `game-bot` module uses the native `nut.js` dependency and has only been tested end to end on Windows.

When reporting a macOS or Linux compatibility problem, include the runtime environment, error logs, and reproduction steps in the GitHub Issue.

### What Should I Do About OOM or Excessive Memory Usage?

Try the following steps in order:

1. **Disable the Reranker**  
   Settings → Cyrene Settings → RAG / Document Import → set Reranker mode to `none`.

2. **Disable MCP Services You Are Not Using**  
   Browser automation services such as Playwright may start additional Chromium processes.

3. **Reduce Large RAG Documents**  
   Remove knowledge-base files that are not currently needed to reduce indexing and retrieval overhead.

4. **Close Unused Windows and Background Tasks**  
   Long-running tool tasks, voice services, and multiple conversations may continue consuming resources.

5. **Restart the Application**  
   This releases memory occupied by models, indexes, browser subprocesses, and long-running tasks.

The Embedding index uses a background Worker, batching, and caching to reduce peak memory usage during document import.

If OOM errors continue, use the Chrome DevTools Memory Profiler in development mode to capture a Heap Snapshot, then include the reproduction steps and relevant logs in the Issue.

---

## ✨ Features

### Core Features

#### 🌸 Desktop Companion

- **Live2D Desktop Character** — Rendered with `pixi-live2d-display` and Cubism Core, with always-on-top display, mouse interaction, natural idle animations, and lip sync.
- **Expression and Action Linking** — Conversation content can trigger expressions, actions, status, mood, and desktop speech bubbles, extending feedback beyond text.
- **Intelligent Stickers** — Includes a built-in sticker panel and semantic matching that can automatically select stickers appropriate to the current context.
- **Multi-Window Interaction** — The companion, chat, settings, tasks, call, and sticker-management windows are independent while sharing unified runtime state.
- **Customizable Appearance** — Supports interface themes, chat styles, and font selection.

#### 💬 Casual Conversation (Chat)

- **Independent Character-Chat Flow** — Chat mode focuses on character-driven interaction and does not expose, invoke, or execute tools.
- **Character-Aware Responses** — Combines Cyrene's character design, recent conversation, social context, user style, and personalized memory.
- **Multiple Conversation Histories** — Conversations are stored independently and support automatic titles, sorting, and renaming.
- **Channel-Specific Chat Style** — Desktop chat, mobile channels, and voice calls can use different expression styles.
- **Segmented Replies** — Choose between “segment all / segment Chat only / disabled,” allowing long replies to be split into semantic chat bubbles.

The session modes below are consumers of the CyreneHarness core engine:

#### 🛠️ Assisted Work (Work)

![Work mode preview](./docs/image/work.png)

- **Driven by CyreneHarness** — Each message enters the while loop in [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts): every round calls the LLM → writes back the assistant message → dispatches tools → writes back tool results → checks uncertain effects → continues or ends. Pre-processors (CITA context understanding) run before the Harness entry, and permission approval filters unsafe tool calls before execution; inside the loop, each round carries a compact execution persona ([`prompts/cyrene_harness.md`](./prompts/cyrene_harness.md)) that only governs expression style and never leaks into tool arguments — on conflict, "task correctness > clarity > Cyrene's style"; the full Soul persona layer generates the reply text after the Harness exit.
- **Free tool chaining** — Web search, webpage reading, file R/W, document generation, and lifestyle tools can be combined on demand; the model picks the next tool without pre-orchestrated flows.
- **Side-effect accounting** — When a non-idempotent side effect (sending email, modifying a remote file, etc.) has an unknown result, it is recorded into `state.uncertainEffects` and blocks automatic replay of the same dangerous call within the round.
- **Failure retry and cancellation** — Tool failures retry based on error class and side-effect tier (with jittered backoff); `AbortSignal` can cancel at any time. Cancellation does not emit a "final reply" event to avoid misleading the user.
- **Recoverable checkpoint** — `messages + state + rounds` are serialized to disk every round, so execution can resume after a cross-process crash without losing context.
- **Persona and workflow coexist** — Cyrene's character-driven reply is preserved alongside tool calls; the reply text is generated by the Soul layer and is not overwritten by tool results.

#### 💻 Code Collaboration (Code)

![Code mode preview](./docs/image/code.png)

> [!WARNING]
>
> Code mode **does not yet include a built-in review / diff preview**. Once the Agent finishes editing a file, the change is written to disk immediately. It is recommended to open the bound directory in your preferred IDE or diff tool (VS Code, Cursor, JetBrains, SourceGit, etc.) so you can inspect and roll back any change at any time.
>
> Initializing Git is the safest fallback: after `git init && git add -A`, any change can be inspected with `git diff` and reverted with `git checkout -- .`.

- **Code-specific tools on top of Work** — Reuses the [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) main loop and registers extra code-focused tools (read/write/edit, command execution, LSP queries, etc.); permission approval (checkPermission) filters unsafe calls before tool execution, and Execution Policy decides whether to require a second user confirmation.
- **Trusted workspace binding** — All read/write, command execution, and LSP queries must stay inside the user-bound directory; the model cannot pick or change the workspace, and out-of-scope access (including `..` and symlink escapes) is rejected outright.
- **Semantic code queries (LSP)** — Code mode can query definitions, references, hover details, symbols, and diagnostics inside the bound workspace without modifying files.
- **User-managed servers** — Cyrene provides an LSP client only. It never bundles, downloads, upgrades, or silently installs language servers.
- **Startup order** — Commands that are absolute paths are picked first, otherwise the workspace `node_modules/.bin` is searched, finally the system PATH is walked entry by entry (Windows also appends `.exe` / `.cmd` and other `PATHEXT` extensions).
- **Install and troubleshoot** — Install the server your language needs, such as `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`, `clangd`, `jdtls`, `OmniSharp`, `intelephense`, `ruby-lsp`, `kotlin-language-server`, `lua-language-server`, `vue-language-server`, `yaml-language-server`. Use `where pyright-langserver` on Windows or `which pyright-langserver` on macOS/Linux. A user may explicitly ask Cyrene to assist through existing permission-controlled installation tools.
- **Security boundary** — Language server processes are spawned with `stdio: "pipe"`, `shell: false`, and `cwd` forced to the bound workspace. The model cannot specify a command, server ID, or workspace root; `lspServerOverrides` only overrides command name / arguments / extensions of built-in services, and **does not accept arbitrary commands supplied by the model in chat**.
- **Built-in languages** — TypeScript / JavaScript / JSON, Python, Go, Rust, C / C++, Java, C#, PHP, Ruby, Kotlin, Lua, Vue, and YAML (13 in total, see `src/main/lsp/server-catalog.ts`).
- **Process reuse and release** — A given `serverId`'s LSP process is reused within the same workspace to avoid repeated cold starts; all processes are released when the app exits.
- **Custom server command** — Configure `lspServerOverrides` in `general-settings.json` under the application data directory to override a built-in service's `command` / `args` / `extensions` / `initializationOptions`; the model cannot supply a launch command in chat. For example:

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

#### 📚 Learning Companion (Learn)

- **Obsidian Vault Workspace** — Binds a Vault as the learning workspace, using the `materials/`, `notes/`, `exercises/`, `templates/`, and `learn/progress.md` structure.
- **Built on RAG and personalized memory** — Learning materials are indexed through the [RAG knowledge base](#-rag-document-knowledge-base) for retrieval, while progress and preferences flow into the L2 long-term memory to stay continuous across sessions.
- **Accompanied Understanding** — Helps users understand materials through questions, breakdowns, analogies, and discussion rather than doing the learning for them.
- **Notes and Exercises** — Organizes concepts, generates exercises, and records reviews inside the Vault, automatically maintaining a learning-progress overview.
- **Respects the User's Pace** — Re-explains when the user is stuck, advances when the user is ready, and never scolds the user for wrong answers.

#### 📝 Rich Text and Code Rendering

- **Markdown Rendering** — Supports headings, lists, blockquotes, tables, links, code blocks, and other common Markdown elements.
- **Syntax Highlighting** — Supports syntax highlighting and copy actions for multiple common programming languages.
- **Mathematical Formulas** — Supports inline and block-level formula rendering.
- **Streaming Compatibility** — Keeps output stable during generation and renders complete rich text after a message finishes.

#### 🧠 Personalized Memory

- **L0 / L1 / L2 Layered Memory** — Separately manages core user profiles, recent state, and long-term experiences.
- **Memory Evidence Chain** — Memory entries retain their source and context to reduce unsupported profile inference.
- **Conflict Detection and Resolution** — Retrieves, scores, and semantically evaluates old and new memories to distinguish contextual differences, preference evolution, and direct conflict.
- **Self-Developed DMAE Worldbook** — Manages character knowledge and long-term interaction content through triggers, priority, intrinsic value, linked activation, and Active / Dormant / Archived states.
- **Relationship and Style Continuity** — Gradually develops user preferences, communication habits, and relationship context through long-term interaction.

#### 🔊 Voice Interaction

- **Multiple TTS Engines** — Supports Mossland, MiniMax, MiMo, GPT-SoVITS, and custom cloud-based speech services.
- **ASR** — Supports Alibaba Cloud real-time speech recognition and Mossland full-turn audio transcription after each utterance.
- **Complete Voice Calls** — Continuous voice interaction through the `LISTENING → THINKING → SPEAKING` state flow.
- **VAD Silence Detection** — Automatically detects when the user has stopped speaking and triggers a response.

#### 🧰 Tool Ecosystem

Cyrene includes many built-in and extensible tools, primarily covering the following categories:

- **Documents and Office Work** — Generate Word, Excel, PDF, and Markdown documents.
- **Web Capabilities** — Web search, webpage reading, content extraction, and information organization.
- **File Processing** — Read, write, and browse local files, as well as interpret images.
- **Everyday Services** — Weather, maps, translation, currency conversion, bookkeeping, trip planning, and more.
- **Music** — Search for songs, retrieve recommendations, and invoke a local music client for playback.
- **Task Collaboration** — Task lists, user-choice cards, task delegation, and subtask handling.
- **MCP Extensions** — Connect additional external tools and services through the Model Context Protocol.

<details>
<summary><b>🧩 Advanced Features</b> (click to expand)</summary>

#### 📚 RAG Document Knowledge Base

- Supports importing `txt`, `md`, `pdf`, `docx`, `xlsx`, `pptx`, `csv`, and `json`.
- Supports hybrid retrieval with vector search, BM25, and a Reranker.
- Supports both local Embedding and OpenAI-compatible cloud Embedding.
- Retrieval results retain source information for traceability.
- Supports entity relationship information and custom tokenization dictionaries.

#### 🔌 MCP (Model Context Protocol)

- Supports `stdio`, SSE, and HTTP transports.
- Supports managing and enabling/disabling MCP Servers from Settings.
- MCP tools are integrated into Cyrene's tool registry, permission approval, and Execution Policy.
- Actual stability of third-party MCP Servers depends on their own implementations.

#### 📱 External Channels

- **Feishu / Lark** — Connects through the official SDK and WebSocket long connection without requiring a public server or tunneling.
- **WeChat iLink** — Supports long-poll message receiving, text sending, and partial media processing.
- **QQ / NapCat** — Connects through a OneBot 11 reverse WebSocket with private/group allowlists, replies, mentions, and media. See the [NapCat guide](docs/user-guide/napcat-onebot.md).
- **Unified Character Across Channels** — Desktop, Feishu, WeChat, and QQ share the same character design and memory capabilities.
- **Channel-Specific Style** — Mobile and desktop chat can use different expression styles.

#### ✨ Skill System

- Supports built-in Skills and user-defined Skills.
- A user Skill with the same name can fully override the built-in version.
- Supports `invoke_skill`, reference reading, and Slash Commands.
- Includes path protection, repeated-read restrictions, and large-text truncation.

#### 🌙 Proactive Chat

- **Status Awareness** — Evaluates time, user activity, conversation state, and character mood before initiating a conversation.
- **Do-Not-Disturb Policy** — Reduces or stops proactive messages late at night, while the user is already chatting, or after repeated unanswered messages.
- **Multi-Channel Delivery** — Desktop, WeChat, or Feishu can be selected as the destination.
- **Channel Failure Protection** — If the selected mobile channel is unavailable, delivery is canceled rather than silently redirected to desktop.

</details>

---

<details>
<summary><b>🔧 Development Features</b> (click to expand)</summary>

#### 🧪 Unit Tests

- Vitest 4 covers core modules including ASR, TTS, channels, chats, game-bot, memory, opener, orchestrator, RAG, scheduler, and Skills.
- Use `npm test` for a one-time run or `npm run test:watch` for watch mode.

#### 🎬 Scenario Simulation

- Use `npm run sim` for the default scenario, or `sim:coffee`, `sim:mix`, and `sim:rescue` for individual scenario debugging.
- Run `npm run sim:sweep --rewardGain=3,5,7,10` to sweep Worldbook scoring parameters.
- Output is written to `sim-result/`.

#### 🔧 Developer Experience

- Unified IPC bus: `shared/ipc-channels.ts` defines more than 90 channel constants.
- Runtime-state preview: Settings displays live previews of mood, status, and related text.
- Embedding hot switching: Automatically detects incompatible dimensions and clears outdated indexes.
- File watching and hot reload: Runtime reloading for Worldbook and other watched files through mechanisms such as `watchWorldbookFile`.

</details>

---

## 🧱 Technology Stack

| Layer | Technologies |
|---|---|
| Runtime | Node.js 24 LTS + Electron 43 |
| Language | TypeScript 5 |
| Build Tool | Vite 7 |
| UI Rendering | HTML / CSS + React 19 + Pixi.js 7 + Ant Design X + Chart.js |
| Live2D | `pixi-live2d-display` 0.5.0-beta + Cubism Core |
| Agent Main Loop | [CyreneHarness](./src/main/orchestrator/harness/cyrene-harness.ts) (while + Function Calling + streaming reasoning/tools + prefix-cache layering + mid-loop compaction) + Structured Output + Native Function Calling |
| Agent Event Protocol | AG-UI (`@ag-ui/core`, `@ag-ui/client`) — decoupled from the renderer through `RUN_STARTED / STEP_* / TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED` and other events |
| Tool Dispatching | Self-developed `tool-dispatcher` + `side-effect-resolver` + `error-classifier` + `retry-policy` quartet, handling the four-state outcome (success / failure / unknown / not_executed) |
| Sandbox Execution (Windows) | `@anthropic-ai/sandbox-runtime` (SRT) — untrusted commands run through `SandboxManager.wrapWithSandboxArgv`; falls back to direct `spawn` when not installed, with `workspace_mutation` commands still rejected |
| LSP Client | Self-developed `LspManager` + `vscode-jsonrpc` protocol; processes are reused by `serverId`, launched with `stdio: "pipe"` and `shell: false` |
| Tool Extensions | `@modelcontextprotocol/sdk` (stdio / SSE / StreamableHTTP transports) |
| Memory and Retrieval | Embedding (`@xenova/transformers`) + BM25 + self-developed Cross-Encoder Reranker + self-developed indexing pipeline |
| Context Entry Scheduling | Self-developed DMAE V5.1 (keyword-hit recall + activation decay + reversible active/dormant/archived states) |
| Chinese Retrieval | `@node-rs/jieba` |
| Browser and Desktop Automation | Playwright + `@nut-tree-fork/nut-js` |
| Rich Text Rendering | `@ant-design/x-markdown` (Markdown / code highlighting / KaTeX math) |
| Voice and Media | TTS / ASR + `silk-wasm` |
| Native Screenshot Helper | Rust + DXGI Desktop Duplication / Direct2D / GDI + WIC PNG + NDJSON IPC |
| Self-Developed Core | CITA (context understanding), CyreneHarness (agent loop and permission approval), DMAE Worldbook, unified Structured Output Pipeline |
| External Channels | Feishu OpenAPI, WeChat iLink, NapCat / OneBot 11 |
| Documents and Email | ExcelJS, docx, PDFKit, Nodemailer |
| Testing | Vitest 4 |

---

## 📦 Project Structure

```text
models/                # Local AI models placed by the user; see MODEL_LICENSE.md
├── Xenova/
│   └── bge-m3/       # Embedding model for sticker semantics and scene detection (~570 MB)
│       ├── tokenizer.json
│       ├── config.json
│       └── onnx/model_quantized.onnx
├── bge-reranker-base/       # Standard reranking model (~279 MB, optional)
└── ms-marco-MiniLM-L-6-v2/  # Lightweight reranking model (~23 MB, optional)

src/
├── cli/              # Command-line entry (`cyrene` command: banner / about / version / run)
├── main/             # Electron main process
│   ├── asr/          # Speech recognition (Alibaba Cloud real-time / Mossland batch transcription)
│   ├── call/         # Voice-call core (ASR -> Agent -> TTS turns)
│   ├── channels/     # External channel adapters (Feishu / WeChat iLink / QQ OneBot 11 / ...)
│   ├── chat/         # Chat support (image handling / think filtering / sending policy)
│   ├── chats/        # Multi-conversation history and persistence
│   ├── cita/         # CITA context-understanding and recommendation engine
│   ├── code-git/     # Git service for Code mode (status / commit / branch / push / revert)
│   ├── game-bot/     # Game automation driven by game recipes
│   ├── learn/        # Learn mode: Obsidian Vault binding + progress overview
│   ├── lsp/          # LSP client (manager / client / server-catalog / server-discovery)
│   ├── memory/       # L0/L1/L2 memory engine + DMAE Worldbook + entity relationship graph
│   ├── music/        # Music companion features (playback / recommendations / sessions / MCP client)
│   ├── orchestrator/ # Agent loop, tool scheduling, and permission approval
│   │   ├── harness/  # CyreneHarness core (while loop + compaction + retry + uncertainty)
│   │   ├── sandbox/  # Windows command-execution sandbox (@anthropic-ai/sandbox-runtime integration)
│   │   ├── code/     # Code mode sub-module (workspace binding + LSP tools)
│   │   ├── vendors/  # Multi-provider model adapters (A/B/M/D tiered Structured Output + Function Calling)
│   │   ├── structured-output/  # Unified Structured Output pipeline
│   │   ├── subagents/ # Sub-agents (task delegation / child Harness)
│   │   ├── tools/    # Tool registry
│   │   ├── model-config/  # Model configuration (tiered by provider/model)
│   │   └── config/   # Timeouts / context-window and other global configuration
│   ├── permission/   # Permission module (checkPermission / risk levels / permission-policy)
│   ├── proactive/    # Proactive chat: model / policy / routing / service
│   ├── prompts/      # Prompt file loading (system prompt / persona / Runtime Policy)
│   ├── protocols/    # Protocol layer (IPC and data-format conventions with external components)
│   ├── rag/          # Retrieval-augmented generation and Worldbook injection (includes DmaeManager)
│   ├── relationship/ # User relationship profile
│   ├── runtime-policy/  # Runtime Policy (tool execution constraints + retry policy + side-effect accounting)
│   ├── scheduler/    # Scheduled tasks (reminders / calendar)
│   ├── screenshot/   # Native screenshot helper (IPC with the Rust assistant)
│   ├── services/     # Service layer (BGE-M3 Embedding / email / search, etc.)
│   ├── settings/     # Settings (general-settings / app-settings / model-settings)
│   ├── sim/          # Scenario simulation tools (dmae-sim / run-l2-sim / sweep)
│   ├── skills/       # Agent Skill system (built-in + user-defined)
│   ├── social-context/  # Social-context extraction and injection
│   ├── startup/      # Startup flow (windows / Tray / registration)
│   ├── tasks/        # Task panel (TaskSessionStore / task execution / delegation)
│   ├── todos/        # Todo working notebook (todoItems persistence inside Harness)
│   ├── tts/          # Speech synthesis (multiple engines: MiniMax / Mossland / MiMo / GPT-SoVITS / custom)
│   ├── windows/      # Windows-native concerns (window layout / position / visibility)
│   ├── agui-bridge.ts # AG-UI event bridge (main process <-> renderer)
│   ├── sync-mcp-builtin.ts  # Built-in MCP synchronization (Playwright / Feishu, etc.)
│   └── sticker-*.ts  # Semantic sticker matching (protocol / storage / description / embedder)
├── preload/          # Electron Preload bridge
├── renderer/         # Vite renderer
│   ├── call/         # Voice-call window
│   ├── chat/         # Main chat interface
│   ├── lib/          # Shared library (hooks / utils / types)
│   ├── live2d/       # Live2D model rendering
│   ├── public/       # Tracked static source assets (audio / avatars / Cubism Core / stickers)
│   ├── react/        # React 19 component library (features / styles / App)
│   ├── settings/     # Settings center
│   ├── sidebar/      # Sidebar
│   ├── sticker-manager/  # Sticker management
│   ├── tasks/        # Task panel
│   ├── tast/         # Character avatar assets (PNG)
│   ├── types/        # Shared type definitions
│   └── ui/           # Shared UI components (modal / theme / chart, etc.)
└── shared/           # Code shared between the main and renderer processes

dist/renderer/        # Vite output (generated files ignored; product assets tracked)
├── assets/           # Bundled JS/CSS (generated, ignored)
├── audio/            # Audio assets (tracked)
├── avatars/          # Avatar images (tracked)
├── call/ chat/ settings/ sidebar/ sticker-manager/ tasks/  # HTML entry points (generated, ignored)
├── feeling/          # Character expression images (shy / calm / happy / moved / worried, tracked)
├── icons/            # Icons (tracked)
├── models/cyrene/    # Live2D model; see MODEL_LICENSE.md (tracked)
├── react/            # React main entry (generated, ignored)
├── status/           # Character status images (working / thinking / reminding / offline / listening, tracked)
└── stickers/         # Sticker images (tracked)
```

> `dist/renderer/assets/`, the per-window `index.html` files, and `dist/renderer/live2dcubismcore.min.js` are generated Vite build outputs and are not tracked by Git.  
> `audio/`, `avatars/`, `feeling/`, `icons/`, `models/`, `status/`, and `stickers/` are product assets and are tracked.  
> Static source assets are located in `src/renderer/public/`. Run `npm run build:renderer` to regenerate the build output.

---

## ⚠️ Disclaimer

This project is an **unofficial fan-made work** and has **no affiliation with, endorsement by, or sponsorship from HoYoverse / miHoYo**.

_Honkai: Star Rail_, Cyrene, and all related artwork, lore, trademarks, and intellectual property belong to **HoYoverse / miHoYo**.

**License scope:**

- The **source code** is licensed under the [MIT License](./LICENSE), which applies only to the source code in this repository.
- **Character IP, the Live2D model, and artwork assets** are not covered by the MIT License. They are governed separately by [MODEL_LICENSE.md](./MODEL_LICENSE.md) and HoYoverse's fan-creation guidelines.
- Derivative works that include Cyrene IP, the Live2D model, or related artwork from this project **must not be used commercially**, including sale, paid communities, advertising monetization, or bundled resale.

---

## 📄 License

The **source code** in this repository is licensed under the [MIT License](./LICENSE), Copyright (c) 2026 Playa.

The MIT License applies only to the source code in this repository. It does not apply to the character, Live2D model, or artwork assets.

Character IP, the Cyrene Live2D model (`models/cyrene/`), and artwork assets are governed by their respective permissions:

- **Live2D Model** — See [MODEL_LICENSE.md](./MODEL_LICENSE.md). The model creator, [@是依七哒](https://space.bilibili.com/457683484), has authorized its use, modification, and redistribution.
- **Character IP / Artwork** — Belongs to **HoYoverse / miHoYo**.

---

## 🙏 Acknowledgements

- **Cyrene Character**: © HoYoverse / miHoYo
- **Live2D Model**: Created by [@是依七哒](https://space.bilibili.com/457683484) — see [MODEL_LICENSE.md](./MODEL_LICENSE.md)
- **Live2D Cubism SDK**: © Live2D Cubism
- **Contributors**: See [docs/CONTRIBUTORS.md](./docs/CONTRIBUTORS.md)

Special thanks to the original model creator for generously authorizing this project to use, modify, and redistribute the work.

---

## 💌 Contact

GitHub Issues and pull requests are welcome. Please keep discussions respectful and relevant to the project.

---

⭐ If you like this project, consider giving it a Star. It helps more Cyrene fans discover it.
