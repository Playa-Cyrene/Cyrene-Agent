# Settings Feature

设置面板已迁移到工作区 React 界面；旧的独立设置窗口入口已移除。

本目录保留 React 设置页仍在复用的共享类型、格式化逻辑、预设和迁移适配器。新增设置界面应放在本目录：
- pages/
- components/
- model/
- adapters/
- index.ts

Settings 不得直接依赖 Chat Feature。
