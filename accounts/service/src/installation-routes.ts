import {
  takosumiAccountsCapsuleEventsPath,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import { type CapsuleRecord, verifyCapsuleEventHashChain } from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import {
  type ActivatedHttpDomainProjection,
  activatedHttpDomainProjectionFromEvents,
  deploymentOutputsFromPublicRecord,
  type DeploymentOutputProjection,
  installationEnvelope,
  serializeAppCapsule,
  serializeCapsuleEvent,
} from "./installation-helpers.ts";
import { errorJson, json } from "./http-helpers.ts";
import { requireAccountsBearer } from "./account-session.ts";
import type { DeployControlFacadeOptions } from "./deploy-control-facade.ts";
import { activatedHttpDomainProjectionFromCoreOutputs } from "./installation-lifecycle-shared.ts";

/**
 * Pagination guard constants for the list endpoints in this file and the
 * peer pagination helpers in `pat-routes.ts`.
 *
 * The same defaults apply to `handleListAppCapsules`,
 * `handleListCapsuleEvents`, and `handleListPersonalAccessTokens`.
 * Cursor values are opaque to the caller: base64-encoded JSON containing a
 * `{ lastId }` field.
 */
export const LIST_PAGE_DEFAULT_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 200;
const CURRENT_DEPLOYMENT_PROJECTION_TIMEOUT_MS = 1_200;

export function parsePageLimit(value: string | null): number | "invalid" {
  if (value === null || value === "") return LIST_PAGE_DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return Math.min(parsed, LIST_PAGE_MAX_LIMIT);
}

export function encodePageCursor(lastId: string): string {
  const json = JSON.stringify({ lastId });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodePageCursor(
  value: string | null,
): string | "invalid" | undefined {
  if (value === null || value === "") return undefined;
  let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { lastId?: unknown }).lastId === "string" &&
      (parsed as { lastId: string }).lastId.length > 0
    ) {
      return (parsed as { lastId: string }).lastId;
    }
    return "invalid";
  } catch {
    return "invalid";
  }
}

interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Generic offset-by-id pagination over an in-memory list. `getId` projects
 * the per-row stable identifier used as the cursor anchor. The caller is
 * responsible for ensuring the underlying iteration order is stable; the
 * store-level iterators we wrap today (D1 / Postgres / in-memory) are all
 * insertion-ordered, which is sufficient.
 */
export function paginateById<T>(
  rows: readonly T[],
  options: {
    readonly getId: (row: T) => string;
    readonly limit: number;
    readonly afterId?: string;
  },
): PageResult<T> {
  let startIndex = 0;
  if (options.afterId) {
    const idx = rows.findIndex((row) => options.getId(row) === options.afterId);
    startIndex = idx === -1 ? rows.length : idx + 1;
  }
  const slice = rows.slice(startIndex, startIndex + options.limit);
  const last = slice[slice.length - 1];
  const hasMore = startIndex + slice.length < rows.length;
  const nextCursor =
    hasMore && last ? encodePageCursor(options.getId(last)) : null;
  return { items: slice, nextCursor };
}

/**
 * List AppCapsules for a space.
 *
 * Authentication: accepts either an Account session (Cookie / header) OR a
 * personal access token (PAT) with `read` scope (parity with the other
 * installation handlers).
 *
 * Pagination: accepts `?limit` (default 50, max 200) and `?cursor` (opaque
 * base64 cursor produced by the previous response). Cursor format:
 * `base64url(JSON({ lastId }))`. Responses include a top-level
 * `next_cursor` string (or `null` when the page is the final one). The
 * non-paginated shape is preserved by including `installations`
 * unchanged; callers that ignore `next_cursor` still see the first page.
 */
