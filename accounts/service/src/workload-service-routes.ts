import {
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_DEPLOYMENT_OUTPUTS_HTTP_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_EVENTS_WEBHOOK_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_TAKOSUMI_CONTROL_V1,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
  type TakosumiAccountsWorkloadServiceDescriptor,
  type TakosumiAccountsWorkloadServiceId,
  type TakosumiAccountsWorkloadServiceProjection,
  takosumiAccountsInstallationBillingUsageReportsPath,
  takosumiAccountsInstallationEventsIngestPath,
  takosumiAccountsInstallationServiceRotateTokenPath,
} from "@takosjp/takosumi-accounts-contract";
import { requireAccountsBearer } from "./account-session.ts";
import type { InstallationRecord } from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import {
  activatedHttpDomainProjectionFromEvents,
  appendLedgerEvent,
  serializeActivatedHttpDomainProjection,
  serializeInstallationEvent,
  serializeOidcClient,
} from "./installation-helpers.ts";
import {
  isPlainRecord,
  json,
  numberValue,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "./http-helpers.ts";
import {
  currentWorkloadServiceTokenRotation,
  mintWorkloadServiceToken,
  requireWorkloadServiceToken,
  WORKLOAD_SERVICE_EVENT_INGESTED_EVENT,
  WORKLOAD_SERVICE_TOKEN_ROTATED_EVENT,
  workloadServiceSecretRef,
  workloadServiceTokenCapability,
  workloadServiceTokenHash,
  type WorkloadServiceTokenRotation,
} from "./workload-service-tokens.ts";

const WORKLOAD_SERVICE_TOKEN_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const WORKLOAD_SERVICE_TOKEN_MIN_TTL_SECONDS = 60;
const WORKLOAD_SERVICE_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

export const WORKLOAD_SERVICE_DESCRIPTORS: readonly TakosumiAccountsWorkloadServiceDescriptor[] =
  [
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
      title: "OIDC identity",
      description: "Operator OIDC issuer and per-installation public client.",
      secret_backed: false,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1,
      title: "Billing port",
      description: "Billing portal and usage report endpoint for the workload.",
      secret_backed: true,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_DEPLOYMENT_OUTPUTS_HTTP_V1,
      title: "HTTP deployment outputs",
      description: "Public non-secret HTTP URLs projected from OpenTofu outputs.",
      secret_backed: false,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_EVENTS_WEBHOOK_V1,
      title: "Event ingest",
      description: "Workload-to-Takosumi event ingest endpoint.",
      secret_backed: true,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_TAKOSUMI_CONTROL_V1,
      title: "Space control",
      description: "Same-space Takosumi control service for deployed workloads.",
      secret_backed: true,
    },
  ];

