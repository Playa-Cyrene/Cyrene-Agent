// file:/// 链接的解析与工作区边界判断（聊天回复里的可点文件引用）。
//
// 设计：链接本身就是指针——路径和 #L 行号写在 href 里，本地不需要猜
// "模型这句话说的是哪个文件"。这里只做两件事：
// 1. 解析 href：拆出绝对路径 + 可选行号（#L12 / #L12-L30）；
// 2. 判断是否在当前工作区内：界内 → 可点 chip，越界 → 降级纯文本
//    （渲染时就灰掉，而不是点了没反应）。

/** 从 file:/// 链接里解析出的定位信息 */
export interface FileLinkTarget {
  /** 绝对路径（已解码、统一成正斜杠） */
  absPath: string;
  /** 起始行（1 起）；没有行号片段时缺省 */
  lineStart?: number;
  /** 结束行；只有单行（#L12）时与 lineStart 相同 */
  lineEnd?: number;
}

/**
 * 解析 file:/// 链接的 href。非 file 协议返回 null。
 * 容忍 markdown 渲染器给出的百分号编码（中文路径、空格）；
 * 行号片段只认 #L12 / #L12-L30 两种形式。
 */
export function parseFileLinkHref(href: string): FileLinkTarget | null {
  if (!href.startsWith("file:///")) return null;
  // 先拆行号片段再解码，避免路径里的 # 干扰（file 链接里不应有 #，稳妥起见先拆）
  const hashIndex = href.indexOf("#");
  const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }

  // file:///E:/x → 去掉协议前缀后是 "/E:/x"，去掉盘符前的斜杠
  let absPath = decoded.slice("file://".length).replace(/\\/g, "/");
  absPath = absPath.replace(/^\/([A-Za-z]:)/, "$1");
  if (!absPath) return null;

  const target: FileLinkTarget = { absPath };
  const lineMatch = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    target.lineStart = start;
    target.lineEnd = lineMatch[2] ? Number(lineMatch[2]) : start;
  }
  return target;
}

/**
 * 判断绝对路径是否在 workspaceRoot 之内，在则返回工作区相对路径（正斜杠），否则 null。
 * Windows 大小写不敏感：统一小写比较。等路径自身返回 "."。
 */
export function relativePathInsideWorkspace(absPath: string, workspaceRoot: string): string | null {
  const normalize = (p: string) => {
    let n = p.replace(/\\/g, "/");
    n = n.replace(/^\/([A-Za-z]:)/, "$1");
    // 去掉中间的重复斜杠（协议前缀已在上一步剥掉）
    n = n.replace(/\/{2,}/g, "/");
    if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
    return n.toLowerCase();
  };
  const target = normalize(absPath);
  const root = normalize(workspaceRoot);
  if (!root) return null;
  if (target === root) return ".";
  // 根必须是路径前缀的完整目录段（防止 E:/proj 匹配到 E:/proj-x）
  if (!target.startsWith(root + "/")) return null;
  return absPath
    .replace(/\\/g, "/")
    .replace(/^\/([A-Za-z]:)/, "$1")
    .slice(root.length + 1);
}
