# ChatPage 重构回归 Checklist

- 配套设计文档：[2026-09-03-chatpage-refactor-design.md](./2026-09-03-chatpage-refactor-design.md)
- 用法：**每个 Phase 完成后执行一轮**。执行人勾选对应条目并在末尾记录执行记录（Phase、日期、结果）。
- 约定：条目按域分组，标注了各 Phase 的**重点范围**，但整表在 Phase 1 / Phase 6（首尾两个大节点）必须**全量执行**。

---

## 1. Run 基本流程【Phase 1 重点】

- [ ] chat 模式：发送消息 → 流式正文渐显 → 正常回答提交
- [ ] work 模式：发送 → 工具调用过程（toolExecutions 折叠区）→ 回答
- [ ] code 模式：发送 → 计划/工具/代码变更展示 → 回答
- [ ] learn 模式：发送 → 回答（speechMode 为 learn 的 TTS 行为正常）
- [ ] 回答过程中 reasoning 折叠区实时展开、结束后可折叠
- [ ] run 阶段指示（understanding → responding → executing 等）随事件流转
- [ ] 表情包 sticker 正常显示（用户发送 + 模型回复）
- [ ] 上下文容量圆环：run 中实时刷新、run 结束为终态值
- [ ] 「正在压缩上下文」提示出现与消失（RUN_STARTED 复位）

## 2. 取消与终态【Phase 1 重点】

- [ ] runId 已知时点停止：流式立即停止、消息进入失败/取消态、无残留 loading
- [ ] cancel-before-ack（发送后极快点停止）：ack 返回后 run 被取消，不产生孤儿 run
- [ ] 取消后正式回答不提交、过程区保留半截内容
- [ ] 超时 / runtime_error 终态：错误文案写入过程区、runStage 显示 failed
- [ ] 取消后立即发新消息：正常启动新 run，无 busy 卡死

## 3. 会话守卫与恢复【Phase 1 重点】

- [ ] F5 刷新后：interruptedRun 恢复提示出现、点 resume 携带 resumeFromRunId 续跑
- [ ] SESSION_RUN_ACTIVE 冲突（F5 后立即发消息）：出现接管操作卡（非通用错误文案）
- [ ] 点接管：本轮重开（takeoverFromRunId）、旧 run 被终止
- [ ] 接管卡出现时再发消息：不出现重复接管卡（ack 成功后清卡）
- [ ] 终态快照落盘：run 结束后杀进程重开，消息状态为 interrupted 而非 running

## 4. 消息队列【Phase 1 / Phase 4 重点】

- [ ] run 进行中发送消息：进入 composer 上方队列、草稿与附件清空
- [ ] run 结束（success / error / cancel）后队列自动按序消费
- [ ] 队列条目可单独删除
- [ ] 队列消费的每条消息正常走完整 run 流程
- [ ] takeover 挂卡期间队列消费行为与现状一致（保持原样，见设计文档 R4）

## 5. 审批与交互卡【Phase 1 / Phase 5 重点】

- [ ] 审批卡出现 → 点允许 → 卡消失、run 恢复执行
- [ ] 审批卡出现 → 点拒绝 → 卡消失、run 按拒绝路径执行
- [ ] 审批卡出现后取消 run：结算广播到达、卡立即消失（僵尸卡根治点）
- [ ] 审批卡 ok:false（pending 已被主进程结算）：卡直接清除
- [ ] 审批请求到达时 runId 路由不到会话：卡不出现（10s 重播后自然出现）
- [ ] ask 选择卡：选选项 → 提交 → 卡消失
- [ ] 老版选择卡超时 dismiss：卡消失（cyrene.choice.dismiss 补发路径）

## 6. 语音外部提交【Phase 1 / Phase 3 重点】

- [ ] 语音提交到当前会话：消息出现、模型运行、**不清用户草稿/附件**（keepComposer）
- [ ] 语音提交到非当前会话（后台运行）：该会话 run 正常
- [ ] 语音提交时目标会话忙：进入队列（提交视为成功）
- [ ] 过期 rendererTargetId（页面重载后旧请求）：回绝 E_NO_ACTIVE_INPUT_TARGET
- [ ] 多会话并发：A 会话手动发送 + B 会话语音提交，两 run 互不干扰

## 7. 计划模式【Phase 5 重点】

- [ ] cyrene.plan.review：计划面板打开、内容渲染、tab 自动切到 plan
- [ ] 批准：阶段变 executing、自动发送执行消息（恰好一次）
- [ ] 补充卡提交文本：作为用户消息发出、重新走审批
- [ ] completed（无 sessionId）：当前计划会话阶段变 completed
- [ ] run 结束后到达的 deferred 事件仍被处理（持久监听不依赖 run 订阅）

## 8. 附件【Phase 4 重点】

- [ ] 拖拽多文件：仅图片入附件、预览正常、拖拽遮罩正确出现/消失
- [ ] 粘贴图片：入附件、预览正常；超 20MiB 拒绝并提示
- [ ] 截图按钮：截图入附件；失败按 reason 提示（helper 未就绪/取消/文件缺失）
- [ ] 发送带 caption 策略的图片：状态 pending → processing → done、caption 展示
- [ ] caption 失败：状态 error、reason 展示
- [ ] direct 发送策略：附件直接标记 done、无 caption
- [ ] 发送后附件清空；语音提交不清附件
- [ ] 附件单独删除正常

## 9. TTS【Phase 1 重点】

- [ ] run 流式过程中 early TTS 按句开始播放
- [ ] 切换会话/模式：播放立即停止
- [ ] run 结束（成功 + 完整正文）：播放完整收尾后停止
- [ ] run 失败/取消：播放停止
- [ ] 发送新消息打断上一轮播放
- [ ] TTS 缓存 key 落盘（重放同一条消息命中缓存）

## 10. 会话管理【Phase 3 重点】

- [ ] 冷启动：恢复上次模式（localStorage）、URL 带 sessionId 直开
- [ ] 四模式切换：列表刷新、选中会话恢复
- [ ] 新建任务：回欢迎页、工作区继承逻辑正确
- [ ] 欢迎页选模型：暂存、ensureSession 后落地
- [ ] 欢迎页选工作区：暂存、首条消息时绑定
- [ ] 改名 / 删除 / 置顶即时生效
- [ ] IPC 连续切换会话（侧栏快速点多个会话）：按序完成不串台
- [ ] 空目录 learn 工作区：初始化结构询问流程

## 11. 编辑与重生成【Phase 2 重点】

- [ ] chat 模式编辑最后一条用户消息：截断重发、回答刷新
- [ ] chat 模式重新生成：保留用户消息重发
- [ ] run 进行中编辑/重生成入口禁用（revisionBusy）

## 12. Todo 面板【Phase 1 重点】

- [ ] work/learn 模式 TodoPanel 实时更新（cyrene.todo 事件）
- [ ] run 结束后切走再切回：todo 从 runSnapshot 恢复
- [ ] 新 run 启动：todo 清空重开

---

## 执行记录

| Phase | 日期 | 执行人 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| | | | | |
