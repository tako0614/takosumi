import type {
  UpstreamOAuthClientRegistration,
  UpstreamOAuthOptions,
} from "./mod.ts";
import { oidcOAuthProvider } from "./upstream.ts";

export const UPSTREAM_PROVIDER_DESCRIPTORS_ENV =
  "TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS";
export const UPSTREAM_SUBJECT_SECRET_ENV = "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET";
export const UPSTREAM_SESSION_TTL_ENV =
  "TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS";
const publicAuthProviderTokenPattern = /^[a-z][a-z0-9._-]{0,127}$/u;

/**
 * Service-side, runtime-neutral registration for one upstream OAuth/OIDC
 * provider. Endpoints and credential references are explicit: providerId is
 * an opaque identity and never selects built-in behavior.
 */
export interface UpstreamProviderDescriptor {
  readonly providerId: string;
  readonly label?: string;
  readonly protocol?: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userInfoEndpoint: string;
  readonly clientId: string;
  /** Name of a deployment-runtime secret binding, never the secret value. */
  readonly clientSecretEnv?: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly subjectClaim?: string;
}

/**
 * Resolve an open provider descriptor list against one deployment runtime's
 * environment. The JSON descriptor is non-secret; confidential client values
 * are read only through explicitly named runtime secret bindings.
 */
export function upstreamOAuthOptionsFromEnvironment(
  env: Readonly<Record<string, unknown>>,
): UpstreamOAuthOptions | undefined {
  const raw = optionalEnvironmentString(env, UPSTREAM_PROVIDER_DESCRIPTORS_ENV);
  const sessionTtlMs = optionalPositiveIntegerEnvironment(
    env,
    UPSTREAM_SESSION_TTL_ENV,
  );
  if (raw === undefined) {
    if (sessionTtlMs !== undefined) {
      throw new TypeError(
        `${UPSTREAM_SESSION_TTL_ENV} requires ${UPSTREAM_PROVIDER_DESCRIPTORS_ENV}`,
      );
    }
    return undefined;
  }

  const descriptors = parseUpstreamProviderDescriptors(raw);
  if (descriptors.length === 0) {
    throw new TypeError(
      `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV} must contain at least one provider descriptor`,
    );
  }
  const subjectSecret = optionalEnvironmentString(
    env,
    UPSTREAM_SUBJECT_SECRET_ENV,
  );
  if (!subjectSecret) {
    throw new TypeError(
      `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV} requires ${UPSTREAM_SUBJECT_SECRET_ENV}`,
    );
  }

  const seen = new Set<string>();
  const providers = descriptors.map((descriptor, index) => {
    if (seen.has(descriptor.providerId)) {
      throw new TypeError(
        `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV}[${index}].providerId is duplicated`,
      );
    }
    seen.add(descriptor.providerId);
    return registrationFromDescriptor(env, descriptor, index);
  });
  return {
    subjectSecret,
    providers,
    ...(sessionTtlMs !== undefined ? { sessionTtlMs } : {}),
  };
}

