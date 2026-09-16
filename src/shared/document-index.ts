/**
 * 文档摄入索引进度的共享类型。
 *
 * 本文件只定义类型，不引入 main / renderer 专属依赖，
 * 因此可以同时被 main、preload、renderer 安全 import。
 */

/** 单个文档索引任务的状态流转。 */
export type DocumentIndexJobStatus =
  | "queued"
  | "reading"
  | "chunking"
  | "embedding"
  | "cached"
  | "done"
  | "failed"
  | "cancelled";

/** 索引进度事件：main 经 IPC 推给渲染端展示。 */
export type DocumentIndexProgress = {
  jobId: string;
  filePath: string;
  fileName: string;
  status: DocumentIndexJobStatus;
  completedChunks?: number;
  totalChunks?: number;
  reason?: string;
};