export async function handleListAppCapsules(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  const workspaceId =
    input.url.searchParams.get("space_id") ??
    input.url.searchParams.get("workspaceId");
  if (!workspaceId) {
    if (!bearer.ok) return bearer.response;
    return errorJson("invalid_request", "space_id is required", 400);
  }
  if (!bearer.ok) return bearer.response;
  const limit = parsePageLimit(input.url.searchParams.get("limit"));
  if (limit === "invalid") {
    return errorJson(
      "invalid_request",
      "limit must be a positive integer",
      400,
    );
  }
  const afterId = decodePageCursor(input.url.searchParams.get("cursor"));
  if (afterId === "invalid") {
    return errorJson("invalid_request", "cursor is malformed", 400);
  }
  const space = await input.store.findWorkspace(workspaceId);
  if (!space) return errorJson("space_not_found", "space not found", 404);
  if (
    !(await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      space.accountId,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  const installations =
    await input.store.listAppCapsulesForWorkspace(workspaceId);
  const page = paginateById(installations, {
    getId: (installation) => installation.capsuleId,
    limit,
    afterId,
  });
  return json({
    installations: page.items.map(serializeAppCapsule),
    next_cursor: page.nextCursor,
  });
}

export async function handleGetAppCapsule(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
  deployControl?: DeployControlFacadeOptions;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  if (!bearer.ok) return bearer.response;
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (
    !(await subjectCanAccessCapsule(
      input.store,
      bearer.auth.subject,
      installation,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  // Wave 6 removed `ServiceBindingMaterial` / `ServiceGrantMaterial` / `RuntimeBinding` from the
  // public API surface, so we do not surface them in this account-facing
  // envelope. They are NOT, however, removed from storage: the entities
  // remain `@internal` ledger records, the store interface still defines
  // their accessors, and the export path (`collectCapsuleExportBundle`)
  // still reads them via `listServiceBindingMaterialsForCapsule` /
  // `listServiceGrantMaterialsForCapsule`. Here we deliberately load only the OIDC
  // client, which is the sole binding-like entity surfaced on this route.
  const oidcClient = await input.store.findOidcClientForCapsule(
    input.capsuleId,
  );
  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const eventActivatedHttpDomain =
    activatedHttpDomainProjectionFromEvents(events);
  const currentDeploymentProjection = eventActivatedHttpDomain
    ? undefined
    : await currentDeploymentProjectionFromDeployControl({
        deployControl: input.deployControl,
        capsuleId: input.capsuleId,
      });
  return json(
    installationEnvelope({
      installation,
      oidcClient,
      activatedHttpDomain:
        eventActivatedHttpDomain ??
        currentDeploymentProjection?.activatedHttpDomain,
      deploymentOutputs: currentDeploymentProjection?.deploymentOutputs,
      eventsUrl: takosumiAccountsCapsuleEventsPath(input.capsuleId),
    }),
  );
}

export async function handleListCapsuleServices(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
  deployControl?: DeployControlFacadeOptions;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  if (!bearer.ok) return bearer.response;
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  if (
    !(await subjectCanAccessCapsule(
      input.store,
      bearer.auth.subject,
      installation,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }

  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const eventActivatedHttpDomain =
    activatedHttpDomainProjectionFromEvents(events);
  const currentDeploymentProjection = eventActivatedHttpDomain
    ? undefined
    : await currentDeploymentProjectionFromDeployControl({
        deployControl: input.deployControl,
        capsuleId: input.capsuleId,
      });
  const deploymentOutputs =
    currentDeploymentProjection?.deploymentOutputs ??
    (eventActivatedHttpDomain
      ? [
          {
            name: "launch_url",
            kind: "launch_url",
            value: eventActivatedHttpDomain.url,
            sensitive: false,
          } satisfies DeploymentOutputProjection,
        ]
      : []);

  return json({
    services: deploymentOutputs.map(deploymentOutputServiceSummary),
  });
}

function deploymentOutputServiceSummary(output: DeploymentOutputProjection) {
  const secretConfigured =
    (output as { readonly sensitive?: unknown }).sensitive === true;
  const endpoint =
    !secretConfigured && typeof output.value === "string" && output.value.trim()
      ? output.value.trim()
      : null;
  return {
    id: output.name,
    capability: "deployment.outputs",
    status: endpoint ? "ready" : "not_configured",
    endpoint,
    secret_configured: secretConfigured,
    token_expires_at: null,
  };
}

async function currentDeploymentProjectionFromDeployControl(input: {
  deployControl?: DeployControlFacadeOptions;
  capsuleId: string;
}): Promise<
  | {
      readonly activatedHttpDomain?: ActivatedHttpDomainProjection;
      readonly deploymentOutputs: readonly DeploymentOutputProjection[];
    }
  | undefined
> {
  if (!input.deployControl) return undefined;
  try {
    return await withProjectionTimeout(
      (async () => {
        const capsuleResponse =
          await input.deployControl!.operations.getCapsule(input.capsuleId);
        const capsule = capsuleResponse.capsule ?? capsuleResponse.installation;
        const currentDeploymentId =
          typeof capsule.currentStateVersionId === "string" &&
          capsule.currentStateVersionId.length > 0
            ? capsule.currentStateVersionId
            : typeof capsule.currentDeploymentId === "string" &&
                capsule.currentDeploymentId.length > 0
              ? capsule.currentDeploymentId
              : undefined;
        const deployments = (
          await input.deployControl!.operations.listDeployments(input.capsuleId)
        ).deployments;
        const deployment = currentDeploymentId
          ? deployments.find((entry) => entry.id === currentDeploymentId)
          : deployments.find((entry) => entry.status === "active");
        if (!deployment) return undefined;
        const deploymentOutputs = deploymentOutputsFromPublicRecord(
          deployment.outputsPublic,
        );
        return {
          activatedHttpDomain: activatedHttpDomainProjectionFromCoreOutputs({
            deploymentId: deployment.id,
            outputs: deployment.outputsPublic,
            now: Date.now(),
          }),
          deploymentOutputs,
        };
      })(),
    );
  } catch {
    return undefined;
  }
}

async function withProjectionTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("current deployment projection timed out"));
        }, CURRENT_DEPLOYMENT_PROJECTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Test whether `subject` can access `installation`.
 *
 * Access depends solely on the current `LedgerAccount.legalOwnerSubject` of
 * the installation's `accountId`. The `createdBySubject ===
 * subject` fallback has been removed: on account transfer, the original
 * creator loses access. Any code path that wants per-installation read/write
 * (lifecycle handlers, dashboard routes, events list) MUST resolve through
 * this function and not assume that being the creator is sufficient.
 */
export async function subjectCanAccessCapsule(
  store: AccountsStore,
  subject: TakosumiSubject,
  installation: CapsuleRecord,
): Promise<boolean> {
  return await subjectCanAccessAccount(store, subject, installation.accountId);
}

export async function subjectCanAccessAccount(
  store: AccountsStore,
  subject: TakosumiSubject,
  accountId: string,
): Promise<boolean> {
  const account = await store.findLedgerAccount(accountId);
  return account?.legalOwnerSubject === subject;
}

/**
 * List CapsuleEvent rows for one installation.
 *
 * Authentication: accepts an Account session OR a PAT with `read` scope.
 * Authorization: subject MUST be the current `legalOwnerSubject` of the
 * Capsule's LedgerAccount (the `createdBySubject` fallback was
 * removed; see `subjectCanAccessCapsule`).
 *
 * Pagination: `?limit` (default 50, max 200) and `?cursor`
 * (base64url(JSON({ lastId }))). `next_cursor` is `null` on the final
 * page. The `hash_chain_valid` field still reflects the FULL event chain
 * for the installation, not just the current page, because verifying a
 * prefix would create a misleading attestation.
 */
export async function handleListCapsuleEvents(input: {
  capsuleId: string;
  request: Request;
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  // Defense in depth: even though mod.ts wraps this route in an account
  // ownership middleware, enforce the same invariant here so direct callers
  // of the handler cannot read another tenant's event chain. Either an
  // Account session OR a personal access token (read scope) is acceptable,
  // but the authenticated subject MUST be the legalOwnerSubject of the
  // LedgerAccount that owns the Capsule; the broader createdBySubject
  // creator-fallback path that `subjectCanAccessCapsule` would allow
  // is intentionally excluded here.
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  if (!bearer.ok) return bearer.response;
  const limit = parsePageLimit(input.url.searchParams.get("limit"));
  if (limit === "invalid") {
    return errorJson(
      "invalid_request",
      "limit must be a positive integer",
      400,
    );
  }
  const afterId = decodePageCursor(input.url.searchParams.get("cursor"));
  if (afterId === "invalid") {
    return errorJson("invalid_request", "cursor is malformed", 400);
  }
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (
    !(await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      installation.accountId,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  const allEvents = await input.store.listCapsuleEvents(input.capsuleId);
  const typeFilter = installationEventTypeFilter(
    input.url.searchParams.get("types"),
  );
  const events = typeFilter
    ? allEvents.filter((event) => typeFilter.has(event.eventType))
    : allEvents;
  const page = paginateById(events, {
    getId: (event) => event.eventId,
    limit,
    afterId,
  });
  return json({
    events: page.items.map(serializeCapsuleEvent),
    next_cursor: page.nextCursor,
    hash_chain_valid: await verifyCapsuleEventHashChain(allEvents),
  });
}

export function installationEventTypeFilter(
  value: string | null,
): ReadonlySet<string> | undefined {
  if (!value) return undefined;
  const types = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return types.length > 0 ? new Set(types) : undefined;
}
