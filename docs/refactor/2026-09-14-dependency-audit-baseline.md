# 生产依赖漏洞处置基线（2026-09-14）

> 快照：`npm audit --omit=dev`，共 30 项：1 严重 / 15 高危 / 14 中危
>
> 配套方案：[2026-09-14-engineering-governance-plan.md](./2026-09-14-engineering-governance-plan.md) 阶段 A
>
> CI 现状：`test.yml` 每次运行留存审计报告工件。高危项清零或限期登记后，把审计步骤改为 `npm audit --omit=dev --audit-level=high` 阻断门禁并移除 `continue-on-error`。
>
> 责任人：维护者本人（默认）。审计结果随漏洞库变化，本清单为当日快照，以 CI 工件为准。

---

## 判定口径

- **是否入包**：electron-builder 把 `package.json` 的 `dependencies`（含传递依赖）打进安装包，`devDependencies` 不入包。renderer 代码经 Vite 打平，但 node_modules 仍会随 asar 分发。
- **输入可控性**：输入是否来自外部网络或下载文件（不可控 / 半可控），还是本机配置与内部数据（可控）。
- **修复路径**：`版本内升级` = 不破坏接口；`跨版本迁移` = 需回归验证；`无上游修复` = 只能登记或缓解。

## 重点项（优先处置）

| 项 | 现状与处置 |
| --- | --- |
| protobufjs（严重） | 两条引入链：飞书 SDK 带 7.6.4；`@xenova/transformers → onnxruntime-web → onnx-proto` 带 6.11.6。通告含任意代码执行类。飞书链随 SDK 升级修复；transformers 链需模型运行时迁移（见下）。 |
| @larksuiteoapi/node-sdk 1.68.0（高危，经 axios） | 升级到 >1.71.0，版本内升级，接口不变；连带修复 axios 与其 protobufjs@7.6.4。输入为飞书开放平台响应（TLS + 官方域名，半可控）。**第一批**。 |
| @xenova/transformers 2.17.2（高危，拖入 4 项） | 拖入 protobufjs@6.11.6 / onnx-proto / onnxruntime-web / sharp@0.32.6。`npm audit` 建议的 1.4.2 是降级，无安全收益，**不采用**。真实路径是迁移到 `@huggingface/transformers`@3（新 onnxruntime），需模型回归验证。**单独审查**。 |
| electron-updater 6.6.2（高危，经 builder-util-runtime 9.3.1 凭据泄露） | 升级到 >6.6.8（6.x 最新），版本内升级。输入为更新源响应。连带修复 builder-util-runtime。**第一批**。 |
| extract-zip 2.0.1（高危，无上游修复） | 唯一使用点 `src/plugins/installer.ts`，解压插件市场的 zip。市场源为 Gitee raw / GitHub，若市场仓库被投毒则输入失控。缓解：解压后校验路径与清单内容；每季度复核上游是否发布修复版本。**登记**。 |
| js-yaml 5.0.0（高危） | 全仓库唯一引用是 `src/main/updater/update-packaging-config.test.ts`（测试专用），运行时未使用。处置：移到 devDependencies（不入包）或确认后删除，低风险动作。**第一批**。 |
| nodemailer 9.0.1（高危） | 升级到 >9.1.0，版本内升级。输入为用户自己的 SMTP 配置与收件地址（可控）。**第一批**。 |

---

## 全量清单（30 项）

