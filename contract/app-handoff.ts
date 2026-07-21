export const TAKOSUMI_APP_HANDOFF_PUBLIC_PATH = "/install" as const;
export const TAKOSUMI_APP_HANDOFF_DASHBOARD_PATH = "/new" as const;

/**
 * Custom URL scheme for the "install into your own home Takosumi" deep link.
 * A registered protocol handler routes `web+takosumi:install?...` to the user's
 * chosen home (`navigator.registerProtocolHandler("web+takosumi",
 * "/install?handoff=%s")`), which decodes it and pre-fills `/new`. Opaque form
 * (`web+takosumi:install?...`, action read from `pathname`) — never the
 * authority form `web+takosumi://install`, whose keyword lands in `host` and is
 * lowercased/punycode-normalized. Canonical spec: docs/integration/remote-install.md.
 */
export const TAKOSUMI_APP_INSTALL_SCHEME = "web+takosumi" as const;
export const TAKOSUMI_APP_INSTALL_SCHEME_ACTION = "install" as const;
/** Base opaque URL the builder appends the query onto. */
export const TAKOSUMI_APP_INSTALL_SCHEME_BASE =
  `${TAKOSUMI_APP_INSTALL_SCHEME}:${TAKOSUMI_APP_INSTALL_SCHEME_ACTION}` as const;
/** The `%s` placeholder target passed to `navigator.registerProtocolHandler`. */
export const TAKOSUMI_APP_INSTALL_HANDLER_TEMPLATE =
  `${TAKOSUMI_APP_HANDOFF_PUBLIC_PATH}?handoff=%s` as const;
/** Upper bound on a decoded handoff string before it is parsed. */
export const TAKOSUMI_APP_INSTALL_SCHEME_MAX_LENGTH = 4096 as const;

export type TakosumiAppProductKey = string;

export interface TakosumiAppHandoff {
  readonly product: TakosumiAppProductKey;
  readonly returnUri: string;
}

export interface CreateTakosumiAppHandoffUrlInput {
  /** Operator- or caller-owned install endpoint. Core never selects a host. */
  readonly baseUrl: string;
  readonly product?: TakosumiAppProductKey;
  readonly returnUri?: string;
  readonly source?: string;
  readonly git?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly name?: string;
}

export interface CreateTakosumiAppConnectHrefInput {
  readonly handoff: TakosumiAppHandoff;
  readonly hostUrl: string;
  readonly runId?: string;
  readonly capsuleId?: string;
  readonly setupTicket?: string;
}

