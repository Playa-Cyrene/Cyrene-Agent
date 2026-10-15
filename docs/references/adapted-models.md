# 模型适配清单

<!-- 自动生成：pnpm run generate:adapted-models；不要手工修改此文件。 -->

本清单描述仓库中的静态声明，不代表每个型号都经过当前官方接口实测。历史迁移规则统一标为「历史未核验」。

- 型号目录、能力规则和界面预填值均维护在 `src/shared/vendor-registry/entries/`。
- 推理与采样列按预设协议展示；结构化输出分协议列出，仅适用于现有官方端点判定。中转、自定义和本地端点保留提示词 JSON 回退。
- 元数据记录证据，不改变请求策略。型号名称和别名说明不会自动重写用户请求。缺少白名单时采样参数不注入。
- 历史代码中的验证等级保留原值，不能替代本清单的证据核验。未匹配结构化输出规则时保守回退。
- 贡献步骤见 [模型适配贡献指南](../contributing/model-adaptation.md)。

## MiniMax（稀宇科技）

预设协议：anthropic；预填地址：https://api.minimaxi.com/anthropic。

运行默认：anthropic / https://api.minimaxi.com/anthropic / MiniMax-M3。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| MiniMax-M3.1-Flash-Preview | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh / max；不可关闭；默认 high；自动 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/minimax.ts<br>未知 sampling / anthropic：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / anthropic：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| MiniMax-M3 | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：提示词 JSON（专用契约）；等级 M；发送 JSON 对象提示；分离思考（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/minimax.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 structuredOutput / anthropic：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| MiniMax-M2.7 | 主模型 | 强制思考；不可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/minimax.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / anthropic：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| MiniMax-M2.5 | 主模型 | 强制思考；不可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/minimax.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / anthropic：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | MiniMax-M2.x 系列 | /^MiniMax-M2\./i | 强制思考；不可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/minimax.ts |

## DeepSeek（深度求索）

预设协议：openai；预填地址：https://api.deepseek.com。

运行默认：openai / https://api.deepseek.com / deepseek-flash。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| deepseek-flash | 主模型 | 思考开关与档位；档位 low / high / max；可关闭；默认 high；自动 high（历史未核验） | 温度 / Top-P；仅关闭思考时（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| deepseek-v4-pro | 主模型 | 思考开关与档位；档位 low / high / max；可关闭；默认 high；自动 high（历史未核验） | 温度 / Top-P；仅关闭思考时（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| deepseek-v4-flash | 非推荐 | 思考开关与档位；档位 low / high / max；可关闭；默认 high；自动 high（历史未核验） | 温度 / Top-P；仅关闭思考时（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |
| deepseek-v4-flash-vision-exp | 非推荐 | 思考开关与档位；档位 low / high / max；可关闭；默认 high；自动 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>历史清单保留名称；不改写用户请求。 |
| deepseek-chat | 非推荐 | 未知（已有规则未确认） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>历史清单保留名称；不改写用户请求。 |
| deepseek-reasoner | 非推荐 | 未知（已有规则未确认） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/deepseek.ts<br>历史清单保留名称；不改写用户请求。 |

## 豆包（火山方舟）

预设协议：openai；预填地址：https://ark.cn-beijing.volces.com/api/v3。

运行默认：openai / https://ark.cn-beijing.volces.com/api/v3 / doubao-seed-2-1-pro-260628。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| doubao-seed-2-1-pro-260628 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/doubao.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| doubao-seed-2-0-pro-260215 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/doubao.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| doubao-seed-2-0-lite-260428 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/doubao.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| doubao-seed-2-0-mini-260428 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/doubao.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | doubao-seed 系列 | /^doubao-seed-/i | 思考开关；可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/doubao.ts |

## GLM（智谱）

预设协议：openai；预填地址：https://open.bigmodel.cn/api/paas/v4。

