/**
 * External install link — CLIENT-handled (the modern form).
 *
 * Other sites may link `<operator-origin>/install?...` to open the
 * dashboard's add flow with the source pre-filled. The worker does nothing
 * special with `/install` (it is a plain SPA path); the SPA router forwards
 * the query to `/new`, and this parser pre-fills the Git form. Two link forms:
 *
 *   /install?git=<https url>&ref=<ref>&path=<module path>
 *   /install?source=git::<https url>//<module path>?ref=<ref>
 *
 * A link only PRE-FILLS — nothing installs from a URL. The visitor always
 * confirms in the client: the summary line states the source came from a
 * link, the compatibility check ("中身を確認") must pass, and the install
 * button is a separate explicit step. Real source-URL policy is enforced
 * server-side when the Source is registered / compatibility-checked; the
 * https-only guard here just refuses to pre-fill the form with junk
 * (non-https, embedded credentials, unparsable URLs).
 */

export interface InstallPrefill {
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly name?: string;
}

/** True when a URL query is trying to prefill the install flow. */
export function hasInstallPrefillParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("git") || params.has("source");
}

/** Parse an install link's query into a prefill, or undefined when absent/bad. */
export function parseInstallPrefill(
  search: string,
): InstallPrefill | undefined {
  const params = new URLSearchParams(search);
  const packed = parsePackedSource(params.get("source"));
  const git = params.get("git") ?? packed?.git ?? "";
  if (!isSafeHttpsGitUrl(git)) return undefined;
  const name = parseOptionalName(params.get("name"));
  return {
    git,
    ref: (params.get("ref") ?? packed?.ref ?? "").trim(),
    path: (params.get("path") ?? packed?.path ?? "").trim(),
    ...(name ? { name } : {}),
  };
}

/**
 * Accepts a full external install URL pasted into the add form and returns the
 * same prefill shape as the router path. Plain Git URLs intentionally return
 * undefined so the normal Git-source input path remains unchanged.
 */
export function parseInstallPrefillFromInput(
  value: string,
): InstallPrefill | undefined {
  const raw = value.trim();
  if (!raw || /[\r\n\0]/u.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (!hasInstallPrefillParams(url.search)) return undefined;
  return parseInstallPrefill(url.search);
}

function parseOptionalName(value: string | null): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if (/[\r\n\0]/u.test(name)) return undefined;
  return name.slice(0, 96);
}

export function isSafeInstallVariableName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return trimmed.split(".").every(isSafeInstallVariablePathSegment);
}

export function isSafeInstallVariableValue(value: string): boolean {
  return value.length <= 512 && !/[\r\n\0]/u.test(value);
}

function isSafeInstallVariablePathSegment(segment: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)) return false;
  if (
    segment === "__proto__" ||
    segment === "constructor" ||
    segment === "prototype"
  ) {
    return false;
  }
  return true;
}

/** `source=git::<url>//<path>?ref=<ref>` (Terraform/OpenTofu module address). */
function parsePackedSource(
  source: string | null,
): { git: string; ref: string; path: string } | undefined {
  const prefix = "git::";
  if (!source?.startsWith(prefix)) return undefined;
  const body = source.slice(prefix.length);
  const queryStart = body.indexOf("?");
  const beforeQuery = queryStart === -1 ? body : body.slice(0, queryStart);
  const query = queryStart === -1 ? "" : body.slice(queryStart + 1);
  const marker = findModulePathMarker(beforeQuery);
  const git = marker === -1 ? beforeQuery : beforeQuery.slice(0, marker);
  const path = marker === -1 ? "" : beforeQuery.slice(marker + 2);
  const params = new URLSearchParams(query);
  return { git, ref: params.get("ref") ?? "", path };
}

/** Index of the `//` module-path separator (after the URL scheme's own `//`). */
function findModulePathMarker(value: string): number {
  const scheme = value.indexOf("://");
  const start = scheme === -1 ? 0 : scheme + "://".length;
  return value.indexOf("//", start);
}

/**
 * Browser-safe link guard: https only, parsable, no embedded credentials.
 * (Local/private-host rejection and the full Source URL policy stay
 * server-side at the registration / compatibility boundary.)
 */
function isSafeHttpsGitUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/[\r\n\0]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return true;
}

/** Friendly capsule label for the summary line (display only). */
export function capsuleNameFromUrl(url: string): string {
  return (
    url
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .pop() ?? url
  );
}
