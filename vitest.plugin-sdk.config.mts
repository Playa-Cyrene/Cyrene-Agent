import { defineConfig } from "vitest/config";
import base from "./vitest.config.mts";

export default defineConfig({
  test: {
    ...base.test,
    include: ["packages/plugin-sdk/src/**/*.test.ts"],
  },
});
