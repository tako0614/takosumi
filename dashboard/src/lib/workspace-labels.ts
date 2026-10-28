/**
 * How a Workspace is named in the UI (スペース in the Japanese UI).
 *
 * A workspace is shown by the name its people gave it. The public API handle
 * is a stable identifier the dashboard generates (`workspace-<time>-<random>`),
 * so it never stands in for a name: a generated handle is never shown, and a
 * chosen handle appears only to tell two workspaces with the same name apart.
 */
import type { Workspace, WorkspaceType } from "./control-api.ts";
import { formatDate, t } from "../i18n/index.ts";

/** What a new workspace is for; offered as the entrance, not the mechanism. */
export type WorkspacePurpose = "environment" | "team";

const GENERATED_HANDLE = /^workspace-[a-z0-9]{1,6}-[a-z0-9]{1,8}$/u;

/** True for handles this dashboard generated rather than a person chose. */
export function isGeneratedWorkspaceHandle(handle: string): boolean {
  return GENERATED_HANDLE.test(handle);
}

/**
 * Fresh public API handle for a workspace created from the dashboard. Global
 * uniqueness is service-enforced, including collision errors.
 */
export function newWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

/** The Workspace type that records a purpose: a team workspace is an organization. */
export function workspaceTypeForPurpose(purpose: WorkspacePurpose): WorkspaceType {
  return purpose === "team" ? "organization" : "personal";
}

/** A workspace's name; never its generated handle. */
export function workspaceName(
  workspace: Pick<Workspace, "displayName" | "handle">,
): string {
  const name = workspace.displayName?.trim();
  if (name && !(name === workspace.handle && isGeneratedWorkspaceHandle(name))) {
    return name;
  }
  return isGeneratedWorkspaceHandle(workspace.handle)
    ? t("workspace.unnamed")
    : workspace.handle;
}

/**
 * A short second label for workspaces that share a name: the chosen handle when
 * there is one, otherwise the day the workspace was created.
 */
export function workspaceDisambiguator(
  workspace: Pick<Workspace, "handle" | "createdAt">,
): string {
  return isGeneratedWorkspaceHandle(workspace.handle)
    ? t("workspace.createdOn", { date: formatDate(workspace.createdAt) })
    : `@${workspace.handle}`;
}

/** Names that appear more than once in `workspaces`. */
export function duplicatedWorkspaceNames(
  workspaces: readonly Pick<Workspace, "displayName" | "handle">[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const name = workspaceName(workspace);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([name]) => name),
  );
}
