import { globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** 校验实际产物中的相对动态导入，避免类型检查通过但 Node 加载失败。 */
export function assertRelativeDynamicImports(outDir) {
  const failures = [];
  for (const relative of globSync("**/*.{js,cjs,mjs}", { cwd: outDir })) {
    const filename = path.resolve(outDir, relative);
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const specifier = node.arguments[0].text;
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const destination = fileURLToPath(new URL(specifier, pathToFileURL(filename)));
          const extension = path.extname(destination);
          const reason = ![".js", ".cjs", ".mjs", ".json"].includes(extension)
            ? "必须显式指定运行时文件扩展名，目录入口需要写 index.js"
            : !statSync(destination, { throwIfNoEntry: false })?.isFile()
              ? "导入目标不存在或不是文件"
              : undefined;
          if (reason) {
            const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
            failures.push(`${relative}:${line + 1}:${character + 1}: ${JSON.stringify(specifier)} ${reason}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (failures.length > 0) {
    throw new Error(`[desktop] 相对动态导入校验失败：\n${failures.join("\n")}`);
  }
}
