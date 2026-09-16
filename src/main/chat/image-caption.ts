import * as fs from "fs";
import * as path from "path";
import { getMimeFromExt, isImageExt } from "../rag/file-ingest";
import { userAnnotationNotice } from "../../shared/chat-context";
import { captionImage, type VisionConfig } from "../orchestrator/vision-captioner";

export const IMAGE_CAPTION_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CAPTION_PROMPT = "请简洁描述这张图片的主要内容，重点提取用户可能想让你看的信息。";

export function buildImageCaptionPrompt(hasAnnotations: boolean): string {
  const notice = userAnnotationNotice(hasAnnotations);
  return notice ? `${IMAGE_CAPTION_PROMPT}\n\n${notice}` : IMAGE_CAPTION_PROMPT;
}

export type ValidCaptionImage =
  | { ok: true; filePath: string; buffer: Buffer; mime: string }
  | { ok: false; error: string };

export function validateCaptionImagePath(filePath: unknown): ValidCaptionImage {
  if (typeof filePath !== "string") {
    return { ok: false, error: "filePath 必须是 string" };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: "文件不存在" };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { ok: false, error: "不是文件" };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!isImageExt(ext)) {
    return { ok: false, error: "只支持图片文件" };
  }
  if (stat.size > IMAGE_CAPTION_MAX_BYTES) {
    return { ok: false, error: "图片不能超过 20MB" };
  }

  return {
    ok: true,
    filePath,
    buffer: fs.readFileSync(filePath),
    mime: getMimeFromExt(ext),
  };
}

/**
 * 安全转述：读文件 → 调视觉模型 → 统一错误格式。
 * 全项目"把一张本地图片转成文字"的唯一入口，调用方不再各自处理边界
 * （视觉配置由调用方先经 image-router 解析，本函数只管执行）。
 */
export async function captionImageSafe(
  filePath: unknown,
  prompt: string,
  config: VisionConfig,
): Promise<{ ok: true; caption: string } | { ok: false; error: string }> {
  const validated = validateCaptionImagePath(filePath);
  if (!validated.ok) return { ok: false, error: validated.error };
  try {
    const caption = await captionImage(
      { base64: validated.buffer.toString("base64"), mime: validated.mime },
      prompt,
      config,
    );
    if (caption.startsWith("[错误")) return { ok: false, error: caption };
    return { ok: true, caption };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
