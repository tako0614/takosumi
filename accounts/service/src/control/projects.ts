/**
 * Session-authenticated facade for the canonical Project ledger.
 *
 * Accounts owns only authentication and Workspace authorization here; Project
 * identity, validation, uniqueness, and persistence remain in core.
 */
import type { ControlDispatchContext } from "./shared.ts";
import { requireWorkspaceAccess } from "./shared.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  stringValue,
} from "../http-helpers.ts";

export async function handleWorkspaceProjects(
  ctx: ControlDispatchContext,
  workspaceId: string,
  method: string,
): Promise<Response> {
  if (method === "GET") {
    return json({
      projects: await ctx.operations.projects.listProjects(workspaceId),
    });
  }
  if (method !== "POST") return methodNotAllowed("GET, POST");
  const body = await readJsonObject(ctx.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const name = stringValue(body.name)?.trim();
  const slug = stringValue(body.slug)?.trim();
  if (!name || !slug) {
    return errorJson("invalid_request", "name and slug are required", 400);
  }
  if (
    body.projectJson !== undefined &&
    (!isRecord(body.projectJson) || Array.isArray(body.projectJson))
  ) {
    return errorJson("invalid_request", "projectJson must be an object", 400);
  }
  const project = await ctx.operations.projects.createProject({
    workspaceId,
    name,
    slug,
    ...(body.projectJson !== undefined
      ? { projectJson: body.projectJson as Readonly<Record<string, unknown>> }
      : {}),
  });
  return json({ project }, 201);
}

export async function handleProjects(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  if (segments[0] !== "projects" || segments.length !== 2) return undefined;
  if (method !== "GET") return methodNotAllowed("GET");
  const projectId = decodeURIComponent(segments[1] ?? "");
  const project = await ctx.operations.projects.getProject(projectId);
  const auth = await requireWorkspaceAccess({
    operations: ctx.operations,
    store: ctx.store,
    workspaceId: project.workspaceId,
    session: ctx.session,
  });
  if (!auth.ok) return auth.response;
  return json({ project });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
