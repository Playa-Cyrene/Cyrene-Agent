# Cyrene（昔涟）Computer Use（电脑操控）插件与安全执行架构设计

> 日期：2026-09-17
>
> 状态：待用户评审
>
> 范围：Windows（微软桌面操作系统）桌面感知、操作、结果验证、运行中求助、UAC 场景和手机渠道恢复
> 核心决策：保留 CyreneHarness 主循环；电脑操控作为第一方内置插件交付，但安全策略、运行中暂停和提权授权由宿主及独立原生进程强制执行。

## 1. 背景与问题

用户希望从桌面或手机向昔涟下达自然语言任务，例如：

> 打开某个游戏启动器，进入游戏并领取奖励。

任务执行期间可能出现正常主页、更新提示、登录失效、未知弹窗、程序崩溃、焦点被抢占或 UAC（用户账户控制）安全桌面。系统不能把“成功发出点击”当作“任务成功”，也不能在状态不确定时继续盲点。

本设计把电脑操控定义为一个闭环：

```text
理解任务 -> 观察桌面 -> 选择动作 -> 执行动作 -> 验证结果
                                           │
                                           ├─ 符合预期：继续
                                           ├─ 可恢复异常：有限重试
                                           └─ 不确定/危险：暂停并询问用户
```

UAC 不是要绕过的障碍，而是必须保留的系统安全边界。真正需要解决的是：

1. 启动前识别可能的提权要求，避免先触发 UAC 再补救；
2. 对少量固定应用提供用户预先登记、可撤销的管理员能力；
3. 任何意外状态都能让昔涟停止、说明所见并等待用户；
4. 用户从手机回答后，任务从检查点重新观察并恢复，而不是重放旧点击。

## 2. 与现有架构的关系

### 2.1 直接复用

本设计优先复用现有成熟能力，不另造通用基础设施：

| 现有能力 | 复用方式 |
| --- | --- |
| CyreneHarness（昔涟智能体执行核心） | 保留唯一 Agent Loop（智能体循环），负责推理、工具选择、多轮执行和最终回答 |
| Plugin Tool Registry（插件工具注册表） | 注册观察、点击、输入、启动应用、等待和恢复工具 |
| `permission.ts` 与权限策略 | 对输入控制、外部副作用和能力登记执行宿主审批 |
| `ask-clarification.ts` 与 `user-choice.ts` | 扩展为运行中求助，并复用排他交互、取消、超时和回答结算 |
| 渠道适配器 | 把暂停问题发送到任务来源渠道，并把手机回答送回原任务 |
| `native/cyrene-screenshot` | 复用 Rust（系统编程语言）、`windows` crate（Rust Windows API 绑定）、DXGI（DirectX 图形基础设施）和 GDI（图形设备接口）经验；可抽取捕获模块，不复制实现 |
| Harness 排他工具调度 | 电脑输入类操作保持串行，防止并发点击、焦点竞争和顺序错乱 |

### 2.2 第一方插件边界

Computer Use（电脑操控）以第一方内置插件形式安装、启停和展示，但不是普通第三方插件可以完全复制的权限模型：

- 插件只声明工具、描述能力并连接宿主控制器；
- 宿主拥有会话状态、强制暂停、审批、恢复和审计记录；
- Rust 执行器拥有桌面感知与普通权限输入执行能力；
- 提权代理是独立安全边界，不能信任插件传入的任意路径、参数或动作；
- 第三方插件仍不能接管 CyreneHarness、改变审批结论或修改任务控制流。

这里的“插件”是功能交付边界，不是管理员权限边界。现有插件运行在 Electron Main Process（Electron 主进程）且不具备恶意代码隔离，因此真正的提权约束必须在独立进程再次验证。

## 3. 目标

