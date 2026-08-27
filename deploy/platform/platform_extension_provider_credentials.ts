import type {
  CredentialRecipeDriverContext,
  CredentialRecipeHostComposition,
} from "takosumi-contract/credential-recipe-host";
import {
  platformExtensionRoutes,
  type PlatformExtensionRoute,
} from "./platform_extensions.ts";

const AUTH_MODE = "broker";
const MAX_RESPONSE_BYTES = 64 * 1024;
const EVIDENCE_ISSUER = "platform_extension_provider_credential";

/**
 * Compiles provider-neutral extension descriptors into one code-only
 * Credential Recipe contribution. The extension still owns provider behavior
 * and credentials; OSS only owns Run authority and exact env delivery.
 */
export function platformExtensionProviderCredentialComposition(env: {
  readonly TAKOSUMI_PLATFORM_EXTENSIONS?: unknown;
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: unknown;
}): CredentialRecipeHostComposition | undefined {
  const routes = platformExtensionRoutes(env).filter(
    (route) => route.providerCredentialBroker !== undefined,
  );
  if (routes.length === 0) return undefined;
  const credentialRequiredProviderSources = sortedProviderSources(routes);
  const origin = exactHttpsOrigin(env.TAKOSUMI_ACCOUNTS_ISSUER);
  const credentialRecipes: CredentialRecipeHostComposition["credentialRecipes"] =
    routes.map((route) => {
      const broker = route.providerCredentialBroker!;
      const issuance = route.runCredential!;
      return Object.freeze({
        id: broker.recipeId,
        displayName: broker.displayName,
        terraformSource: Object.freeze([broker.providerSource]),
        envNames: broker.envNames,
        requiredEnvGroups: Object.freeze(
          broker.envNames.map((name) => Object.freeze([name])),
        ),
        authModes: Object.freeze({
          [AUTH_MODE]: Object.freeze({
            preRun: Object.freeze({
              type: "platform_extension_provider_credential",
            }),
            runIssuance: Object.freeze({
              context: "capsule-run.v1" as const,
              operatorConnection: "workspace-bindable" as const,
              storedMaterial: "none" as const,
              audience: issuance.audience,
              scopes: issuance.requiredScopes,
            }),
          }),
        }),
      });
    });
  const credentialRecipeDrivers: Record<
    string,
    CredentialRecipeHostComposition["credentialRecipeDrivers"][string]
  > = {};
  for (const route of routes) {
    const broker = route.providerCredentialBroker!;
    const issuance = route.runCredential!;
    const handler = platformExtensionCredentialHandler(env, route.handlerKey);
    credentialRecipeDrivers[`${broker.recipeId}/${AUTH_MODE}`] = {
      evidenceIssuer: EVIDENCE_ISSUER,
      verify: async () => ({ ok: true }),
      mint: async (context) =>
        await mintPlatformExtensionProviderCredential(
          context,
          origin,
          route.basePath,
          broker.exchangePath,
          broker.providerSource,
          broker.envNames,
          issuance.audience,
          issuance.requiredScopes,
          handler,
        ),
    };
  }
  return Object.freeze({
    credentialRecipes: Object.freeze([...credentialRecipes]),
    credentialRecipeDrivers: Object.freeze(credentialRecipeDrivers),
    credentialRequiredProviderSources,
    operatorProviderConnections: Object.freeze(
      routes.map((route) => {
        const broker = route.providerCredentialBroker!;
        return Object.freeze({
          id: broker.connectionId,
          providerSource: broker.providerSource,
          displayName: broker.displayName,
          credentialRecipe: Object.freeze({
            id: broker.recipeId,
            authMode: AUTH_MODE,
          }),
          ...(broker.runCredentialSettings
            ? { runCredentialSettings: broker.runCredentialSettings }
            : {}),
        });
      }),
    ),
  });
}

function sortedProviderSources(
  routes: readonly PlatformExtensionRoute[],
): readonly string[] {
  return Object.freeze(
    Array.from(
      new Set(
        routes.flatMap((route) =>
          route.providerCredentialBroker
            ? [route.providerCredentialBroker.providerSource]
            : [],
        ),
      ),
    ).sort(),
  );
}

