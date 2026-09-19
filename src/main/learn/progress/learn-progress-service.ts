/**
 * Learn 进度服务 — 读取、合并、保存学习进度到 learn/progress.md。
 *
 * 通过 ObsidianWorkspaceService 进行文件 IO，
 * 维护 progress.md 中的结构化学习进度数据。
 */

import { obsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import {
  defaultProgressContent,
  type LearnProgress,
  type LearnProgressUpdate,
  type LearnTopicProgress,
} from "./learn-progress-types";
import * as yaml from "yaml";

const PROGRESS_FILE = "learn/progress.md";
const YAML_RE = /^---\s*\n([\s\S]*?)\n---/;

/**
 * 从 progress.md 解析学习进度。
 * 文件不存在或解析失败时返回空进度。
 */
export async function loadProgress(): Promise<LearnProgress> {
  try {
    const result = await obsidianWorkspace.readFile({ path: PROGRESS_FILE });
    return parseProgressFile(result.content);
  } catch {
    // 文件不存在，返回默认
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      topics: {},
    };
  }
}

/**
 * 解析 progress.md 内容为结构化进度。
 */
function parseProgressFile(content: string): LearnProgress {
  const match = YAML_RE.exec(content);
  if (!match) return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    topics: {},
  };

  try {
    const frontmatter = yaml.parse(match[1]);
    if (!frontmatter || typeof frontmatter !== "object") throw new Error("invalid yaml");

    const topics: Record<string, LearnTopicProgress> = {};
    if (frontmatter.topics && typeof frontmatter.topics === "object") {
      for (const [key, val] of Object.entries(frontmatter.topics as Record<string, unknown>)) {
        if (val && typeof val === "object") {
          const t = val as Record<string, unknown>;
          topics[key] = {
            status: ["learning", "reviewing", "mastered"].includes(String(t.status))
              ? (t.status as "learning" | "reviewing" | "mastered")
              : "learning",
            mastery: typeof t.mastery === "number" ? Math.min(100, Math.max(0, t.mastery)) : 0,
            unresolvedQuestions: Array.isArray(t.unresolvedQuestions)
              ? t.unresolvedQuestions.filter((q) => typeof q === "string")
              : [],
            lastStudiedAt: typeof t.lastStudiedAt === "string" ? t.lastStudiedAt : new Date().toISOString(),
          };
        }
      }
    }

    return {
      schemaVersion: 1,
      currentTopic: typeof frontmatter.currentTopic === "string" ? frontmatter.currentTopic : undefined,
      currentSection:
        typeof frontmatter.currentSection === "string" ? frontmatter.currentSection : undefined,
      topics,
      nextStep: typeof frontmatter.nextStep === "string" ? frontmatter.nextStep : undefined,
      updatedAt:
        typeof frontmatter.updatedAt === "string"
          ? frontmatter.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      topics: {},
    };
  }
}

/**
 * 从文件系统创建默认进度文件。
 * 在 obsidianWorkspace 可用时调用。
 */
