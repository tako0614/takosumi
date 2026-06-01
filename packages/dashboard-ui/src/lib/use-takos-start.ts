export const DEFAULT_USE_TAKOS_TERMS_VERSION = "terms-2026-05-13";

export interface UseTakosStartUrlInput {
  readonly origin: string;
  readonly takosUrl: string;
  readonly subject: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly appId?: string;
  readonly termsVersion?: string;
  readonly returnTo?: string;
}

interface ImportMetaEnvShape {
  readonly VITE_TAKOSUMI_DASHBOARD_TAKOS_URL?: string;
}

export const TAKOS_HOST_NOT_CONFIGURED_MESSAGE =
  "Takos host not configured for this distribution";

/**
 * Resolve the operator-configured default Takos product URL. The
 * distribution owner sets `VITE_TAKOSUMI_DASHBOARD_TAKOS_URL` at build
 * time; we keep a single local-substrate fallback so dev hostnames
 * still light up without configuration.
 *
 * THROWS when the operator has not configured a Takos host AND the
 * request is not on a local-substrate hostname (we deliberately don't
 * fall back to `takos.jp` because that presumes a specific
 * distribution operator). Callers must catch the error and surface
 * the message to the user.
 *
 * Use `tryDefaultTakosUrlForHost` to get a `string | undefined` shape
 * without exception handling.
 */
export function defaultTakosUrlForHost(hostname: string): string {
  const resolved = tryDefaultTakosUrlForHost(hostname);
  if (!resolved) {
    throw new Error(TAKOS_HOST_NOT_CONFIGURED_MESSAGE);
  }
  return resolved;
}

/**
 * Non-throwing variant: returns `undefined` when no Takos URL is
 * configured. Useful when the caller wants to render a UI error or
 * provide a remediation hint rather than crashing the render.
 */
export function tryDefaultTakosUrlForHost(
  hostname: string,
): string | undefined {
  if (isLocalHost(hostname)) return "https://takos.test";
  const env = readImportMetaEnv();
  const configured = env?.VITE_TAKOSUMI_DASHBOARD_TAKOS_URL?.trim();
  if (configured) return configured;
  return undefined;
}

function readImportMetaEnv(): ImportMetaEnvShape | undefined {
  try {
    const meta = import.meta as unknown as { env?: ImportMetaEnvShape };
    return meta.env;
  } catch {
    return undefined;
  }
}

export function buildUseTakosStartUrl(
  input: UseTakosStartUrlInput,
): string {
  const url = new URL("/start", input.origin);
  url.searchParams.set("takos_url", input.takosUrl);
  url.searchParams.set("subject", input.subject);
  url.searchParams.set("account_id", input.accountId);
  url.searchParams.set("space_id", input.spaceId);
  if (input.installationId) {
    url.searchParams.set("installation_id", input.installationId);
  }
  if (input.appId) {
    url.searchParams.set("app_id", input.appId);
  }
  url.searchParams.set(
    "terms_version",
    input.termsVersion ?? DEFAULT_USE_TAKOS_TERMS_VERSION,
  );
  url.searchParams.set("terms_accepted", "true");
  url.searchParams.set(
    "return_to",
    safeReturnTo(input.returnTo, input.spaceId),
  );
  return url.toString();
}

export function safeReturnTo(
  value: string | undefined,
  spaceId: string,
): string {
  if (value?.startsWith("/") && !value.startsWith("//")) return value;
  return `/spaces/${spaceId}/threads`;
}

function isLocalHost(hostname: string): boolean {
  return hostname.endsWith(".test") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
}
