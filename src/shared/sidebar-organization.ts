/** Persistent project/group organization for the Work and Code sidebar. */
export interface SidebarProject {
  id: string;
  workspaceRoot: string;
  hidden: boolean;
}

export interface SidebarProjectCategory {
  id: string;
  title: string;
  color: string;
}

export interface SidebarGroup {
  id: string;
  title: string;
  color: string;
}

export type SidebarTopLevelItem =
  | { type: "group"; groupId: string }
  | { type: "session"; sessionId: string };

export interface SidebarOrganizationSnapshot {
  version: 1;
  revision: number;
  projects: SidebarProject[];
  projectOrder: string[];
  projectCategories: SidebarProjectCategory[];
  projectCategoryMembers: Record<string, string[]>;
  groups: SidebarGroup[];
  topLevelOrder: SidebarTopLevelItem[];
  groupMembers: Record<string, string[]>;
}

export type SidebarOrganizationDraft = Omit<SidebarOrganizationSnapshot, "version" | "revision">;

export type SidebarOrganizationResult =
  | { ok: true; snapshot: SidebarOrganizationSnapshot }
  | { ok: false; reason: "conflict" | "invalid" | "write-failed"; snapshot: SidebarOrganizationSnapshot };