export async function handleListWorkloadServices(input: {
  readonly request: Request;
  readonly store: AccountsStore;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  if (!bearer.ok) return bearer.response;
  return json({ services: WORKLOAD_SERVICE_DESCRIPTORS });
}

export async function handleListInstallationWorkloadServices(input: {
  readonly installationId: string;
  readonly request: Request;
  readonly store: AccountsStore;
  readonly issuer: string;
}): Promise<Response> {
  const access = await requireInstallationOwnerAccess({
    request: input.request,
    store: input.store,
    installationId: input.installationId,
    scope: "read",
  });
  if (!access.ok) return access.response;
  return json({
    installation_id: access.installation.installationId,
    services: await buildInstallationWorkloadServiceProjections({
      store: input.store,
      installation: access.installation,
      issuer: input.issuer,
    }),
  });
}

export async function handleRotateInstallationWorkloadServiceToken(input: {
  readonly installationId: string;
  readonly serviceId: string;
  readonly request: Request;
  readonly store: AccountsStore;
  readonly issuer: string;
}): Promise<Response> {
  const serviceId = workloadServiceIdValue(input.serviceId);
  if (!serviceId) return json({ error: "workload_service_not_found" }, 404);
  const capability = workloadServiceTokenCapability(serviceId);
  if (!capability) {
    return json({
      error: "service_not_secret_backed",
      error_description: "this workload service does not issue tokens",
    }, 400);
  }
  const access = await requireInstallationOwnerAccess({
    request: input.request,
    store: input.store,
    installationId: input.installationId,
    scope: "write",
  });
  if (!access.ok) return access.response;

  const body = await readOptionalJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const ttlSeconds = workloadServiceTokenTtlSeconds(
    body.ttlSeconds ?? body.ttl_seconds,
  );
  if (ttlSeconds === "invalid") {
    return json({
      error: "invalid_request",
      error_description:
        `ttlSeconds must be between ${WORKLOAD_SERVICE_TOKEN_MIN_TTL_SECONDS} and ${WORKLOAD_SERVICE_TOKEN_MAX_TTL_SECONDS}`,
    }, 400);
  }

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const token = mintWorkloadServiceToken();
  const tokenId = `wst_${crypto.randomUUID()}`;
  const secretRef = workloadServiceSecretRef({
    installationId: access.installation.installationId,
    serviceId,
    tokenId,
  });
  await input.store.saveAccessToken(token, {
    clientId: `workload-service:${serviceId}`,
    scope: capability,
    subject: `workload-service:${access.installation.installationId}`,
    takosumiSubject: access.installation.createdBySubject,
    installationId: access.installation.installationId,
    appId: access.installation.appId,
    spaceId: access.installation.spaceId,
    role: "workload-service",
    expiresAt,
  });
  await appendLedgerEvent(input.store, {
    installationId: access.installation.installationId,
    eventType: WORKLOAD_SERVICE_TOKEN_ROTATED_EVENT,
    payload: {
      serviceId,
      capability,
      tokenId,
      tokenHash: await workloadServiceTokenHash(token),
      secretRef,
      expiresAt: new Date(expiresAt).toISOString(),
      rotatedBySubject: access.subject,
    },
    now,
  });
  const services = await buildInstallationWorkloadServiceProjections({
    store: input.store,
    installation: access.installation,
    issuer: input.issuer,
  });
  const service = services.find((candidate) => candidate.id === serviceId);
  return json({
    token,
    token_type: "Bearer",
    expires_at: new Date(expiresAt).toISOString(),
    service: service ?? serviceProjectionFallback(serviceId, input.issuer),
  });
}

export async function handleIngestInstallationWorkloadEvent(input: {
  readonly installationId: string;
  readonly request: Request;
  readonly store: AccountsStore;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  const auth = await requireWorkloadServiceToken({
    request: input.request,
    store: input.store,
    installation,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
    capability: "events.ingest",
  });
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const type = stringValue(body.type);
  const workloadPayload = body.payload === undefined ? {} : body.payload;
  if (
    !type ||
    !/^[a-z][a-z0-9_.:-]{0,95}$/.test(type) ||
    !isJsonValue(workloadPayload)
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "type must be a workload event token and payload must be JSON",
    }, 400);
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    installationId: installation.installationId,
    eventType: WORKLOAD_SERVICE_EVENT_INGESTED_EVENT,
    payload: {
      type: `workload.${type.replace(/^workload\./, "")}`,
      payload: workloadPayload,
      serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
      receivedAt: new Date(now).toISOString(),
    },
    now,
  });
  return json({ event: serializeInstallationEvent(event) }, 202);
}