运行默认：openai / https://open.bigmodel.cn/api/paas/v4 / glm-5.2。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| glm-5.3 | 主模型 | 思考开关与档位；档位 low / high / max；不可关闭；默认 high；自动 high（历史未核验） | 温度 / Top-P（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| glm-5.3-flash | 主模型 | 思考开关与档位；档位 low / high / max；不可关闭；默认 high；自动 high（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| glm-5.3-flashx | 主模型 | 思考开关与档位；档位 low / high / max；不可关闭；默认 high；自动 high（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| glm-5.2 | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high；自动 high（历史未核验） | 温度 / Top-P（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| glm-5.1 | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| glm-5-turbo | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| glm-4.7 | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P（历史未核验） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts |
| glm-5v-turbo | 非推荐 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>历史清单保留名称；不改写用户请求。 |
| glm-4.5 | 非推荐 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>历史清单保留名称；不改写用户请求。 |
| glm-4.6 | 非推荐 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | glm-4.5 / glm-4.6 / glm-4.7 | /^glm-(4\.5\|4\.6\|4\.7)/i | 思考开关；可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/glm.ts |

## Kimi（月之暗面）

预设协议：openai；预填地址：https://api.moonshot.cn/v1。

运行默认：openai / https://api.moonshot.cn/v1 / kimi-k2.7-code。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| kimi-k2.6 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A；部分型号使用既有慢修复预算（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| kimi-k2.5 | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| kimi-k2-thinking | 主模型 | 强制思考；不可关闭（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| kimi-k3 | 非推荐 | 思考档位；档位 low / high / max；不可关闭；默认 high；自动 high（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A；部分型号使用既有慢修复预算（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |
| kimi-k2.7-code | 非推荐 | 强制思考；不可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A；部分型号使用既有慢修复预算（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |
| kimi-k2.7-code-highspeed | 非推荐 | 强制思考；不可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A；部分型号使用既有慢修复预算（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/kimi.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |

## Qwen（通义千问）

预设协议：openai；预填地址：https://dashscope.aliyuncs.com/compatible-mode/v1。

运行默认：openai / https://dashscope.aliyuncs.com/compatible-mode/v1 / qwen-max。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| qwen-max | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P；重复惩罚 qwen；温度上限 1.99（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/qwen.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| qwen-plus | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P；重复惩罚 qwen；温度上限 1.99（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/qwen.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| qwen-turbo | 主模型 | 思考开关；可关闭（历史未核验） | 温度 / Top-P；重复惩罚 qwen；温度上限 1.99（历史未核验） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/qwen.ts<br>采样：历史未核验：迁自 src/main/orchestrator/vendors/style-sampling.ts<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | qwen-*-thinking 系列（厂商内后缀；跨厂商限明确千问前缀） | /-thinking$/i | 强制思考；不可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/qwen.ts |
| 推理 | qwen3 系列（3.5 / 3.6 / 3.7 / 3.8） | /^qwen3/i | 思考开关；可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/qwen.ts |

## ChatGPT（OpenAI）

预设协议：responses；预填地址：https://api.openai.com/v1。

运行默认：responses / https://api.openai.com/v1 / 。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| gpt-6-astra | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；不可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-6.1-sol | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-6-sol | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-6-luna | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-5.6 | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-5.6-terra | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gpt-5.6-luna | 主模型 | 思考档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：JSON Schema；等级 A（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / responses：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / responses：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | gpt-5 系列 | /^gpt-5/i | 思考档位；档位 minimal / low / medium / high；可关闭；默认 medium（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts |
| 推理 | o1 系列 | /^o1/i | 思考档位；档位 low / medium / high；可关闭；默认 medium（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts |
| 推理 | o3 系列 | /^o3/i | 思考档位；档位 low / medium / high；可关闭；默认 medium（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts |
| 推理 | o4 系列 | /^o4/i | 思考档位；档位 medium / high；可关闭；默认 medium（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/chatgpt.ts |

## Claude（Anthropic）

预设协议：anthropic；预填地址：https://api.anthropic.com/v1。

