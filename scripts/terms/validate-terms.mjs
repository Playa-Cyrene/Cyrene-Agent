#!/usr/bin/env node
// 只校验本地候选文件；不会上传、发布或改变客户端当前条款。
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const file = process.argv[2];
if (!file) {
  console.error("用法：先 pnpm run build:main，再 node scripts/terms/validate-terms.mjs <terms.json>");
  process.exit(1);
}
try {
  const { validateTermsBundle, termsContentHash, TERMS_MAX_BYTES } = require("../../dist/main/main/terms/terms-service.js");
  if (fs.statSync(file).size > TERMS_MAX_BYTES) throw new Error("文件超过 256 KiB 上限");
  const bundle = validateTermsBundle(JSON.parse(fs.readFileSync(file, "utf8")));
  console.log(JSON.stringify({ revision: bundle.revision, consentVersion: bundle.consentVersion,
    locales: Object.keys(bundle.locales), contentHash: termsContentHash(bundle) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
