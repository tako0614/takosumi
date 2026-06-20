import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  type TakosumiAccountsControlApiPermission,
  type TakosumiAccountsServiceGraphServiceId,
} from "@takosjp/takosumi-accounts-contract";
import type { InstallationRecord } from "./ledger.ts";
import type { AccountsStore, TokenRecord } from "./store.ts";
import {
  base64UrlEncodeBytes,
  constantTimeEqual,
  sha256Text,
} from "./encoding.ts";
import {
  errorJson,
  bearerChallenge,
  bearerToken,
  json,
} from "./http-helpers.ts";

export const SERVICE_GRAPH_SERVICE_TOKEN_ROTATED_EVENT =
  "service_graph_service.token_rotated";
export const SERVICE_GRAPH_SERVICE_EVENT_INGESTED_EVENT =
  "service_event.ingested";

export type ServiceGraphServiceTokenCapability =
  | "billing.usage.report"
  | "events.ingest"
  | "control.api"
  | "ai.model";

export interface ServiceGraphServiceTokenRotation {
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
  readonly capability: ServiceGraphServiceTokenCapability;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly secretRef: string;
  readonly expiresAt: number;
  readonly rotatedAt: number;
}

export function serviceGraphServiceTokenCapability(
  serviceId: string,
): ServiceGraphServiceTokenCapability | undefined {
  if (serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT) {
    return "billing.usage.report";
  }
  if (serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT) {
    return "events.ingest";
  }
  if (serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API) {
    return "control.api";
  }
  if (serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY) {
    return "ai.model";
  }
  return undefined;
}

export function serviceGraphServiceIdsForCapability(
  capability: string,
): readonly TakosumiAccountsServiceGraphServiceId[] {
  if (capability === "billing.usage.report") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT];
  }
  if (capability === "events.ingest") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT];
  }
  if (capability === "control.api") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API];
  }
  if (capability === "ai.model") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY];
  }
  return [];
}

export function mintServiceGraphServiceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `taksrv_${base64UrlEncodeBytes(bytes)}`;
}

export function isServiceGraphServiceAccessTokenRecord(
  record: Pick<TokenRecord, "clientId">,
): boolean {
  return record.clientId.startsWith("service-graph-service:");
}

export async function serviceGraphServiceTokenHash(
  token: string,
): Promise<string> {
  return await sha256Text(`takosumi-service-graph-service:${token}`);
}

export function serviceGraphServiceSecretRef(input: {
  readonly installationId: string;
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
  readonly tokenId: string;
}): string {
  return `takosumi-accounts://installations/${encodeURIComponent(
    input.installationId,
  )}/services/${encodeURIComponent(input.serviceId)}/tokens/${encodeURIComponent(
    input.tokenId,
  )}`;
}

export async function currentServiceGraphServiceTokenRotation(input: {
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
}): Promise<ServiceGraphServiceTokenRotation | undefined> {
  const events = await input.store.listInstallationEvents(input.installationId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.eventType !== SERVICE_GRAPH_SERVICE_TOKEN_ROTATED_EVENT) continue;
    const payload = event.payload;
    if (payload.serviceId !== input.serviceId) continue;
    const capability = serviceGraphServiceTokenCapability(input.serviceId);
    const tokenId = stringPayload(payload.tokenId);
    const tokenHash = stringPayload(payload.tokenHash);
    const secretRef = stringPayload(payload.secretRef);
    const expiresAt = timestampPayload(payload.expiresAt);
    if (!capability || !tokenId || !tokenHash || !secretRef || !expiresAt) {
      continue;
    }
    return {
      serviceId: input.serviceId,
      capability,
      tokenId,
      tokenHash,
      secretRef,
      expiresAt,
      rotatedAt: event.createdAt,
    };
  }
  return undefined;
}

export async function isCurrentServiceGraphServiceAccessToken(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly record: TokenRecord;
  readonly capability: string;
  readonly serviceId?: TakosumiAccountsServiceGraphServiceId;
  readonly now?: number;
}): Promise<boolean> {
  if (!input.record.installationId) return false;
  if (!scopeIncludes(input.record.scope, input.capability)) return false;
  const serviceIds = input.serviceId
    ? [input.serviceId]
    : serviceGraphServiceIdsForCapability(input.capability);
  if (serviceIds.length === 0) return false;
  const tokenHash = await serviceGraphServiceTokenHash(input.token);
  const now = input.now ?? Date.now();
  for (const serviceId of serviceIds) {
    const rotation = await currentServiceGraphServiceTokenRotation({
      store: input.store,
      installationId: input.record.installationId,
      serviceId,
    });
    if (
      rotation &&
      rotation.capability === input.capability &&
      constantTimeEqual(rotation.tokenHash, tokenHash) &&
      rotation.expiresAt > now
    ) {
      return true;
    }
  }
  return false;
}

