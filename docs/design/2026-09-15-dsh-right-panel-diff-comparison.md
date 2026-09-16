# dsh 右侧文件面板与 Cyrene 变更审查：代码对照

> 根据用户提供的界面截图，完整需求还包括外部应用打开下拉和右侧文件树。后续施工以 [工作区打开方式、右侧文件浏览与差异审查](2026-09-15-workspace-open-files-review-design.md) 为准；本篇只保留最初的差异审查对照。

## 结论

本地 `E:\deepseek-harness` 当前代码把“工具修改产生的差异”和“右侧文件预览”分成两层：文件修改工具卡在对话内展开差异，点卡片中的文件路径时，右侧打开该文件的代码预览。右侧是可复用的文件工作区，并非专属的整轮差异审查页。Cyrene 已有相反侧重点：对话内有逐工具 `FileChangeCard`，运行结束后有完整 `ReviewSnapshot`，点文件才打开右侧的单文件差异。

因此用户看到的“像开发环境一样从右边跳出来”主要来自右侧面板的布局、标签、文件预览和响应式交互；差异数据本身，Cyrene 已有成熟来源。不应把 dsh 整套侧栏框架当作差异算法移植。

## 代码证据

| 关注点 | dsh | Cyrene |
| --- | --- | --- |
| 逐工具差异 | `packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx` 使用 `diffCardModel`；`ToolRow.tsx` 在卡内渲染 `DiffBlock` | `src/renderer/react/features/chat/components/FileChangeCard.tsx` 在工具结果内显示变更与差异行 |
| 右侧打开动作 | `packages/client/ui-chat/src/client/apply.ts` 的 `openFile` 把文件地址交给 `sidebarRight.openResource` | `ReviewPanel.tsx` 点击运行变更文件后传 `runId + fileIndex`，`ChatPage.tsx` 打开右侧差异标签 |
| 右侧内容 | `ui-sidebar-documentpreview` 按文件地址读取当前文件，代码视图使用 `CodeBlock`；支持文件标签、预览和定位源码行 | `ReviewInspector.tsx` 读取不可变的运行后快照，只显示所选文件的行级差异；`RightInspector.tsx` 当前承载差异和计划两个标签 |
| 数据时间点 | 工具卡可以在执行时从参数显示意图，成功后从工具结果元数据获取实际差异；右侧文件预览读当前文件 | 逐工具卡使用工具结果；整轮 `REVIEW_GET` 仅在运行结束后提供快照，包含运行前基线与结束后的状态 |
| 面板布局 | `ui-sidebar-right` 与 `ui-dockkit` 提供会话级多标签、拖动宽度、分屏、浮动与窄屏全屏；常规宽度首次打开约占窗口 45%，有最小阅读宽度约束 | `RightInspector.css` 固定宽 620px，差异和计划共享单个右侧容器，没有上述通用布局机制 |

## 现成方案与复用判断

- Cyrene 已装 `diff` 库，并在 `RunReviewTracker` 中使用它生成结构化差异；`ReviewSnapshot`、`ReviewDiffContent` 和 `RightInspector` 可以保留。若只想改善“像开发环境一样的右侧审查体验”，不需要新差异库。
- dsh 的右侧面板代码可参考交互边界，尤其是宽度跟随窗口、点击文件复用标签、窄屏全屏和代码行定位；其 `ui-dockkit`、会话地址和文件读取服务跨多个包，整体移植成本高，与 Cyrene 现有界面状态不兼容。当前需求若只涉及差异审查，优先改现有面板。
- 若需要语法高亮，Cyrene 已有 `@ant-design/x` 的 `CodeHighlighter` 与已安装的 `shiki`；先评估复用其中一个，避免另造高亮器。

## 可选改造方向

1. **右侧面板体验**：在 `RightInspector` 上加拖动宽度、保持聊天区最低阅读宽度、窄屏切换全屏；保留现有差异和计划标签。只修改呈现层，不改审查快照。
2. **文件导航**：右侧差异内支持上一个/下一个变更文件与文件列表；同一运行中点击已打开文件时切换选中项，不重复打开面板。若增加“查看当前文件”标签，须明确它读取的是当前磁盘内容，与固定的运行后差异快照不同。
3. **运行中反馈**：沿用 `FileChangeCard` 展示每次工具已报告的差异；不能把运行中的文件预览冒充完整运行审查。若希望运行中右侧自动打开差异，需单独定义由哪个工具事件触发、展示意图还是已应用结果，以及后续工具再次修改同一文件时如何更新。

这份对照基于当前本地 dsh 源码。如果所指的是另一个 dsh 版本或另一种右侧视图，需以实际界面入口重新核对，不能将目前的文件预览误称为右侧整轮差异页。
