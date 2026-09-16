# 读图链路重构方案：统一图片路由

> 日期：2026-09-15
> 前置阅读：`2026-09-15-vision-image-pipeline-review.md`（现状与问题）
> 核心理念：回到最初设计——"纯文本主模型配 VLM 转文字；多模态主模型直接进图"。其余复杂度只允许存在于协议适配层，不允许泄漏到路由判断。

---

## 一、设计目标

1. **一个路由函数**决定所有图片的去向，全项目唯一入口
2. **三种结果**：直发 / 转述 / 明确拒绝（拒绝必须带人话原因）
3. **消灭 404 地雷**：任何"注定失败的配置"不允许被返回
4. **接线零重复**：调 VLM 转述的代码只存在一份
5. **迁移一次性清完**：三层历史判定收敛为一次持久化迁移

非目标（本期不做）：
- 工具结果直返 image block（列为后续可选阶段）
- bmp/svg 转码归一化（本期统一为"格式不一致时明确拒绝"）
- moments / channels 语义合并（保持直发，仅接入统一路由判定）

---

## 二、核心设计：`resolveImageRoute()`

新建 `src\main\orchestrator\image-router.ts`，全项目唯一图片路由：

```ts
/** 图片路由结果：三选一，不允许模糊状态 */
export type ImageRoute =
  | { mode: "direct" }                                        // 直发主模型
  | { mode: "caption"; config: VisionConfig }                 // 独立 VLM 转述
  | { mode: "reject"; reason: string };                       // 明确拒绝，reason 面向用户

/**
 * 统一路由判定。
 * @param source 图片来源：附件 / 工具 / 频道 / 动态（用于生成针对性提示）
 * @param settings 已展开档案的模型设置（调用方负责 resolveModelSettingsProfile）
 */
export function resolveImageRoute(
  source: "attachment" | "tool" | "channel" | "moments",
  settings: ResolvedModelSettings,
): ImageRoute {
  // ── 分支一：主模型多模态 → 直发 ──
  if (settings.multimodal) {
    return { mode: "direct" };
    // 协议差异（OpenAI image_url / Anthropic image 块）由 transport 适配层处理，
    // 路由层不关心协议。
  }

  // ── 分支二：纯文本主模型 + 已配独立 VLM → 转述 ──
  const v = settings.vision;
  if (v?.baseUrl && v.apiKey && v.model) {
    return { mode: "caption", config: { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model } };
  }

  // ── 分支三：拒绝，说人话 ──
  return {
    mode: "reject",
    reason: "当前主模型不是多模态，且未配置独立视觉模型。"
      + "请在「设置 → API 设置」中配置视觉模型，或切换到多模态主模型。",
  };
}
```

### 与旧逻辑的关键差异

| 场景 | 旧逻辑（loadVisionConfig） | 新逻辑（resolveImageRoute） |
|---|---|---|
| multimodal + OpenAI 兼容 | 返回主模型配置（对，但语义混） | `direct`（主模型自己看，不经过 VLM 概念） |
| multimodal + Anthropic + 有 VLM | 返回 VLM（歪打正着） | `direct` |
| multimodal + Anthropic + 无 VLM | **返回主模型地址 → 必然 404** | `direct`（发图没问题）；工具读图场景见下文"工具读图的直发判定" |
| 非多模态 + 有 VLM | 返回 VLM | `caption` |
| 非多模态 + 无 VLM | null（各调用方自己拼报错） | `reject` + 统一话术 |

---

## 三、工具读图的直发判定（`read_image` / `read_image_url`）

工具读图的特殊性：工具返回值是纯文本，**主模型没法直发看图**，所以工具链路必须有一个"能调的 VLM 端点"。新增一个工具专用判定：

```ts
/** 工具读图专用：解析"工具该调谁来看图"。 */
export function resolveToolVisionConfig(
  settings: ResolvedModelSettings,
): VisionConfig | { error: string } {
  // 纯文本主模型：路由到独立 VLM
  const route = resolveImageRoute("tool", settings);
  if (route.mode === "caption") return route.config;

  // 多模态主模型 + OpenAI 兼容：主模型自己兼职看图（现状保留，行为不变）
  if (settings.multimodal && settings.explicitTransport !== "anthropic") {
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model };
  }

  // 多模态主模型 + Anthropic：视觉链路只拼 /chat/completions，复用必然 404，
  // 这里显式拒绝而不是返回注定失败的配置
  return {
    error: "主模型走 Anthropic 协议，工具读图需要 OpenAI 兼容的独立视觉模型。"
      + "请在「设置 → API 设置」中配置视觉模型。",
  };
}
```

**与旧逻辑的行为差异只有一处**：`multimodal + Anthropic + 无 VLM` 从"运行时 404（看起来像网络问题）"变为"工具直接返回清晰的配置提示"。这是修 bug，不是行为变更。

---

## 四、收口四处接线：`captionImageSafe()`

`vision-captioner.ts` 新增一个带完整错误处理的包装（现四处调用方自己拼错误格式）：

```ts
/** 安全转述：读文件 → 调视觉模型 → 统一错误格式。调用方不再处理边界。 */
export async function captionImageSafe(
  filePath: string,
  config: VisionConfig,
): Promise<{ ok: true; caption: string } | { ok: false; error: string }>
```

四处调用方（agent-runtime / bootstrap / chat-ui-ipc / settings-ipc）全部改为：

```ts
const vision = resolveToolVisionConfig(resolveModelSettingsProfile(loadModelSettings()));
if ("error" in vision) return { ok: false, error: vision.error };
return captionImageSafe(filePath, vision);
```

四份重复代码 → 两行标准接线。

---

## 五、配置与迁移：一次性清完

### 5.1 语义简化

`ModelSettings` 字段含义收敛为：

