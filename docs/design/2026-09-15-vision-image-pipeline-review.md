# Cyrene-Agent 读图逻辑现状与问题

> 整理时间：2026-09-15
> 目的：梳理当前图片处理链路的真实逻辑与设计缺陷，供重新设计参考。

---

## 一、涉及的文件清单

### 核心链路

| 文件 | 职责 |
|---|---|
| `src\main\settings\model-settings.ts` | 配置层：`multimodal` 开关、`vision`（独立视觉模型）配置、`loadVisionConfig()` 路由判断 |
| `src\main\orchestrator\vision-captioner.ts` | 协议层：`captionImage()`，唯一多模态协议接触点，永远拼 OpenAI 兼容 `/chat/completions` |
| `src\main\orchestrator\build-options.ts` | 主链路发图：`directVisionOk` 判定 + 直发挂块 / caption 降级两条分支 |
| `src\main\orchestrator\vendors\anthropic-adapter.ts` | Anthropic 协议转换：`image_url` → 原生 `image` 块，含 MIME 白名单 |
| `src\main\orchestrator\tools\fs-tools.ts` | `read_image` 工具：本地图片 → base64 → 视觉模型转述 |
| `src\main\orchestrator\tools\builtin-tools\read-image-url-tool.ts` | `read_image_url` 工具：公网 URL 直传视觉模型 |

### 重复接线（四处几乎相同的 caption 调用）

| 文件 | 场景 |
|---|---|
| `src\main\orchestrator\agent-runtime.ts`（约 L210） | 主对话链路直发失败后的降级回调 |
| `src\main\channels\bootstrap.ts`（约 L175） | 频道 bot（QQ 等）收图 |
| `src\main\chats\chat-ui-ipc.ts`（约 L182） | 聊天 UI 发图 |
| `src\main\settings\settings-ipc.ts`（约 L277） | 设置页视觉模型连通性测试 |

### 外围（也会碰图）

| 文件 | 说明 |
|---|---|
| `src\main\moments\moments-agent.ts` | 动态图片直接拼 `image_url` 块（无 multimodal 判断） |
| `src\main\channels\agent-input.ts` | 频道图 caption 注入 |
| `src\main\orchestrator\context-manager.ts` | image_url 块按固定 token 估算 |
| `src\main\renderer\settings\...` | 设置界面（视觉模型配置、multimodal 开关） |

---

## 二、当前逻辑全景

### 入口一：用户发图（聊天附件）

```
用户在聊天框发图
  │
  ├─ multimodal = true（默认）
  │    └─ 直发：build-options.ts 把图读成 base64，
  │       拼成 OpenAI image_url 块塞进最后一条 user 消息
  │       → 主模型直接看图
  │       → Anthropic 协议时由 anthropic-adapter 转成原生 image 块
  │       → 主模型若直发失败，回退 caption 降级（buildImageCaptionFallbackMessages）
  │
  └─ multimodal = false
       └─ 转述：每张图先调视觉模型拿文字描述，
          以"【图片视觉信息】"文本块注入 user 消息 → 主模型只看文字
```

### 入口二：工具读图（read_image / read_image_url）

```
模型调用工具
  │
  ├─ read_image：本地文件 → 校验大小/格式 → base64
  └─ read_image_url：公网 URL 原样直传（本机不下载）
       │
       └─ 两者都调 loadVisionConfig() 取"视觉模型配置"
          ├─ multimodal=true 且 OpenAI 兼容 → 用主模型自己当视觉模型
          ├─ multimodal=true 且 Anthropic 协议 → 已配独立视觉模型就用它；
          │   没配 → 返回主模型 Anthropic 地址（拼 /chat/completions 必然 404）
          └─ multimodal=false → 用独立视觉模型，没配则返回 null（工具报错）
```

### 配置判断的完整规则（model-settings.ts）

`loadVisionConfig()` 的判定顺序：

1. 先展开默认档案再取顶层镜像（防止空壳 provider 误判）
2. `multimodal = true`：
   - 主模型是 Anthropic 协议 → 视觉链路只拼 OpenAI 兼容格式，复用主模型地址必然 404，所以已配独立视觉模型则优先用；没配则照样返回主模型地址（埋雷，见问题 2）
   - 否则 → 返回主模型配置（主模型自己当视觉模型）
3. `multimodal = false` → 返回 `vision` 独立视觉模型配置（三字段齐全才有效，否则 null）

### 配置迁移（三层历史包袱判定）

- 旧字段 `vision.syncWithMain === true` → 映射为 `multimodal = true`
- 旧配置无 `multimodal` 字段但独立视觉模型三字段齐全 → `multimodal = false`（沿用老行为）
- 都不满足 → 默认 `multimodal = true`

### Anthropic 协议图片转换（anthropic-adapter.ts）

- data URL → `source.type = base64`，但 MIME 必须在白名单：**png / jpeg / webp / gif**
- 白名单外（bmp、svg 等）→ 降级为文本占位 `[图片格式 xxx 暂不支持直发，已跳过]`，图被丢弃
- http(s) URL → `source.type = url` 原样直传

---

## 三、问题清单

