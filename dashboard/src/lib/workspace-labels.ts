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
