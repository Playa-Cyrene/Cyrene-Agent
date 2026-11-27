# QQ 生命周期只读诊断

`readQqLifecycleDiagnostics(app.getPath('userData'))` 只能由主机调用。渲染层不得传路径；结果按 `validateQqLifecycleDiagnostics` 校验。固定检查 migration、first-setup、recovery、driver-ownership、adoption 五个 sidecar。

结果只含固定状态和阶段枚举，不返回账号、白名单、监听配置、包标识、scope、epoch、凭据 revision、路径或原始错误。读取不创建目录、不取得所有权、不删除锁、不修复状态、不启动任何驱动。

- `absent`：本次未观察到该 sidecar，不是首次安装或没有历史驱动的证明。
- `locked`：发现锁，不推断进程是否存在或锁是否过期。主机崩溃后保留现场，转人工处理。
- `dirty`、`incomplete`、`corrupt`、`unavailable`：不能确认安全状态，禁止自动清理或恢复。
- `clean-retired`：文件记录正常退役，但诊断不是运行时停止证明、scope 匹配或激活许可。
- `recorded`：格式有效、阶段本身不要求人工核查的生命周期记录，仅展示阶段，不表示模块正在运行。对迁移或首次配置，只有已选择的初始记录（`selected`）归此类；尚不能作为恢复来源的事务显示 `incomplete`。显式恢复的 `prepared` / `module-staged` 同样显示 `incomplete`。设置页会在需要人工核查时额外提示。

任何持久 artifact 都返回 `startupMode: blocked`。`manualReviewRequired` 仅对 dirty/locked/incomplete/corrupt/unavailable 为 true；正常 recorded/clean-retired 不显示人工异常，但仍不授权启动。这保留保守启动门控；诊断不能替代经过验证的首次安装/升级资格、可信签名配对发布、所有权 supervisor 或显式确认。结果是非原子的观察快照；正在运行时发现锁正常，不能仅凭此声称发生崩溃。应用/恢复前必须重新执行原有可信证明和事务检查。

拒绝符号链接路径/文件、硬链接状态、超限文件、未知目录项。只读检查不是敌对本机进程的文件系统沙箱，也不承诺避免本地攻击者同时替换路径的竞态。

验证：`node node_modules/vitest/vitest.mjs run src/main/qq-modules/lifecycle-diagnostics.test.ts`。

Adoption 的 intent-lock 是不可清理的一次性意图标记，合法完整意图显示 recorded/prepared（不是活进程锁），仍阻止自动启动。缺失状态/锁或残留临时文件显示 incomplete；异常结构显示 corrupt。意图不等于已完成纳管。