1. 让昔涟通过截图、窗口信息和 UI Automation（Windows 界面自动化）理解当前桌面状态。
2. 支持鼠标、键盘、窗口激活、控件调用、应用启动、等待和结果验证。
3. 每个高层步骤都声明预期结果，动作完成后必须验证。
4. 遇到异常、低置信度或安全边界时立即停止后续输入。
5. 用户能在桌面或手机收到可理解的问题，并在稍后恢复同一任务。
6. 对固定管理员应用提供一次登记、按能力调用、可审计和可撤销的运行方式。
7. 保持 Cyrene 主进程为普通权限，不让模型、插件或通用命令工具长期持有管理员权限。
8. 使用持续原生运行时、增量观察和目标区域捕获获得低延迟。

## 4. 非目标

- 不绕过、伪造或自动点击 UAC 安全桌面。
- 不利用 Windows 提权漏洞或系统自动提权白名单。
- 不提供任意管理员命令、任意管理员程序启动或远程管理员终端。
- 不保证控制锁屏、登录桌面、Ctrl+Alt+Del 或其他 Secure Attention Sequence（安全注意序列）。
- 本阶段不处理验证码识别、双因素登录、游戏反作弊兼容或服务条款判断；这些状态统一进入运行中求助。
- 不让 Computer Use 插件替换 CyreneHarness 主循环。
- 不承诺对所有自绘界面、独占全屏和受保护内容都能获得结构化控件树。

## 5. 总体架构

```text
桌面/手机用户
      │
      ▼
CyreneHarness
  ├─ 任务规划与下一步决策
  ├─ 结果语义验证
  └─ 决定继续、重试或询问
      │
      ▼
第一方 Computer Use 插件
  ├─ 注册模型可调用工具
  ├─ 把高层请求转换为受限动作
  └─ 不持有管理员通用能力
      │
      ▼
ComputerUseSessionCoordinator（电脑操控会话协调器，宿主所有）
  ├─ 会话状态机与排他执行
  ├─ 动作前置条件与后置条件
  ├─ 运行中求助与检查点
  ├─ 审批、超时、取消和审计
  └─ 提权能力路由
      │
      ├───────────────┐
      ▼               ▼
Rust 普通执行器       Privileged Broker（提权代理）
  ├─ 窗口枚举          ├─ 独立安装与签名
  ├─ UIA 控件树        ├─ 严格 IPC（进程间通信）访问控制
  ├─ 截图              ├─ 只接受能力 ID
  ├─ 输入注入          ├─ 重新验证应用身份
  └─ 状态事件          └─ 执行少量白名单动作
```

### 5.1 为什么协调器属于宿主

运行中求助会暂停当前工具组、等待用户回答并恢复原任务，属于宿主控制流。若由插件自行实现，会迫使插件接管 Harness 或私自构造会话消息，违反现有插件边界。

协调器只为宿主提供一个窄接口；插件仍然只是工具贡献者。安全状态由宿主和原生执行器共同强制：一旦会话进入 `waiting_for_user`，后续输入动作全部拒绝，即使模型再次调用工具也不能继续盲点。

## 6. 会话状态机

```text
idle
  -> observing
  -> acting
  -> verifying
       ├─ success -> observing/acting
       ├─ retryable -> acting（受重试预算限制）
       ├─ needs_user_input -> waiting_for_user
       ├─ blocked -> stopped
       └─ failed -> stopped

waiting_for_user
  ├─ 用户继续 -> reobserving -> verifying
  ├─ 用户提供新信息 -> reobserving -> planning
  ├─ 用户取消 -> stopped
  └─ 超时 -> suspended

suspended
  └─ 用户稍后恢复 -> reobserving -> planning
```

关键不变量：

- 同一桌面会话同一时刻只允许一个输入型动作；
- `waiting_for_user`、`suspended` 和 `stopped` 状态不接受点击、输入或启动动作；
- 恢复后第一步永远是重新观察；
- 不缓存并重放暂停前尚未执行的坐标动作；
- 取消信号贯穿插件、协调器、Rust 执行器和用户询问。

## 7. 观察、动作与验证契约

### 7.1 Observation（观察）

