// macOS（实验性）打包配置：由 electron-builder.yml 派生，见 scripts/packaging/mac-builder-config.cjs。
// 用法：pnpm run package:mac:dir（需在 macOS 上运行）
module.exports = require("./scripts/packaging/mac-builder-config.cjs").loadMacBuilderConfig();
