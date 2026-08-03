/**
 * Closed, page-owned Workspace read projections.
 *
 * These handlers adapt an authenticated account request to one bounded
 * application operation. The application operation owns Workspace authority
 * and its fixed read plan; this HTTP module owns only parsing, deadline, and
 * response redaction.
 */
import type {
  WorkspaceResourcesView,
  WorkspaceResourceSummary,
} from "../control-operations.ts";
import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  controlPlaneUnavailable,
  publicCapsule,
} from "./shared.ts";

const RESOURCES_VIEW_DEFAULT_LIMIT = 50;
const RESOURCES_VIEW_MAX_LIMIT = 100;
const RESOURCES_VIEW_DEADLINE_MS = 1_200;

export async function handleWorkspaceResourcesView(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const views = ctx.operations.workspaceViews;
  if (!views) return controlPlaneUnavailable();
  const parsedPage = parseWorkspaceViewPage(ctx.url);
  if (!parsedPage.ok) return parsedPage.response;
  const page = {
    ...(parsedPage.params.cursor ? { cursor: parsedPage.params.cursor } : {}),
    limit: Math.min(
      parsedPage.params.limit ?? RESOURCES_VIEW_DEFAULT_LIMIT,
      RESOURCES_VIEW_MAX_LIMIT,
    ),
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const view = await Promise.race([
      views.readResources({
        workspaceId,
        space: workspaceId,
        subject: ctx.session.subject,
        ...(ctx.session.workspaceId
          ? { credentialWorkspaceId: ctx.session.workspaceId }
          : {}),
        requiredAccess: "read",
        page,
        signal: controller.signal,
      }),
      new Promise<WorkspaceResourcesView>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("workspace resources view deadline exceeded"));
        }, RESOURCES_VIEW_DEADLINE_MS);
      }),
    ]);
    return json(sanitizeWorkspaceResourcesView(view, workspaceId), 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    controller.abort();
    if (isWorkspaceViewAccessDenied(error)) {
      return errorJson(
        "forbidden",
        "The authenticated session cannot access this Workspace.",
        403,
      );
    }
    if (isWorkspaceViewCursorInvalid(error)) {
      return errorJson("invalid_request", "cursor is malformed", 400);
    }
    return controlPlaneUnavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isWorkspaceViewCursorInvalid(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "workspace_view_cursor_invalid"
  );
}

function parseWorkspaceViewPage(url: URL):
  | {
      readonly ok: true;
      readonly params: { readonly limit?: number; readonly cursor?: string };
    }
  | { readonly ok: false; readonly response: Response } {
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/u.test(rawLimit) || Number(rawLimit) < 1) {
      return {
        ok: false,
        response: errorJson(
          "invalid_request",
          "limit must be a positive integer",
          400,
        ),
      };
    }
    limit = Number(rawLimit);
  }
  const rawCursor = url.searchParams.get("cursor");
  if (
    rawCursor !== null &&
    rawCursor !== "" &&
    (rawCursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(rawCursor))
  ) {
    return {
      ok: false,
      response: errorJson("invalid_request", "cursor is malformed", 400),
    };
  }
  return {
    ok: true,
    params: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== null && rawCursor !== "" ? { cursor: rawCursor } : {}),
    },
  };
}

function isWorkspaceViewAccessDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "workspace_view_access_denied"
  );
}

function sanitizeWorkspaceResourcesView(
  view: WorkspaceResourcesView,
  workspaceId: string,
): WorkspaceResourcesView {
  if (
    view.view !== "resources.v1" ||
    view.workspaceId !== workspaceId ||
    view.space !== workspaceId ||
    typeof view.hasTargetPool !== "boolean"
  ) {
    throw new Error("invalid resources view identity");
  }
  return {
    view: "resources.v1",
    workspaceId,
    space: workspaceId,
    ...(view.nextCursor ? { nextCursor: view.nextCursor } : {}),
    resources: sanitizeResourcePage(view.resources),
    workloads: {
      items: view.workloads.items.map(publicCapsule),
      ...(view.workloads.nextCursor
        ? { nextCursor: view.workloads.nextCursor }
        : {}),
    },
    forms: {
      items: view.forms.items,
      ...(view.forms.nextCursor ? { nextCursor: view.forms.nextCursor } : {}),
    },
    hasTargetPool: view.hasTargetPool,
  };
}

function sanitizeResourcePage(
  page: WorkspaceResourcesView["resources"],
): WorkspaceResourcesView["resources"] {
  return {
    items: page.items.map(sanitizeResourceSummary),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function sanitizeResourceSummary(
  resource: WorkspaceResourceSummary,
): WorkspaceResourceSummary {
  if (
    typeof resource.id !== "string" ||
    typeof resource.apiVersion !== "string" ||
    typeof resource.kind !== "string" ||
    typeof resource.metadata?.name !== "string" ||
    typeof resource.metadata.space !== "string" ||
    typeof resource.metadata.managedBy !== "string"
  ) {
    throw new Error("invalid Resource summary");
  }
  const metadata = {
    name: resource.metadata.name,
    space: resource.metadata.space,
    ...(resource.metadata.project !== undefined
      ? { project: resource.metadata.project }
      : {}),
    ...(resource.metadata.environment !== undefined
      ? { environment: resource.metadata.environment }
      : {}),
    ...(resource.metadata.labels !== undefined
      ? { labels: resource.metadata.labels }
      : {}),
    managedBy: resource.metadata.managedBy,
  };
  const status = resource.status
    ? {
        phase: resource.status.phase,
        observedGeneration: resource.status.observedGeneration,
        ...(resource.status.resolution
          ? { resolution: resource.status.resolution }
          : {}),
      }
    : undefined;
  return {
    id: resource.id,
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata,
    ...(status ? { status } : {}),
  };
}
