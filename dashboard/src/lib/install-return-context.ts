import { capsuleNameFromUrl, parseInstallPrefill } from "./install-link.ts";

export interface InstallReturnContext {
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly label: string;
  readonly host: string;
  readonly sourceLabel: string;
  readonly displayRef: string;
}

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