| 包 | 级别 | 依赖 | 引入链 | 入包 | 输入 | 修复路径 | 处置 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| protobufjs | 严重 | 传递 | 飞书 SDK；transformers→onnxruntime-web→onnx-proto | 是 | 飞书响应 / 模型文件 | 飞书链随 SDK；transformers 链需迁移 | 待处置（第一批 + 单独审查） |
| @larksuiteoapi/node-sdk | 高 | 直接 | — | 是 | 飞书 API | 版本内升级 >1.71.0 | 待处置（第一批） |
| axios | 高 | 传递 | 飞书 SDK | 是 | 飞书 API | 随 SDK 升级 | 随第一批 |
| electron-updater | 高 | 直接 | — | 是 | 更新源 | 版本内升级 >6.6.8 | 待处置（第一批） |
| builder-util-runtime | 高 | 传递 | electron-updater 带 9.3.1 | 是 | 更新源 | 随 electron-updater | 随第一批 |
| js-yaml | 高 | 直接 | — | 是 | 仅测试使用 | 移 devDependencies / 删除 | 待处置（第一批） |
| nodemailer | 高 | 直接 | — | 是 | 用户 SMTP（可控） | 版本内升级 >9.1.0 | 待处置（第一批） |
| extract-zip | 高 | 直接 | — | 是 | 插件市场 zip | 无上游修复 | 登记风险 + 缓解 |
| @xenova/transformers | 高 | 直接 | — | 是 | 本地/下载模型 | 跨版本迁移，需模型回归 | 单独审查 |
| sharp | 高 | 传递 | @xenova/transformers | 是 | 模型图片预处理 | 随迁移 | 随单独审查 |
| onnxruntime-web | 高 | 传递 | @xenova/transformers | 是 | 模型文件 | 随迁移 | 随单独审查 |
| onnx-proto | 高 | 传递 | onnxruntime-web | 是 | 模型文件 | 随迁移 | 随单独审查 |
| nanoid | 高 | 传递 | docx→nanoid@5.1.14 | 是 | 文档生成内部 | 版本内升级（随 docx） | 待处置（第二批） |
| fast-uri | 高 | 传递 | ajv→fast-uri@3.1.2 | 是 | ajv 校验的 schema | 版本内升级 | 待处置（第二批） |
| ip-address | 高 | 传递 | @modelcontextprotocol/sdk→express-rate-limit | 是 | MCP 请求地址 | 版本内升级 | 待处置（第二批） |
| brace-expansion | 高 | 传递 | exceljs→archiver→readdir-glob→minimatch（2.1.1 入包）；electron-builder / ts-json-schema-generator 的副本为构建期 | 是（exceljs 链） | 内部文件名模式 | 版本内升级 | 待处置（第二批） |
| dompurify | 中 | 直接 | — | 是 | 聊天渲染的富文本 | 版本内升级 >3.4.12 | 待处置（第二批） |
| exceljs | 中 | 直接 | — | 是 | 用户导出 Excel | uuid 链修复或 overrides | 待评估 |
| uuid | 中 | 传递 | exceljs→uuid@8.3.2 | 是 | exceljs 内部 | overrides 到 ≥11.1.1 需回归导出 | 待评估 |
| @nut-tree-fork/nut-js | 中 | 直接 | — | 是 | 本机输入事件（可控） | 无上游修复（range: *） | 登记 |
| @nut-tree-fork/shared | 中 | 传递 | nut-js | 是 | 本机 | 随 nut-js 升级 | 登记 |
| @nut-tree-fork/provider-interfaces | 中 | 传递 | nut-js | 是 | 本机 | 随 nut-js 升级 | 登记 |
| jimp | 中 | 传递 | @nut-tree-fork/nut-js→jimp@0.22.10 | 是 | 本机截图处理 | 无上游修复 | 登记 |
| @jimp/custom | 中 | 传递 | jimp | 是 | 同上 | 无上游修复 | 登记 |
| @jimp/core | 中 | 传递 | @jimp/custom | 是 | 同上 | 无上游修复 | 登记 |
| file-type | 中 | 传递 | @jimp/core→file-type@16.5.4 | 是 | 本机图片 | 无上游修复 | 登记 |
| @hono/node-server | 中 | 传递 | @modelcontextprotocol/sdk | 是 | MCP HTTP 服务 | 版本内升级 ≥1.19.15 | 待处置（第二批） |
| hono | 中 | 传递 | @modelcontextprotocol/sdk、llamaindex | 是 | MCP HTTP | 版本内升级 | 待处置（第二批） |
| mermaid | 中 | 传递 | @ant-design/x→mermaid@11.16.0 | 是 | 聊天渲染的图表语法 | 版本内升级 | 待处置（第二批） |
| qs | 中 | 传递 | 飞书 SDK / MCP SDK / pixi.js 等 | 是 | 内部 URL 解析 | 版本内升级 | 待处置（第二批） |

说明：electron-builder（开发依赖）自带的 brace-expansion@1.1.15 / 2.1.2、vite 的 nanoid@3.3.12、ts-json-schema-generator 的 brace-expansion@2.1.4 也在审计计数内，但不入安装包、仅构建期存在，随对应开发工具升级自然修复，未单列处置项。

---

## 处置批次与期限

- **第一批（建议 2026-09-28 前）**：飞书 SDK、electron-updater、nodemailer、dompurify、js-yaml 归位。均为版本内升级或依赖归属修正，接口不变；每批提交后跑 `npm ci` + 全量测试 + 安装包冒烟。
- **第二批（建议 2026-10-15 前）**：MCP / 渲染链路的传递依赖（ip-address、hono、@hono/node-server、fast-uri、mermaid、nanoid、brace-expansion）。优先通过升级直接依赖（如 @modelcontextprotocol/sdk、@ant-design/x、docx、ajv）带动，不直接改 lock。
- **单独审查（评估结论 2026-10-15 前）**：`@xenova/transformers` 迁移到 `@huggingface/transformers`@3，评估嵌入模型兼容性与包体积变化；Electron 与原生模块（nut-js、@node-rs/jieba、@lancedb）升级单独立项。
- **登记项（每季度复核）**：extract-zip、nut-js / jimp 系。extract-zip 在上游发布修复版本前保持解压后路径校验的缓解措施。
- **待评估**：exceljs→uuid 用 overrides 强制 ≥11.1.1，需回归 Excel 导出后决定；或等 exceljs 上游修复。

每批升级遵循治理方案 A2-4：小批提交、`npm ci` + 完整测试 + 安装包冒烟验证；不套用降级式自动修复。
