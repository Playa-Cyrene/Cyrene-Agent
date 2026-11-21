# 旧卸载器保护钩子

`installUtil.nsh` 来自 MIT 许可的 electron-builder / app-builder-lib 26.15.3。
原始许可证在同目录 `LICENSE.electron-builder`。本地仅增加编译目录恢复、
`CyreneBeforeOldUninstall` 调用及两个无有效卸载信息的返回检查，其他卸载行为与锁定上游一致。

标准 `nsis.include` 的 `customHeader` 临时切换编译目录，使主模板命中此单文件；
覆盖文件立即恢复原目录。继续使用 electron-builder 的标准安装器、卸载器生成和签名流程，
无需修改 node_modules 或使用 `nsis.script`。每次编译安装器都校验上游版本、三个相关模板
的 SHA-256 和覆盖文件的精确差异，因此 `--prepackaged` 也不能绕过校验。

钩子在最终安装范围/目标及实际旧 `installationDir` 已确定、关闭程序检查完成后，
旧卸载器复制/执行前保护内容。初始化与向导页面不移动文件。同盘、互不嵌套的新目录可迁移；
跨盘、卷根、重解析路径、两个范围同时注册的安装、已有目标内容/残留暂存均停止并保留数据。
这些情况需用户先整理旧安装，不能猜测多个内容版本的合并优先级。

依赖升级时，重新审查模板调用顺序，更新覆盖及 `scripts/verify/nsis-overlay.mjs` 中的版本/哈希，
运行 `node --test scripts/verify/nsis-overlay.test.mjs`；再运行 Windows 原生回归：

```
node scripts/verify/installer-content-preservation.mjs --nsis-dir <NSIS目录>
node scripts/verify/installer-upgrade-paths.mjs --nsis-dir <NSIS目录>
node scripts/verify/installer-validation.mjs
```

还须用真实 electron-builder 模板确认旧版交互/静默升级、取消、改目录、旧卸载失败与多安装范围。
已安装的旧卸载器文件本身不会被此源码修改；修复在用户运行重新构建的新安装器时生效。