export function parseUpstreamProviderDescriptors(
  raw: string,
): readonly UpstreamProviderDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(
      `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV} must be valid JSON`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV} must be a JSON array`,
    );
  }
  return parsed.map((value, index) => parseDescriptor(value, index));
}

function parseDescriptor(
  value: unknown,
  index: number,
): UpstreamProviderDescriptor {
  const label = `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV}[${index}]`;
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if ("clientSecret" in value || "clientSecretValue" in value) {
    throw new TypeError(
      `${label} must reference a runtime secret with clientSecretEnv; inline client secrets are forbidden`,
    );
  }
  const providerId = requiredString(value.providerId, `${label}.providerId`);
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(providerId)) {
    throw new TypeError(
      `${label}.providerId must be a lowercase provider token`,
    );
  }
  if (providerId === "passkey") {
    throw new TypeError(
      `${label}.providerId is reserved for the WebAuthn provider`,
    );
  }
  const protocol = optionalString(value.protocol, `${label}.protocol`);
  const normalizedProtocol = protocol?.toLowerCase();
  if (
    normalizedProtocol !== undefined &&
    !publicAuthProviderTokenPattern.test(normalizedProtocol)
  ) {
    throw new TypeError(`${label}.protocol must be a lowercase provider token`);
  }
  const clientSecretEnv = optionalString(
    value.clientSecretEnv,
    `${label}.clientSecretEnv`,
  );
  if (
    clientSecretEnv !== undefined &&
    !/^[A-Z][A-Z0-9_]*$/.test(clientSecretEnv)
  ) {
    throw new TypeError(
      `${label}.clientSecretEnv must be an uppercase environment binding name`,
    );
  }
  const scopes = optionalStringArray(value.scopes, `${label}.scopes`);
  return {
    providerId,
    ...optionalProperty("label", optionalString(value.label, `${label}.label`)),
    ...optionalProperty("protocol", normalizedProtocol),
    issuer: requiredHttpUrl(value.issuer, `${label}.issuer`),
    authorizationEndpoint: requiredHttpUrl(
      value.authorizationEndpoint,
      `${label}.authorizationEndpoint`,
    ),
    tokenEndpoint: requiredHttpUrl(
      value.tokenEndpoint,
      `${label}.tokenEndpoint`,
    ),
    userInfoEndpoint: requiredHttpUrl(
      value.userInfoEndpoint,
      `${label}.userInfoEndpoint`,
    ),
    clientId: requiredString(value.clientId, `${label}.clientId`),
    ...optionalProperty("clientSecretEnv", clientSecretEnv),
    redirectUri: requiredHttpUrl(value.redirectUri, `${label}.redirectUri`),
    ...(scopes !== undefined ? { scopes } : {}),
    ...optionalProperty(
      "subjectClaim",
      optionalString(value.subjectClaim, `${label}.subjectClaim`),
    ),
  };
}

function registrationFromDescriptor(
  env: Readonly<Record<string, unknown>>,
  descriptor: UpstreamProviderDescriptor,
  index: number,
): UpstreamOAuthClientRegistration {
  const clientSecret = descriptor.clientSecretEnv
    ? optionalEnvironmentString(env, descriptor.clientSecretEnv)
    : undefined;
  if (descriptor.clientSecretEnv && !clientSecret) {
    throw new TypeError(
      `${UPSTREAM_PROVIDER_DESCRIPTORS_ENV}[${index}].clientSecretEnv references missing runtime secret ${descriptor.clientSecretEnv}`,
    );
  }
  return {
    providerId: descriptor.providerId,
    ...(descriptor.label ? { label: descriptor.label } : {}),
    protocol: descriptor.protocol ?? "oidc",
    clientId: descriptor.clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri: descriptor.redirectUri,
    ...(descriptor.scopes ? { scopes: descriptor.scopes } : {}),
    provider: oidcOAuthProvider({
      id: descriptor.providerId,
      issuer: descriptor.issuer,
      authorizationEndpoint: descriptor.authorizationEndpoint,
      tokenEndpoint: descriptor.tokenEndpoint,
      userInfoEndpoint: descriptor.userInfoEndpoint,
      ...(descriptor.scopes ? { defaultScopes: descriptor.scopes } : {}),
      ...(descriptor.subjectClaim
        ? { subjectClaim: descriptor.subjectClaim }
        : {}),
    }),
  };
}

function optionalEnvironmentString(
  env: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalPositiveIntegerEnvironment(
  env: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const raw = optionalEnvironmentString(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredHttpUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be an http:// or https:// URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must be an http:// or https:// URL`);
  }
  return url.toString();
}

function optionalStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  const entries = value.map((entry, index) =>
    requiredString(entry, `${label}[${index}]`),
  );
  if (new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return entries;
}

function optionalProperty<K extends string>(
  key: K,
  value: string | undefined,
): { readonly [P in K]?: string } {
  return value === undefined
    ? {}
    : ({ [key]: value } as {
        readonly [P in K]?: string;
      });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