```ts
interface ComputerObservation {
  observationId: string;
  capturedAt: string;
  desktop: "interactive" | "secure" | "locked" | "unknown";
  foregroundWindow?: WindowSnapshot;
  windows: WindowSnapshot[];
  screenshot?: ScreenshotRef;
  uiTree?: UiTreeSnapshot;
  displayTopologyVersion: string;
  warnings: ObservationWarning[];
}
```

观察由以下证据组成：

- 窗口句柄、进程 ID、标题、类名、边界、可见性和前台状态；
- 目标窗口或目标区域截图；
- 可用时的 UIA 控件树、属性和 Control Pattern（控件操作模式）；
- 桌面类型、显示器布局、DPI（每英寸像素密度）和坐标映射版本；
- 捕获失败、受保护画面、窗口消失等警告。

### 7.2 Action（动作）

低层动作仅包含：

- `focus_window`
- `invoke_element`
- `set_value`
- `click`
- `move_pointer`
- `scroll`
- `type_text`
- `send_key`
- `wait`
- `launch_registered_app`

优先级为：UIA 控件操作 > 窗口相对坐标输入 > 屏幕绝对坐标输入。能通过控件模式完成时不模拟鼠标；必须注入输入时，执行前再次确认目标窗口仍在前台且显示拓扑未变化。

每个变更型动作必须携带：

```ts
interface ComputerActionRequest {
  sessionId: string;
  actionId: string;
  basedOnObservationId: string;
  target: StableTarget;
  action: ComputerAction;
  preconditions: ActionPrecondition[];
  expectedEffects: ExpectedEffect[];
  timeoutMs: number;
  idempotencyKey?: string;
}
```

`basedOnObservationId` 防止使用过期截图点击；目标窗口、显示拓扑或关键控件版本变化时，动作返回 `stale_observation`，不继续猜测。

### 7.3 ActionResult（动作结果）

```ts
type ComputerActionStatus =
  | "completed"
  | "retryable"
  | "needs_user_input"
  | "permission_required"
  | "blocked"
  | "cancelled"
  | "failed";

interface ComputerActionResult {
  actionId: string;
  status: ComputerActionStatus;
  evidence: EvidenceRef[];
  observedEffects: ObservedEffect[];
  confidence: number;
  reasonCode?: string;
  safeToRetry: boolean;
  suggestedQuestion?: RuntimeInterventionDraft;
}
```

执行器只能报告事实与安全状态，不宣称完整用户任务已经完成。任务完成由 CyreneHarness 根据目标和多步证据判断。

### 7.4 三层验证

1. 执行层验证：系统调用是否成功、输入是否发送、目标窗口是否仍有效。
2. 结构层验证：预期进程、窗口、控件或文本是否出现。
3. 语义层验证：昔涟根据任务目标、最新截图和结构化证据判断是否仍走在正确路径上。

前两层可以强制阻断；第三层决定“看起来不对”时是否求助用户。任何一层都不能只凭动作 API 返回成功就推断业务成功。

## 8. 运行中求助与手机恢复

### 8.1 求助触发条件

确定性条件直接触发，不交给模型忽略：

- 进入 UAC 安全桌面、锁屏或无交互桌面；
- 目标窗口或目标进程意外消失；
- 前台窗口与目标不一致且无法安全恢复焦点；
- 显示器布局或 DPI 在动作前后变化；
- 动作对象已经过期；
- 同一恢复动作连续失败两次；
- 观察证据不足以安全执行下一步。

语义条件由昔涟判断：

- 页面与预期阶段不一致；
- 出现未知对话框、更新、登录、验证码、错误页或业务分支；
- 操作可能造成未在原请求中明确授权的外部后果；
- 成功状态不能通过当前证据确认。

### 8.2 扩展现有询问契约

在现有 `AskCardMode` 中新增：

```ts
type AskCardMode =
  | "action_parameters"
  | "semantic_clarification"
  | "runtime_intervention";
```

运行中求助增加以下只读上下文：

```ts
interface RuntimeInterventionContext {
  sessionId: string;
  checkpointId: string;
  reasonCode: string;
  expected: string;
  observed: string;
  screenshot?: ScreenshotRef;
  allowedResponses: Array<"continue" | "retry" | "cancel" | "custom">;
}
```