async function buildInstallationWorkloadServiceProjections(input: {
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly issuer: string;
}): Promise<readonly TakosumiAccountsWorkloadServiceProjection[]> {
  const issuer = normalizeIssuer(input.issuer);
  const events = await input.store.listInstallationEvents(
    input.installation.installationId,
  );
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installation.installationId,
  );
  const account = await input.store.findLedgerAccount(
    input.installation.accountId,
  );
  const billingAccount = input.installation.billingAccountId
    ? await input.store.findBillingAccount(input.installation.billingAccountId)
    : account?.billingAccountId
    ? await input.store.findBillingAccount(account.billingAccountId)
    : account
    ? await input.store.findBillingAccountForSubject(account.legalOwnerSubject)
    : undefined;
  const activatedHttpDomain = activatedHttpDomainProjectionFromEvents(events);
  const billingRotation = await currentWorkloadServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  });
  const eventsRotation = await currentWorkloadServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  });
  const controlRotation = await currentWorkloadServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
  });

  const billingEndpoint = new URL(
    takosumiAccountsInstallationBillingUsageReportsPath(
      input.installation.installationId,
    ),
    issuer,
  ).toString();
  const eventEndpoint = new URL(
    takosumiAccountsInstallationEventsIngestPath(
      input.installation.installationId,
    ),
    issuer,
  ).toString();

  return [
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
      status: oidcClient ? "ready" : "not_configured",
      endpoint: issuer,
      material: oidcClient
        ? {
          ...serializeOidcClient(oidcClient),
          discoveryUrl: new URL(
            "/.well-known/openid-configuration",
            issuer,
          ).toString(),
        }
        : { issuerUrl: issuer },
    },
    withRotation({
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1,
      status: billingAccount ? "ready" : "not_configured",
      endpoint: billingEndpoint,
      material: {
        usageReportEndpoint: billingEndpoint,
        portalUrl: new URL("/account/billing", issuer).toString(),
        billingSubjectRef: billingAccount
          ? `takosumi-accounts://billing-accounts/${
            encodeURIComponent(billingAccount.billingAccountId)
          }`
          : `takosumi-accounts://accounts/${
            encodeURIComponent(input.installation.accountId)
          }/billing`,
      },
      rotation: billingRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_DEPLOYMENT_OUTPUTS_HTTP_V1,
      status: activatedHttpDomain ? "ready" : "not_configured",
      endpoint: activatedHttpDomain?.url,
      material: {
        outputs: activatedHttpDomain
          ? [{
            name: "launch_url",
            kind: "launch_url",
            value: activatedHttpDomain.url,
            sensitive: false,
          }]
          : [],
        ...(activatedHttpDomain
          ? {
            launchUrl: activatedHttpDomain.url,
            activatedHttpDomain:
              serializeActivatedHttpDomainProjection(activatedHttpDomain),
          }
          : {}),
      },
    },
    withRotation({
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_EVENTS_WEBHOOK_V1,
      status: activeRotation(eventsRotation) ? "ready" : "not_configured",
      endpoint: eventEndpoint,
      material: {
        ingestEndpoint: eventEndpoint,
        eventTypePrefix: "workload.",
      },
      rotation: eventsRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
    withRotation({
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
      material_kind: TAKOSUMI_ACCOUNTS_MATERIAL_TAKOSUMI_CONTROL_V1,
      status: activeRotation(controlRotation) ? "ready" : "not_configured",
      endpoint: new URL("/v1", issuer).toString(),
      material: {
        baseUrl: new URL("/v1", issuer).toString(),
        spaceId: input.installation.spaceId,
        allowedOperations: [
          "installations.list.same-space",
          "installations.read.same-space",
          "installations.events.read.same-space",
          "installations.outputs.read.same-space",
          "installations.deploy.same-space",
          "installations.rollback.same-space",
          "installations.materialize.same-space",
          "installations.export.same-space",
          "billing.usage.report.same-space",
        ],
        deniedOperations: [
          "runnerProfiles.manage",
          "providerCredentials.manage",
          "stateBackends.manage",
          "billingOwner.manage",
          "accountTokens.manage",
          "oidcIssuer.manage",
        ],
      },
      rotation: controlRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
  ];
}

function withRotation(input: {
  readonly id: TakosumiAccountsWorkloadServiceId;
  readonly material_kind: string;
  readonly status: TakosumiAccountsWorkloadServiceProjection["status"];
  readonly endpoint?: string;
  readonly material: Record<string, unknown>;
  readonly rotation: WorkloadServiceTokenRotation | undefined;
  readonly issuer: string;
  readonly installationId: string;
}): TakosumiAccountsWorkloadServiceProjection {
  const rotation = activeRotation(input.rotation);
  return {
    id: input.id,
    material_kind: input.material_kind,
    status: input.status,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    material: input.material,
    rotate_token_url: new URL(
      takosumiAccountsInstallationServiceRotateTokenPath(
        input.installationId,
        input.id,
      ),
      input.issuer,
    ).toString(),
    ...(rotation
      ? {
        secret_ref: rotation.secretRef,
        token_expires_at: new Date(rotation.expiresAt).toISOString(),
      }
      : {}),
  };
}

function activeRotation(
  rotation: WorkloadServiceTokenRotation | undefined,
): WorkloadServiceTokenRotation | undefined {
  return rotation && rotation.expiresAt > Date.now() ? rotation : undefined;
}

async function requireInstallationOwnerAccess(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly scope: "read" | "write";
}): Promise<
  | {
    readonly ok: true;
    readonly subject: string;
    readonly installation: InstallationRecord;
  }
  | { readonly ok: false; readonly response: Response }
> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: input.scope,
  });
  if (!bearer.ok) return bearer;
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return { ok: false, response: json({ error: "installation_not_found" }, 404) };
  const account = await input.store.findLedgerAccount(installation.accountId);
  if (account?.legalOwnerSubject !== bearer.auth.subject) {
    return { ok: false, response: json({ error: "installation_not_found" }, 404) };
  }
  return {
    ok: true,
    subject: bearer.auth.subject,
    installation,
  };
}

function workloadServiceTokenTtlSeconds(value: unknown): number | "invalid" {
  if (value === undefined) return WORKLOAD_SERVICE_TOKEN_DEFAULT_TTL_SECONDS;
  const parsed = numberValue(value);
  if (
    parsed === undefined ||
    parsed < WORKLOAD_SERVICE_TOKEN_MIN_TTL_SECONDS ||
    parsed > WORKLOAD_SERVICE_TOKEN_MAX_TTL_SECONDS
  ) {
    return "invalid";
  }
  return parsed;
}

function workloadServiceIdValue(
  value: string,
): TakosumiAccountsWorkloadServiceId | undefined {
  return WORKLOAD_SERVICE_DESCRIPTORS.some((service) => service.id === value)
    ? value as TakosumiAccountsWorkloadServiceId
    : undefined;
}

function serviceProjectionFallback(
  serviceId: TakosumiAccountsWorkloadServiceId,
  issuer: string,
): TakosumiAccountsWorkloadServiceProjection {
  const descriptor = WORKLOAD_SERVICE_DESCRIPTORS.find((service) =>
    service.id === serviceId
  );
  return {
    id: serviceId,
    material_kind: descriptor?.material_kind ?? "unknown",
    status: "unavailable",
    endpoint: normalizeIssuer(issuer),
  };
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}
