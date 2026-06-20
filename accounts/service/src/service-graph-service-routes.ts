import {
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_DEPLOYMENT_OUTPUTS,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_EVENTS_WEBHOOK,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_CONTROL_API,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  TAKOSUMI_ACCOUNTS_CONTROL_API_PERMISSIONS,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_EMBEDDING_MODEL,
  type TakosumiAccountsServiceGraphServiceDescriptor,
  type TakosumiAccountsServiceGraphServiceId,
  type TakosumiAccountsServiceGraphServiceProjection,
  takosumiAccountsInstallationBillingUsageReportsPath,
  takosumiAccountsInstallationEventsIngestPath,
  takosumiAccountsInstallationServiceRotateTokenPath,
} from "@takosjp/takosumi-accounts-contract";
import { TAKOSUMI_AI_GATEWAY_BASE_PATH } from "takosumi-contract/ai-gateway";
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
  errorJson,
  isPlainRecord,
  json,
  numberValue,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "./http-helpers.ts";
import {
  currentServiceGraphServiceTokenRotation,
  mintServiceGraphServiceToken,
  requireServiceGraphServiceToken,
  SERVICE_GRAPH_SERVICE_EVENT_INGESTED_EVENT,
  SERVICE_GRAPH_SERVICE_TOKEN_ROTATED_EVENT,
  serviceGraphServiceSecretRef,
  serviceGraphServiceTokenCapability,
  serviceGraphServiceTokenHash,
  type ServiceGraphServiceTokenRotation,
} from "./service-graph-service-tokens.ts";
import { redactPublicValue } from "./public-redaction.ts";

const SERVICE_GRAPH_SERVICE_TOKEN_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const SERVICE_GRAPH_SERVICE_TOKEN_MIN_TTL_SECONDS = 60;
const SERVICE_GRAPH_SERVICE_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const AI_GATEWAY_DEFAULT_SCOPES = [
  "ai.models.read",
  "ai.chat",
  "ai.embeddings",
] as const;

export interface ServiceGraphRuntimeAvailability {
  readonly aiGatewayConfigured?: boolean;
}

export const SERVICE_GRAPH_SERVICE_DESCRIPTORS: readonly TakosumiAccountsServiceGraphServiceDescriptor[] =
  [
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
      title: "OIDC identity",
      description:
        "Installed-service identity projection from the operator issuer.",
      secret_backed: false,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
      title: "Billing port",
      description: "Billing portal and usage report endpoint for the service.",
      secret_backed: true,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_DEPLOYMENT_OUTPUTS,
      title: "HTTP deployment outputs",
      description:
        "Public non-secret HTTP URLs projected from OpenTofu outputs.",
      secret_backed: false,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_EVENTS_WEBHOOK,
      title: "Event ingest",
      description: "Service-to-Takosumi event ingest endpoint.",
      secret_backed: true,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_CONTROL_API,
      title: "Same-Space support projection",
      description:
        "Limited same-Space callbacks exposed as service material, not a replacement for the /api/v1 control API.",
      secret_backed: true,
    },
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
      title: "AI model gateway",
      description:
        "OpenAI-compatible model and embedding endpoint backed by operator-selected upstream AI providers.",
      secret_backed: true,
    },
  ];

export async function handleListServiceGraphServices(input: {
  readonly request: Request;
  readonly store: AccountsStore;
}): Promise<Response> {
  const bearer = await requireAccountsBearer({
    request: input.request,
    store: input.store,
    scope: "read",
  });
  if (!bearer.ok) return bearer.response;
  return json({ services: SERVICE_GRAPH_SERVICE_DESCRIPTORS });
}

export async function handleListInstallationServiceGraphServices(input: {
  readonly installationId: string;
  readonly request: Request;
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly runtimeAvailability?: ServiceGraphRuntimeAvailability;
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
    services: await buildInstallationServiceGraphServiceProjections({
      store: input.store,
      installation: access.installation,
      issuer: input.issuer,
      runtimeAvailability: input.runtimeAvailability,
    }),
  });
}

