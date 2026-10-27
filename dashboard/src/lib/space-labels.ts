/**
 * How a Workspace is named in the UI, where it is called a スペース / space.
 *
 * A space is shown by the name its people gave it. The public API handle is a
 * stable identifier the dashboard generates (`workspace-<time>-<random>`), so
 * it never stands in for a name: a generated handle is never shown, and a
 * chosen handle appears only to tell two spaces with the same name apart.
 */
import type { Workspace, WorkspaceType } from "./control-api.ts";
import { formatDate, t } from "../i18n/index.ts";

/** What a new space is for; offered as the entrance instead of the mechanism. */
export type SpacePurpose = "environment" | "team";

const GENERATED_HANDLE = /^workspace-[a-z0-9]{1,6}-[a-z0-9]{1,8}$/u;

/** True for handles this dashboard generated rather than a person chose. */
export function isGeneratedSpaceHandle(handle: string): boolean {
  return GENERATED_HANDLE.test(handle);
}

/**
 * Fresh public API handle for a space created from the dashboard. Global
 * uniqueness is service-enforced, including collision errors.
 */
export function newSpaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

/** The Workspace type that records a purpose: a team space is an organization. */
export function workspaceTypeForPurpose(purpose: SpacePurpose): WorkspaceType {
  return purpose === "team" ? "organization" : "personal";
}

/** A space's name; never its generated handle. */
export function spaceName(
  workspace: Pick<Workspace, "displayName" | "handle">,
): string {
  const name = workspace.displayName?.trim();
  if (name && !(name === workspace.handle && isGeneratedSpaceHandle(name))) {
    return name;
  }
  return isGeneratedSpaceHandle(workspace.handle)
    ? t("space.unnamed")
    : workspace.handle;
}

/**
 * A short second label for spaces that share a name: the chosen handle when
 * there is one, otherwise the day the space was created.
 */
export function spaceDisambiguator(
  workspace: Pick<Workspace, "handle" | "createdAt">,
): string {
  return isGeneratedSpaceHandle(workspace.handle)
    ? t("space.createdOn", { date: formatDate(workspace.createdAt) })
    : `@${workspace.handle}`;
}

/** Names that appear more than once in `workspaces`. */
export function duplicatedSpaceNames(
  workspaces: readonly Pick<Workspace, "displayName" | "handle">[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const name = spaceName(workspace);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([name]) => name),
  );
}
