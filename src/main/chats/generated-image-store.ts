import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GeneratedImageAttachment, GeneratedImageOutput } from "../../shared/generated-image";

export const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GeneratedImageStore {
  save(input: { conversationId: string; image: GeneratedImageOutput }): Promise<GeneratedImageAttachment>;
  deleteConversation(conversationId: string): Promise<void>;
  readManagedPng(filePath: string): Promise<Buffer>;
}

export function createGeneratedImageStore(options: { rootDirectory: string }): GeneratedImageStore {
  const rootDirectory = path.resolve(options.rootDirectory);

  return {
    async save({ conversationId, image }) {
      const bytes = decodePng(image);
      const directory = path.join(rootDirectory, digest(conversationId));
      const name = `generated-${digest(image.id).slice(0, 16)}.png`;
      const filePath = path.join(directory, name);

      await mkdir(rootDirectory, { recursive: true });
      await mkdir(directory, { recursive: true });
      await assertContainedDirectory(rootDirectory, directory);

      try {
        const existing = await readFile(filePath);
        if (!existing.equals(bytes)) throw new Error("生成图片标识冲突");
        return attachment(image, name, filePath, existing.byteLength);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporaryPath, "wx");
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          // Hard-link installation is atomic and exclusive on Windows and POSIX;
          // rename() would replace an existing target on POSIX during concurrent saves.
          await link(temporaryPath, filePath);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const existing = await readFile(filePath);
          if (!existing.equals(bytes)) throw new Error("生成图片标识冲突");
        }
        const saved = await stat(filePath);
        if (!saved.isFile() || saved.size !== bytes.byteLength) throw new Error("生成图片文件校验失败");
        return attachment(image, name, filePath, saved.size);
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },

    async deleteConversation(conversationId) {
      const target = path.join(rootDirectory, digest(conversationId));
      let rootRealPath: string;
      try {
        rootRealPath = await realpath(rootDirectory);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      let targetRealPath: string;
      try {
        targetRealPath = await realpath(target);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      assertInside(rootRealPath, targetRealPath);
      if (targetRealPath === rootRealPath) throw new Error("拒绝删除生成图片根目录");
      await rm(targetRealPath, { recursive: true, force: true });
    },

    async readManagedPng(filePath) {
      const rootRealPath = await realpath(rootDirectory);
      const targetRealPath = await realpath(path.resolve(filePath));
      assertInside(rootRealPath, targetRealPath);
      const fileStat = await stat(targetRealPath);
      if (!fileStat.isFile() || fileStat.size > GENERATED_IMAGE_MAX_BYTES) {
        throw new Error("生成图片文件无效");
      }
      const bytes = await readFile(targetRealPath);
      if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error("生成图片文件无效");
      }
      return bytes;
    },
  };
}

/** 将模型返回的临时编码独立落盘；失败的图片不阻止其他图片提交。 */
export async function persistGeneratedImages(
  store: GeneratedImageStore | undefined,
  conversationId: string,
  images: GeneratedImageOutput[] | undefined,
): Promise<{ attachments: GeneratedImageAttachment[]; failedCount: number }> {
  const attachments: GeneratedImageAttachment[] = [];
  let failedCount = 0;
  for (const image of images ?? []) {
    try {
      if (!store) throw new Error("生成图片存储不可用");
      attachments.push(await store.save({ conversationId, image }));
    } catch (error) {
      failedCount += 1;
      console.warn("[GeneratedImageStore] failed to save model image:", error instanceof Error ? error.message : "unknown error");
    }
  }
  return { attachments, failedCount };
}

function decodePng(image: GeneratedImageOutput): Buffer {
  if (!image || typeof image.id !== "string" || image.id.length === 0
    || typeof image.toolCallId !== "string" || image.toolCallId.length === 0
    || image.mime !== "image/png" || typeof image.base64 !== "string") {
    throw new Error("生成图片信息无效");
  }
  const maxEncodedLength = Math.ceil(GENERATED_IMAGE_MAX_BYTES / 3) * 4;
  if (image.base64.length === 0 || image.base64.length > maxEncodedLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
    throw new Error("生成图片编码无效或超过 20 MiB");
  }
  const bytes = Buffer.from(image.base64, "base64");
  if (bytes.toString("base64") !== image.base64) throw new Error("生成图片编码无效");
  if (bytes.byteLength > GENERATED_IMAGE_MAX_BYTES) throw new Error("生成图片超过 20 MiB");
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("生成图片不是有效 PNG");
  }
  return bytes;
}

function attachment(image: GeneratedImageOutput, name: string, filePath: string, byteLength: number): GeneratedImageAttachment {
  return { id: image.id, kind: "image", name, filePath, mime: "image/png", source: "model", byteLength, status: "done" };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertContainedDirectory(root: string, directory: string): Promise<void> {
  const [rootRealPath, directoryRealPath] = await Promise.all([realpath(root), realpath(directory)]);
  assertInside(rootRealPath, directoryRealPath);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("生成图片路径超出存储目录");
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && ["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}
