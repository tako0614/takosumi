/**
 * Per-app replacements for Workspace-addressed reads (TASK-0118 Phase 9.1):
 * the app's backups and its Interface materialization failures (with their
 * retry). The `/capsules/:id` dispatcher has already applied the ordinary
 * per-app decision (`view` for reads, `update` for a retry); nothing here
 * reads Workspace membership.
 */
import type { Capsule } from "takosumi-contract/install-configs";
import type { ListBackupsResponse } from "takosumi-contract/backups";
import { clampPageLimit } from "takosumi-contract/pagination";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  stringValue,
} from "../http-helpers.ts";
import { parseLimit } from "./parse.ts";
import {
  controlPlaneUnavailable,
  parseControlPageParams,
  type ControlDispatchContext,
} from "./shared.ts";

/** `GET /api/v1/capsules/:id/backups`: backups taken of this app, newest first. */
export async function handleCapsuleBackupList(
  ctx: ControlDispatchContext,
  capsule: Capsule,
): Promise<Response> {
  const backups = ctx.operations.backups;
  if (typeof backups.listCapsuleBackups !== "function") return controlPlaneUnavailable();
  const page = parseControlPageParams(ctx.url);
  if (!page.ok) return page.response;
  const listed = await backups.listCapsuleBackups.call(backups, capsule.id, {
    ...page.params,
    limit: clampPageLimit(page.params.limit),
  });
  return json({
    backups: listed.backups.filter((backup) => backup.capsuleId === capsule.id),
    ...(listed.nextCursor !== undefined ? { nextCursor: listed.nextCursor } : {}),
  } satisfies ListBackupsResponse, 200, { "cache-control": "no-store" });
}

/**
 * `GET /api/v1/capsules/:id/interface-materialization-failures` and
 * `POST .../interface-materialization-failures/:intentId/retries`.
 */
export async function handleCapsuleInterfaceMaterializationFailures(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { operations } = ctx;
  if (segments.length === 3) {
    if (method !== "GET") return methodNotAllowed("GET");
    if (typeof operations.listCapsuleInterfaceMaterializationFailures !== "function") {
      return controlPlaneUnavailable();
    }
    const limit = parseLimit(ctx.url.searchParams.get("limit"));
    if (limit === "invalid" || (limit !== undefined && limit > 100)) {
      return errorJson("invalid_request", "limit must be an integer from 1 to 100", 400);
    }
    const failures = await operations.listCapsuleInterfaceMaterializationFailures(
      capsule.id,
      limit ? { limit } : {},
    );
    return json({
      failures: failures.filter((failure) => failure.capsuleId === capsule.id),
    }, 200, { "cache-control": "no-store" });
  }
  if (segments.length === 5 && segments[4] === "retries") {
    if (method !== "POST") return methodNotAllowed("POST");
    if (typeof operations.retryCapsuleInterfaceMaterializationFailure !== "function") {
      return controlPlaneUnavailable();
    }
    const intentId = decodeURIComponent(segments[3] ?? "");
    const body = await readJsonObject(ctx.request);
    const failureDigest = body ? stringValue(body.failureDigest) : undefined;
    const stateVersionId = body ? stringValue(body.stateVersionId) : undefined;
    const stateGeneration = body?.stateGeneration;
    if (
      !intentId ||
      !failureDigest ||
      !stateVersionId ||
      typeof stateGeneration !== "number" ||
      !Number.isSafeInteger(stateGeneration) ||
      stateGeneration < 1 ||
      Object.keys(body!).some(
        (key) => key !== "failureDigest" && key !== "stateVersionId" && key !== "stateGeneration",
      )
    ) {
      return errorJson(
        "invalid_request",
        "body must contain failureDigest, stateVersionId, and a positive stateGeneration",
        400,
      );
    }
    return json({
      retry: await operations.retryCapsuleInterfaceMaterializationFailure(
        capsule.id,
        intentId,
        { failureDigest, stateVersionId, stateGeneration },
      ),
    });
  }
  return undefined;
}
