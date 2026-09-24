import { Conversations, type ConversationItemType } from "@ant-design/x";
import { DeleteOutlined, EditOutlined, FolderOpenOutlined, PushpinOutlined } from "@ant-design/icons";
import { ColorPicker, Dropdown, Input, Menu, Modal, Popover, Tooltip } from "antd";
import type { InputRef } from "antd";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Folder, FolderInput, FolderOpen, FolderPlus, Hash, Maximize2, Minimize2 } from "lucide-react";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "../../../i18n";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { SettingsSegmented } from "../../../components/ui/SettingsControls";
import { reportChatPerfRender } from "./chat-perf-probe";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { SidebarOrganizationDraft, SidebarOrganizationSnapshot } from "../../../../../shared/sidebar-organization";

interface ConversationSidebarProps {
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  sidebarSessions: ChatSessionMeta[];
  organization: SidebarOrganizationSnapshot | null;
  onSaveOrganization: (draft: SidebarOrganizationDraft) => Promise<boolean>;
  activeSessionId?: string;
  onSelect: (sessionId: string, mode?: ConversationMode) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string, pinned: boolean) => void | Promise<void>;
}

const SIDEBAR_SESSION_PREVIEW_LIMIT = 5;

interface ProjectSummary {
  name: string;
  workspaceRoot?: string;
  conversationCount: number;
  updatedAt: number;
}

type SidebarNameDialog = {
  kind: "create-project-category" | "rename-project-category" | "create-group" | "rename-group";
  value: string;
  id?: string;
  color?: string;
} | null;

function ProjectIcon({ mode }: { mode: ConversationMode }) {
  if (mode === "code") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22" />
        <path d="M38 29L43 34L38 39" />
        <path d="M30 29L25 34L30 39" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" />
      <path d="M14 22L19 27L14 32" />
      <path d="M26 32H34" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5.5h14v10H9l-4 3v-13Z" />
    </svg>
  );
}

function formatModifiedTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function getThemeAccentColor(): string {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--rb-accent").trim();
  return /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#ff5b8a";
}

function ProjectInfoCard({
  mode,
  project,
  onOpen,
}: {
  mode: ConversationMode;
  project: ProjectSummary;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="cy-project-card" aria-label={t("sidebar.projectInfoAria", { name: project.name })}>
      <div className="cy-project-card__name">
        <ProjectIcon mode={mode} />
        <span>{project.name}</span>
      </div>
      <dl className="cy-project-card__details">
        <div><dt>{t("sidebar.projectNameLabel")}</dt><dd>{project.name}</dd></div>
        <div><dt>{t("sidebar.conversationCountLabel")}</dt><dd>{project.conversationCount}</dd></div>
        <div><dt>{t("sidebar.projectPathLabel")}</dt><dd title={project.workspaceRoot}>{project.workspaceRoot ?? t("sidebar.noProjectPath")}</dd></div>
        <div><dt>{t("sidebar.lastModifiedLabel")}</dt><dd>{formatModifiedTime(project.updatedAt)}</dd></div>
      </dl>
      <button
        className="cy-project-card__open"
        type="button"
        disabled={!project.workspaceRoot}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <ProjectIcon mode={mode} />
        <span>{t("sidebar.openProjectFolder")}</span>
      </button>
    </section>
  );
}

function SortableProjectRow({
  id,
  categoryId,
  title,
  count,
  hideLabel,
  openLabel,
  expanded,
  onToggle,
  onHide,
  onOpen,
  categoryControl,
  children,
}: {
  id: string;
  categoryId: string | null;
  title: string;
  count: number;
  hideLabel: string;
  openLabel: string;
  expanded: boolean;
  onToggle: () => void;
  onHide: () => void;
  onOpen: () => void;
  categoryControl?: ReactNode;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { kind: "project", categoryId } });
  return (
    <section
      ref={setNodeRef}
      className={`cy-sidebar-project ${isDragging ? "is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="cy-sidebar-project__row">
        <button
          type="button"
          className="cy-sidebar-project__handle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`cy-project-sessions-${id}`}
          {...attributes}
          {...listeners}
        >
          {expanded
            ? <FolderOpen className="cy-sidebar-project__folder-icon" size={15} strokeWidth={1.8} aria-hidden="true" />
            : <Folder className="cy-sidebar-project__folder-icon" size={15} strokeWidth={1.8} aria-hidden="true" />}
          <span className="cy-sidebar-project__title" title={title}>{title}</span>
          <span className="cy-sidebar-project__count">{count}</span>
        </button>
        {categoryControl}
        <button type="button" className="cy-sidebar-project__action" title={openLabel} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpen(); }}><FolderOpenOutlined /></button>
        <button type="button" className="cy-sidebar-project__hide" title={hideLabel} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onHide(); }}>×</button>
      </div>
      <div
        id={`cy-project-sessions-${id}`}
        className={`cy-sidebar-expand-region ${expanded ? "is-expanded" : ""}`}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="cy-sidebar-expand-region__inner">
          <div className="cy-sidebar-project__sessions">{children}</div>
        </div>
      </div>
    </section>
  );
}

function SidebarProjectCategory({
  id,
  title,
  color,
  count,
  expanded,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  id: string;
  title: string;
  color: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { isOver, setNodeRef } = useDroppable({ id: `project-category:${id}`, data: { kind: "project-category", categoryId: id } });
  return (
      <section className="cy-sidebar-project-category">
        <div ref={setNodeRef} className={`cy-sidebar-project-category__row ${isOver ? "is-drop-target" : ""}`}>
        <button type="button" className="cy-sidebar-project-category__toggle" onClick={onToggle} aria-expanded={expanded} aria-controls={`cy-project-category-content-${id}`}>
          <span className={`cy-sidebar-project__chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
          <span className="cy-sidebar-project-category__dot" style={{ background: color }} />
          <span className="cy-sidebar-project__title">{title}</span>
          <span className="cy-sidebar-project__count">{count}</span>
        </button>
        <button type="button" className="cy-sidebar-project-category__action" title={t("sidebar.renameProjectCategory")} aria-label={t("sidebar.renameProjectCategory")} onClick={onRename}><EditOutlined /></button>
        <button type="button" className="cy-sidebar-project-category__action" title={t("sidebar.deleteProjectCategory")} aria-label={t("sidebar.deleteProjectCategory")} onClick={onDelete}><DeleteOutlined /></button>
      </div>
      <div
        id={`cy-project-category-content-${id}`}
        className={`cy-sidebar-expand-region ${expanded ? "is-expanded" : ""}`}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="cy-sidebar-expand-region__inner">
          <div className="cy-sidebar-project-category__projects">{children}</div>
        </div>
      </div>
    </section>
  );
}

