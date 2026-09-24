import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ChatSessionMeta } from "../../shared/chat-types";
import type {
  SidebarGroup,
  SidebarOrganizationDraft,
  SidebarOrganizationResult,
  SidebarOrganizationSnapshot,
  SidebarProjectCategory,
  SidebarProject,
  SidebarTopLevelItem,
} from "../../shared/sidebar-organization";
import * as chatsStore from "./chats-store";

const FILE_NAME = "sidebar-organization.json";
let snapshot: SidebarOrganizationSnapshot | null = null;

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  const parsedRoot = path.parse(resolved).root;
  const normalizedPath = `${parsedRoot}${resolved.slice(parsedRoot.length).replace(/[\\/]+$/, "")}`;
  return process.platform === "win32" ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath;
}

function projectId(root: string): string {
  return `project-${createHash("sha256").update(normalizeRoot(root)).digest("hex").slice(0, 20)}`;
}

function filePath(): string {
  return path.join(chatsStore.getRootDir(), FILE_NAME);
}

function clone(value: SidebarOrganizationSnapshot): SidebarOrganizationSnapshot {
  return JSON.parse(JSON.stringify(value)) as SidebarOrganizationSnapshot;
}

function emptySnapshot(): SidebarOrganizationSnapshot {
  return { version: 1, revision: 0, projects: [], projectOrder: [], projectCategories: [], projectCategoryMembers: {}, groups: [], topLevelOrder: [], groupMembers: {} };
}

