import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * IPC 契约静态扫描器：用 TypeScript 语法树识别 IPC 通道的注册与调用表达式。
 *
 * 只认「首个实参是 `IPC.<KEY>` 属性访问」的调用，因此下列写法都不会被误判：
 *   - 注释里的注册代码（正则扫描会把注释当真）
 *   - 字符串字面量里的通道名
 *   - 形参透传（`webContents.send(channel, payload)` 的 channel 无法静态求值）
 *
 * 与 `src/renderer/default-dialogs-scanner.ts` 保持同一约定：
 * 纯函数，输入 (file, source)，输出带文件与行号的命中清单。
 */

export type IpcChannelUseKind =
  /** 渲染端 `ipcRenderer.invoke` —— 需要主进程 handle 提供返回值。 */
  | "invoke"
  /** 渲染端 `ipcRenderer.send` —— 需要主进程 on 接收单向消息。 */
  | "send"
  /** 渲染端 `ipcRenderer.on/once/off/removeListener` —— 需要主进程外发。 */
  | "listen"
  /** 主进程 `handle` / 插件运行时 `registerIpc` —— 提供返回值。 */
  | "handle"
  /** 主进程 `ipcMain.on` —— 接收单向消息。 */
  | "on"
  /** 主进程外发：`send` / `broadcast` / `emit` / `post` 系函数。 */
  | "outbound";

export interface IpcChannelUse {
  kind: IpcChannelUseKind;
  /** IPC 常量表键名，如 `WINDOW_MINIMIZE`。 */
  channel: string;
  /** 调用点所在文件，按传入的 file 原样回填。 */
  file: string;
  /** 1 起的行号。 */
  line: number;
}

const RENDERER_EMIT_METHODS = new Set(["send", "sendSync"]);
const RENDERER_RECEIVE_METHODS = new Set([
  "on",
  "once",
  "off",
  "removeListener",
  "removeAllListeners",
]);
const OUTBOUND_METHOD = /(?:send|broadcast|emit|post)/i;

/**
 * 判定调用表达式的方向。
 *
 * `objectName` 为点号左侧标识符（`a.b.f()` 这类链式访问链取不到，按 undefined 处理）。
 * 未知对象上的 `.on(IPC.X)` 归入主进程监听 —— 通道名是 `IPC.*` 常量，误判面极小。
 */
function classify(objectName: string | undefined, methodName: string): IpcChannelUseKind | null {
  if (objectName === "ipcRenderer") {
    if (methodName === "invoke") return "invoke";
    if (RENDERER_EMIT_METHODS.has(methodName)) return "send";
    if (RENDERER_RECEIVE_METHODS.has(methodName)) return "listen";
    return null;
  }
  if (methodName === "handle" || methodName === "handleOnce") return "handle";
  // 插件运行时入口 `runtime.registerIpc(IPC.X, handler)`，最终落到 ipcMain.handle
  if (methodName === "registerIpc") return "handle";
  if (objectName === undefined) {
    // 裸函数名：只认外发系，如 sendToPetWindow(IPC.X)、broadcastToAuxWindows(IPC.X)
    return OUTBOUND_METHOD.test(methodName) ? "outbound" : null;
  }
  if (methodName === "on") return "on";
  return OUTBOUND_METHOD.test(methodName) ? "outbound" : null;
}

/** 仅接受 `IPC.<KEY>` 这种属性访问，其他一切形态（含透传变量）一律返回 null。 */
function ipcChannelKey(argument: ts.Expression | undefined): string | null {
  if (argument === undefined || !ts.isPropertyAccessExpression(argument)) return null;
  if (!ts.isIdentifier(argument.expression)) return null;
  if (argument.expression.text !== "IPC") return null;
  return argument.name.text;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function findIpcChannelUses(file: string, source: string): IpcChannelUse[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const uses: IpcChannelUse[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let objectName: string | undefined;
      let methodName: string | undefined;
      if (ts.isPropertyAccessExpression(callee)) {
        objectName = ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
        methodName = callee.name.text;
      } else if (ts.isIdentifier(callee)) {
        methodName = callee.text;
      }

      if (methodName !== undefined) {
        const kind = classify(objectName, methodName);
        const channel = ipcChannelKey(node.arguments[0]);
        if (kind !== null && channel !== null) {
          uses.push({
            kind,
            channel,
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return uses;
}

const RESOLVE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", `${path.sep}index.ts`];

/** 把相对模块说明符解析为磁盘文件路径；非相对说明符（外部依赖）返回 null。 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 收集一个文件里的静态依赖说明符：import / export-from / import= / require() / import()。 */
function collectDependencySpecifiers(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if ((isRequire || isDynamicImport) && first && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return specifiers;
}

/**
 * 从入口文件出发，沿相对 import 关系求可达文件集合（绝对路径）。
 *
 * 用途：区分「源码里出现过注册表达式」与「该文件确属生产装配路径」——
 * 只被测试或死代码引用的模块不会出现在结果里。
 *
 * 已知放宽：type-only import 与动态 import 也计入可达，因此偏保守（偏向不误报，
 * 而不是偏向漏报）。
 */
export function collectReachableFiles(entryFile: string): Set<string> {
  const reachable = new Set<string>();
  const pending = [path.resolve(entryFile)];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current) || !fs.existsSync(current)) continue;
    reachable.add(current);

    const source = fs.readFileSync(current, "utf8");
    for (const specifier of collectDependencySpecifiers(current, source)) {
      const resolved = resolveRelativeSpecifier(current, specifier);
      if (resolved !== null && !reachable.has(resolved)) pending.push(resolved);
    }
  }

  return reachable;
}