宿主把问题发到发起任务的来源渠道。渠道支持卡片时发送按钮和截图；只支持文本时发送编号选项和短期有效的交互标识。回答必须绑定原 `runId`、交互修订号和发送者身份，过期或来自其他会话的回答不生效。

### 8.3 检查点

检查点保存“如何重新理解任务”，而不是保存“下一次点击哪里”：

- 用户原始目标及当前子目标；
- 已确认完成的业务步骤；
- 最近有效观察的摘要和证据引用；
- 当前目标应用身份；
- 未完成动作的语义意图；
- 求助原因、问题和回答；
- 重试预算与幂等键；
- 能力授权引用，不保存管理员凭据。

截图按现有隐私与保留策略保存；检查点不得包含明文密码或一次性验证码。

### 8.4 恢复语义

用户回答“继续”不表示直接重放旧动作。恢复流程固定为：

```text
校验回答身份与修订号
-> 重新观察桌面
-> 确认目标应用仍是同一个
-> 对照检查点重新规划
-> 生成新的动作与新的 observationId
```

如果状态已经变化，昔涟基于新状态继续或再次求助。

## 9. UAC 与管理员能力设计

### 9.1 默认行为

普通电脑操控运行时不具备管理员权限。检测到安全桌面后：

- 停止输入；
- 将会话标记为 `needs_user_input`；
- 使用安全桌面前最后一张普通桌面截图及进程信息解释原因；
- 不尝试截图、读取、点击或关闭 UAC；
- 无预登记能力时，提示用户必须在电脑旁处理或稍后重新登记。

Windows 默认把 UAC 提示放在安全桌面，普通用户进程不能访问；设计依据见 [Microsoft：How User Account Control works](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works)。

### 9.2 启动前预检

`launch_registered_app` 不能等 UAC 出现后才判断。协调器先检查：

- 规范化可执行文件路径；
- 文件是否位于普通用户可写目录；
- Authenticode（Windows 代码签名）发行商与证书指纹；
- 文件版本中的产品名和内部名；
- 应用清单中的 `requestedExecutionLevel`；
- 该应用历史上是否触发过提权；
- 当前登记能力是否仍匹配。

明确需要提权且没有有效能力时，不启动程序，直接询问用户。这样不会先把无人值守桌面锁在 UAC 上。

### 9.3 Capability Ticket（能力票据）

用户在电脑旁完成一次本地登记后，获得一个不可由模型自由构造的能力 ID：

```ts
interface ElevatedAppCapability {
  capabilityId: string;
  displayName: string;
  canonicalPath: string;
  protectedInstallRoot: string;
  binaryName: string;
  productName: string;
  publisherSubject: string;
  signerThumbprint: string;
  allowedArgumentProfiles: string[];
  allowedCallerUserSid: string;
  allowRemoteTrigger: boolean;
  requireRemoteConfirmation: boolean;
  createdAt: string;
  revokedAt?: string;
}
```

关键约束：

- 模型只能传 `capabilityId` 和预定义参数配置 ID；
- 不接受任意可执行文件路径、任意命令行、工作目录或环境变量；
- 文件路径、签名、产品身份或受保护目录发生变化时拒绝执行并要求重新登记；
- 更新后可在发行商签名和产品身份均匹配时走显式重新确认，不能静默扩大授权；
- 能力可单独撤销，并记录创建、调用、失败和撤销审计；
- 手机远程确认是 Cyrene 自身的业务授权，不是假装点击 Windows UAC。

### 9.4 提权执行提供器

对外保持统一 `ElevationProvider`，分阶段替换实现：

```ts
interface ElevationProvider {
  enroll(input: EnrollmentRequest): Promise<ElevatedAppCapability>;
  launch(capabilityId: string, argumentProfileId: string): Promise<LaunchReceipt>;
  revoke(capabilityId: string): Promise<void>;
  inspect(capabilityId: string): Promise<CapabilityHealth>;
}
```