- `multimodal: boolean` —— 主模型是否多模态，**唯一**的直发开关
- `vision?: VisionModelConfig` —— 独立视觉模型，仅服务 `multimodal=false` 的转述场景（及工具读图）

### 5.2 一次性迁移

在 `normalizeModelSettings()`（[model-settings.ts](file:///e:/Cyrene-Agent/src/main/settings/model-settings.ts#L277-L296)）里，把现有三层判定（`syncWithMain` / 无字段推断 / 默认 true）执行后**立即持久化**结果到 settings 文件，并在文件里写入迁移完成标记（如 `schemaVersion: 2`）。

下次加载时看到 `schemaVersion >= 2` 就跳过全部迁移判定，三层 if 删除。老用户第一次启动应用时自动迁移，之后走干净路径。

### 5.3 删除项

- `loadVisionConfig()` 整个函数（被 `resolveImageRoute` + `resolveToolVisionConfig` 取代）
- `vision.syncWithMain` 旧字段的读取代码（迁移后不再需要）
- build-options.ts 里 `directVisionOk` 的内联判定 → 改调 `resolveImageRoute("attachment", ...)`

---

## 六、各入口的改造对照

| 入口 | 现状 | 改造后 |
|---|---|---|
| 聊天附件（build-options.ts） | 内联 `directVisionOk` + 两分支 | 调 `resolveImageRoute("attachment")`；`reject` 时注入文字提示"当前配置看不了图+怎么修" |
| `read_image`（fs-tools.ts） | `loadVisionConfigLazy` + 自己拼报错 | 调 `resolveToolVisionConfig`；error 原样返回给模型 |
| `read_image_url`（read-image-url-tool.ts） | 同上 | 同上 |
| agent-runtime / bootstrap / chat-ui-ipc / settings-ipc | 四份重复 caption 接线 | 统一两行接线（第四节） |
| moments-agent.ts | 不做判断直接拼 image_url | **本期只接入判定**：`direct` 走现状；`reject` 时跳过图片块并 log（保持现有"直发不降级"语义，不引入 caption） |

---

## 七、执行步骤（每步独立可验证、可提交）

### 阶段 1：路由函数落地（纯新增，零行为变更）

1. 新建 `image-router.ts`，实现 `resolveImageRoute()` + `resolveToolVisionConfig()`
2. 新建 `image-router.test.ts`，覆盖判定表全部 6 种组合（含 Anthropic 地雷场景）
3. **验证**：`npx vitest run src/main/orchestrator/image-router.test.ts` 全绿；现有测试零改动全绿

### 阶段 2：消灭 404 地雷（行为变更仅此一处）

1. `fs-tools.ts` 的 `read_image`、`read-image-url-tool.ts` 的 `read_image_url` 改调 `resolveToolVisionConfig()`
2. **验证**：`npx vitest run src/main/orchestrator/tools` 全绿；手工构造 multimodal+Anthropic+无VLM 配置，确认工具返回的是配置提示而非 404

### 阶段 3：收口四处接线

1. `vision-captioner.ts` 增加 `captionImageSafe()`
2. agent-runtime / bootstrap / chat-ui-ipc / settings-ipc 四处改为标准两行接线
3. **验证**：`npx vitest run src/main` 全量回归（agent-input.test / chat-ui-ipc.test / work-tool-boundary.test 都覆盖这些接线）

### 阶段 4：附件链路与 moments 接入路由

1. build-options.ts 的 `directVisionOk` 改调 `resolveImageRoute("attachment")`；补 `reject` 分支的提示注入
2. moments-agent.ts 接入判定（只加 reject 拦截，不改直发路径）
3. **验证**：`npx vitest run src/main/orchestrator/build-options.test.ts src/main/moments` 全绿

### 阶段 5：一次性迁移 + 删旧代码

1. `normalizeModelSettings()` 写入 `schemaVersion: 2` 并持久化迁移结果
2. 删除 `loadVisionConfig()`、三层迁移判定、`syncWithMain` 读取
3. 更新 `model-settings.vision.test.ts`：迁移用例改为"旧配置 → 迁移后快照断言"
4. **验证**：全量 `npx vitest run`；手工用一份带 `syncWithMain` 的旧 settings 文件启动，确认迁移后文件内容正确、重启不再走迁移分支

### 阶段 6（可选，另立方案）：工具结果直返 image block

多模态主模型 + `read_image` 时工具结果直接带图（需改 tool-registry 的返回类型为 string | content blocks），彻底解决"转述精度卡死"问题。涉及面广，本期不做。

---

## 八、风险与回滚

| 风险 | 缓解 |
|---|---|
| 阶段 2 行为变更影响现有用户（Anthropic 多模态用户工具读图从 404 变配置提示） | 本来就是坏路径，变更即修复；发布说明里提一句 |
| 阶段 5 迁移写坏用户 settings 文件 | 迁移前备份原文件（settings 目录下 `.bak`）；迁移函数纯函数可单测 |
| moments 接入判定改变现有行为 | 只加 reject 拦截；多模态/有VLM 场景行为完全不变 |
| 分阶段提交中途被打断 | 每阶段独立成 commit、独立可运行，随时可停在任一阶段 |

回滚策略：每阶段一个 commit，出问题 `git revert` 单阶段即可，阶段间无隐式依赖（阶段 2-4 都只依赖阶段 1 的新函数）。

---

## 九、决策点（需要拍板）

1. **阶段 6（工具直返图）要不要进本期**？建议不进——先收口，验证稳定后再做
2. **moments 的 reject 场景**：静默跳过图片 + log，还是也注入一句提示文字？建议后者（跟附件链路话术统一）
3. **迁移备份**：`.bak` 文件放 settings 同目录可以吗？还是放 `userData/backups/`？建议后者更干净