export async function requireServiceGraphServiceToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
  readonly capability: ServiceGraphServiceTokenCapability;
}): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const token = bearerToken(input.request.headers.get("authorization"));
  if (!token) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  const record = await input.store.findAccessToken(token);
  if (!record || record.expiresAt < Date.now()) {
    if (record) await input.store.deleteToken(token);
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (
    record.installationId !== input.installation.installationId ||
    record.spaceId !== input.installation.spaceId
  ) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (!scopeIncludes(record.scope, input.capability)) {
    return {
      ok: false,
      response: errorJson(
        "insufficient_scope",
        "insufficient scope",
        403,
        undefined,
        {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${input.capability}"`,
        },
      ),
    };
  }
  if (
    !(await isCurrentServiceGraphServiceAccessToken({
      store: input.store,
      token,
      record,
      serviceId: input.serviceId,
      capability: input.capability,
    }))
  ) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  return { ok: true, record };
}

export async function requireSameSpaceServiceGraphControlToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly targetSpaceId: string;
  readonly requiredPermissions?: readonly TakosumiAccountsControlApiPermission[];
}): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const auth = await requireCurrentServiceGraphControlToken(input);
  if (!auth.ok) return auth;
  const { record } = auth;
  if (record.spaceId !== input.targetSpaceId) {
    return {
      ok: false,
      response: errorJson(
        "installation_not_found",
        "installation not found",
        404,
      ),
    };
  }
  return { ok: true, record };
}

export async function requireSameSpaceServiceGraphControlForInstallation(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly targetInstallationId: string;
  readonly requiredPermissions?: readonly TakosumiAccountsControlApiPermission[];
}): Promise<
  | {
      readonly ok: true;
      readonly record: TokenRecord;
      readonly installation: InstallationRecord;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const auth = await requireCurrentServiceGraphControlToken(input);
  if (!auth.ok) return auth;
  const installation = await input.store.findAppInstallation(
    input.targetInstallationId,
  );
  if (!installation) {
    return {
      ok: false,
      response: errorJson(
        "installation_not_found",
        "installation not found",
        404,
      ),
    };
  }
  if (auth.record.spaceId !== installation.spaceId) {
    return {
      ok: false,
      response: errorJson(
        "installation_not_found",
        "installation not found",
        404,
      ),
    };
  }
  return { ok: true, record: auth.record, installation };
}

export async function requireCurrentServiceGraphServiceAccessToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
  readonly capability: ServiceGraphServiceTokenCapability;
  readonly requiredScopes?: readonly string[];
  readonly now?: number;
}): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const token = bearerToken(input.request.headers.get("authorization"));
  if (!token) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  const record = await input.store.findAccessToken(token);
  const now = input.now ?? Date.now();
  if (!record || record.expiresAt < now) {
    if (record) await input.store.deleteToken(token);
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (!scopeIncludes(record.scope, input.capability)) {
    return {
      ok: false,
      response: errorJson(
        "insufficient_scope",
        "insufficient scope",
        403,
        undefined,
        {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${input.capability}"`,
        },
      ),
    };
  }
  const missingScope = (input.requiredScopes ?? []).find(
    (scope) => !scopeIncludes(record.scope, scope),
  );
  if (missingScope) {
    return {
      ok: false,
      response: errorJson(
        "insufficient_scope",
        "insufficient scope",
        403,
        undefined,
        {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${missingScope}"`,
        },
      ),
    };
  }
  if (
    !(await isCurrentServiceGraphServiceAccessToken({
      store: input.store,
      token,
      record,
      serviceId: input.serviceId,
      capability: input.capability,
      now,
    }))
  ) {
    if (isServiceGraphServiceAccessTokenRecord(record)) {
      await input.store.deleteToken(token);
    }
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  return { ok: true, record };
}

async function requireCurrentServiceGraphControlToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly requiredPermissions?: readonly TakosumiAccountsControlApiPermission[];
}): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly response: Response }
> {
  return await requireCurrentServiceGraphServiceAccessToken({
    request: input.request,
    store: input.store,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
    capability: "control.api",
    requiredScopes: input.requiredPermissions,
  });
}

export function serviceGraphServiceTokenScopeIncludes(
  scope: string,
  required: string,
): boolean {
  return scope.split(/\s+/).includes(required);
}

function scopeIncludes(scope: string, required: string): boolean {
  return serviceGraphServiceTokenScopeIncludes(scope, required);
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampPayload(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