- 第一阶段：`DisabledElevationProvider`。只做检测、暂停和本地处理，不提供无人值守提权。
- 验证阶段：每个应用一个固定的 Windows Task Scheduler（任务计划程序）任务，用于验证产品体验；不作为稳定公开契约。
- 正式阶段：签名的最小 Windows 服务或受保护代理。服务只处理登记、验证和白名单启动，不包含模型、截图识别、浏览器或通用命令解释器。

禁止把整个 Cyrene、Electron 主进程或 Rust 电脑操控执行器长期以管理员身份运行。

### 9.5 提权代理安全要求

- 安装在仅管理员可写的受保护目录并进行代码签名；
- IPC（进程间通信）使用命名管道且显式配置 DACL（自主访问控制列表），不采用默认权限；微软说明命名管道两端都受安全描述符控制，见 [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)；
- DACL 绑定安装用户 SID 和当前登录会话 SID；
- 校验客户端进程身份、会话、用户和协议版本；
- 每个请求包含随机数、时效、幂等键，并防止重放；
- 所有请求重新读取能力存储并重新验证目标文件，不信任调用方缓存；
- 不提供 `run_command`、`launch_path` 或透传参数接口；
- 日志记录能力 ID、调用来源、文件身份、结果和原因，但不记录凭据；
- 服务更新、卸载和能力迁移均需要显式管理员操作。

## 10. Windows 原生执行器

### 10.1 技术选型

继续使用项目已有 `windows` crate，不自行维护 Win32 FFI（外部函数接口）。成熟系统能力的使用顺序：

1. UIA：读取控件树、属性、事件和可调用模式；使用缓存批量取回属性，减少跨进程调用。官方客户端模型见 [UI Automation Clients Overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-clientsoverview)。
2. Windows.Graphics.Capture（Windows 图形捕获）或现有 DXGI/GDI 后端：窗口和显示器截图。
3. `SendInput`：需要真实鼠标键盘语义时使用，并在发送前验证前台窗口。
4. Win32 窗口 API：枚举、定位、激活、DPI 和显示器映射。

UIA 不可用或应用为自绘界面时回退到视觉定位；回退必须降低置信度并加强后置验证。

### 10.2 进程模型

原生执行器采用持续子进程，而不是每个动作重新启动：

- 通过版本化 NDJSON（逐行 JSON）协议通信；
- 启动时报告协议版本、功能位和显示拓扑；
- 请求带 `sessionId`、`actionId` 和取消标识；
- 父进程退出时原生进程自动退出；
- 单次请求、单行和截图大小均设上限；
- 标准输出只承载协议，诊断日志走标准错误或独立日志；
- 协议错误、超时和崩溃不得让宿主自动重复有副作用动作。

`native/cyrene-screenshot` 中可复用的捕获、编码、显示器、窗口、父进程监视和协议测试应抽到共享 crate；不直接把已有截图选择器膨胀成全部电脑操控职责。

### 10.3 性能策略

- 常驻 COM（组件对象模型）与图形设备，避免每步初始化；
- UIA 使用属性缓存和事件订阅，避免反复遍历完整桌面树；
- 默认只捕获目标窗口或变化区域，需要全局定位时才截全屏；
- 连续等待优先监听窗口/UIA 事件，低频截图兜底；
- 图像编码与模型上传分离，模型不需要时不编码 PNG（便携式网络图形）；
- 鼠标移动等瞬时动作不单独触发模型轮次，高层工具内可执行受限动作序列；
- 每个动作序列都设置最大动作数、最大持续时间和中途观察点。

## 11. 工具设计

第一阶段不暴露几十个细碎工具，避免模型调用成本和状态碎片化。注册以下高层工具：

| 工具 | 作用 | 副作用 |
| --- | --- | --- |
| `computer_use_observe` | 获取当前桌面、目标窗口和必要截图 | 只读 |
| `computer_use_act` | 执行一个或一小组受限动作并返回新观察 | 输入控制 |
| `computer_use_wait_for` | 等待窗口、控件或视觉状态 | 只读/验证 |
| `computer_use_launch_app` | 启动普通或已登记应用 | 外部副作用 |
| `computer_use_resume` | 用户回答后重新观察并恢复会话 | 输入控制前置 |
| `computer_use_stop` | 停止会话并释放输入状态 | 安全操作 |