function SidebarUncategorizedDropTarget({ categoryId, children }: { categoryId: string; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: `project-uncategorized:${categoryId}`, data: { kind: "project-uncategorized" } });
  return <div ref={setNodeRef} className={`cy-sidebar-uncategorized-drop ${isOver ? "is-drop-target" : ""}`}>{children}</div>;
}

function SidebarSessionRow({
  session,
  active,
  title,
  editingValue,
  onEditingChange,
  onEditingCommit,
  onEditingCancel,
  onSelect,
  onContextMenu,
}: {
  session: ChatSessionMeta;
  active: boolean;
  title: string;
  editingValue?: string;
  onEditingChange?: (value: string) => void;
  onEditingCommit?: () => void;
  onEditingCancel?: () => void;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`cy-sidebar-session ${active ? "is-active" : ""}`}
      data-session-id={session.id}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={title}
    >
      {editingValue !== undefined ? (
        <input
          autoFocus
          className="cy-sidebar-session__rename"
          value={editingValue}
          onChange={(event) => onEditingChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEditingCommit?.();
            if (event.key === "Escape") onEditingCancel?.();
          }}
          onBlur={onEditingCommit}
          onClick={(event) => event.stopPropagation()}
        />
      ) : <span className="cy-sidebar-session__title">{title}</span>}
      {session.pinned && <PushpinOutlined className="cy-session-label__pin" />}
    </button>
  );
}

function SortableGroupedSession({
  session,
  groupId,
  children,
}: {
  session: ChatSessionMeta;
  groupId: string | null;
  children: ReactNode;
}) {
  const sortableId = `session:${session.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: { kind: "session", sessionId: session.id, groupId },
  });
  return (
    <div
      ref={setNodeRef}
      className={`cy-sidebar-sortable-session ${isDragging ? "is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      role="presentation"
      {...listeners}
    >
      {children}
    </div>
  );
}

