/**
 * External install link — CLIENT-handled (the modern form).
 *
 * Other sites may link `https://app.takosumi.com/install?...` to open the
 * dashboard's add flow with the source pre-filled. The worker does nothing
 * special with `/install` (it is a plain SPA path); the SPA router forwards
 * the query to `/new`, and this parser seeds the Git form. Two link forms:
 *
 *   /install?git=<https url>&ref=<ref>&path=<module path>
 *   /install?source=git::<https url>//<module path>?ref=<ref>
 *
 * A link only PRE-FILLS — nothing installs from a URL. The visitor always
 * confirms in the client: the summary line states the source came from a
 * link, the compatibility check ("中身を確認") must pass, and the install
 * button is a separate explicit step. Real source-URL policy is enforced
 * server-side when the Source is registered / compatibility-checked; the
 * https-only guard here just refuses to seed the form with junk
 * (non-https, embedded credentials, unparsable URLs).
 */

export interface InstallPrefill {
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
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
  const vars = parseVariableParams(params);
  return {
    git,
    ref: (params.get("ref") ?? packed?.ref ?? "").trim(),
    path: (params.get("path") ?? packed?.path ?? "").trim(),
    ...(name ? { name } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  };
}

function parseOptionalName(value: string | null): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if (/[\r\n\0]/u.test(name)) return undefined;
  return name.slice(0, 96);
}

function parseVariableParams(
  params: URLSearchParams,
): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!key.startsWith("var.")) continue;
    const name = key.slice("var.".length);
    if (!isSafeInstallVariableName(name)) continue;
    if (!isSafeInstallVariableValue(value)) continue;
    vars[name] = value;
  }
  return vars;
}

export function isSafeInstallVariableName(name: string): boolean {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) return false;
  return !/(secret|token|password|credential|private_?key|api_?key)/iu.test(
    trimmed,
  );
}

export function isSafeInstallVariableValue(value: string): boolean {
  return value.length <= 512 && !/[\r\n\0]/u.test(value);
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