`computer_use_act` 的批量动作只适合稳定、短小且可验证的局部操作，例如“聚焦输入框、输入文字、按回车”。每个批次最多包含少量动作，遇到任何前置条件失效立即停止剩余动作。

插件工具仍返回当前 Plugin API 要求的字符串，但内容采用有版本的 JSON Envelope（JSON 信封）并由宿主适配器解码。稳定后再评估把结构化工具结果推广到公共 Plugin API；第一阶段不为单一插件扩大所有第三方插件的控制流能力。

## 12. 风险与审批

建议把电脑操控内部风险细分为：

| 风险级别 | 示例 | 默认策略 |
| --- | --- | --- |
| `observe` | 截图、窗口枚举、读取控件 | 首次说明隐私范围，可按会话允许 |
| `interact` | 点击、输入、切换窗口 | 普通电脑任务授权后允许 |
| `external_effect` | 发送消息、购买、删除云数据 | 复用对应业务工具的确认规则 |
| `privileged_registered` | 启动已登记管理员应用 | 必须有能力票据；按配置要求手机二次确认 |
| `privileged_unregistered` | 未登记的提权请求 | 永远不自动执行 |

模型不得通过把危险操作拆成多个普通点击规避确认。审批依据是预期外部效果，而不只是底层动作类型。

## 13. 失败处理

| 场景 | 行为 |
| --- | --- |
| UAC 安全桌面 | 强制暂停；无登记能力则要求本地处理 |
| 桌面锁定 | 进入 `suspended`，通知用户解锁后恢复 |
| 目标窗口消失 | 重新枚举一次；仍不存在则询问或失败 |
| 前台焦点被抢 | 不发送输入；尝试一次安全聚焦，失败后求助 |
| 控件引用过期 | 重新观察，不使用旧坐标 |
| 画面无变化 | 在等待阈值后重新观察；达到预算后求助 |
| 执行器崩溃 | 终止会话的输入能力；重启后只允许观察，不重放动作 |
| 渠道离线 | 保存暂停状态并在渠道恢复后发送；达到保留期限后转 `suspended` |
| 用户回答过期 | 拒绝旧回答并发送当前状态的新问题 |
| 应用更新导致身份变化 | 撤销能力健康状态，要求重新登记 |

Rust 执行器必须在取消和异常退出时释放按键、鼠标按钮、捕获资源及事件订阅，避免留下“按键卡住”状态。

## 14. 数据与隐私

- 默认只上传完成当前判断所需的目标窗口截图；
- 用户可查看当前允许观察的应用范围；
- 密码输入框、系统凭据窗口和安全桌面不读取、不记录；
- 日志保存动作类型、目标应用和结果，不保存完整键入文本；
- 调试模式需要用户明确开启，并显示截图和 UI 树可能包含隐私的提示；
- 检查点和截图设置独立保留期限，任务删除时同步清理引用；
- 手机渠道发送截图前沿用渠道附件安全策略，失败时只发送文本摘要。

## 15. 测试策略

### 15.1 Rust 单元与契约测试

- 坐标、DPI、多显示器和窗口裁剪；
- NDJSON 协议版本、行长、非法字段和取消；
- UIA 元素定位、缓存、过期和事件；
- 输入前台校验及按键释放；
- 桌面类型检测和安全桌面拒绝；
- 能力票据路径、签名、参数和撤销验证；
- 命名管道 DACL 与错误客户端拒绝。

### 15.2 宿主测试

- 电脑操作始终按排他方式调度；
- `needs_user_input` 后所有动作被拒绝；
- `runtime_intervention` 正确绑定 `runId`、修订号和渠道身份；
- 取消、超时、重复回答和过期回答只结算一次；
- 恢复时先观察，不重放旧动作；
- 调度任务无人值守时遇到求助进入暂停，不自动批准。

