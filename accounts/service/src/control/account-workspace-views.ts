/**
 * Read-only account Workspace views.
 *
 * This route is deliberately separate from `/api/v1/workspaces`: that
 * interactive list owns the first-login personal Workspace bootstrap and
 * repair path, while this inventory is a strictly projection-only seam for
 * callers that need every active membership (including archived Workspaces).
 */
import type {
  AccountWorkspaceInventoryPageV1,
  Workspace,
} from "takosumi-contract/workspaces";
import { ACCOUNT_WORKSPACE_INVENTORY_PAGE_V1_KIND } from "takosumi-contract/workspaces";
import { clampPageLimit } from "takosumi-contract/pagination";
import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import type { ControlDispatchContext } from "./shared.ts";
import { parseControlPageParams } from "./shared.ts";

const ACCOUNT_WORKSPACE_INVENTORY_PATH = "workspaces.v1";

const ACCOUNT_WORKSPACE_INVENTORY_FORBIDDEN_MESSAGE =
  "A Workspace-scoped credential cannot read the account Workspace inventory.";

/** Matches the normalized dispatcher segments for this inventory route. */
export function isAccountWorkspaceInventorySegments(
  segments: readonly string[],
): boolean {
  return (
    segments.length === 2 &&
    segments[0] === "views" &&
    segments[1] === ACCOUNT_WORKSPACE_INVENTORY_PATH
  );
}

/**
 * Returns the canonical scope error for the inventory route. The dispatcher
 * uses this before resolving Control operations; the handler repeats the same
 * guard as defense in depth for direct composition callers.
 */
export function accountWorkspaceInventoryForbiddenResponse(): Response {
  return errorJson(
    "forbidden",
    ACCOUNT_WORKSPACE_INVENTORY_FORBIDDEN_MESSAGE,
    403,
  );
}

/** Handles `GET /api/v1/views/workspaces.v1`. */
export async function handleAccountWorkspaceViews(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (!isAccountWorkspaceInventorySegments(segments)) return undefined;
  if (method !== "GET") return methodNotAllowed("GET");

  // A Workspace-scoped credential cannot ask this account-wide view to widen
  // its authority. Check the signed session restriction before touching either
  // the AccountsStore or any operation port.
  if (ctx.session.workspaceId !== undefined) {
    return accountWorkspaceInventoryForbiddenResponse();
  }

  const unknownQueryKey = [...ctx.url.searchParams.keys()].find(
    (key) => key !== "limit" && key !== "cursor",
  );
  if (unknownQueryKey !== undefined) {
    return errorJson(
      "invalid_request",
      `unsupported query parameter: ${unknownQueryKey}`,
      400,
    );
  }
  const parsedPage = parseControlPageParams(ctx.url);
  if (!parsedPage.ok) return parsedPage.response;

  const limit = clampPageLimit(parsedPage.params.limit);
  const page = await ctx.operations.workspaces.listWorkspacesForAccountPage(
    ctx.session.subject,
    {
      includeArchived: true,
      includeTotal: true,
      order: "created_asc",
      limit,
      ...(parsedPage.params.cursor
        ? { cursor: parsedPage.params.cursor }
        : {}),
    },
  );
  assertInventoryPage(page, limit, parsedPage.params.cursor);

  const workspaces = page.items.map(publicWorkspaceProjection);
  const response: AccountWorkspaceInventoryPageV1 = {
    kind: ACCOUNT_WORKSPACE_INVENTORY_PAGE_V1_KIND,
    workspaces,
    total: page.total!,
    returned: workspaces.length,
    limit,
    truncated: page.nextCursor !== undefined,
    ...(page.nextCursor !== undefined
      ? { nextCursor: page.nextCursor }
      : {}),
  };
  return json(response, 200, { "cache-control": "no-store" });
}

function assertInventoryPage(
  page: Readonly<{
    readonly items: readonly Workspace[];
    readonly nextCursor?: string;
    readonly total?: number;
  }>,
  limit: number,
  cursor: string | undefined,
): asserts page is Readonly<{
  readonly items: readonly Workspace[];
  readonly nextCursor?: string;
  readonly total: number;
}> {
  const total = page.total;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    throw new Error("account Workspace inventory total is missing or invalid");
  }
  if (page.items.length > limit || page.items.length > total) {
    throw new Error("account Workspace inventory page is inconsistent");
  }
  if (
    page.nextCursor !== undefined &&
    (typeof page.nextCursor !== "string" ||
      page.nextCursor.length === 0 ||
      page.items.length !== limit ||
      page.items.length >= total)
  ) {
    throw new Error("account Workspace inventory cursor is inconsistent");
  }
  if (
    page.nextCursor === undefined &&
    cursor === undefined &&
    page.items.length !== total
  ) {
    throw new Error("account Workspace inventory total does not match page");
  }
}

/** Select only fields in the public Workspace projection. */
function publicWorkspaceProjection(workspace: Workspace): Workspace {
  return {
    id: workspace.id,
    handle: workspace.handle,
    displayName: workspace.displayName,
    type: workspace.type,
    ownerUserId: workspace.ownerUserId,
    ...(workspace.billingSettings !== undefined
      ? { billingSettings: workspace.billingSettings }
      : {}),
    ...(workspace.archivedAt !== undefined
      ? { archivedAt: workspace.archivedAt }
      : {}),
    ...(workspace.policy !== undefined ? { policy: workspace.policy } : {}),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
