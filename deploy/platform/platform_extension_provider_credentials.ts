import type {
  CredentialRecipeDriverContext,
  CredentialRecipeHostComposition,
} from "takosumi-contract/credential-recipe-host";
import { platformExtensionRoutes } from "./platform_extensions.ts";

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
  const origin = exactHttpsOrigin(env.TAKOSUMI_ACCOUNTS_ISSUER);
  const credentialRecipes: CredentialRecipeHostComposition["credentialRecipes"] = routes.map(
    (route) => {
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
    },
  );
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
        });
      }),
    ),
  });
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
  if (!context.run || !context.issueRunCredential || !context.runCredentialSettings) {
    logCredentialExchangeFailure("context_unavailable");
    throw new Error("provider credential exchange requires a canonical Run and settings");
  }
  if (!handler) {
    logCredentialExchangeFailure("handler_unavailable");
    throw new Error("provider credential exchange requires a bound handler");
  }
  // Keep the platform credential wider than the downstream 300-second
  // provider token so small cross-service clock/latency differences cannot
  // make a valid response appear to outlive its caller authority.
  let issued: Awaited<ReturnType<NonNullable<typeof context.issueRunCredential>>>;
  try {
    issued = await context.issueRunCredential({ ttlSeconds: 600 });
  } catch {
    logCredentialExchangeFailure("issuance_failed");
    throw new Error("provider credential exchange issuance failed");
  }
  const url = new URL(`${basePath}${exchangePath}`, origin);
  url.searchParams.set("workspaceId", context.run.workspaceId);
  let response: Response;
  try {
    response = await handler.fetchAuthenticated(
      new Request(url.href, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "takosumi.provider-run-credential-request@v1",
          providerSource,
          settings: context.runCredentialSettings,
        }),
      }),
      Object.freeze({
        authKind: "run-credential" as const,
        subject: context.run.installingPrincipalId,
        workspaceId: context.run.workspaceId,
        capsuleId: context.run.capsuleId,
        runId: context.run.runId,
        installingPrincipalId: context.run.installingPrincipalId,
        audience,
        scopes: Object.freeze([...scopes]),
        phase: context.run.phase,
      }),
    );
  } catch {
    logCredentialExchangeFailure("handler_rpc_failed");
    throw new Error("provider credential exchange handler failed");
  }
  if (!response.ok) {
    // The vault intentionally collapses provider-driver failures into the
    // public `credential_service_unavailable` diagnostic. Preserve only the
    // non-secret HTTP boundary here so an operator can distinguish platform
    // authentication, extension validation, and upstream availability
    // failures without logging the bearer, response body, Workspace, or Run.
    logCredentialExchangeFailure("handler_response_failed", response.status);
    throw new Error("provider credential exchange failed");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("provider credential exchange response is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("provider credential exchange response is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
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
  fetchAuthenticated(
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
      typeof (value as { fetchAuthenticated?: unknown }).fetchAuthenticated ===
        "function"
    ? (value as PlatformExtensionCredentialHandler)
    : undefined;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("TAKOSUMI_ACCOUNTS_ISSUER is required for provider credential brokers");
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
    throw new TypeError("TAKOSUMI_ACCOUNTS_ISSUER must be an exact HTTPS origin");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