function readDisk(): SidebarOrganizationSnapshot {
  const target = filePath();
  if (!fs.existsSync(target)) return emptySnapshot();
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<SidebarOrganizationSnapshot>;
    const valid = value.version === 1 && Number.isSafeInteger(value.revision)
      && Array.isArray(value.projects) && value.projects.every((item) => item
        && typeof item.id === "string" && typeof item.workspaceRoot === "string" && typeof item.hidden === "boolean")
      && Array.isArray(value.projectOrder) && value.projectOrder.every((id) => typeof id === "string")
      && (value.projectCategories === undefined || Array.isArray(value.projectCategories) && value.projectCategories.every((item) => item
        && typeof item.id === "string" && typeof item.title === "string" && typeof item.color === "string"
        && /^#[0-9a-fA-F]{6}$/.test(item.color)))
      && (value.projectCategoryMembers === undefined || value.projectCategoryMembers && typeof value.projectCategoryMembers === "object"
        && !Array.isArray(value.projectCategoryMembers)
        && Object.values(value.projectCategoryMembers).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string")))
      && Array.isArray(value.groups) && value.groups.every((item) => item
        && typeof item.id === "string" && typeof item.title === "string" && typeof item.color === "string"
        && /^#[0-9a-fA-F]{6}$/.test(item.color))
      && Array.isArray(value.topLevelOrder) && value.topLevelOrder.every((item) => item
        && ((item.type === "group" && typeof item.groupId === "string")
          || (item.type === "session" && typeof item.sessionId === "string")))
      && value.groupMembers && typeof value.groupMembers === "object" && !Array.isArray(value.groupMembers)
      && Object.values(value.groupMembers).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"));
    if (!valid) {
      throw new Error("invalid sidebar organization schema");
    }
    return {
      version: 1,
      revision: value.revision!,
      projects: value.projects as SidebarProject[],
      projectOrder: value.projectOrder as string[],
      projectCategories: (value.projectCategories ?? []) as SidebarProjectCategory[],
      projectCategoryMembers: (value.projectCategoryMembers ?? {}) as Record<string, string[]>,
      groups: value.groups as SidebarGroup[],
      topLevelOrder: value.topLevelOrder as SidebarTopLevelItem[],
      groupMembers: value.groupMembers as Record<string, string[]>,
    };
  } catch (error) {
    // Preserve malformed user data for recovery; rebuild a displayable in-memory view.
    try {
      fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
    } catch (backupError) {
      console.warn("[sidebar-organization] could not preserve corrupt file", backupError);
    }
    console.warn("[sidebar-organization] invalid file; rebuilding from chat index", error);
    return emptySnapshot();
  }
}

function migrateLegacyProjects(current: SidebarOrganizationSnapshot, sessions: ChatSessionMeta[]): SidebarOrganizationSnapshot {
  const result = clone(current);
  const knownRoots = new Set(result.projects.map((project) => normalizeRoot(project.workspaceRoot)));
  const roots = new Map<string, string>();
  for (const session of sessions) {
    if ((session.mode !== "work" && session.mode !== "code") || !session.workspaceRoot) continue;
    const normalized = normalizeRoot(session.workspaceRoot);
    if (!knownRoots.has(normalized)) roots.set(normalized, session.workspaceRoot);
  }
  for (const [normalized, workspaceRoot] of roots) {
    const id = projectId(workspaceRoot);
    if (result.projects.some((project) => project.id === id)) continue;
    result.projects.push({ id, workspaceRoot, hidden: false });
    result.projectOrder.push(id);
    knownRoots.add(normalized);
  }
  if (result.topLevelOrder.length === 0 && result.groups.length === 0) {
    result.topLevelOrder = sessions
      .filter((session) => session.mode === "work" || session.mode === "code")
      .map((session) => ({ type: "session" as const, sessionId: session.id }));
  }
  return result;
}

function reconcile(current: SidebarOrganizationSnapshot, sessions: ChatSessionMeta[]): SidebarOrganizationSnapshot {
  const allowed = new Set(sessions.filter((session) => session.mode === "work" || session.mode === "code").map((session) => session.id));
  const result = clone(current);
  const knownProjects = new Set(result.projects.map((project) => project.id));
  const assignedProjects = new Set<string>();
  result.projectCategoryMembers = Object.fromEntries(result.projectCategories.map((category) => {
    const members = (result.projectCategoryMembers[category.id] ?? []).filter((id) => {
      if (!knownProjects.has(id) || assignedProjects.has(id)) return false;
      assignedProjects.add(id);
      return true;
    });
    return [category.id, members];
  }));
  const used = new Set<string>();
  result.topLevelOrder = result.topLevelOrder.filter((item) => {
    if (item.type === "group") return result.groups.some((group) => group.id === item.groupId);
    if (item.type !== "session" || !allowed.has(item.sessionId) || used.has(item.sessionId)) return false;
    used.add(item.sessionId);
    return true;
  });
  result.groupMembers = Object.fromEntries(result.groups.map((group) => {
    const members: string[] = [];
    for (const id of result.groupMembers[group.id] ?? []) {
      if (allowed.has(id) && !used.has(id)) {
        members.push(id);
        used.add(id);
      }
    }
    return [group.id, members];
  }));
  for (const session of sessions) {
    if ((session.mode === "work" || session.mode === "code") && !used.has(session.id)) {
      result.topLevelOrder.push({ type: "session", sessionId: session.id });
    }
  }
  result.projectOrder = [...new Set(result.projectOrder.filter((id) => result.projects.some((project) => project.id === id)))];
  for (const project of result.projects) if (!result.projectOrder.includes(project.id)) result.projectOrder.push(project.id);
  return result;
}

function persist(value: SidebarOrganizationSnapshot): void {
  const target = filePath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, target);
}

function isValidDraft(draft: SidebarOrganizationDraft, sessions: ChatSessionMeta[], currentProjects: SidebarProject[]): boolean {
  if (!draft || !Array.isArray(draft.projects) || !Array.isArray(draft.projectOrder)
    || !Array.isArray(draft.projectCategories) || !draft.projectCategoryMembers
    || typeof draft.projectCategoryMembers !== "object" || Array.isArray(draft.projectCategoryMembers)
    || !Array.isArray(draft.groups) || !Array.isArray(draft.topLevelOrder)
    || !draft.groupMembers || typeof draft.groupMembers !== "object" || Array.isArray(draft.groupMembers)) return false;
  const projectIds = new Set<string>();
  const roots = new Set<string>();
  const allowedRoots = new Set([
    ...currentProjects.map((project) => normalizeRoot(project.workspaceRoot)),
    ...sessions.filter((session) => (session.mode === "work" || session.mode === "code") && session.workspaceRoot)
      .map((session) => normalizeRoot(session.workspaceRoot!)),
  ]);
  for (const project of draft.projects) {
    if (!project || typeof project.id !== "string" || typeof project.workspaceRoot !== "string"
      || typeof project.hidden !== "boolean" || project.id !== projectId(project.workspaceRoot)
      || !allowedRoots.has(normalizeRoot(project.workspaceRoot))
      || projectIds.has(project.id) || roots.has(normalizeRoot(project.workspaceRoot))) return false;
    projectIds.add(project.id);
    roots.add(normalizeRoot(project.workspaceRoot));
  }
  if (new Set(draft.projectOrder).size !== draft.projectOrder.length || draft.projectOrder.some((id) => !projectIds.has(id))) return false;
  if (draft.projectOrder.length !== projectIds.size || currentProjects.some((project) => !projectIds.has(project.id))) return false;
  const projectCategoryIds = new Set<string>();
  for (const category of draft.projectCategories) {
    if (!category || typeof category.id !== "string" || !category.id || typeof category.title !== "string" || !category.title.trim()
      || typeof category.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(category.color) || projectCategoryIds.has(category.id)) return false;
    projectCategoryIds.add(category.id);
  }
  const categorizedProjects = new Set<string>();
  for (const [categoryId, ids] of Object.entries(draft.projectCategoryMembers)) {
    if (!projectCategoryIds.has(categoryId) || !Array.isArray(ids)) return false;
    for (const id of ids) {
      if (!projectIds.has(id) || categorizedProjects.has(id)) return false;
      categorizedProjects.add(id);
    }
  }
  const groupIds = new Set<string>();
  for (const group of draft.groups) {
    if (!group || typeof group.id !== "string" || !group.id || typeof group.title !== "string" || !group.title.trim()
      || typeof group.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(group.color) || groupIds.has(group.id)) return false;
    groupIds.add(group.id);
  }
  const allowed = new Set(sessions.filter((session) => session.mode === "work" || session.mode === "code").map((session) => session.id));
  const used = new Set<string>();
  const orderedGroups = new Set<string>();
  for (const item of draft.topLevelOrder) {
    if (item?.type === "group") {
      if (!groupIds.has(item.groupId) || orderedGroups.has(item.groupId)) return false;
      orderedGroups.add(item.groupId);
    } else if (item?.type === "session") {
      if (!allowed.has(item.sessionId) || used.has(item.sessionId)) return false;
      used.add(item.sessionId);
    } else return false;
  }
  if (orderedGroups.size !== groupIds.size) return false;
  for (const [groupId, ids] of Object.entries(draft.groupMembers)) {
    if (!groupIds.has(groupId) || !Array.isArray(ids)) return false;
    for (const id of ids) {
      if (!allowed.has(id) || used.has(id)) return false;
      used.add(id);
    }
  }
  return true;
}

export function initialize(): void {
  if (snapshot) return;
  const sessions = chatsStore.listSessions();
  const loaded = readDisk();
  snapshot = reconcile(migrateLegacyProjects(loaded, sessions), sessions);
  if (JSON.stringify(snapshot) !== JSON.stringify(loaded)) {
    snapshot.revision = loaded.revision + 1;
    try { persist(snapshot); } catch (error) { console.error("[sidebar-organization] initialization save failed", error); }
  }
}

export function getSnapshot(): SidebarOrganizationSnapshot {
  initialize();
  const reconciled = reconcile(snapshot!, chatsStore.listSessions());
  if (JSON.stringify(reconciled) !== JSON.stringify(snapshot)) {
    reconciled.revision = snapshot!.revision + 1;
    try {
      persist(reconciled);
      snapshot = reconciled;
    } catch (error) {
      console.error("[sidebar-organization] reconciliation save failed", error);
    }
  }
  return clone(snapshot!);
}

export function applyDraft(expectedRevision: number, draft: SidebarOrganizationDraft): SidebarOrganizationResult {
  initialize();
  const current = snapshot!;
  if (expectedRevision !== current.revision) return { ok: false, reason: "conflict", snapshot: clone(current) };
  const sessions = chatsStore.listSessions();
  if (!isValidDraft(draft, sessions, current.projects)) return { ok: false, reason: "invalid", snapshot: clone(current) };
  const next: SidebarOrganizationSnapshot = { ...draft, version: 1, revision: current.revision + 1 };
  try {
    persist(next);
    snapshot = next;
    return { ok: true, snapshot: clone(next) };
  } catch (error) {
    console.error("[sidebar-organization] save failed", error);
    return { ok: false, reason: "write-failed", snapshot: clone(current) };
  }
}