运行默认：anthropic / https://api.anthropic.com/v1 / claude-sonnet-4-6。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| claude-fable-5 | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / anthropic：现有采样白名单未覆盖该型号。 |
| claude-opus-4-8 | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / anthropic：现有采样白名单未覆盖该型号。 |
| claude-sonnet-4-6 | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / anthropic：现有采样白名单未覆盖该型号。 |
| claude-haiku-5-5 | 主模型 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 medium | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A<br>responses：未知（提示词 JSON 回退） | 推理：官方资料 [链接](<https://platform.claude.com/docs/en/build-with-claude/effort>)；核验 2026-10-08；协议 anthropic<br>输出 anthropic：官方资料 [链接](<https://platform.claude.com/docs/en/build-with-claude/structured-outputs>)；核验 2026-10-08；协议 anthropic<br>2026-10-07 发布；固定型号名，无日期后缀、无别名。<br>未知 sampling / anthropic：官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。 |
| claude-opus-4-7 | 非推荐 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |
| claude-opus-4-6 | 非推荐 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |
| claude-sonnet-5 | 非推荐 | 思考开关与档位；档位 low / medium / high / xhigh / max；可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：JSON Schema；等级 A（历史未核验）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/claude.ts<br>输出 anthropic：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>历史清单保留名称；不改写用户请求。 |

## MiMo（小米）

预设协议：openai；预填地址：https://api.xiaomimimo.com/v1。

运行默认：openai / https://api.xiaomimimo.com/v1 / mimo-v2.6-pro。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| mimo-v2.6-pro | 主模型 / 视觉 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/mimo.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| mimo-v2.6-flash | 主模型 / 视觉 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/mimo.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |
| mimo-v2.6-pro-ultraspeed | 主模型 | 思考开关；可关闭（历史未核验） | 未知（无采样白名单） | openai：JSON 对象；等级 B（历史未核验）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/mimo.ts<br>输出 openai：历史未核验：迁自 src/main/orchestrator/structured-output/profiles.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | mimo-v2.x 系列（含 V2.5） | /^mimo-v2\./i | 思考开关；可关闭（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/mimo.ts |

## Grok（xAI）

预设协议：openai；预填地址：https://api.x.ai/v1。

运行默认：openai / https://api.x.ai/v1 / grok-4.7。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| grok-4.7 | 主模型 | 思考档位；档位 low / medium / high / xhigh；不可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/grok.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| grok-4.6 | 主模型 | 思考档位；档位 low / medium / high / xhigh；不可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/grok.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| grok-4.5 | 主模型 | 思考档位；档位 low / medium / high；不可关闭；默认 high（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/grok.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| grok-build-0.1 | 主模型 | 未知（无专用规则） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 未知 reasoning / openai：现有推理规则未确认该型号。<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| grok-4.20-multi-agent | 非推荐 | 强制思考；不可关闭（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/grok.ts<br>历史清单保留名称；不改写用户请求。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | grok-4 系列 | /^grok-4/i | 思考档位；档位 low / medium / high；不可关闭；默认 high（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/grok.ts |

## Gemini（Google）

预设协议：openai；预填地址：https://generativelanguage.googleapis.com/v1beta/openai。

运行默认：openai / https://generativelanguage.googleapis.com/v1beta/openai / gemini-3.8-flash。

工具支持：厂商级声明 支持，未逐型号核验。视觉推荐仅表示目录推荐用途，未逐型号核验。

| 型号 | 界面推荐 | 推理（预设协议） | 采样（预设协议） | 结构化输出（官方端点） | 证据与限制 |
| --- | --- | --- | --- | --- | --- |
| gemini-3.8-flash | 主模型 | 思考档位；档位 low / medium / high；不可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gemini-3.1-pro | 主模型 | 思考档位；档位 low / medium / high；不可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gemini-3.5-flash | 主模型 | 思考档位；档位 low / medium / high；不可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gemini-2.5-flash | 主模型 | 思考开关与档位；档位 low / medium / high；可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts<br>未知 sampling / openai：现有采样白名单未覆盖该型号。<br>未知 structuredOutput / openai：预设协议没有专用结构化输出规则，保留提示词 JSON 回退。 |
| gemini-2.5-pro | 非推荐 | 思考档位；档位 low / medium / high；不可关闭；默认 medium（历史未核验） | 未知（无采样白名单） | openai：未知（提示词 JSON 回退）<br>anthropic：未知（提示词 JSON 回退）<br>responses：未知（提示词 JSON 回退） | 推理：历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts<br>历史清单保留名称；不改写用户请求。 |

### 人工标注的规则范围

以下为规则说明，实际型号仍按首条匹配生效；系列标签不承诺未来型号兼容。

| 能力 | 系列标签 | 实际匹配 | 声明 | 证据 |
| --- | --- | --- | --- | --- |
| 推理 | gemini-3 系列 | /^gemini-3/i | 思考档位；档位 low / medium / high；不可关闭；默认 medium（历史未核验） | 历史未核验：迁自 src/shared/vendor-registry/entries/gemini.ts |

## 自定义端点

`custom-cloud`（云端自定义端点）与 `custom-local`（本地模型端点）不维护内置型号推荐；用户填写实际服务提供的名称和协议。