### 问题 1：路由判断散落三处，接线代码复制四份

"这张图发给谁"的判定没有一个统一入口：

- 发图直发的判定在 `build-options.ts` 的 `directVisionOk`
- 工具读图的判定在 `model-settings.ts` 的 `loadVisionConfig()`
- `moments-agent.ts` 干脆不做判断，直接拼 image_url 块

而"调视觉模型转述"的接线代码（loadVisionConfig → 判空 → captionImage）在 agent-runtime / bootstrap / chat-ui-ipc / settings-ipc 四处几乎逐字重复。

**后果**：改一处路由逻辑要摸五个以上文件；新增图片入口必然再抄一遍。

### 问题 2：埋了一颗 404 地雷

组合：`multimodal = true` + 主模型 Anthropic 协议 + 未配独立视觉模型。

此时 `loadVisionConfig()` 返回主模型的 Anthropic baseUrl，而 captioner 只会拼 `/chat/completions`——Anthropic 走 `/v1/messages`，**必然 404**。注释里自己都承认了这一点，但仍然选择返回这个注定失败的配置，把失败拖到运行时才暴露，且报错形态像网络问题，用户难以自查。

**正确做法**：这种组合应在配置层显式返回"不可用"，并给出人话提示（"Anthropic 协议下请配置独立视觉模型或关闭多模态直发"）。

### 问题 3：多模态主模型通过工具看图，看到的永远是转述而非图

`read_image` / `read_image_url` 的返回值是纯文本（`max_tokens: 512` 的文字描述）。即使主模型本身多模态，通过工具读截图也只能拿到"画面里有个红色报错"这种概括，拿不到原始像素。

而 OpenAI / Anthropic 协议现在都支持工具结果直接携带 image block。当前设计等于：

- 白白浪费多模态能力
- "找 UI 错别字""读图表数据"这类需要像素级精度的任务被转述精度卡死
- 连续多图时还要担心转述文本回灌撑爆上下文（当前靠"简洁"指令缓解，治标不治本）

### 问题 4：一个布尔量要过三道迁移判定

`multimodal` 的最终取值取决于：旧字段 `syncWithMain`、旧配置是否带 `multimodal` 字段、独立视觉模型是否三字段齐全、默认值 true——四层条件叠加。能理解是历史包袱，但可读性和可测试性都差，且"默认 true"意味着纯文本主模型的用户发图会先走直发失败再降级，多付一次失败请求的延迟。

### 问题 5：格式支持不一致

- `read_image` 工具接受：png / jpg / jpeg / gif / webp / bmp / svg（七种）
- Anthropic 直发白名单：png / jpeg / webp / gif（四种）

bmp / svg 的图在工具链路能被"看"（走视觉模型转述），但作为附件直发 Anthropic 主模型时会被静默降级成文本占位。同一个文件，走不同入口结果不同，且没有统一的格式归一化层（比如 bmp → png 转码）。

### 问题 6：降级路径存在静默丢弃

`withCaptionedImageAttachments` 里：降级路径上若没配独立视觉模型（`captionImageForFallback` 缺失），图片会被完全丢弃，只剩文件名文本。虽然打了 warn 日志，但对用户侧是静默失败——模型只会含糊地说"看不了图"，用户不知道是配置问题。

---

## 四、值得保留的设计

重新设计时这些方向是对的，建议保留：

1. **vision-captioner 作为唯一多模态协议出口**——一处协议、一处维护，厂商差异（temperature 兼容、max_tokens vs max_completion_tokens、超时）都收在这一个文件里
2. **视觉链路永远走 OpenAI 兼容格式**——避免给 captioner 再维护一套 Anthropic 协议，复杂度减半
3. **直发失败有 caption 兜底**——安全网存在，只是接线方式差
4. **URL 直传不本机下载**（read_image_url）——省流量省内存，厂商服务器拉图

---

## 五、重新设计的关键决策点

供设计时思考，不是结论：

1. **统一路由函数**：是否收成单一函数，输入（图片来源：附件/工具/频道/动态 × 协议 × multimodal × 视觉配置），输出三种明确结果：直发 / 转述 / 拒绝（带人话原因）？
2. **工具读图是否支持直返 image block**：多模态主模型 + read_image 时，工具结果直接带图而不是转述？需要动 tool result 的 content 类型
3. **Anthropic + multimodal 组合怎么处理**：显式拒绝？强制要求独立视觉模型？还是 captioner 学会拼 `/v1/messages`？
4. **格式归一化层**：bmp/svg 是否在入口统一转码成 png，消灭白名单不一致？
5. **迁移逻辑是否可以简化**：老配置用户占比多少？是否可以一次性迁移完删掉三层判定？
6. **moments / channels 等外围入口是否纳入统一路由**：还是允许它们保持独立（它们只直发不降级，语义确实略不同）

---

## 六、一句话总结

架构方向（单一协议出口、OpenAI 兼容、降级兜底）是对的，垃圾在**路由判断没收口、接线代码抄了四遍、失败路径不诚实（404 地雷 + 静默丢图）、多模态能力被转述浪费**。重新设计的核心是收口路由 + 让失败尽早、明确地暴露。
