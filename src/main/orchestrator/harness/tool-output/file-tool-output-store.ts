import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FindToolOutputInput,
  FindToolOutputMatch,
  FindToolOutputResult,
  PutToolOutputInput,
  ReadToolOutputInput,
  ReadToolOutputResult,
  ToolOutputRef,
  ToolOutputStore,
} from "./types";

const SCHEMA_VERSION = 1;
const RESULT_REF_PREFIX = "tool-result://v1/";
export const MAX_READ_CODE_POINTS = 8_192;
const MAX_FIND_MATCHES = 8;
const FIND_CONTEXT_CODE_POINTS = 160;

interface ToolOutputRecordMeta extends Omit<ToolOutputRef, "resultRef"> {
  schemaVersion: typeof SCHEMA_VERSION;
  conversationId: string;
  outcome: PutToolOutputInput["outcome"];
  sha256: string;
}

export class ToolOutputInvalidInputError extends Error {
  readonly code = "E_TOOL_OUTPUT_INVALID_INPUT";
}

export class ToolOutputCorruptError extends Error {
  readonly code = "E_TOOL_OUTPUT_CORRUPT";
}

export class ToolOutputPersistenceError extends Error {
  readonly code = "E_TOOL_OUTPUT_PERSISTENCE";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export function toolOutputRecordId(conversationId: string, runId: string, toolCallId: string): string {
  return sha256(`${conversationId}\0${runId}\0${toolCallId}`);
}

export function toolOutputResultRef(recordId: string): string {
  return `${RESULT_REF_PREFIX}${recordId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseResultRef(resultRef: string): string {
  const recordId = resultRef.startsWith(RESULT_REF_PREFIX)
    ? resultRef.slice(RESULT_REF_PREFIX.length)
    : "";
  if (!/^[a-f0-9]{64}$/.test(recordId)) {
    throw new ToolOutputInvalidInputError("工具结果引用无效");
  }
  return recordId;
}

function validateRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ToolOutputInvalidInputError("offset 必须是非负整数");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_READ_CODE_POINTS) {
    throw new ToolOutputInvalidInputError(`length 必须是 1-${MAX_READ_CODE_POINTS} 的整数`);
  }
}

function isRecordMeta(value: unknown): value is ToolOutputRecordMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === SCHEMA_VERSION
    && typeof candidate.recordId === "string"
    && /^[a-f0-9]{64}$/.test(candidate.recordId)
    && typeof candidate.conversationId === "string"
    && typeof candidate.runId === "string"
    && typeof candidate.toolCallId === "string"
    && typeof candidate.toolName === "string"
    && (candidate.outcome === "success" || candidate.outcome === "failure" || candidate.outcome === "unknown")
    && typeof candidate.createdAt === "number"
    && typeof candidate.bytes === "number"
    && typeof candidate.codePoints === "number"
    && typeof candidate.truncatedForModel === "boolean"
    && typeof candidate.sha256 === "string";
}

function toRef(meta: ToolOutputRecordMeta): ToolOutputRef {
  return {
    recordId: meta.recordId,
    resultRef: toolOutputResultRef(meta.recordId),
    runId: meta.runId,
    toolCallId: meta.toolCallId,
    toolName: meta.toolName,
    bytes: meta.bytes,
    codePoints: meta.codePoints,
    truncatedForModel: meta.truncatedForModel,
    createdAt: meta.createdAt,
  };
}

export interface FileToolOutputStoreOptions {
  now?: () => number;
}

/**
 * Tool output persistence deliberately depends on a supplied root, not Electron.
 * That keeps the store directly testable and lets the adapter own userData wiring.
 */
export class FileToolOutputStore implements ToolOutputStore {
  private readonly root: string;
  private readonly now: () => number;

  constructor(root: string, options: FileToolOutputStoreOptions = {}) {
    this.root = path.resolve(root, "cyrene-runs", "tool-results");
    this.now = options.now ?? Date.now;
  }

  async put(input: PutToolOutputInput): Promise<ToolOutputRef> {
    this.validatePutInput(input);
    const recordId = toolOutputRecordId(input.conversationId, input.runId, input.toolCallId);
    const recordDir = this.recordDir(input.conversationId, recordId);

    try {
      const existing = await this.readMetaIfPresent(recordDir);
      if (existing) {
        await this.readAndValidate(recordDir, input.conversationId, recordId);
        if (existing.runId !== input.runId || existing.toolCallId !== input.toolCallId) {
          throw new ToolOutputCorruptError("工具结果记录身份不匹配");
        }
        return toRef(existing);
      }

      await mkdir(recordDir, { recursive: true });
      const outputPath = path.join(recordDir, "output.txt");
      const outputTempPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(outputTempPath, input.output, "utf8");
      await rename(outputTempPath, outputPath);

      const meta: ToolOutputRecordMeta = {
        schemaVersion: SCHEMA_VERSION,
        recordId,
        conversationId: input.conversationId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        outcome: input.outcome,
        createdAt: this.now(),
        bytes: Buffer.byteLength(input.output, "utf8"),
        codePoints: Array.from(input.output).length,
        truncatedForModel: input.truncatedForModel,
        sha256: sha256(input.output),
      };
      const metaPath = path.join(recordDir, "meta.json");
      const metaTempPath = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(metaTempPath, JSON.stringify(meta), "utf8");
      await rename(metaTempPath, metaPath);
      return toRef(meta);
    } catch (error) {
      if (error instanceof ToolOutputCorruptError) throw error;
      throw new ToolOutputPersistenceError("工具结果保存失败", error);
    }
  }

  async read(input: ReadToolOutputInput): Promise<ReadToolOutputResult | null> {
    validateRange(input.offset, input.length);
    const recordId = parseResultRef(input.resultRef);
    const record = await this.readAndValidate(this.recordDir(input.conversationId, recordId), input.conversationId, recordId, input.canReadTool);
    if (!record) return null;
    const points = Array.from(record.output);
    return {
      content: points.slice(input.offset, input.offset + input.length).join(""),
      offset: input.offset,
      totalCodePoints: points.length,
      resultRef: input.resultRef,
      toolName: record.meta.toolName,
    };
  }

  async find(input: FindToolOutputInput): Promise<FindToolOutputResult | null> {
    if (!input.query || Array.from(input.query).length > MAX_READ_CODE_POINTS) {
      throw new ToolOutputInvalidInputError("query 必须是 1-8192 个 Unicode 码点");
    }
    const recordId = parseResultRef(input.resultRef);
    const record = await this.readAndValidate(this.recordDir(input.conversationId, recordId), input.conversationId, recordId, input.canReadTool);
    if (!record) return null;

    const output = Array.from(record.output);
    const query = Array.from(input.query);
    const matches: FindToolOutputMatch[] = [];
    for (let index = 0; index <= output.length - query.length && matches.length < MAX_FIND_MATCHES; index += 1) {
      if (!query.every((point, queryIndex) => output[index + queryIndex] === point)) continue;
      const start = Math.max(0, index - FIND_CONTEXT_CODE_POINTS);
      const end = Math.min(output.length, index + query.length + FIND_CONTEXT_CODE_POINTS);
      matches.push({ offset: index, preview: output.slice(start, end).join("") });
    }
    return { resultRef: input.resultRef, toolName: record.meta.toolName, totalCodePoints: output.length, matches };
  }

  async deleteConversation(conversationId: string): Promise<void> {
    if (!conversationId) throw new ToolOutputInvalidInputError("conversationId 不能为空");
    const target = this.conversationDir(conversationId);
    this.assertWithinRoot(target);
    await rm(target, { recursive: true, force: true });
  }

  private validatePutInput(input: PutToolOutputInput): void {
    if (!input.conversationId || !input.runId || !input.toolCallId || !input.toolName) {
      throw new ToolOutputInvalidInputError("工具结果缺少会话、运行、调用或工具标识");
    }
    if (typeof input.output !== "string") {
      throw new ToolOutputInvalidInputError("工具结果必须是字符串");
    }
  }

  private conversationDir(conversationId: string): string {
    return path.join(this.root, sha256(conversationId));
  }

  private recordDir(conversationId: string, recordId: string): string {
    const target = path.join(this.conversationDir(conversationId), "records", recordId);
    this.assertWithinRoot(target);
    return target;
  }

  private assertWithinRoot(target: string): void {
    const relative = path.relative(this.root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ToolOutputInvalidInputError("工具结果存储路径无效");
    }
  }

  private async readMetaIfPresent(recordDir: string): Promise<ToolOutputRecordMeta | null> {
    try {
      const raw = await readFile(path.join(recordDir, "meta.json"), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecordMeta(parsed)) throw new ToolOutputCorruptError("工具结果元数据损坏");
      return parsed;
    } catch (error) {
      if (isNodeNotFound(error)) return null;
      throw error;
    }
  }

  private async readAndValidate(
    recordDir: string,
    conversationId: string,
    recordId: string,
    canReadTool?: (toolName: string) => boolean,
  ): Promise<{ meta: ToolOutputRecordMeta; output: string } | null> {
    const meta = await this.readMetaIfPresent(recordDir);
    if (!meta) return null;
    if (meta.recordId !== recordId || meta.conversationId !== conversationId) return null;
    if (canReadTool && !canReadTool(meta.toolName)) return null;
    let output: string;
    try {
      output = await readFile(path.join(recordDir, "output.txt"), "utf8");
    } catch (error) {
      if (isNodeNotFound(error)) throw new ToolOutputCorruptError("工具结果内容缺失");
      throw error;
    }
    if (sha256(output) !== meta.sha256
      || Buffer.byteLength(output, "utf8") !== meta.bytes
      || Array.from(output).length !== meta.codePoints) {
      throw new ToolOutputCorruptError("工具结果内容校验失败");
    }
    return { meta, output };
  }
}

function isNodeNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