async function mintPlatformExtensionProviderCredential(
  context: CredentialRecipeDriverContext,
  origin: string,
  basePath: string,
  exchangePath: string,
  providerSource: string,
  envNames: readonly string[],
  audience: string,
  scopes: readonly string[],
  handler: PlatformExtensionCredentialHandler | undefined,
) {
  if (!context.run || !context.issueRunCredential) {
    logCredentialExchangeFailure("context_unavailable");
    throw new Error("provider credential exchange requires a canonical Run");
  }
  const runCredentialSettings =
    context.runCredentialSettings ?? Object.freeze({});
  if (!handler) {
    logCredentialExchangeFailure("handler_unavailable");
    throw new Error("provider credential exchange requires a bound handler");
  }
  // Keep the platform credential wider than the downstream 300-second
  // provider token so small cross-service clock/latency differences cannot
  // make a valid response appear to outlive its caller authority.
  let issued: Awaited<
    ReturnType<NonNullable<typeof context.issueRunCredential>>
  >;
  try {
    issued = await context.issueRunCredential({ ttlSeconds: 600 });
  } catch {
    logCredentialExchangeFailure("issuance_failed");
    throw new Error("provider credential exchange issuance failed");
  }
  const url = new URL(`${basePath}${exchangePath}`, origin);
  url.searchParams.set("workspaceId", context.run.workspaceId);
  const exchangeRequest = Object.freeze({
    kind: "takosumi.provider-run-credential-request@v1" as const,
    providerSource,
    settings: runCredentialSettings,
  });
  const exchangeContext = Object.freeze({
    authKind: "run-credential" as const,
    subject: context.run.installingPrincipalId,
    workspaceId: context.run.workspaceId,
    capsuleId: context.run.capsuleId,
    runId: context.run.runId,
    installingPrincipalId: context.run.installingPrincipalId,
    audience,
    scopes: Object.freeze([...scopes]),
    phase: context.run.phase,
    lifecycleIntent: context.run.lifecycleIntent,
  });
  let responseStatus: number;
  let responseBytes: Uint8Array;
  try {
    if (handler.exchangeProviderCredential) {
      const exchanged = await handler.exchangeProviderCredential(
        Object.freeze({
          url: url.href,
          request: exchangeRequest,
          context: exchangeContext,
        }),
      );
      if (
        !isRecord(exchanged) ||
        !exactKeys(exchanged, ["body", "status"]) ||
        !Number.isSafeInteger(exchanged.status) ||
        (exchanged.status as number) < 100 ||
        (exchanged.status as number) > 599 ||
        typeof exchanged.body !== "string"
      ) {
        throw new Error("provider credential RPC returned an invalid envelope");
      }
      responseStatus = exchanged.status as number;
      responseBytes = new TextEncoder().encode(exchanged.body);
    } else if (handler.fetchAuthenticated) {
      const response = await handler.fetchAuthenticated(
        new Request(url.href, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(exchangeRequest),
        }),
        exchangeContext,
      );
      responseStatus = response.status;
      const declaredLength = Number(
        response.headers.get("content-length") ?? "NaN",
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("provider credential exchange response is too large");
      }
      responseBytes = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("provider credential exchange handler is unavailable");
    }
  } catch {
    logCredentialExchangeFailure("handler_rpc_failed");
    throw new Error("provider credential exchange handler failed");
  }
  if (responseStatus < 200 || responseStatus > 299) {
    // The vault intentionally collapses provider-driver failures into the
    // public `credential_service_unavailable` diagnostic. Preserve only the
    // non-secret HTTP boundary here so an operator can distinguish platform
    // authentication, extension validation, and upstream availability
    // failures without logging the bearer, response body, Workspace, or Run.
    logCredentialExchangeFailure("handler_response_failed", responseStatus);
    throw new Error("provider credential exchange failed");
  }
  if (responseBytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("provider credential exchange response is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    ) as unknown;
  } catch {
    throw new Error("provider credential exchange response is malformed");
  }
  if (!isRecord(value) || !exactKeys(value, ["env", "expiresAt", "kind"])) {
    throw new Error("provider credential exchange response is malformed");
  }
  if (
    value.kind !== "takosumi.provider-run-credential@v1" ||
    !isRecord(value.env) ||
    !exactKeys(value.env, envNames) ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("provider credential exchange response is malformed");
  }
  const env: Record<string, string> = {};
  for (const name of envNames) {
    const entry = value.env[name];
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 8_192 ||
      /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new Error("provider credential exchange response is malformed");
    }
    env[name] = entry;
  }
  const expiresAt = Date.parse(value.expiresAt);
  const issuerExpiresAt = Date.parse(issued.expiresAt);
  const nowMs = context.now().getTime();
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAt ||
    expiresAt - nowMs < 1_000 ||
    !Number.isFinite(issuerExpiresAt) ||
    expiresAt > issuerExpiresAt
  ) {
    throw new Error("provider credential exchange expiry is invalid");
  }
  const ttlSeconds = Math.floor((expiresAt - nowMs) / 1_000);
  return {
    env: Object.freeze(env),
    evidence: Object.freeze({
      connectionId: context.connection.id,
      provider: context.connection.provider,
      temporary: true,
      ttlEnforced: true,
      expiresAt: value.expiresAt,
      ttlSeconds,
      issuer: EVIDENCE_ISSUER,
      secretValueStored: false as const,
    }),
  };
}

function logCredentialExchangeFailure(stage: string, status?: number): void {
  console.warn(
    JSON.stringify({
      event: "platform_extension_provider_credential_exchange_failed",
      stage,
      ...(status === undefined ? {} : { status }),
    }),
  );
}

interface PlatformExtensionCredentialHandler {
  exchangeProviderCredential?(input: {
    readonly url: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly context: {
      readonly authKind: "run-credential";
      readonly subject: string;
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly runId: string;
      readonly installingPrincipalId: string;
      readonly audience: string;
      readonly scopes: readonly string[];
      readonly phase: "plan" | "apply" | "destroy";
      readonly lifecycleIntent: "provision" | "destroy";
    };
  }): Promise<{ readonly status: number; readonly body: string }>;
  fetchAuthenticated?(
    request: Request,
    context: {
      readonly authKind: "run-credential";
      readonly subject: string;
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly runId: string;
      readonly installingPrincipalId: string;
      readonly audience: string;
      readonly scopes: readonly string[];
      readonly phase: "plan" | "apply" | "destroy";
      readonly lifecycleIntent: "provision" | "destroy";
    },
  ): Promise<Response>;
}

function platformExtensionCredentialHandler(
  env: object,
  handlerKey: string,
): PlatformExtensionCredentialHandler | undefined {
  const value = (env as Record<string, unknown>)[handlerKey];
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (typeof (value as { exchangeProviderCredential?: unknown })
      .exchangeProviderCredential === "function" ||
      typeof (value as { fetchAuthenticated?: unknown }).fetchAuthenticated ===
        "function")
    ? (value as PlatformExtensionCredentialHandler)
    : undefined;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ISSUER is required for provider credential brokers",
    );
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ISSUER must be an exact HTTPS origin",
    );
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}
