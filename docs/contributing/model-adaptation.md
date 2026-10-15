# 模型适配贡献指南

模型发布快，想使用的新型号还没适配时，可以直接提 PR（合并请求）。准确型号、能力依据和聚焦回归用例齐全的单厂商声明更新，无需等待维护者认领。需要协助时，使用仓库的“模型适配 / 贡献认领” Issue（问题单）模板。

先看 [模型适配清单](../references/adapted-models.md)。推荐型号不等于所有协议、端点和能力都支持；清单明确标出历史未核验与未知项。

## 从哪里改

| 内容 | 唯一维护入口 | 使用位置 |
| --- | --- | --- |
| 型号与推荐用途 | `src/shared/vendor-registry/entries/<厂商>.ts` 的 `models` | 界面候选和生成清单 |
| 界面预填值 | 同文件的 `presetDefaults` | 模型预设 |
| 运行默认与厂商级信息 | 同文件的 `capability` | 现有适配器 |
| 推理规则 | 同文件的 `reasoningRules` | 共享推理解析与请求转换 |
| 采样白名单 | 同文件的 `samplingRules` | 主进程采样策略 |
| 结构化输出声明 | 同文件的 `structuredOutputRules` | 主进程结构化输出配置 |

沿用已有声明函数、适配器和官方 SDK（软件开发工具包）。常规型号更新不需要新增通用请求框架或外部模型数据库。修复预算、超时、重试、参数数值映射由现有消费者负责。

## 三种贡献范围

### 1. 现有能力规则已覆盖的新型号

1. 在所属厂商的 `models` 添加准确接口名称，按需要填写 `recommendedFor: ["chat"]` 或 `"vision"`。历史名称可保留 `recommendedFor: []`，不要擅自删除存量型号。
2. 检查**首条命中**的推理、采样与结构化输出规则。名称相似不能证明兼容；在 PR 中提供型号资料和适用协议。
3. 推荐协议下无覆盖或无有效证据的能力，在 `unknownCapabilities` 写明协议与原因。没有结构化输出规则时保留提示词 JSON（结构化文本）回退；没有采样白名单时不注入采样参数。
4. 添加准确型号的行为断言，预期值独立填写，不从同一注册表复制生成。生成清单后一起提交。

### 2. 需要新增或修正规则的型号

仍以所属厂商文件为入口。具体规则放在宽泛规则前；正则不使用 `g`（全局匹配）或 `y`（粘连匹配）标志。不要手填规则的厂商标识或末尾 `/.*/` 兜底，声明函数自动补齐。

只有确认型号家族在托管或自定义厂商场景中也可识别时，才设置 `modelInferencePattern`（跨厂商推断匹配式）。厂商内宽泛后缀不能直接用作跨厂商推断。添加系列规则时填写 `familyLabel`（人工系列说明），并写正向型号、邻近反例和重叠规则优先级用例。

结构化输出规则必须明确 `transport`（调用协议）。一种协议的证据不能宣传为另一种协议支持；官方端点判定也不会因目录增加型号自动扩大。采样的 `requiresReasoningOff`（要求关闭思考）条件和温度上限需要对应行为用例。

### 3. 新厂商或公共逻辑变化

先开问题单讨论新厂商、新协议、认证、缓存、官方端点范围、公共适配器接口、请求转换与修复策略。新厂商确认方向后，新增厂商文件，在 `index.ts` 两套厂商顺序中分别登记，界面层补图标和官网展示。已有厂商的常规型号更新不需要走这一步。

## 一个完整的目录添加示例

下面是**流程演示名称，不是真实型号支持声明**。假设在 `qwen.ts` 的 `models` 末尾添加一项：现有千问推理前缀会命中它，采样和输出规则未覆盖，明确登记未知。

```ts
{
  model: "qwen-plus-contribution-example",
  recommendedFor: ["chat"],
  note: "演示名称；实际贡献替换成厂商准确型号并在 PR 提供资料。",
  unknownCapabilities: [
    { feature: "sampling", transport: "openai", note: "采样白名单未覆盖，等待核验。" },
    { feature: "structuredOutput", transport: "openai", note: "未核验原生输出，保留提示词 JSON 回退。" },
  ],
},
```

在 `src/shared/vendor-registry/resolver-golden.test.ts` 增加独立行为断言：

```ts
test("新千问型号保留已有推理开关", () => {
  const cap = resolveReasoningCapability("qwen", "qwen-plus-contribution-example");
  expect(cap.control).toBe("toggle");
  expect(cap.requestStyle).toBe("qwen-enable-thinking");
  expect(cap.supportsDisable).toBe(true);
});
```

这种仅补目录的贡献，通常修改一个厂商文件、一个相关用例和生成清单。新增能力规则时还要补实际消费者的请求字段或回退用例。

## 能力依据怎么写

新能力规则的 `metadata`（审核元数据）包含 `status`（声明状态）和 `evidence`（依据）：

```ts
metadata: {
  status: "supported",
  evidence: {
    kind: "official",
    url: "https://example.com/vendor-documentation", // 替换为真正支持此声明的资料
    checkedAt: "2026-10-04",                       // 替换为实际核验日期
    transports: ["openai"],
  },
},
```

脱敏实测可使用 `kind: "observed"`，填写 `artifact`（记录文件或公开链接）、`checkedAt`、`transport` 和公开 `endpoint`（接口地址）。记录准确型号、请求能力字段、响应或错误；清除密钥、授权头、私人对话和带凭证的地址。

`kind: "legacy"` 仅用于旧规则迁移，不能把历史注释当成当前官方保证。旧协议矩阵引用缺失，当前保留为历史未核验。新型号复用旧规则时，补型号资料并保留原证据等级，未核验的协议明确未知。不要为通过检查编造核验日期或链接。

元数据不控制运行开关；仅改 `status` 不能修正请求行为，实际能力变更还需要修改规则字段和消费者用例。别名只作说明，不会自动替换发送给服务的名称。

## 本地验证与提交

安装仓库依赖后，不需要付费密钥即可执行：

```powershell
pnpm exec vitest run src/shared/vendor-registry src/shared/reasoning.test.ts src/renderer/settings/api/presets.test.ts
pnpm run check:main
pnpm run check:renderer
pnpm run generate:adapted-models
pnpm run check:adapted-models
```

按修改能力追加聚焦检查：

```powershell
# 采样与实际请求字段
pnpm exec vitest run src/main/orchestrator/vendors
# 输出模式、协议和端点回退、修复预算
pnpm exec vitest run src/main/orchestrator/structured-output
```

检查命令会验证重复型号、推荐型号的能力覆盖或未知说明、证据基本格式，以及生成清单是否过期。只检查模式不会改文件，允许换行风格差异。CI（持续集成）运行同样的清单检查；生成结果纳入版本控制，不手工修改。

提交时附厂商、准确型号、协议、端点类型、资料或脱敏实测、核验日期、未知项和实际执行的验证命令。提交说明沿用 `feat(模型):中文描述`、`fix(模型):中文描述` 等现有格式，保持改动集中。

## 已记录的边界

- 当前官方端点判断仍使用运行默认地址及月之暗面编码入口；MiniMax 的兼容入口可能被判为自定义端点。扩充端点范围需要独立验证。
- 记忆调用方与其他调用方选取输出协议的来源尚不统一，本轮整理保留现状。
- `gpt-6.1-sol` 虽在候选和推理声明中，现有聊天补全结构化输出规则没有覆盖；目录增加型号不会自动补上。
- 工具支持是厂商级声明，视觉候选是用途推荐；没有型号级证据时不宣传为逐型号实测。