export async function handleRotateInstallationServiceGraphServiceToken(input: {
  readonly installationId: string;
  readonly serviceId: string;
  readonly request: Request;
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly runtimeAvailability?: ServiceGraphRuntimeAvailability;
}): Promise<Response> {
  const serviceId = serviceGraphServiceIdValue(input.serviceId);
  if (!serviceId)
    return errorJson(
      "service_graph_service_not_found",
      "service graph service not found",
      404,
    );
  const capability = serviceGraphServiceTokenCapability(serviceId);
  if (!capability) {
    return errorJson(
      "service_not_secret_backed",
      "this service graph service does not issue tokens",
      400,
    );
  }
  const access = await requireInstallationOwnerAccess({
    request: input.request,
    store: input.store,
    installationId: input.installationId,
    scope: "write",
  });
  if (!access.ok) return access.response;

  const body = await readOptionalJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const ttlSeconds = serviceGraphServiceTokenTtlSeconds(
    body.ttlSeconds ?? body.ttl_seconds,
  );
  if (ttlSeconds === "invalid") {
    return errorJson(
      "invalid_request",
      `ttlSeconds must be between ${SERVICE_GRAPH_SERVICE_TOKEN_MIN_TTL_SECONDS} and ${SERVICE_GRAPH_SERVICE_TOKEN_MAX_TTL_SECONDS}`,
      400,
    );
  }
  const scopes = serviceGraphServiceTokenScopes({
    serviceId,
    value: body.scopes,
  });
  if (scopes === "invalid") {
    return errorJson(
      "invalid_request",
      `scopes must be an array of supported ${serviceId} scope tokens`,
      400,
    );
  }

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const token = mintServiceGraphServiceToken();
  const tokenId = `wst_${crypto.randomUUID()}`;
  const secretRef = serviceGraphServiceSecretRef({
    installationId: access.installation.installationId,
    serviceId,
    tokenId,
  });
  await input.store.saveAccessToken(token, {
    clientId: `service-graph-service:${serviceId}`,
    scope: serviceGraphServiceTokenScope(capability, scopes),
    subject: `service-graph-service:${access.installation.installationId}`,
    takosumiSubject: access.installation.createdBySubject,
    installationId: access.installation.installationId,
    appId: access.installation.appId,
    spaceId: access.installation.spaceId,
    role: "service-graph-service",
    expiresAt,
  });
  await appendLedgerEvent(input.store, {
    installationId: access.installation.installationId,
    eventType: SERVICE_GRAPH_SERVICE_TOKEN_ROTATED_EVENT,
    payload: {
      serviceId,
      capability,
      tokenId,
      tokenHash: await serviceGraphServiceTokenHash(token),
      secretRef,
      expiresAt: new Date(expiresAt).toISOString(),
      rotatedBySubject: access.subject,
      ...(scopes.length > 0 ? { scopes } : {}),
    },
    now,
  });
  const services = await buildInstallationServiceGraphServiceProjections({
    store: input.store,
    installation: access.installation,
    issuer: input.issuer,
    runtimeAvailability: input.runtimeAvailability,
  });
  const service = services.find((candidate) => candidate.id === serviceId);
  return json({
    token,
    token_type: "Bearer",
    expires_at: new Date(expiresAt).toISOString(),
    service: service ?? serviceProjectionFallback(serviceId, input.issuer),
  });
}

export async function handleIngestInstallationServiceEvent(input: {
  readonly installationId: string;
  readonly request: Request;
  readonly store: AccountsStore;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  const auth = await requireServiceGraphServiceToken({
    request: input.request,
    store: input.store,
    installation,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
    capability: "events.ingest",
  });
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const type = stringValue(body.type);
  const servicePayload = body.payload === undefined ? {} : body.payload;
  if (
    !type ||
    !/^[a-z][a-z0-9_.:-]{0,95}$/.test(type) ||
    !isJsonValue(servicePayload)
  ) {
    return errorJson(
      "invalid_request",
      "type must be a service event token and payload must be JSON",
      400,
    );
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    installationId: installation.installationId,
    eventType: SERVICE_GRAPH_SERVICE_EVENT_INGESTED_EVENT,
    payload: {
      type: `service.${type.replace(/^service\./, "")}`,
      payload: redactPublicValue(servicePayload),
      serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
      receivedAt: new Date(now).toISOString(),
    },
    now,
  });
  return json({ event: serializeInstallationEvent(event) }, 202);
}

