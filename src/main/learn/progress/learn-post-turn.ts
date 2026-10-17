/**
 * LearnPostTurnHook — 每轮回复后静默更新学习进度。
 *
 * 接入点：agui-bridge.ts 的 onAgentRunFinished 后。
 *
 * 策略：
 * - 非阻塞异步执行
 * - 调用轻量模型提取进度增量
 * - 应用到 progress.md
 * - 失败仅 log warn，永不抛出异常上浮
 */

import { extractProgress } from "./learn-progress-extractor";
import { loadProgress, applyUpdate, saveProgress, ensureProgressFile } from "./learn-progress-service";
import { ObsidianWorkspaceService } from "../obsidian/obsidian-workspace-service";
import type { ChatVendorAdapter } from "../../orchestrator/vendors/types";
import type { VendorConfig } from "../../orchestrator/vendors/types";
import type { QuizAnswerResult } from "../../../shared/pop-quiz";

export interface LearnPostTurnDeps {
  workspaceRoot: string;
  adapter: ChatVendorAdapter;
  cfg: VendorConfig;
  systemPrompt: string;
  userMessage: string;
  assistantMessage: string;
  /** 本轮 pop_quiz 抽查的实测作答（已本地判分）；跳过的抽查不进来。 */
  quizEvidence?: QuizAnswerResult[];
}

/**
 * 在有实质性教学内容的轮次后，异步静默更新学习进度。
 */
export async function runLearnPostTurnHook(deps: LearnPostTurnDeps): Promise<void> {
  // 独立实例固定来源 Vault；异步提取完成后不再读取全局绑定。
  const workspace = new ObsidianWorkspaceService();
  workspace.configure({ enabled: true, vaultPath: deps.workspaceRoot });
  // 检查 Vault 是否可用
  if (!workspace.isReady()) {
    console.warn("[LearnProgress] Vault 未配置或不可用，跳过进度更新");
    return;
  }

  try {
    // 跳过短消息（短回复通常不是教学）
    if (deps.assistantMessage.length < 50) return;

    // 确保 progress.md 存在
    await ensureProgressFile(workspace);
  } catch {}

  // 提取进度增量（不阻塞主流程）
  scheduleAsync(() =>
    updateProgressAsync(deps, workspace).catch((err) =>
      console.warn("[LearnProgress] 进度更新失败：", err),
    ),
  );
}

async function updateProgressAsync(deps: LearnPostTurnDeps, workspace: ObsidianWorkspaceService): Promise<void> {
  // 1. 轻量模型提取（quizEvidence 为本轮抽查实测作答，作为客观事实优先采信）
  const update = await extractProgress({
    adapter: deps.adapter,
    cfg: deps.cfg,
    systemPrompt: deps.systemPrompt,
    userMessage: deps.userMessage,
    assistantMessage: deps.assistantMessage,
    quizEvidence: deps.quizEvidence,
  });

  if (!update || !update.hasMeaningfulChange) return;

  // 2. 加载现有进度
  const progress = await loadProgress(workspace);

  // 3. 应用更新
  const updated = applyUpdate(progress, update);

  // 4. 保存
  await saveProgress(updated, workspace);
}

/**
 * 延迟执行异步任务，不阻塞当前调用栈。
 */
function scheduleAsync(fn: () => Promise<void>): void {
  setImmediate(() => {
    fn().catch((err) => console.warn("[LearnProgress] 异步任务失败：", err));
  });
}
