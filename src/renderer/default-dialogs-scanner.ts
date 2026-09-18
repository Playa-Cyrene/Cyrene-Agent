import path from "node:path";
import ts from "typescript";

/**
 * 渲染进程默认弹窗边界扫描器：
 * 用 TypeScript 语法树识别裸调用 alert()/confirm() 和 window.alert()/window.confirm()，
 * 成员方法（如 modal.confirm()）不会被误报；覆盖 .ts/.tsx/.js/.jsx 四类源文件，
 * 返回 "相对路径:行号" 形式的命中清单。
 */
function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function findDefaultDialogCalls(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      const bare = ts.isIdentifier(target) && (target.text === "alert" || target.text === "confirm");
      const windowCall = ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression)
        && target.expression.text === "window"
        && (target.name.text === "alert" || target.name.text === "confirm");
      if (bare || windowCall) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${path.normalize(file)}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
