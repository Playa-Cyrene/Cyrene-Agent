/**
 * 工具结果图片：让工具把图片交给主模型直接查看，而不是先转述成文字。
 *
 * 会话轨迹里只保存文件引用（文件名 + 尺寸），编码数据在组装请求时才读取：
 * 轨迹不会因为截图而膨胀，图片文件被清理后旧会话也只是退化为一句文字说明。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolResultImage } from "./vendors/types";

/**
 * 允许返回图片的工具白名单，按宿主注册的工具对象登记而不是按工具名。
 * 任意工具都能返回图片的话，被注入的网页或 MCP 输出就可以借此读走本地文件；
 * 只认名字的话，插件也能注册同名工具（如 id 为 computer 的插件注册 computer_screenshot）冒充。
 */
const imageResultTools = new WeakSet<object>();

/** 由宿主内置工具在注册时调用；插件和 MCP 工具不经过这里，因此永远不会被当成图片来源。 */
export function allowToolResultImages<T extends object>(tool: T): T {
  imageResultTools.add(tool);
  return tool;
}

/** helper 生成的固定文件名模式；不接受任何路径分隔符，引用无法指向图片目录之外。 */
const TOOL_IMAGE_FILE_NAME = /^shot-\d{1,20}-\d{1,10}\.png$/;
const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_IMAGE_EDGE = 8192;
export const TOOL_IMAGE_RESULT_KIND = "tool_image_result";

let imageDirectory: string | undefined;

export function configureToolResultImageDirectory(directory: string | undefined): void {
  imageDirectory = directory;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

export function isToolResultImage(value: unknown): value is ToolResultImage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return typeof image.fileName === "string"
    && TOOL_IMAGE_FILE_NAME.test(image.fileName)
    && image.mediaType === "image/png"
    && isPositiveInteger(image.width, MAX_TOOL_IMAGE_EDGE)
    && isPositiveInteger(image.height, MAX_TOOL_IMAGE_EDGE);
}

/** 生成图片类工具的输出文本；与 parseToolResultImages 成对使用，格式只在本文件定义。 */
export function formatToolImageResult(text: string, image: ToolResultImage): string {
  return JSON.stringify({ kind: TOOL_IMAGE_RESULT_KIND, text, image });
}

/** 从白名单工具的输出中取出图片引用；其他工具即使输出了同样的结构也不会被当成图片。 */
export function parseToolResultImages(tool: Pick<ToolDefinition, "id">, output: string): ToolResultImage[] | undefined {
  if (!imageResultTools.has(tool) || output.length > 4096) return undefined;
  try {
    const value = JSON.parse(output) as Record<string, unknown> | null;
    if (value?.kind !== TOOL_IMAGE_RESULT_KIND || !isToolResultImage(value.image)) return undefined;
    const { fileName, mediaType, width, height } = value.image;
    return [{ fileName, mediaType, width, height }];
  } catch {
    return undefined;
  }
}

export interface LoadedToolResultImage {
  mediaType: string;
  /** base64 编码数据。 */
  data: string;
}

export type ToolResultImageResolver = (image: ToolResultImage) => LoadedToolResultImage | undefined;

/** 读取图片供请求使用；文件缺失、过大或引用不合法时返回 undefined，由调用方退化为文字说明。 */
export const resolveToolResultImage: ToolResultImageResolver = (image) => {
  if (!imageDirectory || !isToolResultImage(image)) return undefined;
  try {
    const filePath = path.join(imageDirectory, image.fileName);
    if (fs.statSync(filePath).size > MAX_TOOL_IMAGE_BYTES) return undefined;
    return { mediaType: image.mediaType, data: fs.readFileSync(filePath).toString("base64") };
  } catch {
    return undefined;
  }
};

/**
 * 启动时清理上次运行遗留的工具图片：自动截图只保留到会话结束，异常退出时来不及清理的，
 * 在下次启动时补删。只删除符合 helper 命名模式、且早于本次启动写入的文件，目录里的其他内容一概不动。
 */
export async function pruneToolResultImages(before = Date.now()): Promise<void> {
  if (!imageDirectory) return;
  let names: string[];
  try {
    names = await fs.promises.readdir(imageDirectory);
  } catch {
    return;
  }
  await Promise.all(names.filter(name => TOOL_IMAGE_FILE_NAME.test(name)).map(async (name) => {
    const filePath = path.join(imageDirectory!, name);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs < before) await fs.promises.unlink(filePath);
    } catch {
      // 文件被并发删除或暂时占用都不影响功能，下次启动再清理。
    }
  }));
}
