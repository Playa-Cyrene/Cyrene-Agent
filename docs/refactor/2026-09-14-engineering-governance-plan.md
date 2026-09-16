# 工程治理改进实施方案

> 日期：2026-09-14
>
> 状态：阶段 A、B 已实施（2026-09-14，漏洞处置清单见 [2026-09-14-dependency-audit-baseline.md](./2026-09-14-dependency-audit-baseline.md)；安装包工作流为 .github/workflows/package-windows.yml，发布（草稿 Release）待 GitHub 托管恢复后另建）；C/D 待实施
>
> 范围：CI/CD（持续集成/持续部署）、依赖治理、临时目录、模块命名、主进程组合根
>
> 基线：本地 `eb6c311a`；工作区已有未提交代码与产品资源变更，本方案不将其计入实施范围。

## 1. 目标与现状

目标是让每次合入都覆盖权威测试全集，让生产依赖风险可追踪，让 Windows（微软桌面操作系统）安装包可重复构建，并降低主进程装配文件的修改冲突。产品行为、设置和用户数据格式保持不变。

| 事项 | 已确认现状 | 目标 |
| --- | --- | --- |
| 测试门禁 | `.github/workflows/test.yml` 构建后按手写目录运行测试；当前 `src/main` 的 358 个测试文件中有 95 个未被选中 | 直接运行 `vitest.config.ts` 定义的完整测试集，新增测试自动纳入 |
| 桌面应用交付 | 有 `electron-builder.yml` 和本地 `package:win:dir`，无桌面安装包构建、产物留存和发布工作流；插件 SDK（软件开发工具包）已有独立发布流 | 先有可下载、可验证的 Windows 安装包，再单独开启发布 |
| 依赖安全 | `package-lock.json` 已提交，CI 使用 npm（依赖包管理工具）的 `npm ci`；2026-09-14 的 `npm audit --omit=dev` 报 30 项：1 严重、15 高危、14 中危；无自动更新配置 | 逐项处置或有期限地登记风险，防止新增高危问题 |
| 临时目录 | `.gitignore` 覆盖多数产物，但根目录存在大量被忽略的缓存、旧构建和验证目录 | 建立固定输出位置及安全清理流程，不误删产品资源和本地模型 |
| 模块命名 | `src/renderer/tast/` 是明确的拼写错误；`cita/` 与 `services/cita/` 分别是领域实现和装配工厂 | 修正确定错误，记录语义边界，不做无收益的全仓库改名 |
| 组合根 | `src/main/application/default-dependencies.ts` 为 663 行，除了装配还含记忆协调、计划模式处理和提醒抑制策略 | 保留装配职责，把业务规则移到已有模块，并由测试固定启动顺序 |

上述漏洞数是一次审计快照，不等于 30 条均可从应用外部触发；升级前应核对传递依赖链、实际调用路径和修复版本。当前 README（项目说明文件）另有 GitHub（代码托管平台）仓库暂不可用的公告；真正启用远端发布前须验证仓库和发布权限已恢复。

## 2. 先复用现成能力

| 能力 | 采用的现成方案 | 替代的自实现 | 成本与限制 | 保留的自定义部分 |
| --- | --- | --- | --- | --- |
| 全量测试 | 已有 Vitest（测试框架）的 `include` 配置和 `npm test` | 手写目录白名单 | 基本无新增依赖；Windows 单进程测试耗时需测量 | 必要时按性能数据划分独立任务，但最终全量门禁必须保留 |
| 依赖安装与安全审计 | 已有 `npm ci`、锁文件及 npm 内置 `audit` | 自写依赖扫描器 | 审计依赖公开漏洞库，不能代替可达性和行为验证 | 风险分级、例外记录和回归测试 |
| 依赖更新 | GitHub 内置 Dependabot（依赖自动更新工具）；若主仓库长期改在 Gitee（代码托管平台），再评估 Renovate（依赖更新机器人） | 人工定期逐包巡检脚本 | Dependabot 不增加运行时依赖，但依赖 GitHub 托管与审查时间；Renovate 自托管有运营成本 | 原生模块、模型运行时和 Electron（桌面应用框架）升级的人工验收 |
| 安装包 | 已有 `electron-builder`、NSIS（Windows 安装器系统）配置和准备脚本 | 新造打包/更新系统 | Windows 构建需 Rust（系统编程语言）工具链与第三方二进制下载；签名和正式发布另需凭据 | 构建前检查、产物验证和发布授权 |
| 临时文件 | `.gitignore`、`git status --ignored`、`git clean -ndX` | 自研垃圾回收服务 | `git clean` 可预览，但不能对整个仓库直接执行删除，因忽略项含本地模型和产品资源 | 仅对已确认的路径做定向清理 |
| 依赖装配 | 已有 `application` 分阶段启动模块与各领域 `bootstrap` 工厂 | 新增通用依赖注入容器 | 没有新依赖；迁移时须保护启动次序与退出注册 | 少量跨模块回调与组合根接线 |