function SortableGroupContainer({ groupId, dragLabel, header, expanded, children }: { groupId: string; dragLabel: string; header: ReactNode; expanded: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group:${groupId}`,
    data: { kind: "group", groupId },
  });
  return (
    <section
      ref={setNodeRef}
      className={`cy-sidebar-group ${isDragging ? "is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="cy-sidebar-group__drag-row">
        <button type="button" className="cy-sidebar-group__drag-handle" aria-label={dragLabel} {...attributes} {...listeners}>⠿</button>
        {header}
      </div>
      <div
        id={`cy-sidebar-group-content-${groupId}`}
        className={`cy-sidebar-expand-region ${expanded ? "is-expanded" : ""}`}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="cy-sidebar-expand-region__inner">
          <div className="cy-sidebar-group__sessions">{children}</div>
        </div>
      </div>
    </section>
  );
}

// 阶段 1A：memo 隔离——ChatPage 流式重渲染时，只要 props 引用稳定（sessions/回调由父级保证），
// 侧栏子树整体跳过执行，流式期间执行次数应为 0（探针验收）。
export const ConversationSidebar = memo(function ConversationSidebar({
  mode,
  sessions,
  sidebarSessions,
  organization,
  onSaveOrganization,
  activeSessionId,
  onSelect,
  onOpenProject,
  onRename,
  onDelete,
  onTogglePin,
}: ConversationSidebarProps) {
  // 性能探针：perf harness 注册后统计侧栏子树执行次数（阶段 1A 验收：流式期间应为 0）
  reportChatPerfRender("sidebarRenders");
  const { t } = useTranslation();
  // 统一反馈入口：删除会话走危险确认
  const feedback = useFeedback();
  const supportsProjects = mode === "work" || mode === "code";
  const projects = useMemo(() => {
    const result = new Map<string, ProjectSummary>();
    for (const session of sessions) {
      const key = session.workspaceRoot ?? `unbound:${session.id}`;
      const current = result.get(key);
      if (current) {
        current.conversationCount += 1;
        current.updatedAt = Math.max(current.updatedAt, session.updatedAt);
      } else {
        result.set(key, {
          name: session.workspaceDisplayName ?? t("sidebar.unboundProject"),
          workspaceRoot: session.workspaceRoot,
          conversationCount: 1,
          updatedAt: session.updatedAt,
        });
      }
    }
    return result;
  }, [sessions]);
  const projectKeys = useMemo(() => [...projects.keys()], [projects]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(projectKeys);

  useEffect(() => {
    setExpandedKeys((current) => [...new Set([...current, ...projectKeys])]);
  }, [projectKeys]);

  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    sessionId: string;
    sessionTitle: string;
    pinned: boolean;
  }>({ open: false, x: 0, y: 0, sessionId: "", sessionTitle: "", pinned: false });

  const [editing, setEditing] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);

  // antd Input 的 ref 是 InputRef（含 focus/select），不是原生元素
  const renameInputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (!editing) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.updatedAt - a.updatedAt;
      }),
    [sessions],
  );

  const [sidebarView, setSidebarView] = useState<"projects" | "groups">(() => {
    try { return localStorage.getItem("cyrene.chat.sidebar.view") === "groups" ? "groups" : "projects"; } catch { return "projects"; }
  });
  const [expandedProjects, setExpandedProjects] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("cyrene.chat.sidebar.projects.expanded") ?? "[]") as string[]; } catch { return []; }
  });
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<string[]>([]);
  const [collapsedProjectCategories, setCollapsedProjectCategories] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("cyrene.chat.sidebar.project-categories.collapsed") ?? "[]") as string[]; } catch { return []; }
  });
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("cyrene.chat.sidebar.groups.expanded") ?? "[]") as string[]; } catch { return []; }
  });
  const [nameDialog, setNameDialog] = useState<SidebarNameDialog>(null);
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const projectRows = useMemo(() => {
    const registered = organization?.projects.filter((project) => !project.hidden) ?? [];
    const sessionsByRoot = new Map<string, ChatSessionMeta[]>();
    for (const session of sidebarSessions) {
      if (!session.workspaceRoot || session.pinned) continue;
      const rootKey = session.workspaceRoot.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
      const entries = sessionsByRoot.get(rootKey) ?? [];
      entries.push(session);
      sessionsByRoot.set(rootKey, entries);
    }
    const byId = new Map(registered.map((project) => [project.id, project]));
    const ids = (organization?.projectOrder ?? []).filter((id) => byId.has(id));
    for (const project of registered) if (!ids.includes(project.id)) ids.push(project.id);
    const result = ids.map((id) => {
      const project = byId.get(id)!;
      const rootKey = project.workspaceRoot.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
      return {
        id,
        root: project.workspaceRoot,
        title: sidebarSessions.find((session) => session.workspaceRoot && session.workspaceRoot.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US") === rootKey)?.workspaceDisplayName
          ?? project.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)
          ?? project.workspaceRoot,
        sessions: (sessionsByRoot.get(rootKey) ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
      };
    });
    const unbound = sidebarSessions.filter((session) => !session.workspaceRoot && !session.pinned)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (unbound.length) result.push({ id: "__unbound__", root: "", title: t("sidebar.unboundProject"), sessions: unbound });
    return result;
  }, [organization, sidebarSessions, t]);
  const projectIds = useMemo(() => projectRows.map((project) => project.id), [projectRows]);
  const collapsibleProjectIds = useMemo(() => projectIds.filter((id) => id !== "__unbound__"), [projectIds]);
  const projectCategoryRows = useMemo(() => {
    const categorizedIds = new Set<string>();
    const categories = (organization?.projectCategories ?? []).map((category) => {
      const memberIds = new Set(organization?.projectCategoryMembers?.[category.id] ?? []);
      const projects = projectRows.filter((project) => project.id !== "__unbound__" && memberIds.has(project.id));
      projects.forEach((project) => categorizedIds.add(project.id));
      return { ...category, projects };
    });
    return {
      categories,
      ungrouped: projectRows.filter((project) => project.id !== "__unbound__" && !categorizedIds.has(project.id)),
    };
  }, [organization, projectRows]);
  const sortableProjectIds = useMemo(() => [
    ...projectCategoryRows.categories.flatMap((category) => collapsedProjectCategories.includes(category.id) ? [] : category.projects.map((project) => project.id)),
    ...projectCategoryRows.ungrouped.map((project) => project.id),
  ], [collapsedProjectCategories, projectCategoryRows]);
  const allProjectFoldersExpanded = collapsibleProjectIds.length > 0
    && collapsibleProjectIds.every((id) => expandedProjects.includes(id))
    && projectCategoryRows.categories.every((category) => !collapsedProjectCategories.includes(category.id));
  const sidebarSessionById = useMemo(() => new Map(sidebarSessions.map((session) => [session.id, session])), [sidebarSessions]);

  useEffect(() => {
    try { localStorage.setItem("cyrene.chat.sidebar.projects.expanded", JSON.stringify(expandedProjects)); } catch { /* optional preference */ }
  }, [expandedProjects]);

  useEffect(() => {
    try { localStorage.setItem("cyrene.chat.sidebar.project-categories.collapsed", JSON.stringify(collapsedProjectCategories)); } catch { /* optional preference */ }
  }, [collapsedProjectCategories]);

  useEffect(() => {
    try { localStorage.setItem("cyrene.chat.sidebar.groups.expanded", JSON.stringify(expandedGroups)); } catch { /* optional preference */ }
  }, [expandedGroups]);

  function selectSidebarView(next: "projects" | "groups") {
    setSidebarView(next);
    try { localStorage.setItem("cyrene.chat.sidebar.view", next); } catch { /* preference is optional */ }
  }

  function toggleAllProjectFolders() {
    if (allProjectFoldersExpanded) {
      setExpandedProjects([]);
      setCollapsedProjectCategories(projectCategoryRows.categories.map((category) => category.id));
    } else {
      setExpandedProjects(collapsibleProjectIds);
      setCollapsedProjectCategories([]);
    }
  }

  function createProjectCategory() {
    if (!organization) return;
    setNameDialog({ kind: "create-project-category", value: "", color: getThemeAccentColor() });
  }

  function moveProjectToCategory(projectId: string, categoryId: string | null) {
    if (!organization) return;
    const projectCategoryMembers = Object.fromEntries(Object.entries(organization.projectCategoryMembers).map(([id, members]) => [
      id,
      members.filter((memberId) => memberId !== projectId),
    ]));
    if (categoryId) projectCategoryMembers[categoryId] = [...(projectCategoryMembers[categoryId] ?? []), projectId];
    void saveOrganizationDraft({ ...organization, projectCategoryMembers });
  }

  function renameProjectCategory(categoryId: string, currentTitle: string) {
    setNameDialog({ kind: "rename-project-category", id: categoryId, value: currentTitle });
  }

  async function deleteProjectCategory(categoryId: string) {
    if (!organization) return;
    const confirmed = await feedback.confirm({
      title: t("sidebar.deleteProjectCategory"),
      message: t("sidebar.deleteProjectCategoryConfirm"),
      confirmText: t("sidebar.deleteProjectCategory"),
      cancelText: t("common.cancel"),
    });
    if (!confirmed) return;
    const projectCategoryMembers = { ...organization.projectCategoryMembers };
    delete projectCategoryMembers[categoryId];
    void saveOrganizationDraft({
      ...organization,
      projectCategories: organization.projectCategories.filter((category) => category.id !== categoryId),
      projectCategoryMembers,
    });
    setCollapsedProjectCategories((current) => current.filter((id) => id !== categoryId));
  }

  function submitNameDialog() {
    if (!organization || !nameDialog) return;
    const title = nameDialog.value.trim();
    if (!title) return;
    if (nameDialog.kind === "create-project-category") {
      const category = { id: `project-category-${crypto.randomUUID()}`, title, color: nameDialog.color ?? getThemeAccentColor() };
      void saveOrganizationDraft({
        ...organization,
        projectCategories: [...organization.projectCategories, category],
        projectCategoryMembers: { ...organization.projectCategoryMembers, [category.id]: [] },
      });
      setCollapsedProjectCategories((current) => current.filter((id) => id !== category.id));
    } else if (nameDialog.kind === "rename-project-category" && nameDialog.id) {
      void saveOrganizationDraft({
        ...organization,
        projectCategories: organization.projectCategories.map((category) => category.id === nameDialog.id ? { ...category, title } : category),
      });
    } else if (nameDialog.kind === "create-group") {
      const id = `group-${crypto.randomUUID()}`;
      void saveOrganizationDraft({
        ...organization,
        groups: [...organization.groups, { id, title, color: nameDialog.color ?? getThemeAccentColor() }],
        topLevelOrder: [...organization.topLevelOrder, { type: "group", groupId: id }],
        groupMembers: { ...organization.groupMembers, [id]: [] },
      });
      setExpandedGroups((current) => [...new Set([...current, id])]);
    } else if (nameDialog.kind === "rename-group" && nameDialog.id) {
      void saveOrganizationDraft({
        ...organization,
        groups: organization.groups.map((group) => group.id === nameDialog.id ? { ...group, title } : group),
      });
    }
    setNameDialog(null);
  }

  async function deleteSidebarGroup(groupId: string) {
    if (!organization) return;
    const confirmed = await feedback.confirm({
      title: t("sidebar.deleteGroup"),
      message: t("sidebar.deleteGroupConfirm"),
      confirmText: t("sidebar.deleteGroup"),
      cancelText: t("common.cancel"),
    });
    if (!confirmed) return;
    const moved = [...(organization.groupMembers[groupId] ?? [])].filter((id) => sidebarSessionById.has(id));
    const groupIndex = organization.topLevelOrder.findIndex((item) => item.type === "group" && item.groupId === groupId);
    const remainingTop = organization.topLevelOrder.filter((item) => !(item.type === "group" && item.groupId === groupId));
    remainingTop.splice(Math.max(0, groupIndex), 0, ...moved.map((id) => ({ type: "session" as const, sessionId: id })));
    const groupMembers = { ...organization.groupMembers };
    delete groupMembers[groupId];
    void saveOrganizationDraft({
      ...organization,
      groups: organization.groups.filter((group) => group.id !== groupId),
      topLevelOrder: remainingTop,
      groupMembers,
    });
  }

  function renderProjectRow(project: (typeof projectRows)[number]) {
    if (project.id === "__unbound__") return null;
    const showAllSessions = expandedProjectSessions.includes(project.id);
    const visibleSessions = showAllSessions
      ? project.sessions
      : project.sessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT);
    const currentCategoryId = Object.entries(organization?.projectCategoryMembers ?? {})
      .find(([, members]) => members.includes(project.id))?.[0];
    const categoryItems = [
      { key: "__uncategorized__", label: t("sidebar.uncategorizedProjects") },
      ...(organization?.projectCategories ?? []).map((category) => ({ key: category.id, label: category.title })),
    ];
    return (
      <SortableProjectRow
        key={project.id}
        id={project.id}
        categoryId={currentCategoryId ?? null}
        title={project.title}
        count={project.sessions.length}
        hideLabel={t("sidebar.hideProject")}
        openLabel={t("sidebar.openProjectFolder")}
        expanded={expandedProjects.includes(project.id)}
        categoryControl={organization?.projectCategories.length ? (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: categoryItems,
              selectedKeys: [currentCategoryId ?? "__uncategorized__"],
              onClick: ({ key }) => moveProjectToCategory(project.id, key === "__uncategorized__" ? null : key),
            }}
          >
            <button
              type="button"
              className="cy-sidebar-project__action cy-sidebar-project__category-action"
              title={t("sidebar.moveProjectToCategory")}
              aria-label={t("sidebar.moveProjectToCategory")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <FolderInput size={13} />
            </button>
          </Dropdown>
        ) : undefined}
        onOpen={() => onOpenProject(project.root)}
        onHide={() => {
          if (!organization) return;
          void saveOrganizationDraft({ ...organization, projects: organization.projects.map((item) => item.id === project.id ? { ...item, hidden: true } : item) });
        }}
        onToggle={() => setExpandedProjects((current) => current.includes(project.id)
          ? current.filter((id) => id !== project.id)
          : [...current, project.id])}
      >
        {visibleSessions.map((session) => renderSidebarSession(session))}
        {project.sessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT && (
          <button
            type="button"
            className="cy-sidebar-show-more"
            aria-expanded={showAllSessions}
            onClick={() => setExpandedProjectSessions((current) => showAllSessions
              ? current.filter((id) => id !== project.id)
              : [...current, project.id])}
          >
            {t(showAllSessions ? "sidebar.showLess" : "sidebar.showMore")}
          </button>
        )}
        {project.sessions.length === 0 && <div className="cy-sidebar-empty-project">{t("sidebar.emptyProjectSessions")}</div>}
      </SortableProjectRow>
    );
  }

  async function saveOrganizationDraft(draft: SidebarOrganizationDraft) {
    await onSaveOrganization(draft);
  }

  function handleProjectDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || !organization) return;
    const activeData = active.data.current as { kind?: string; categoryId?: string | null } | undefined;
    const overData = over.data.current as { kind?: string; categoryId?: string | null } | undefined;
    if (activeData?.kind !== "project") return;
    if (overData?.kind === "project-category" && overData.categoryId) {
      moveProjectToCategory(String(active.id), overData.categoryId);
      return;
    }
    if (overData?.kind === "project-uncategorized") {
      moveProjectToCategory(String(active.id), null);
      return;
    }
    if (active.id === over.id) return;
    const activeCategoryId = activeData.categoryId ?? null;
    const overCategoryId = overData?.categoryId ?? null;
    if (activeCategoryId !== overCategoryId) return;
    if (overData?.kind !== "project") return;
    const bucketIds = activeCategoryId
      ? projectCategoryRows.categories.find((category) => category.id === activeCategoryId)?.projects.map((project) => project.id) ?? []
      : projectCategoryRows.ungrouped.map((project) => project.id);
    const from = bucketIds.indexOf(String(active.id));
    const to = bucketIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const reorderedBucket = arrayMove(bucketIds, from, to);
    const bucketSet = new Set(bucketIds);
    let nextIndex = 0;
    const projectOrder = organization.projectOrder.map((id) => bucketSet.has(id) ? reorderedBucket[nextIndex++]! : id);
    void saveOrganizationDraft({ ...organization, projectOrder });
  }

  function handleGroupDragEnd(event: DragEndEvent) {
    if (!organization || !event.over || event.active.id === event.over.id) return;
    const active = event.active.data.current as { kind?: string; groupId?: string; sessionId?: string } | undefined;
    const over = event.over.data.current as { kind?: string; groupId?: string; sessionId?: string } | undefined;
    if (!active || !over) return;

    if (active.kind === "group" && active.groupId) {
      const topLevelOrder = [...organization.topLevelOrder];
      const from = topLevelOrder.findIndex((item) => item.type === "group" && item.groupId === active.groupId);
      if (from < 0) return;
      if (over.kind === "group" && over.groupId) {
        const groupPositions = topLevelOrder.map((item, index) => item.type === "group" ? index : -1).filter((index) => index >= 0);
        const orderedGroupIds = groupPositions.map((index) => (topLevelOrder[index] as { type: "group"; groupId: string }).groupId);
        const to = orderedGroupIds.indexOf(over.groupId);
        const moved = arrayMove(orderedGroupIds, orderedGroupIds.indexOf(active.groupId), to);
        groupPositions.forEach((index, groupIndex) => { topLevelOrder[index] = { type: "group", groupId: moved[groupIndex]! }; });
      } else if (over.kind === "session" && !over.groupId && over.sessionId) {
        const [groupNode] = topLevelOrder.splice(from, 1);
        const targetIndex = topLevelOrder.findIndex((item) => item.type === "session" && item.sessionId === over.sessionId);
        topLevelOrder.splice(targetIndex < 0 ? topLevelOrder.length : targetIndex, 0, groupNode!);
      } else return;
      void saveOrganizationDraft({ ...organization, topLevelOrder });
      return;
    }

    if (active.kind !== "session" || !active.sessionId) return;
    const sessionId = active.sessionId;
    const topLevelOrder = organization.topLevelOrder.filter((item) => !(item.type === "session" && item.sessionId === sessionId));
    const groupMembers = Object.fromEntries(Object.entries(organization.groupMembers).map(([id, memberIds]) => [
      id,
      memberIds.filter((id) => id !== sessionId),
    ]));
    const destinationGroupId = over.kind === "group" ? over.groupId : over.groupId;
    if (destinationGroupId && organization.groups.some((group) => group.id === destinationGroupId)) {
      const members = groupMembers[destinationGroupId] ?? [];
      const targetIndex = over.kind === "session" && over.sessionId
        ? members.indexOf(over.sessionId)
        : -1;
      members.splice(targetIndex < 0 ? members.length : targetIndex, 0, sessionId);
      groupMembers[destinationGroupId] = members;
    } else {
      const targetIndex = over.kind === "session" && over.sessionId
        ? topLevelOrder.findIndex((item) => item.type === "session" && item.sessionId === over.sessionId)
        : -1;
      topLevelOrder.splice(targetIndex < 0 ? topLevelOrder.length : targetIndex, 0, { type: "session", sessionId });
    }
    void saveOrganizationDraft({ ...organization, topLevelOrder, groupMembers });
  }

  function createSidebarGroup() {
    if (!organization) return;
    setNameDialog({ kind: "create-group", value: "", color: getThemeAccentColor() });
  }

  // 阶段 1A：items 数组 useMemo——避免每次渲染重建（Conversations 拿到新数组引用即重渲染全部条目）
  const items: ConversationItemType[] = useMemo(
    () =>
      sortedSessions.map((session) => ({
        key: session.id,
        "data-session-id": session.id,
        "data-pinned": session.pinned ? "true" : undefined,
        label:
          editing?.sessionId === session.id ? (
            <Input
              ref={renameInputRef}
              size="small"
              className="cy-session-rename-input"
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onPressEnter={() => {
                const title = editing.value.trim();
                if (title && title !== session.title) {
                  void onRename(session.id, title);
                }
                setEditing(null);
              }}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="cy-session-label">
              <span className="cy-session-label__title">{session.title || t("sidebar.defaultSessionTitle")}</span>
              {session.pinned && <PushpinOutlined className="cy-session-label__pin" />}
            </span>
          ),
        icon: <ConversationIcon />,
        ...(supportsProjects ? { group: session.workspaceRoot ?? `unbound:${session.id}` } : {}),
      })),
    [sortedSessions, editing, t, supportsProjects, onRename],
  );

  function openContextMenu(event: React.MouseEvent, sessionId: string) {
    const session = sidebarSessions.find((s) => s.id === sessionId) ?? sessions.find((s) => s.id === sessionId);
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      sessionId,
      sessionTitle: session.title || t("sidebar.defaultSessionTitle"),
      pinned: session.pinned ?? false,
    });
  }

  function closeContextMenu() {
    setContextMenu((current) => ({ ...current, open: false }));
  }

  async function handleMenuClick(key: string) {
    closeContextMenu();
    if (key === "rename") {
      const target = sidebarSessions.find((s) => s.id === contextMenu.sessionId)
        ?? sessions.find((s) => s.id === contextMenu.sessionId);
      setEditing({
        sessionId: contextMenu.sessionId,
        value: target?.title ?? "",
      });
    } else if (key === "toggle-pin") {
      void onTogglePin(contextMenu.sessionId, !contextMenu.pinned);
    } else if (key === "delete") {
      // 删除会话不可恢复：危险确认，默认聚焦取消，确认后才触发删除
      const confirmed = await feedback.confirm({
        title: t("sidebar.deleteConfirmTitle", { title: contextMenu.sessionTitle }),
        message: t("sidebar.deleteConfirmContent"),
        confirmText: t("sidebar.delete"),
        cancelText: t("common.cancel"),
        dangerous: true,
      });
      if (confirmed) onDelete(contextMenu.sessionId);
    } else if (key.startsWith("move-to-group:") && organization) {
      const groupId = key.slice("move-to-group:".length);
      const topLevelOrder = organization.topLevelOrder.filter((item) => !(item.type === "session" && item.sessionId === contextMenu.sessionId));
      const groupMembers = Object.fromEntries(Object.entries(organization.groupMembers).map(([id, memberIds]) => [
        id,
        memberIds.filter((id) => id !== contextMenu.sessionId),
      ]));
      groupMembers[groupId] = [...(groupMembers[groupId] ?? []), contextMenu.sessionId];
      void saveOrganizationDraft({ ...organization, topLevelOrder, groupMembers });
    } else if (key === "move-to-top" && organization) {
      const groupMembers = Object.fromEntries(Object.entries(organization.groupMembers).map(([id, memberIds]) => [
        id,
        memberIds.filter((id) => id !== contextMenu.sessionId),
      ]));
      const topLevelOrder = organization.topLevelOrder.some((item) => item.type === "session" && item.sessionId === contextMenu.sessionId)
        ? organization.topLevelOrder
        : [...organization.topLevelOrder, { type: "session" as const, sessionId: contextMenu.sessionId }];
      void saveOrganizationDraft({ ...organization, topLevelOrder, groupMembers });
    }
  }

  function renderSidebarSession(session: ChatSessionMeta) {
    return (
      <SidebarSessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId}
        title={session.title || t("sidebar.defaultSessionTitle")}
        editingValue={editing?.sessionId === session.id ? editing.value : undefined}
        onEditingChange={(value) => setEditing({ sessionId: session.id, value })}
        onEditingCommit={() => {
          if (editing?.sessionId !== session.id) return;
          const title = editing.value.trim();
          if (title && title !== session.title) void onRename(session.id, title);
          setEditing(null);
        }}
        onEditingCancel={() => setEditing(null)}
        onSelect={() => onSelect(session.id, session.mode)}
        onContextMenu={(event) => openContextMenu(event, session.id)}
      />
    );
  }

  const pinnedSidebarSessions = sidebarSessions.filter((session) => session.pinned).sort((a, b) => b.updatedAt - a.updatedAt);

  useEffect(() => {
    if (!contextMenu.open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (target.closest(".cy-session-context-menu")) return;
      closeContextMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu.open]);

  return (
    <nav className={`cy-conversation-sidebar ${supportsProjects ? "cy-chat-sidebar" : ""}`} aria-label={supportsProjects ? t("sidebar.projectsAndConversationsAria") : t("sidebar.conversationListAria")}>
      <div className="cy-conversation-sidebar__title">{supportsProjects ? t("sidebar.projectsTitle") : t("sidebar.conversationsTitle")}</div>
      {supportsProjects && (
        <div className="cy-sidebar-toolbar">
          <SettingsSegmented
            className="cy-sidebar-view-switch"
            value={sidebarView}
            options={[
              { label: <span className="cy-sidebar-view-label"><Folder size={12} />{t("sidebar.projectsView")}</span>, value: "projects" },
              { label: <span className="cy-sidebar-view-label"><Hash size={12} />{t("sidebar.groupsView")}</span>, value: "groups" },
            ]}
            onChange={(value) => selectSidebarView(value as "projects" | "groups")}
          />
          {sidebarView === "projects" && (
            <>
              <Tooltip title={t(allProjectFoldersExpanded ? "sidebar.collapseAllProjects" : "sidebar.expandAllProjects")}>
                <button
                  className="cy-sidebar-expand-toggle"
                  type="button"
                  aria-label={t(allProjectFoldersExpanded ? "sidebar.collapseAllProjects" : "sidebar.expandAllProjects")}
                  disabled={collapsibleProjectIds.length === 0}
                  onClick={toggleAllProjectFolders}
                >
                  {allProjectFoldersExpanded
                    ? <Minimize2 size={14} strokeWidth={1.8} />
                    : <Maximize2 size={14} strokeWidth={1.8} />}
                </button>
              </Tooltip>
              <Tooltip title={t("sidebar.createProjectCategory")}>
                <button
                  className="cy-sidebar-expand-toggle"
                  type="button"
                  aria-label={t("sidebar.createProjectCategory")}
                  onClick={createProjectCategory}
                >
                  <FolderPlus size={15} strokeWidth={1.8} />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      )}
      {supportsProjects ? (
        <div className="cy-conversation-list-wrapper cy-sidebar-tree">
            {pinnedSidebarSessions.length > 0 && (
              <section className="cy-sidebar-pinned">
                <div className="cy-sidebar-section-label">{t("sidebar.pinned")}</div>
                {pinnedSidebarSessions.map((session) => renderSidebarSession(session))}
              </section>
            )}
            {sidebarView === "projects" ? (
              <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleProjectDragEnd}>
                <SortableContext items={sortableProjectIds} strategy={verticalListSortingStrategy}>
                  {projectCategoryRows.categories.map((category) => (
                    <SidebarProjectCategory
                      key={category.id}
                      id={category.id}
                      title={category.title}
                      color={category.color}
                      count={category.projects.length}
                      expanded={!collapsedProjectCategories.includes(category.id)}
                      onToggle={() => setCollapsedProjectCategories((current) => current.includes(category.id)
                        ? current.filter((id) => id !== category.id)
                        : [...current, category.id])}
                      onRename={() => renameProjectCategory(category.id, category.title)}
                      onDelete={() => deleteProjectCategory(category.id)}
                    >
                      {category.projects.map((project) => renderProjectRow(project))}
                      {category.projects.length === 0 && <div className="cy-sidebar-empty-project">{t("sidebar.emptyProjectCategory")}</div>}
                    </SidebarProjectCategory>
                  ))}
                  {projectCategoryRows.categories.length > 0 && (
                    <SidebarUncategorizedDropTarget categoryId="all">
                      <div className="cy-sidebar-section-label">{t("sidebar.uncategorizedProjects")}</div>
                    </SidebarUncategorizedDropTarget>
                  )}
                  {projectCategoryRows.ungrouped.map((project) => renderProjectRow(project))}
                </SortableContext>
                <DragOverlay dropAnimation={null} />
              </DndContext>
            ) : (
              <>
                <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
                <SortableContext
                  items={(organization?.topLevelOrder ?? []).flatMap((item) => item.type === "group"
                    ? [`group:${item.groupId}`, ...(expandedGroups.includes(item.groupId) ? (organization?.groupMembers[item.groupId] ?? []).filter((id) => sidebarSessionById.has(id) && !sidebarSessionById.get(id)?.pinned).map((id) => `session:${id}`) : [])]
                    : [`session:${item.sessionId}`])}
                  strategy={verticalListSortingStrategy}
                >
                <div className="cy-sidebar-groups-toolbar">
                  <span>{t("sidebar.groupsView")}</span>
                  <button type="button" onClick={createSidebarGroup}>{t("sidebar.createGroup")}</button>
                </div>
                {(organization?.topLevelOrder ?? []).map((item) => {
                  if (item.type === "session") {
                    const session = sidebarSessionById.get(item.sessionId);
                    if (!session || session.pinned) return null;
                    return <SortableGroupedSession key={session.id} session={session} groupId={null}>{renderSidebarSession(session)}</SortableGroupedSession>;
                  }
                  const group = organization?.groups.find((candidate) => candidate.id === item.groupId);
                  if (!group) return null;
                  const members = (organization?.groupMembers[group.id] ?? []).map((id) => sidebarSessionById.get(id)).filter((session): session is ChatSessionMeta => Boolean(session && !session.pinned));
                  const expanded = expandedGroups.includes(group.id);
                  return (
                    <SortableGroupContainer
                      key={group.id}
                      groupId={group.id}
                      dragLabel={t("sidebar.dragGroup")}
                      expanded={expanded}
                      header={(
                        <div className="cy-sidebar-group__heading">
                        <button type="button" className="cy-sidebar-group__toggle" aria-expanded={expanded} aria-controls={`cy-sidebar-group-content-${group.id}`} onClick={() => setExpandedGroups((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])}>
                            <span className={`cy-sidebar-project__chevron ${expanded ? "is-open" : ""}`} />
                            <span className="cy-sidebar-group__dot" style={{ background: group.color }} />
                            <span className="cy-sidebar-project__title">{group.title}</span>
                            <span className="cy-sidebar-project__count">{members.length}</span>
                          </button>
                          <button type="button" className="cy-sidebar-group__action" title={t("sidebar.renameGroup")} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                            setNameDialog({ kind: "rename-group", id: group.id, value: group.title });
                          }}>···</button>
                          <button type="button" className="cy-sidebar-group__action" title={t("sidebar.deleteGroup")} onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                            void deleteSidebarGroup(group.id);
                          }}>×</button>
                        </div>
                      )}
                    >
                      {members.map((session) => (
                        <SortableGroupedSession key={session.id} session={session} groupId={group.id}>
                          {renderSidebarSession(session)}
                        </SortableGroupedSession>
                      ))}
                    </SortableGroupContainer>
                  );
                })}
                </SortableContext>
                <DragOverlay dropAnimation={null} />
                </DndContext>
              </>
            )}
            {projectRows.filter((project) => project.id === "__unbound__").map((project) => (
              <section className="cy-sidebar-project cy-sidebar-project--unbound" key={project.id}>
                <div className="cy-sidebar-project__row"><span className="cy-sidebar-project__title">{project.title}</span></div>
                {project.sessions.map((session) => renderSidebarSession(session))}
              </section>
            ))}
            {sidebarSessions.length === 0 && <div className="cy-conversation-sidebar__empty">{t("sidebar.emptyProjects")}</div>}
          </div>
      ) : items.length === 0 ? (
        <div className="cy-conversation-sidebar__empty">{t("sidebar.emptyConversations")}</div>
      ) : (
        <>
          <div
            className="cy-conversation-list-wrapper"
            onContextMenu={(e) => {
              const item = (e.target as HTMLElement).closest("[data-session-id]");
              const sessionId = item?.getAttribute("data-session-id");
              if (!sessionId) return;
              openContextMenu(e, sessionId);
            }}
          >
            <Conversations
              rootClassName="cy-conversation-list"
              items={items}
              activeKey={activeSessionId}
              onActiveChange={(key) => {
                onSelect(String(key));
              }}
              groupable={supportsProjects ? {
                collapsible: true,
                expandedKeys,
                // @ant-design/x 2.9.0 在 setState updater 内部调用 onExpand（use-collapsible.js），
                // updater 会在渲染期执行，直接 setExpandedKeys 会触发
                // "Cannot update a component while rendering a different component"。
                // 用 queueMicrotask 把 setState 挪出渲染期，行为不变。
                onExpand: (keys) => {
                  queueMicrotask(() => setExpandedKeys(keys));
                },
                label: (group) => {
                  const project = projects.get(group);
                  if (!project) return null;
                  return (
                    <Popover
                      placement="rightTop"
                      mouseEnterDelay={0.25}
                      mouseLeaveDelay={0.12}
                      overlayClassName="cy-project-popover"
                      content={(
                        <ProjectInfoCard
                          mode={mode}
                          project={project}
                          onOpen={() => project.workspaceRoot && onOpenProject(project.workspaceRoot)}
                        />
                      )}
                    >
                      <span className="cy-conversation-project">
                        <ProjectIcon mode={mode} />
                        <span>{project.name}</span>
                      </span>
                    </Popover>
                  );
                },
              } : false}
            />
          </div>
        </>
      )}
      {contextMenu.open && (
        <div className="cy-session-context-menu" style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 1050 }}>
          <Menu
            items={[
              { key: "rename", label: t("sidebar.rename"), icon: <EditOutlined /> },
              { key: "toggle-pin", label: contextMenu.pinned ? t("sidebar.unpin") : t("sidebar.pin"), icon: <PushpinOutlined /> },
              { key: "delete", label: t("sidebar.delete"), icon: <DeleteOutlined />, danger: true },
              ...(organization?.groups.length ? [{ type: "divider" as const }] : []),
              ...(organization?.groups ?? []).map((group) => ({ key: `move-to-group:${group.id}`, label: `${t("sidebar.moveToGroup")}: ${group.title}` })),
              ...(organization?.groups.some((group) => organization.groupMembers[group.id]?.includes(contextMenu.sessionId)) ? [{ key: "move-to-top", label: t("sidebar.moveToUngrouped") }] : []),
            ]}
            onClick={({ key }) => handleMenuClick(key)}
          />
        </div>
      )}
      <Modal
        className="cy-sidebar-name-modal"
        open={Boolean(nameDialog)}
        title={nameDialog?.kind === "create-project-category" ? t("sidebar.newProjectCategoryPrompt")
          : nameDialog?.kind === "rename-project-category" ? t("sidebar.renameProjectCategoryPrompt")
            : nameDialog?.kind === "create-group" ? t("sidebar.newGroupPrompt")
              : t("sidebar.renameGroupPrompt")}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        onCancel={() => setNameDialog(null)}
        onOk={submitNameDialog}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={nameDialog?.value ?? ""}
          onChange={(event) => setNameDialog((current) => current ? { ...current, value: event.target.value } : current)}
          onPressEnter={submitNameDialog}
        />
        {(nameDialog?.kind === "create-project-category" || nameDialog?.kind === "create-group") && (
          <div className="cy-sidebar-create-color">
            <span>{t("sidebar.colorLabel")}</span>
            <ColorPicker
              value={nameDialog.color ?? getThemeAccentColor()}
              format="hex"
              showText
              presets={[{ label: t("sidebar.colorPresets"), colors: ["#ff5b8a", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#64748b"] }]}
              onChange={(color) => setNameDialog((current) => current ? { ...current, color: color.toHexString() } : current)}
            />
          </div>
        )}
      </Modal>
    </nav>
  );
});
