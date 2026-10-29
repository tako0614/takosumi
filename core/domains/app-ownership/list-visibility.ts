import type { ListBackupsResponse } from "takosumi-contract/backups";
import type { UsageEvent } from "takosumi-contract/billing";
import type { Capsule } from "takosumi-contract/install-configs";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type { Run } from "takosumi-contract/runs";
import type { ListSourcesResponse } from "takosumi-contract/sources";

/**
 * Per-app visibility inside Workspace compatibility lists (TASK-0118).
 *
 * A store given a viewer returns only rows the viewer may see, so a page never
 * consists of hidden rows and its keyset cursor never points at one. Every
 * backend (memory, Postgres, D1) applies the same rule in its list query:
 *
 * - An app (Capsule) is hidden when it has an ownership row and the viewer is
 *   neither its owner nor an active member, or when the viewer's credential is
 *   limited to `appIds` that do not include it. An uninstalled app keeps its
 *   ownership row and roster, so its owner and members still see its history.
 *   An app without an ownership row keeps the Workspace decision the route has
 *   already applied.
 * - A Run belongs to its Capsule (an older apply row without one: its plan's
 *   Capsule), else to its Source's apps. A Source belongs to its owner app, or,
 *   while ownerless, to every live app built from it (`capsules.source_id`). A
 *   backup belongs to its Capsule, or, Workspace-wide, to every live app. A
 *   usage event belongs to its Capsule, else to its Run's apps. A row is hidden
 *   when any app it belongs to is hidden; a row that belongs to no app keeps
 *   the Workspace decision.
 * - A usage event whose Run no longer exists cannot be attributed: it is hidden
 *   while the Workspace has an app with an ownership row.
 *
 * A target without the ownership schema (pre-v77 D1, pre-v123 Postgres)
 * applies no predicate: every row keeps the Workspace decision.
 */
export interface AppListViewer {
  readonly accountId: string;
  /** A credential limited to these apps (PAT `appIds`) hides every other owned app. */
  readonly appIds?: readonly string[];
}

/** The memory store's mirror of the SQL rule for one app. */
export function appHiddenFromViewer(
  viewer: AppListViewer,
  capsuleId: string,
  ownerAccountId: string | undefined,
  isActiveMember: () => boolean,
): boolean {
  if (!ownerAccountId) return false;
  if (viewer.appIds !== undefined && !viewer.appIds.includes(capsuleId)) return true;
  return ownerAccountId !== viewer.accountId && !isActiveMember();
}

/**
 * Workspace compatibility lists filtered for one viewer in the store query.
 * A host that wires an ownership store exposes these; the Accounts list routes
 * refuse to serve an unfiltered list when they are missing.
 */
export interface AppViewerLists {
  listCapsulesPage(
    workspaceId: string,
    params: PageParams & { readonly includeDestroyed?: boolean },
    viewer: AppListViewer,
  ): Promise<Page<Capsule>>;
  listRunsPage(
    workspaceId: string,
    options: { readonly limit?: number; readonly cursor?: string },
    viewer: AppListViewer,
  ): Promise<{ readonly runs: readonly Run[]; readonly nextCursor?: string }>;
  listSources(workspaceId: string, params: PageParams, viewer: AppListViewer): Promise<ListSourcesResponse>;
  listBackups(workspaceId: string, params: PageParams, viewer: AppListViewer): Promise<ListBackupsResponse>;
  listWorkspaceUsage(
    workspaceId: string,
    params: PageParams,
    viewer: AppListViewer,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[]; readonly nextCursor?: string }>;
}