参考：[GitHub Dependabot 配置](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates)、[npm audit 文档](https://docs.npmjs.com/cli/v11/commands/npm-audit/)、[electron-builder 发布配置](https://www.electron.build/v26/docs/publish/)。

## 3. 分阶段实施

### 阶段 A：合入门禁与依赖基线（P0，先完成）

1. 将 `.github/workflows/test.yml` 的手写测试目录步骤收敛为一次 `npm test -- --reporter=dot`；保留 `npm ci --foreground-scripts` 和 `npm run build`。如果全量测试耗时不能接受，先测量并优化测试隔离，不再维护第二份路径清单。
2. 在同一工作流执行 `npm run check:plugin-schema`，以验证源码与生成契约一致。插件包已有独立 `plugin-sdk.yml`，不重复发布逻辑。
3. 为生产依赖增加 `npm audit --omit=dev --json` 报告。基线未清零前先留存报告并明确责任人；修复或限期登记现有高危问题后，改为 `npm audit --omit=dev --audit-level=high` 的阻断门禁。不能永久采用 `continue-on-error` 掩盖失败。
4. 对现有漏洞按「直接/传递依赖、是否打入安装包、输入是否可控、修复是否破坏接口」建清单。优先检查 `protobufjs`、`@larksuiteoapi/node-sdk`、`@xenova/transformers`、`electron-updater`、`extract-zip`、`js-yaml`、`nodemailer`。每个升级分小批提交，并运行 `npm ci`、完整测试和安装包冒烟验证。对无安全收益的降级式自动修复不要直接套用。
5. 增加 `.github/dependabot.yml`，每周检查根目录 npm 和 GitHub Actions（自动化工作流）依赖，设置合理的同时打开请求上限。`@types/ws` 从生产依赖移至开发依赖，并确认打包仍能加载 `ws`。原生模块、Electron、模型运行时更新单独审查。

验收：任意新增 `src/main/application` 或 `src/main/orchestrator/harness` 测试失败都能令 CI 失败；构建、测试、插件模式契约检查均为绿色；高危生产依赖有明确处置状态。审计结果随漏洞库变化，验收使用实施当日快照。

### 阶段 B：安装包构建与发布（P1，依赖阶段 A）

1. 新建 Windows 安装包工作流，复用 `build`、`build:screenshot-helper`、`prepare:mingit`、`prepare:mpv`，然后运行 `electron-builder --win nsis --publish never`。`package:win:dir` 继续用于本地目录包验证，不把目录包误认为可分发安装器。
2. 在干净的 Windows 运行器中验证 `Cyrene-Setup-<version>.exe`、更新元数据、截图辅助程序、mpv（媒体播放器）和 MinGit（精简版 Git）是否齐全；执行安装、启动、卸载和更新路径的冒烟检查。首次可只保存工作流产物，避免自动公开发布。
3. 发布步骤与构建步骤分开：仅版本标签且测试和安装验证通过后创建草稿 Release（发布版本），人工核对版本、更新说明、签名与产物后再公开。发布任务只授予所需写权限；常规测试任务维持只读权限。
4. 如果 GitHub 主仓库仍不可用，先完成本地或镜像平台的安装包构建验证；远端上传、更新源切换和自动发布待托管地址与权限明确后实施。不要因为镜像可用就静默改变已安装客户端的更新来源。

验收：从干净环境凭锁文件与已记录的外部二进制校验值产出可安装文件；产物版本与标签一致；安装后应用可启动，更新来源正确；无签名或托管权限时只交付内部测试产物。

### 阶段 C：临时目录与命名收敛（P2）

1. 记录各临时目录的生产者、用途、体积、是否可再生及保留期。`tmp/`、`output/`、`release-verify*/`、`dist/renderer-old-*` 和构建日志可列为清理候选；`models/`、`resources/bin/`、`dist/renderer` 中跟踪的产品资源不能按忽略状态直接删除。
2. 将新验证产物统一写入 `output/<任务名>/` 或系统临时目录，避免继续新增根目录散落文件。清理前运行 `git clean -ndX` 仅作总览，然后对明确的目标路径逐个确认、定向清理；不添加仓库根目录级的无差别删除脚本。
3. `.gitignore` 的 `docs/` 后接 `!docs/`，实际允许新增多数文档，与“Private design docs”注释不一致。按仓库现有大量已跟踪设计文档的事实，优先把注释和私有草稿专用目录规则写清楚，而非突然忽略整个 `docs/`。
4. 用一次独立改动将 `src/renderer/tast/` 改为 `src/renderer/character-portraits/`，同步导入和 README，运行构建验证资源路径。`cita/` 与 `services/cita/` 目前分别承载核心能力和环境装配，应在模块文档中说明，不按相似名字直接合并。

验收：干净克隆后不会生成未约定的根目录临时文件；清理操作有可预览的精确路径；构建可解析全部头像资源；新同事能从目录说明找到领域实现与装配入口。

### 阶段 D：缩小组合根职责（P2，分批实施）

1. 保留 `default-dependencies.ts` 的阶段工厂、实例构造和跨模块回调。先标注现有启动顺序、失败降级和退出资源注册的行为基线，复用 `application/*.test.ts` 测试。
2. 将 `reconcileUserMemoryIndex` 协调逻辑移到已有 `memory` 模块；组合根只传入必要的存储与日志依赖。
3. 将计划模式 `PLAN_SET_MODE` / `PLAN_GET_STATE` 处理移到 `plan-mode` 附近的注册函数；将提醒焦点抑制规则移到 `toast` 服务或其策略模块。每步仅改一个领域，保持原有通道、返回值和初始化时机。
4. 检查模块加载即注册的副作用与可变全局状态；只在确实影响测试或启动顺序的路径上改为显式工厂，不引入新的通用容器或抽象接口体系。

验收：组合根不再实现领域规则；主进程类型检查、完整测试与桌面启动冒烟通过；原有阶段顺序、降级、窗口显示、计划模式返回值和受控退出行为保持一致。行数仅作为观察指标，不设机械目标。

## 4. 推荐提交边界和优先顺序

建议拆为四组可独立审查的改动：A1 全量测试门禁；A2 漏洞处置与依赖更新配置；B 安装包构建和发布控制；C/D 各自按目录或领域分小批推进。A1 与 A2 优先于命名、文件长度优化。任何阶段发现现成框架或仓库模块已经提供所需能力，直接复用并删掉重复胶水。

本方案只写实施路径；没有修改工作流、依赖、代码或本地临时产物。