export async function ensureProgressFile(): Promise<boolean> {
  try {
    await obsidianWorkspace.readFile({ path: PROGRESS_FILE });
    return true; // 已存在
  } catch {
    try {
      await obsidianWorkspace.edit({
        operation: "create",
        path: PROGRESS_FILE,
        content: defaultProgressContent(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 更新进度并保存。
 * 由于 workspace.edit 修改已有文件要求携带 expectedContentHash，
 * 写入流程固定为：先 read_file 拿 hash，再 replace_file 携带 hash。
 */
export async function saveProgress(progress: LearnProgress): Promise<boolean> {
  try {
    const content = buildProgressFile(progress);

    // 文件不存在时创建；存在时携带 hash 替换（外部修改过则本轮放弃保存）
    const existing = await obsidianWorkspace.readFile({ path: PROGRESS_FILE }).catch(() => null);
    if (!existing) {
      await obsidianWorkspace.edit({
        operation: "create",
        path: PROGRESS_FILE,
        content,
      });
    } else {
      await obsidianWorkspace.edit({
        operation: "replace_file",
        path: PROGRESS_FILE,
        content,
        expectedContentHash: existing.contentHash,
      });
    }

    return true;
  } catch (err) {
    console.warn("[LearnProgress] 保存进度失败：", err);
    return false;
  }
}

/**
 * 构建 progress.md 文件内容（YAML frontmatter + markdown body）。
 */
function buildProgressFile(progress: LearnProgress): string {
  const now = new Date().toISOString();
  const frontmatter: Record<string, unknown> = {
    schemaVersion: 1,
    updatedAt: now,
  };

  if (progress.currentTopic) frontmatter.currentTopic = progress.currentTopic;
  if (progress.currentSection) frontmatter.currentSection = progress.currentSection;
  if (progress.nextStep) frontmatter.nextStep = progress.nextStep;

  // 按 topic 名排序
  const sortedTopics = Object.keys(progress.topics).sort();
  if (sortedTopics.length > 0) {
    const topicMap: Record<string, unknown> = {};
    for (const name of sortedTopics) {
      const t = progress.topics[name];
      topicMap[name] = {
        status: t.status,
        mastery: t.mastery,
        unresolvedQuestions: t.unresolvedQuestions,
        lastStudiedAt: t.lastStudiedAt,
      };
    }
    frontmatter.topics = topicMap;
  }

  const yamlStr = yaml.stringify(frontmatter).trim();

  let body = `# 学习进度\n\n`;

  if (progress.currentTopic) {
    body += `**当前主题**：${progress.currentTopic}`;
    if (progress.currentSection) body += ` > ${progress.currentSection}`;
    body += `\n\n`;
  }

  if (sortedTopics.length > 0) {
    body += `## 主题掌握度\n\n`;
    for (const name of sortedTopics) {
      const t = progress.topics[name];
      const statusEmoji = t.status === "mastered" ? "✅" : t.status === "reviewing" ? "🔄" : "📖";
      body += `- ${statusEmoji} **${name}** — ${t.mastery}% ${t.status === "mastered" ? "(已掌握)" : t.status === "reviewing" ? "(复习中)" : "(学习中)"}\n`;

      if (t.unresolvedQuestions.length > 0) {
        body += `  - 待解决的问题：\n`;
        for (const q of t.unresolvedQuestions) {
          body += `    - [ ] ${q}\n`;
        }
      }
    }
    body += `\n`;
  }

  if (progress.nextStep) {
    body += `## 下一步\n\n${progress.nextStep}\n`;
  }

  return `---\n${yamlStr}\n---\n\n${body}`;
}

/**
 * 应用进度更新增量到现有进度。
 */
export function applyUpdate(progress: LearnProgress, update: LearnProgressUpdate): LearnProgress {
  if (!update.hasMeaningfulChange) return progress;

  const now = new Date().toISOString();
  const updated: LearnProgress = {
    ...progress,
    updatedAt: now,
  };

  if (update.topic) {
    updated.currentTopic = update.topic;

    // 初始化或更新主题
    if (!updated.topics[update.topic]) {
      updated.topics[update.topic] = {
        status: "learning",
        mastery: 0,
        unresolvedQuestions: [],
        lastStudiedAt: now,
      };
    }

    const topicProgress = { ...updated.topics[update.topic] };
    topicProgress.lastStudiedAt = now;

    // 状态更新
    if (update.status) {
      topicProgress.status = update.status;
    }

    // 掌握度变化
    if (typeof update.masteryDelta === "number") {
      topicProgress.mastery = Math.min(
        100,
        Math.max(0, topicProgress.mastery + update.masteryDelta),
      );
    }

    // 自动推断状态
    if (topicProgress.mastery >= 90 && !update.status) {
      topicProgress.status = "mastered";
    } else if (topicProgress.mastery >= 50 && topicProgress.status === "learning" && !update.status) {
      topicProgress.status = "reviewing";
    }

    // 未解决问题
    if (update.unresolvedQuestionsAdded && update.unresolvedQuestionsAdded.length > 0) {
      const existing = new Set(topicProgress.unresolvedQuestions);
      for (const q of update.unresolvedQuestionsAdded) {
        if (!existing.has(q)) {
          topicProgress.unresolvedQuestions.push(q);
        }
      }
    }
    if (update.unresolvedQuestionsResolved && update.unresolvedQuestionsResolved.length > 0) {
      topicProgress.unresolvedQuestions = topicProgress.unresolvedQuestions.filter(
        (q) => !update.unresolvedQuestionsResolved!.includes(q),
      );
    }

    updated.topics[update.topic] = topicProgress;
  }

  if (update.section) {
    updated.currentSection = update.section;
  }

  if (update.nextStep) {
    updated.nextStep = update.nextStep;
  }

  return updated;
}