### 15.3 端到端场景

1. 打开记事本、输入文本并验证。
2. 启动普通应用并确认目标窗口。
3. 中途弹出未知对话框，昔涟暂停并在桌面询问。
4. 手机发起任务，中途异常，手机回答后继续。
5. UAC 意外出现，执行器停止且没有输入泄漏。
6. 已登记应用通过提权提供器启动，未登记路径被拒绝。
7. 应用更新换签名后原能力失效。
8. 执行中锁屏、切换显示器、改变 DPI 或抢焦点。
9. 原生执行器崩溃后不重复有副作用动作。

### 15.4 安全回归

- 任意路径、命令行、环境变量和工作目录注入；
- 符号链接、目录联接和路径替换；
- 普通用户可写目录中的同名程序替换；
- 命名管道未授权用户、跨会话和请求重放；
- 插件伪造能力 ID、用户回答或审批结果；
- 模型尝试把管理员操作拆分为普通动作。

## 16. 分阶段交付

### 阶段 0：可行性验证

- 从现有 Rust 截图模块抽取可复用捕获层；
- 验证 UIA 窗口树、控件调用、焦点检查和 `SendInput`；
- 建立持续原生进程与版本化协议；
- 仅支持测试应用，不保留原型代码作为正式安全边界。

### 阶段 1：普通权限闭环

- 第一方插件和宿主协调器；
- 观察、动作、等待、验证和停止工具；
- stale observation（过期观察）保护；
- 桌面端运行中求助；
- 明确拒绝 UAC、锁屏和高完整性目标。

### 阶段 2：手机暂停与恢复

- `runtime_intervention` 询问类型；
- 渠道问题投递、身份绑定和回答恢复；
- 可持久化检查点；
- 断线、超时、取消和稍后恢复。

### 阶段 3：预登记管理员应用

- 启动前提权预检；
- 能力票据、登记、撤销和审计界面；
- 先用固定任务计划验证用户体验；
- 完成威胁建模和安全测试后切换到签名的最小提权代理。

### 阶段 4：性能与兼容性

- UIA 事件驱动等待和缓存；
- 目标区域增量捕获；
- 自绘界面视觉定位；
- 多显示器、高 DPI、远程桌面和常见启动器兼容矩阵。

## 17. 验收标准

1. CyreneHarness 仍是唯一任务循环，插件没有替换或接管入口。
2. 每个变更动作都有前置条件、预期效果和动作后观察。
3. 异常状态下昔涟能停止并向任务来源用户说明“预期、实际、下一步需要什么”。
4. 用户回答后系统重新观察再规划，不重放旧坐标动作。
5. UAC、锁屏和无交互桌面无法被普通执行器输入。
6. 未登记应用不能使用管理员启动能力。
7. 提权代理不接受任意路径、任意参数或任意命令。
8. 整个 Cyrene 与插件保持普通权限运行。
9. 执行器崩溃、超时、取消和宿主退出均不会留下持续输入状态。
10. 电脑操控基础路径、异常求助、手机恢复和能力撤销均有自动化测试。

## 18. 已确定的架构决策

- 不为 Computer Use 创建第二套智能体循环。
- 不通过提示词单独保证“看到不对就停”；执行器状态机也必须强制阻断。
- 不在第一阶段开放通用的插件运行中交互 API；第一方功能通过宿主协调器复用现有询问链。
- 不把整个主程序提升为管理员。
- 不把 UAC 点击能力作为产品功能。
- 管理员无人值守能力只针对用户预登记的具体应用和参数配置。
- MVP（最小可行产品）首先完成普通权限闭环与暂停恢复，再引入提权代理。

## 19. 参考资料

- [Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)
- [UI Automation Clients Overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-clientsoverview)
- [How User Account Control works](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works)
- [Security Considerations for Assistive Technologies](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
- [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [OpenAI Computer Use Sample Apps](https://github.com/openai/openai-cua-sample-app)
