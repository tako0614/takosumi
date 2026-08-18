import type {
  CredentialRecipeDriverContext,
  CredentialRecipeHostComposition,
} from "takosumi-contract/credential-recipe-host";
import { platformExtensionRoutes } from "./platform_extensions.ts";

const AUTH_MODE = "broker";
const MAX_RESPONSE_BYTES = 64 * 1024;

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
    credentialRecipeDrivers[`${broker.recipeId}/${AUTH_MODE}`] = {
      evidenceIssuer: "platform_extension_provider_credential",
      verify: async () => ({ ok: true }),
      mint: async (context) =>
        await mintPlatformExtensionProviderCredential(
          context,
          origin,
          route.basePath,
          broker.exchangePath,
          broker.providerSource,
          broker.envNames,
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
) {
  if (!context.run || !context.issueRunCredential || !context.runCredentialSettings) {
    throw new Error("provider credential exchange requires a canonical Run and settings");
  }
  // Keep the platform credential wider than the downstream 300-second
  // provider token so small cross-service clock/latency differences cannot
  // make a valid response appear to outlive its caller authority.
  const issued = await context.issueRunCredential({ ttlSeconds: 600 });
  const url = new URL(`${basePath}${exchangePath}`, origin);
  url.searchParams.set("workspaceId", context.run.workspaceId);
  const response = await context.fetch(url.href, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "takosumi.provider-run-credential-request@v1",
      providerSource,
      settings: context.runCredentialSettings,
    }),
  });
  if (!response.ok) {
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
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAt ||
    expiresAt <= context.now().getTime() ||
    !Number.isFinite(issuerExpiresAt) ||
    expiresAt > issuerExpiresAt
  ) {
    throw new Error("provider credential exchange expiry is invalid");
  }
  return {
    env: Object.freeze(env),
    evidence: context.staticEvidence(),
  };
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