export function takosumiAppHandoffFromSearch(
  search: string,
): TakosumiAppHandoff | undefined {
  const params = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`,
  );
  const product = parseTakosumiAppProductKey(params.get("product"));
  if (!product) return undefined;
  const returnUri = parseTakosumiAppReturnUri(params.get("return_uri"));
  return returnUri ? { product, returnUri } : undefined;
}

export function appendTakosumiAppHandoff(
  path: string | undefined,
  handoff: TakosumiAppHandoff | undefined,
): string | undefined {
  if (!path || !handoff) return path;
  if (!path.startsWith("/") || path.startsWith("//") || hasUnsafeBytes(path)) {
    return path;
  }
  const product = parseTakosumiAppProductKey(handoff.product);
  const returnUri = parseTakosumiAppReturnUri(handoff.returnUri);
  if (!product || !returnUri) return path;

  try {
    const base = "https://takosumi.invalid";
    const url = new URL(path, base);
    if (url.origin !== base) return path;
    url.searchParams.set("product", product);
    url.searchParams.set("return_uri", returnUri);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return path;
  }
}

export function createTakosumiAppHandoffUrl(
  input: CreateTakosumiAppHandoffUrlInput,
): string {
  const url = new URL(input.baseUrl);
  for (const key of [
    "source",
    "git",
    "installConfigId",
    "ref",
    "path",
    "name",
    "product",
    "return_uri",
  ]) {
    url.searchParams.delete(key);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("var.") || key.startsWith("varjson.")) {
      url.searchParams.delete(key);
    }
  }
  const source = safeQueryValue(input.source);
  const git = safeQueryValue(input.git);
  if (source && git) {
    throw new Error("App handoff URL requires exactly one of git or source.");
  }
  if (!source && !git) {
    throw new Error("App handoff URL requires git or source.");
  }

  if (input.product || input.returnUri) {
    const product = requireTakosumiAppProductKey(
      input.product ?? "",
      "App handoff product",
    );
    url.searchParams.set("product", product);
    url.searchParams.set(
      "return_uri",
      requireTakosumiAppReturnUri(input.returnUri ?? ""),
    );
  }
  if (source) url.searchParams.set("source", source);
  if (!source && git) url.searchParams.set("git", git);
  if (input.ref != null) url.searchParams.set("ref", input.ref);
  if (input.path != null) url.searchParams.set("path", input.path);
  if (input.name) url.searchParams.set("name", input.name);
  return url.toString();
}

export function createTakosumiAppConnectHref(
  input: CreateTakosumiAppConnectHrefInput,
): string | undefined {
  const product = parseTakosumiAppProductKey(input.handoff.product);
  const returnUri = parseTakosumiAppReturnUri(input.handoff.returnUri);
  const hostUrl = normalizeTakosumiAppHandoffHostUrl(input.hostUrl);
  if (!product || !returnUri || !hostUrl) return undefined;

  const url = new URL(returnUri);
  url.searchParams.set("host_url", hostUrl);
  url.searchParams.set("product", product);
  if (input.runId) url.searchParams.set("run_id", input.runId);
  if (input.capsuleId) url.searchParams.set("capsule_id", input.capsuleId);
  if (input.setupTicket)
    url.searchParams.set("setup_ticket", input.setupTicket);
  return url.toString();
}

export type CreateTakosumiAppInstallSchemeInput = Omit<
  CreateTakosumiAppHandoffUrlInput,
  "baseUrl"
>;

export interface TakosumiAppInstallSchemeFields {
  readonly git?: string;
  readonly source?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly name?: string;
  readonly product?: TakosumiAppProductKey;
  readonly returnUri?: string;
}

/**
 * Build a `web+takosumi:install?...` deep link (host-independent — the visitor's
 * registered handler supplies the home origin). Same payload vocabulary and
 * one-of-git/source rule as {@link createTakosumiAppHandoffUrl}. Values MUST go
 * through `URLSearchParams`; never concatenate a raw git URL (its `&`/`?` would
 * truncate the link and silently prefill the wrong repo).
 */
export function createTakosumiAppInstallScheme(
  input: CreateTakosumiAppInstallSchemeInput,
): string {
  const source = safeQueryValue(input.source);
  const git = safeQueryValue(input.git);
  if (source && git) {
    throw new Error("Install scheme requires exactly one of git or source.");
  }
  if (!source && !git) {
    throw new Error("Install scheme requires git or source.");
  }
  const url = new URL(TAKOSUMI_APP_INSTALL_SCHEME_BASE);
  if (input.product || input.returnUri) {
    url.searchParams.set(
      "product",
      requireTakosumiAppProductKey(input.product ?? "", "Install scheme product"),
    );
    url.searchParams.set(
      "return_uri",
      requireTakosumiAppReturnUri(input.returnUri ?? ""),
    );
  }
  if (source) url.searchParams.set("source", source);
  if (!source && git) url.searchParams.set("git", git);
  if (input.ref != null) url.searchParams.set("ref", input.ref);
  if (input.path != null) url.searchParams.set("path", input.path);
  if (input.name) url.searchParams.set("name", input.name);
  return url.toString();
}

/**
 * Parse a decoded `web+takosumi:install?...` string into its whitelisted
 * install fields, or undefined when the scheme/action/payload is invalid.
 * Guards (in order): length cap, CR/LF/NUL screen on the whole string, exact
 * `web+takosumi:` scheme + `install` action, exactly one of git/source,
 * product/return_uri travel together. Note: this does not apply the browser's
 * https-only git guard — the dashboard prefill path re-checks git via
 * `isSafeHttpsGitUrl` in `install-link.ts`.
 */
export function parseTakosumiAppInstallScheme(
  raw: unknown,
): TakosumiAppInstallSchemeFields | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > TAKOSUMI_APP_INSTALL_SCHEME_MAX_LENGTH ||
    hasUnsafeBytes(trimmed)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${TAKOSUMI_APP_INSTALL_SCHEME}:`) return undefined;
  if (url.pathname !== TAKOSUMI_APP_INSTALL_SCHEME_ACTION) return undefined;

  const params = url.searchParams;

  // Fail closed: if a recognized field is PRESENT but fails validation (e.g. a
  // percent-encoded newline in `ref`/`path` that only surfaces after decode),
  // reject the whole payload rather than silently prefilling a partial one.
  let invalid = false;
  const field = (key: string): string | undefined => {
    if (!params.has(key)) return undefined;
    const value = safeQueryValue(params.get(key) ?? undefined);
    if (!value) {
      invalid = true;
      return undefined;
    }
    return value;
  };

  const source = field("source");
  const git = field("git");
  const ref = field("ref");
  const path = field("path");
  const name = field("name");

  let product: TakosumiAppProductKey | undefined;
  if (params.has("product")) {
    product = parseTakosumiAppProductKey(params.get("product"));
    if (!product) invalid = true;
  }
  let returnUri: string | undefined;
  if (params.has("return_uri")) {
    returnUri = parseTakosumiAppReturnUri(params.get("return_uri"));
    if (!returnUri) invalid = true;
  }

  if (invalid) return undefined;
  if (source && git) return undefined;
  if (!source && !git) return undefined;
  if (Boolean(product) !== Boolean(returnUri)) return undefined;

  return {
    ...(git ? { git } : {}),
    ...(source ? { source } : {}),
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
    ...(name ? { name } : {}),
    ...(product ? { product } : {}),
    ...(returnUri ? { returnUri } : {}),
  };
}

