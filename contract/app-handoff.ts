export const TAKOSUMI_APP_HANDOFF_PUBLIC_PATH = "/install" as const;
export const TAKOSUMI_APP_HANDOFF_DASHBOARD_PATH = "/new" as const;
export const TAKOSUMI_CLOUD_APP_HANDOFF_URL =
  "https://app.takosumi.com/install" as const;

export type TakosumiAppProductKey = string;

export interface TakosumiAppHandoff {
  readonly product: TakosumiAppProductKey;
  readonly returnUri: string;
}

export interface CreateTakosumiAppHandoffUrlInput {
  readonly baseUrl?: string;
  readonly product?: TakosumiAppProductKey;
  readonly returnUri?: string;
  readonly source?: string;
  readonly git?: string;
  readonly installConfigId?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
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
  const url = new URL(input.baseUrl ?? TAKOSUMI_CLOUD_APP_HANDOFF_URL);
  const source = safeQueryValue(input.source);
  const git = safeQueryValue(input.git);
  const installConfigId = safeQueryValue(input.installConfigId);
  if (!source && !git && !installConfigId) {
    throw new Error(
      "App handoff URL requires git, source, or installConfigId.",
    );
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
  if (installConfigId) {
    url.searchParams.set("installConfigId", installConfigId);
  }
  if (input.ref != null) url.searchParams.set("ref", input.ref);
  if (input.path != null) url.searchParams.set("path", input.path);
  if (input.name) url.searchParams.set("name", input.name);
  for (const [key, value] of Object.entries(input.vars ?? {}).sort()) {
    if (!isTakosumiAppHandoffVariableName(key)) {
      throw new Error(`App handoff variable name is invalid: ${key}`);
    }
    if (!isTakosumiAppHandoffVariableValue(value)) {
      throw new Error(`App handoff variable value is invalid: ${key}`);
    }
    url.searchParams.set(`var.${key}`, value);
  }
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

export function isTakosumiAppHandoffVariableName(name: string): boolean {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) return false;
  return !/(secret|token|password|credential|private_?key|api_?key)/iu.test(
    trimmed,
  );
}

export function isTakosumiAppHandoffVariableValue(value: string): boolean {
  return value.length <= 512 && !hasUnsafeBytes(value);
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
