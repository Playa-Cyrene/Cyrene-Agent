import fs from "node:fs/promises";
import path from "node:path";
import {
  EXERCISES_README_MD,
  MATERIALS_README_MD,
  NOTES_README_MD,
  OUTLINE_TEMPLATE_MD,
  PROGRESS_MD,
  REVIEW_TEMPLATE_MD,
  TOPIC_TEMPLATE_MD,
  VAULT_README_MD,
  renderTemplate,
} from "./vault-templates";

export interface VaultInitEntry {
  relativePath: string;
  content: string;
}

const VAULT_ENTRIES: VaultInitEntry[] = [
  { relativePath: "README.md", content: VAULT_README_MD },
  { relativePath: "materials/README.md", content: MATERIALS_README_MD },
  { relativePath: "notes/README.md", content: NOTES_README_MD },
  { relativePath: "exercises/README.md", content: EXERCISES_README_MD },
  { relativePath: "templates/topic-template.md", content: TOPIC_TEMPLATE_MD },
  { relativePath: "templates/review-template.md", content: REVIEW_TEMPLATE_MD },
  { relativePath: "templates/outline-template.md", content: OUTLINE_TEMPLATE_MD },
  { relativePath: "learn/progress.md", content: PROGRESS_MD },
];

export interface VaultInitResult {
  created: string[];
  skipped: string[];
  error?: string;
}

/**
 * Check whether a directory looks like an empty workspace that can be auto-initialized.
 * Directories that already contain any regular file or Obsidian metadata are not empty.
 */
export async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // 忽略纯应用数据目录：只含它们时仍视为"空"，可被 Learn bootstrap 初始化。
    // .cyrene/ 是同进程外部的 Cyrene Notes 写的内部数据目录。
    const ignoredDirs = new Set([".obsidian", ".cyrene"]);
    const ignoredFiles = new Set([".DS_Store", "Thumbs.db"]);
    return entries.every((entry) => {
      if (ignoredFiles.has(entry.name)) return true;
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) return true;
      return false;
    });
  } catch {
    return true;
  }
}

/**
 * Create the Cyrene Learn workspace structure.
 * Only missing files are created; existing files are never overwritten.
 */
export async function ensureVaultStructure(root: string): Promise<VaultInitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const entry of VAULT_ENTRIES) {
    const fullPath = path.join(root, entry.relativePath);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      try {
        await fs.access(fullPath);
        skipped.push(entry.relativePath);
      } catch {
        const content = renderTemplate(entry.content, { date: today });
        await fs.writeFile(fullPath, content, "utf-8");
        created.push(entry.relativePath);
      }
    } catch (err) {
      return { created, skipped, error: String(err) };
    }
  }

  return { created, skipped };
}