async function buildInstallationServiceGraphServiceProjections(input: {
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly issuer: string;
  readonly runtimeAvailability?: ServiceGraphRuntimeAvailability;
}): Promise<readonly TakosumiAccountsServiceGraphServiceProjection[]> {
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
        ? await input.store.findBillingAccountForSubject(
            account.legalOwnerSubject,
          )
        : undefined;
  const activatedHttpDomain = activatedHttpDomainProjectionFromEvents(events);
  const billingRotation = await currentServiceGraphServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  });
  const eventsRotation = await currentServiceGraphServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  });
  const controlRotation = await currentServiceGraphServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
  });
  const aiGatewayRotation = await currentServiceGraphServiceTokenRotation({
    store: input.store,
    installationId: input.installation.installationId,
    serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  });
  const aiGatewayConfigured =
    input.runtimeAvailability?.aiGatewayConfigured === true;

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
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
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
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
      status: billingAccount ? "ready" : "not_configured",
      endpoint: billingEndpoint,
      material: {
        usageReportEndpoint: billingEndpoint,
        portalUrl: new URL("/account/billing", issuer).toString(),
        billingSubjectRef: billingAccount
          ? `takosumi-accounts://billing-accounts/${encodeURIComponent(
              billingAccount.billingAccountId,
            )}`
          : `takosumi-accounts://accounts/${encodeURIComponent(
              input.installation.accountId,
            )}/billing`,
      },
      rotation: billingRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
    {
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_DEPLOYMENT_OUTPUTS,
      status: activatedHttpDomain ? "ready" : "not_configured",
      endpoint: activatedHttpDomain?.url,
      material: {
        outputs: activatedHttpDomain
          ? [
              {
                name: "launch_url",
                kind: "launch_url",
                value: activatedHttpDomain.url,
                sensitive: false,
              },
            ]
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
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_EVENTS_WEBHOOK,
      status: activeRotation(eventsRotation) ? "ready" : "not_configured",
      endpoint: eventEndpoint,
      material: {
        ingestEndpoint: eventEndpoint,
        eventTypePrefix: "service.",
      },
      rotation: eventsRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
    withRotation({
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_CONTROL_API,
      status: activeRotation(controlRotation) ? "ready" : "not_configured",
      endpoint: new URL("/v1/installation-projections", issuer).toString(),
      material: {
        baseUrl: new URL("/v1/installation-projections", issuer).toString(),
        spaceId: input.installation.spaceId,
        allowedOperations: [...TAKOSUMI_ACCOUNTS_CONTROL_API_PERMISSIONS],
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
    withRotation({
      id: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
      capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
      status:
        activeRotation(aiGatewayRotation) && aiGatewayConfigured
          ? "ready"
          : "not_configured",
      endpoint: new URL(TAKOSUMI_AI_GATEWAY_BASE_PATH, issuer).toString(),
      material: {
        baseUrl: new URL(TAKOSUMI_AI_GATEWAY_BASE_PATH, issuer).toString(),
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_BASE_URL",
        modelEnv: "OPENAI_MODEL",
        defaultModel: "takosumi/default",
        capabilities: [
          TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
          TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_EMBEDDING_MODEL,
          "protocol.http.api",
        ],
        compatibleProtocol: "openai.chat_completions",
        compatibleProtocols: ["openai.chat_completions", "openai.embeddings"],
        runtimeConfigured: aiGatewayConfigured,
      },
      rotation: aiGatewayRotation,
      issuer,
      installationId: input.installation.installationId,
    }),
  ];
}

function withRotation(input: {
  readonly id: TakosumiAccountsServiceGraphServiceId;
  readonly capability: string;
  readonly status: TakosumiAccountsServiceGraphServiceProjection["status"];
  readonly endpoint?: string;
  readonly material: Record<string, unknown>;
  readonly rotation: ServiceGraphServiceTokenRotation | undefined;
  readonly issuer: string;
  readonly installationId: string;
}): TakosumiAccountsServiceGraphServiceProjection {
  const rotation = activeRotation(input.rotation);
  return {
    id: input.id,
    capability: input.capability,
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
          token_expires_at: new Date(rotation.expiresAt).toISOString(),
        }
      : {}),
  };
}

function activeRotation(
  rotation: ServiceGraphServiceTokenRotation | undefined,
): ServiceGraphServiceTokenRotation | undefined {
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
  if (!installation)
    return {
      ok: false,
      response: errorJson(
        "installation_not_found",
        "installation not found",
        404,
      ),
    };
  const account = await input.store.findLedgerAccount(installation.accountId);
  if (account?.legalOwnerSubject !== bearer.auth.subject) {
    return {
      ok: false,
      response: errorJson(
        "installation_not_found",
        "installation not found",
        404,
      ),
    };
  }
  return {
    ok: true,
    subject: bearer.auth.subject,
    installation,
  };
}

function serviceGraphServiceTokenTtlSeconds(
  value: unknown,
): number | "invalid" {
  if (value === undefined)
    return SERVICE_GRAPH_SERVICE_TOKEN_DEFAULT_TTL_SECONDS;
  const parsed = numberValue(value);
  if (
    parsed === undefined ||
    parsed < SERVICE_GRAPH_SERVICE_TOKEN_MIN_TTL_SECONDS ||
    parsed > SERVICE_GRAPH_SERVICE_TOKEN_MAX_TTL_SECONDS
  ) {
    return "invalid";
  }
  return parsed;
}

function serviceGraphServiceTokenScopes(input: {
  readonly serviceId: TakosumiAccountsServiceGraphServiceId;
  readonly value: unknown;
}): readonly string[] | "invalid" {
  if (input.value === undefined) {
    return input.serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY
      ? AI_GATEWAY_DEFAULT_SCOPES
      : [];
  }
  if (input.serviceId === TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY) {
    if (!Array.isArray(input.value)) return "invalid";
    const allowed = new Set<string>(AI_GATEWAY_DEFAULT_SCOPES);
    const scopes: string[] = [];
    for (const value of input.value) {
      if (typeof value !== "string") return "invalid";
      const scope = value.trim();
      if (!scope || !allowed.has(scope)) return "invalid";
      if (!scopes.includes(scope)) scopes.push(scope);
    }
    return scopes;
  }
  if (input.serviceId !== TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API) {
    return "invalid";
  }
  if (!Array.isArray(input.value)) return "invalid";
  const allowed = new Set<string>(TAKOSUMI_ACCOUNTS_CONTROL_API_PERMISSIONS);
  const scopes: string[] = [];
  for (const value of input.value) {
    if (typeof value !== "string") return "invalid";
    const scope = value.trim();
    if (!scope || !allowed.has(scope)) return "invalid";
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

function serviceGraphServiceTokenScope(
  capability: string,
  scopes: readonly string[],
): string {
  return [capability, ...scopes].join(" ");
}

function serviceGraphServiceIdValue(
  value: string,
): TakosumiAccountsServiceGraphServiceId | undefined {
  return SERVICE_GRAPH_SERVICE_DESCRIPTORS.some(
    (service) => service.id === value,
  )
    ? (value as TakosumiAccountsServiceGraphServiceId)
    : undefined;
}

function serviceProjectionFallback(
  serviceId: TakosumiAccountsServiceGraphServiceId,
  issuer: string,
): TakosumiAccountsServiceGraphServiceProjection {
  const descriptor = SERVICE_GRAPH_SERVICE_DESCRIPTORS.find(
    (service) => service.id === serviceId,
  );
  return {
    id: serviceId,
    capability: descriptor?.capability ?? "unknown",
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