export function parseTakosumiAppProductKey(
  value: unknown,
): TakosumiAppProductKey | undefined {
  const raw = parseBoundedString(value, 64);
  if (!raw) return undefined;
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(raw) ? raw : undefined;
}

export function isTakosumiAppProductKey(
  value: unknown,
): value is TakosumiAppProductKey {
  return parseTakosumiAppProductKey(value) !== undefined;
}

export function requireTakosumiAppProductKey(
  value: string,
  label = "App handoff product",
): TakosumiAppProductKey {
  const product = parseTakosumiAppProductKey(value);
  if (product) return product;
  throw new Error(`${label} key is invalid.`);
}

/**
 * Schemes a browser can turn into script or inline content. A `return_uri` is
 * rendered as an anchor href on the run screen, and the authority form of these
 * schemes survives URL parsing: `javascript://x/%0Aalert(1)//` keeps
 * `javascript:` as its protocol, and the connect payload appended after it
 * lands behind the `//` line comment, so the click executes in the dashboard
 * origin. A client scheme (`notesapp://connect`) stays allowed.
 */
const UNSAFE_LINK_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
  "about:",
  "filesystem:",
  "view-source:",
]);

/**
 * True when a value is safe to place in an anchor `href`. Fail-closed: an
 * unparseable value, a control byte, or a script-capable scheme is not safe.
 * Site-relative paths stay allowed so ordinary in-app links pass unchanged.
 */
export function isSafeLinkHref(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!raw || hasUnsafeBytes(raw)) return false;
  if (raw.startsWith("/") && !raw.startsWith("//")) return true;
  try {
    return !UNSAFE_LINK_PROTOCOLS.has(new URL(raw).protocol.toLowerCase());
  } catch {
    // A relative value with no base is not a scheme, so it cannot be one of
    // the script-capable schemes above.
    return !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  }
}

export function parseTakosumiAppReturnUri(value: unknown): string | undefined {
  const raw = parseBoundedString(value, 2048);
  if (!raw || hasUnsafeBytes(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return undefined;
  if (UNSAFE_LINK_PROTOCOLS.has(url.protocol)) return undefined;
  if (url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:") return undefined;
  if (!raw.match(/^[a-z][a-z0-9+.-]*:\/\//i)) return undefined;
  if (!url.hostname && !url.pathname.replace(/^\/+/, "")) return undefined;
  return url.toString();
}

export function requireTakosumiAppReturnUri(value: string): string {
  const returnUri = parseTakosumiAppReturnUri(value);
  if (returnUri) return returnUri;
  throw new Error("App handoff return_uri is invalid.");
}

export function normalizeTakosumiAppHandoffHostUrl(
  value: string,
): string | undefined {
  if (hasUnsafeBytes(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return undefined;
  }
}

export function takosumiAppProductLabel(product: string): string {
  return product
    .split(/[-_.:]+/u)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function parseBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function safeQueryValue(value: string | undefined): string | undefined {
  const parsed = parseBoundedString(value, 4096);
  if (!parsed || hasUnsafeBytes(parsed)) return undefined;
  return parsed;
}

function hasUnsafeBytes(value: string): boolean {
  return /[\r\n\0]/u.test(value);
}
