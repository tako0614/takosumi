import {
  takosumiAccountsInstallationEventsPath,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import {
  type InstallationRecord,
  verifyInstallationEventHashChain,
} from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import {
  activatedHttpDomainProjectionFromEvents,
  installationEnvelope,
  serializeAppInstallation,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import { errorJson, json } from "./http-helpers.ts";
import { requireAccountsBearer } from "./account-session.ts";
import {
  requireSameSpaceServiceGraphControlForInstallation,
  requireSameSpaceServiceGraphControlToken,
  serviceGraphServiceTokenScopeIncludes,
} from "./service-graph-service-tokens.ts";

/**
 * Pagination guard constants for the list endpoints in this file and the
 * peer pagination helpers in `pat-routes.ts`.
 *
 * The same defaults apply to `handleListAppInstallations`,
 * `handleListInstallationEvents`, and `handleListPersonalAccessTokens`.
 * Cursor values are opaque to the caller: base64-encoded JSON containing a
 * `{ lastId }` field.
 */
export const LIST_PAGE_DEFAULT_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 200;

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
 * List AppInstallations for a space.
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
export async function handleListAppInstallations(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  const spaceId =
    input.url.searchParams.get("space_id") ??
    input.url.searchParams.get("spaceId");
  if (!spaceId) {
    if (!bearer.ok) return bearer.response;
    return errorJson("invalid_request", "space_id is required", 400);
  }
  if (!bearer.ok) {
    const serviceGraphControl = await requireSameSpaceServiceGraphControlToken({
      request: input.request,
      store: input.store,
      targetSpaceId: spaceId,
      requiredPermissions: ["installations.list.same-space"],
    });
    if (!serviceGraphControl.ok) {
      return preferredCompositeAuthResponse(
        bearer.response,
        serviceGraphControl.response,
      );
    }
  }
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
  const space = await input.store.findSpace(spaceId);
  if (!space) return errorJson("space_not_found", "space not found", 404);
  if (
    bearer.ok &&
    !(await subjectCanAccessAccount(
      input.store,
      bearer.auth.subject,
      space.accountId,
    ))
  ) {
    return errorJson("installation_not_found", "installation not found", 404);
  }
  const installations = await input.store.listAppInstallationsForSpace(spaceId);
  const page = paginateById(installations, {
    getId: (installation) => installation.installationId,
    limit,
    afterId,
  });
  return json({
    installations: page.items.map(serializeAppInstallation),
    next_cursor: page.nextCursor,
  });
}

export async function handleGetAppInstallation(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  let serviceGraphControl:
    | Awaited<
        ReturnType<typeof requireSameSpaceServiceGraphControlForInstallation>
      >
    | undefined;
  let bearerFailure: Response | undefined;
  if (!bearer.ok) {
    bearerFailure = bearer.response;
    serviceGraphControl =
      await requireSameSpaceServiceGraphControlForInstallation({
        request: input.request,
        store: input.store,
        targetInstallationId: input.installationId,
        requiredPermissions: ["installations.read.same-space"],
      });
    if (!serviceGraphControl.ok) {
      return preferredCompositeAuthResponse(
        bearerFailure,
        serviceGraphControl.response,
      );
    }
  }
  const installation = serviceGraphControl?.ok
    ? serviceGraphControl.installation
    : await input.store.findAppInstallation(input.installationId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (bearer.ok) {
    if (
      !(await subjectCanAccessInstallation(
        input.store,
        bearer.auth.subject,
        installation,
      ))
    ) {
      return errorJson("installation_not_found", "installation not found", 404);
    }
  }
  // Wave 6 removed `ServiceBindingMaterial` / `ServiceGrantMaterial` / `RuntimeBinding` from the
  // public API surface, so we do not surface them in this account-facing
  // envelope. They are NOT, however, removed from storage: the entities
  // remain `@internal` ledger records, the store interface still defines
  // their accessors, and the export path (`collectInstallationExportBundle`)
  // still reads them via `listServiceBindingMaterialsForInstallation` /
  // `listServiceGrantMaterialsForInstallation`. Here we deliberately load only the OIDC
  // client, which is the sole binding-like entity surfaced on this route.
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installationId,
  );
  const includeOutputProjection =
    !serviceGraphControl?.ok ||
    serviceGraphServiceTokenScopeIncludes(
      serviceGraphControl.record.scope,
      "installations.outputs.read.same-space",
    );
  const events = includeOutputProjection
    ? await input.store.listInstallationEvents(input.installationId)
    : [];
  return json(
    installationEnvelope({
      installation,
      oidcClient,
      activatedHttpDomain: includeOutputProjection
        ? activatedHttpDomainProjectionFromEvents(events)
        : undefined,
      eventsUrl: takosumiAccountsInstallationEventsPath(input.installationId),
    }),
  );
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
export async function subjectCanAccessInstallation(
  store: AccountsStore,
  subject: TakosumiSubject,
  installation: InstallationRecord,
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
 * List InstallationEvent rows for one installation.
 *
 * Authentication: accepts an Account session OR a PAT with `read` scope.
 * Authorization: subject MUST be the current `legalOwnerSubject` of the
 * Installation's LedgerAccount (the `createdBySubject` fallback was
 * removed; see `subjectCanAccessInstallation`).
 *
 * Pagination: `?limit` (default 50, max 200) and `?cursor`
 * (base64url(JSON({ lastId }))). `next_cursor` is `null` on the final
 * page. The `hash_chain_valid` field still reflects the FULL event chain
 * for the installation, not just the current page, because verifying a
 * prefix would create a misleading attestation.
 */
export async function handleListInstallationEvents(input: {
  installationId: string;
  request: Request;
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  // Defense in depth: even though mod.ts wraps this route in an account
  // ownership middleware, enforce the same invariant here so direct callers
  // of the handler cannot read another tenant's event chain. Either an
  // Account session OR a personal access token (read scope) is acceptable,
  // but the authenticated subject MUST be the legalOwnerSubject of the
  // LedgerAccount that owns the Installation; the broader createdBySubject
  // creator-fallback path that `subjectCanAccessInstallation` would allow
  // is intentionally excluded here.
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  let serviceGraphControl:
    | Awaited<
        ReturnType<typeof requireSameSpaceServiceGraphControlForInstallation>
      >
    | undefined;
  let bearerFailure: Response | undefined;
  if (!bearer.ok) {
    bearerFailure = bearer.response;
    serviceGraphControl =
      await requireSameSpaceServiceGraphControlForInstallation({
        request: input.request,
        store: input.store,
        targetInstallationId: input.installationId,
        requiredPermissions: ["installations.events.read.same-space"],
      });
    if (!serviceGraphControl.ok) {
      return preferredCompositeAuthResponse(
        bearerFailure,
        serviceGraphControl.response,
      );
    }
  }
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
  const installation = serviceGraphControl?.ok
    ? serviceGraphControl.installation
    : await input.store.findAppInstallation(input.installationId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (bearer.ok) {
    if (
      !(await subjectCanAccessAccount(
        input.store,
        bearer.auth.subject,
        installation.accountId,
      ))
    ) {
      return errorJson("installation_not_found", "installation not found", 404);
    }
  }
  const allEvents = await input.store.listInstallationEvents(
    input.installationId,
  );
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
    events: page.items.map(serializeInstallationEvent),
    next_cursor: page.nextCursor,
    hash_chain_valid: await verifyInstallationEventHashChain(allEvents),
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

function preferredCompositeAuthResponse(
  accountResponse: Response,
  serviceGraphResponse: Response,
): Response {
  if (accountResponse.status === 401 && serviceGraphResponse.status !== 401) {
    return serviceGraphResponse;
  }
  return accountResponse;
}
