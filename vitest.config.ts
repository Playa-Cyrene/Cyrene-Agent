import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/plugins/**/*.test.ts",
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/cli/**/*.test.ts",
      "skills/**/tests/**/*.test.ts",
      "scripts/cline-poc/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    // 2026-09-21：windows-2025 镜像更新后，单 fork 串行模式下 vitest worker 在 CI 上
    // 确定性崩溃（libuv fs-event 断言，进程无输出直接死）。改用 4 路并发 fork：
    // 每个文件独立进程，单文件崩溃不再拖垮整轮；本地与 CI 已验证并发模式稳定。
    pool: "forks",
    maxWorkers: 4,
    minWorkers: 1,
    watch: false,
    cache: false,
    fileParallelism: true,
  },
});
