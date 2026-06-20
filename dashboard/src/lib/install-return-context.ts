import {
  capsuleNameFromUrl,
  parseInstallPrefill,
  type InstallPrefill,
} from "./install-link.ts";

export interface InstallReturnContext {
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly label: string;
  readonly host: string;
  readonly sourceLabel: string;
  readonly displayRef: string;
}

export const INSTALL_RETURN_QUERY_PARAM = "return";
export const PROVIDER_CONNECTIONS_PATH = "/space/settings/connections";

/**
 * Extract the safe `/new?...` install prefill from a sign-in return URL.
 *
 * `/install?...` is only a public prefill route; unauthenticated visitors are
 * redirected to `/sign-in?return=/new?...`. Showing that pending source on the
 * sign-in page keeps the install flow understandable without trusting arbitrary
 * return URLs or unsafe Git addresses.
 */
export function installReturnContext(
  returnTo: string | null | undefined,
): InstallReturnContext | undefined {
  const safePath = safeLocalReturnPath(returnTo);
  if (!safePath) return undefined;

  const parsed = new URL(safePath, "https://takosumi.invalid");
  if (parsed.pathname !== "/new") return undefined;

  const prefill = parseInstallPrefill(parsed.search);
  if (!prefill) return undefined;

  return {
    ...prefill,
    label: capsuleNameFromUrl(prefill.git),
    host: new URL(prefill.git).host,
    sourceLabel: sourceLabelFromGit(prefill.git),
    displayRef: displayRef(prefill.ref),
  };
}

export function installReturnPathFromPrefill(
  prefill: Pick<InstallPrefill, "git"> &
    Partial<Pick<InstallPrefill, "ref" | "path">>,
): string | undefined {
  const params = new URLSearchParams();
  params.set("git", prefill.git.trim());
  params.set("ref", prefill.ref?.trim() ?? "");
  params.set("path", prefill.path?.trim() || ".");

  const safe = parseInstallPrefill(`?${params.toString()}`);
  if (!safe) return undefined;

  const canonical = new URLSearchParams();
  canonical.set("git", safe.git);
  canonical.set("ref", safe.ref);
  canonical.set("path", safe.path || ".");
  return `/new?${canonical.toString()}`;
}

export function installReturnPathFromContext(
  context: Pick<InstallReturnContext, "git" | "ref" | "path">,
): string | undefined {
  return installReturnPathFromPrefill(context);
}

export function installReturnPathFromReturnParam(
  returnTo: string | null | undefined,
): string | undefined {
  const context = installReturnContext(returnTo);
  return context ? installReturnPathFromContext(context) : undefined;
}

export function providerConnectionsHrefForInstallReturn(
  returnPath: string | null | undefined,
): string {
  const safeReturnPath = installReturnPathFromReturnParam(returnPath);
  if (!safeReturnPath) return PROVIDER_CONNECTIONS_PATH;
  const params = new URLSearchParams();
  params.set(INSTALL_RETURN_QUERY_PARAM, safeReturnPath);
  return `${PROVIDER_CONNECTIONS_PATH}?${params.toString()}`;
}

function sourceLabelFromGit(git: string): string {
  const url = new URL(git);
  const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  return path ? `${url.host}/${path}` : url.host;
}

function displayRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

function safeLocalReturnPath(
  value: string | null | undefined,
): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.startsWith("//") || !raw.startsWith("/")) return undefined;
  if (/[\r\n\0]/.test(raw)) return undefined;
  try {
    const base = "https://takosumi.invalid";
    const parsed = new URL(raw, base);
    if (parsed.origin !== base) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}
