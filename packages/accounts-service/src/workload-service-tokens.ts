import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
  type TakosumiAccountsWorkloadServiceId,
} from "@takosjp/takosumi-accounts-contract";
import type { InstallationRecord } from "./ledger.ts";
import type { AccountsStore, TokenRecord } from "./store.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";
import { bearerChallenge, bearerToken, json } from "./http-helpers.ts";

export const WORKLOAD_SERVICE_TOKEN_ROTATED_EVENT =
  "workload_service.token_rotated";
export const WORKLOAD_SERVICE_EVENT_INGESTED_EVENT =
  "workload.event_ingested";

export type WorkloadServiceTokenCapability =
  | "billing.usage.report"
  | "events.ingest"
  | "takosumi.control.space";

export interface WorkloadServiceTokenRotation {
  readonly serviceId: TakosumiAccountsWorkloadServiceId;
  readonly capability: WorkloadServiceTokenCapability;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly secretRef: string;
  readonly expiresAt: number;
  readonly rotatedAt: number;
}

export function workloadServiceTokenCapability(
  serviceId: string,
): WorkloadServiceTokenCapability | undefined {
  if (serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT) {
    return "billing.usage.report";
  }
  if (
    serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT
  ) {
    return "events.ingest";
  }
  if (
    serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE
  ) {
    return "takosumi.control.space";
  }
  return undefined;
}

export function workloadServiceIdsForCapability(
  capability: string,
): readonly TakosumiAccountsWorkloadServiceId[] {
  if (capability === "billing.usage.report") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT];
  }
  if (capability === "events.ingest") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT];
  }
  if (capability === "takosumi.control.space") {
    return [TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE];
  }
  return [];
}

export function mintWorkloadServiceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `taksrv_${base64UrlEncodeBytes(bytes)}`;
}

export function isWorkloadServiceAccessTokenRecord(
  record: Pick<TokenRecord, "clientId">,
): boolean {
  return record.clientId.startsWith("workload-service:");
}

export async function workloadServiceTokenHash(token: string): Promise<string> {
  return await sha256Text(`takosumi-workload-service:${token}`);
}

export function workloadServiceSecretRef(input: {
  readonly installationId: string;
  readonly serviceId: TakosumiAccountsWorkloadServiceId;
  readonly tokenId: string;
}): string {
  return `takosumi-accounts://installations/${
    encodeURIComponent(input.installationId)
  }/services/${encodeURIComponent(input.serviceId)}/tokens/${
    encodeURIComponent(input.tokenId)
  }`;
}

export async function currentWorkloadServiceTokenRotation(input: {
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly serviceId: TakosumiAccountsWorkloadServiceId;
}): Promise<WorkloadServiceTokenRotation | undefined> {
  const events = await input.store.listInstallationEvents(input.installationId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.eventType !== WORKLOAD_SERVICE_TOKEN_ROTATED_EVENT) continue;
    const payload = event.payload;
    if (payload.serviceId !== input.serviceId) continue;
    const capability = workloadServiceTokenCapability(input.serviceId);
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

export async function isCurrentWorkloadServiceAccessToken(input: {
  readonly store: AccountsStore;
  readonly token: string;
  readonly record: TokenRecord;
  readonly capability: string;
  readonly serviceId?: TakosumiAccountsWorkloadServiceId;
  readonly now?: number;
}): Promise<boolean> {
  if (!input.record.installationId) return false;
  if (!scopeIncludes(input.record.scope, input.capability)) return false;
  const serviceIds = input.serviceId
    ? [input.serviceId]
    : workloadServiceIdsForCapability(input.capability);
  if (serviceIds.length === 0) return false;
  const tokenHash = await workloadServiceTokenHash(input.token);
  const now = input.now ?? Date.now();
  for (const serviceId of serviceIds) {
    const rotation = await currentWorkloadServiceTokenRotation({
      store: input.store,
      installationId: input.record.installationId,
      serviceId,
    });
    if (
      rotation &&
      rotation.capability === input.capability &&
      rotation.tokenHash === tokenHash &&
      rotation.expiresAt > now
    ) {
      return true;
    }
  }
  return false;
}

export async function requireWorkloadServiceToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly serviceId: TakosumiAccountsWorkloadServiceId;
  readonly capability: WorkloadServiceTokenCapability;
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
      response: json({ error: "insufficient_scope" }, 403, {
        "www-authenticate":
          `Bearer error="insufficient_scope", scope="${input.capability}"`,
      }),
    };
  }
  if (
    !await isCurrentWorkloadServiceAccessToken({
      store: input.store,
      token,
      record,
      serviceId: input.serviceId,
      capability: input.capability,
    })
  ) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  return { ok: true, record };
}

export async function requireSameSpaceWorkloadControlToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly targetSpaceId: string;
}): Promise<
  | { readonly ok: true; readonly record: TokenRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const auth = await requireCurrentWorkloadControlToken(input);
  if (!auth.ok) return auth;
  const { record } = auth;
  if (record.spaceId !== input.targetSpaceId) {
    return { ok: false, response: json({ error: "installation_not_found" }, 404) };
  }
  return { ok: true, record };
}

export async function requireSameSpaceWorkloadControlForInstallation(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly targetInstallationId: string;
}): Promise<
  | {
    readonly ok: true;
    readonly record: TokenRecord;
    readonly installation: InstallationRecord;
  }
  | { readonly ok: false; readonly response: Response }
> {
  const auth = await requireCurrentWorkloadControlToken(input);
  if (!auth.ok) return auth;
  const installation = await input.store.findAppInstallation(
    input.targetInstallationId,
  );
  if (!installation) {
    return { ok: false, response: json({ error: "installation_not_found" }, 404) };
  }
  if (auth.record.spaceId !== installation.spaceId) {
    return { ok: false, response: json({ error: "installation_not_found" }, 404) };
  }
  return { ok: true, record: auth.record, installation };
}

async function requireCurrentWorkloadControlToken(input: {
  readonly request: Request;
  readonly store: AccountsStore;
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
  if (!scopeIncludes(record.scope, "takosumi.control.space")) {
    return {
      ok: false,
      response: json({ error: "insufficient_scope" }, 403, {
        "www-authenticate":
          `Bearer error="insufficient_scope", scope="takosumi.control.space"`,
      }),
    };
  }
  if (
    !await isCurrentWorkloadServiceAccessToken({
      store: input.store,
      token,
      record,
      serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
      capability: "takosumi.control.space",
    })
  ) {
    if (isWorkloadServiceAccessTokenRecord(record)) {
      await input.store.deleteToken(token);
    }
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  return { ok: true, record };
}

function scopeIncludes(scope: string, required: string): boolean {
  return scope.split(/\s+/).includes(required);
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampPayload(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
