/**
 * Takosumi Capsule Store (TCS) read client — the small open read spec a store
 * node exposes (GET /tcs/v1/listings etc.). The store is a SEPARATE product
 * (`takosumi-store`); this dashboard cannot import it, so the wire types are
 * RE-DECLARED here. Structurally compatible with takosumi-store/spec.
 *
 * Scoped to one server base url; aggregation across many servers lives in
 * tcs-aggregate.ts. Reads are unauthenticated and cross-origin (the store sends
 * Access-Control-Allow-Origin: * on its read surface).
 */

export interface TcsLocalizedText {
  readonly ja: string;
  readonly en: string;
}

export interface TcsListingSource {
  readonly git: string;
  readonly ref?: string;
  readonly resolvedCommit?: string;
  readonly path: string;
}

export interface TcsListingInput {
  readonly name: string;
  readonly type?: "string" | "number" | "boolean" | "json";
  readonly format?:
    | "text"
    | "url"
    | "hostname"
    | "subdomain"
    | "password"
    | "token"
    | "email"
    | "sha256";
  readonly required?: boolean;
  readonly advanced?: boolean;
  readonly secret?: boolean;
  readonly defaultValue?: string;
  readonly label: TcsLocalizedText;
  readonly helper?: TcsLocalizedText;
  readonly placeholder?: string;
}

export interface TcsInstallExperience {
  readonly projections?: readonly (
    | {
        readonly kind: "service_name";
        readonly variable: string;
      }
    | {
        readonly kind: "public_endpoint";
        readonly variables: {
          readonly subdomain?: string;
          readonly url?: string;
          readonly routePattern?: string;
        };
        readonly baseDomain?: string;
      }
    | {
        readonly kind: "initial_secret";
        readonly variable: string;
        readonly secretKind?: "password" | "password_or_hash" | "token";
        readonly optional?: boolean;
      }
    | {
        readonly kind: "oidc_client";
        readonly variables: {
          readonly issuerUrl?: string;
          readonly accountsUrl?: string;
          readonly clientId?: string;
          readonly redirectUri?: string;
        };
        readonly callbackPath?: string;
      }
    | {
        readonly kind: "artifact";
        readonly variables: {
          readonly url?: string;
          readonly sha256?: string;
        };
      }
  )[];
}

export interface TcsListingOutput {
  readonly key: string;
  readonly from: string;
  readonly type: "string" | "url" | "hostname" | "number" | "boolean" | "json";
  readonly required?: boolean;
}

export type TcsListingKind = "app" | "worker" | "storage" | "site";
export type TcsListingSurface = "service" | "building_block" | "example";

export interface TcsListing {
  readonly id: string;
  /** Dashboard aggregation hint used to rehydrate `/new` hand-offs. */
  readonly primaryServer?: string;
  readonly source: TcsListingSource;
  readonly kind: TcsListingKind;
  readonly surface: TcsListingSurface;
  readonly provider: string;
  readonly category: string;
  readonly suggestedName: string;
  readonly name: TcsLocalizedText;
  readonly description: TcsLocalizedText;
  readonly badge: TcsLocalizedText;
  readonly iconUrl?: string;
  /** Hydrated from repo `.well-known/tcs.json`; store listings do not own setup. */
  readonly inputs?: readonly TcsListingInput[];
  /** Hydrated from repo `.well-known/tcs.json`; store listings do not own setup. */
  readonly installExperience?: TcsInstallExperience;
  /** Hydrated from repo `.well-known/tcs.json`; store listings do not own setup. */
  readonly outputAllowlist?: readonly TcsListingOutput[];
  readonly publisher?: {
    readonly handle: string;
    readonly displayName?: string;
  };
  readonly badges?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TcsRepoMetadata {
  readonly schemaVersion?: string;
  readonly id?: string;
  readonly modulePath?: string;
  readonly kind?: TcsListingKind;
  readonly surface?: TcsListingSurface;
  readonly provider?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly suggestedName?: string;
  readonly name?: TcsLocalizedText;
  readonly description?: TcsLocalizedText;
  readonly badge?: TcsLocalizedText;
  readonly iconUrl?: string;
  readonly inputs?: readonly TcsListingInput[];
  readonly installExperience?: TcsInstallExperience;
  readonly outputAllowlist?: readonly TcsListingOutput[];
}

export type TcsSort = "updated" | "created" | "name";

export interface TcsListingsPage {
  readonly items: readonly TcsListing[];
  readonly nextCursor?: string;
}

export interface TcsServerInfo {
  readonly spec: {
    readonly version: string;
    readonly capabilities: readonly string[];
  };
  readonly server: {
    readonly name: string;
    readonly software: { readonly name: string; readonly version: string };
    readonly baseUrl: string;
  };
  readonly listings: { readonly count: number };
  readonly categories: readonly {
    readonly key: string;
    readonly count: number;
  }[];
  readonly kinds: readonly { readonly key: string; readonly count: number }[];
  readonly providers: readonly {
    readonly key: string;
    readonly count: number;
  }[];
  readonly defaultLocale?: "ja" | "en";
}

export interface TcsPageQuery {
  readonly sort?: TcsSort;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** Thrown when a node does not implement search (501 not_implemented). */
export class TcsNotSupportedError extends Error {}

function joinBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export async function fetchTcsServerInfo(
  base: string,
  signal?: AbortSignal,
): Promise<TcsServerInfo> {
  const res = await fetch(joinBase(base, "/.well-known/tcs"), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`server-info ${res.status}`);
  return (await res.json()) as TcsServerInfo;
}

export async function fetchTcsListingsPage(
  base: string,
  query: TcsPageQuery = {},
): Promise<TcsListingsPage> {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const path = query.q
    ? `/tcs/v1/listings/search?q=${encodeURIComponent(query.q)}&${params}`
    : `/tcs/v1/listings?${params}`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal: query.signal,
  });
  if (res.status === 501)
    throw new TcsNotSupportedError("search not supported");
  if (!res.ok) throw new Error(`listings ${res.status}`);
  return (await res.json()) as TcsListingsPage;
}

export async function fetchTcsListing(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<TcsListing | null> {
  const res = await fetch(
    joinBase(base, `/tcs/v1/listings/${encodeURIComponent(id)}`),
    { headers: { accept: "application/json" }, signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return (await res.json()) as TcsListing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function repoMetadataUrl(source: TcsListingSource): string | undefined {
  try {
    const url = new URL(source.git);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const parts = url.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return undefined;
    const ref = (source.resolvedCommit ?? source.ref ?? "main").trim();
    if (!ref) return undefined;
    const owner = encodeURIComponent(parts[0]);
    const repo = encodeURIComponent(parts[1]);
    const encodedRef = encodeURIComponent(ref);
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRef}/.well-known/tcs.json`;
  } catch {
    return undefined;
  }
}

function repoAssetUrl(
  source: TcsListingSource,
  value: string | undefined,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    // Relative URL. Resolve it against the same git ref that supplied
    // `.well-known/tcs.json`; the store remains only the repository pointer.
  }

  try {
    const url = new URL(source.git);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const parts = url.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "")
      .split("/")
      .filter(Boolean);
    const ref = (source.resolvedCommit ?? source.ref ?? "main").trim();
    const asset = raw.replace(/^\.?\//u, "");
    if (parts.length < 2 || !ref || asset.includes("..")) return undefined;
    return `https://raw.githubusercontent.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/${encodeURIComponent(ref)}/${asset
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function localized(value: unknown): TcsLocalizedText | undefined {
  if (!isRecord(value)) return undefined;
  const ja = text(value.ja) ?? "";
  const en = text(value.en) ?? "";
  return ja || en ? { ja, en } : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function repoMetadataFromJson(json: unknown): TcsRepoMetadata | undefined {
  if (!isRecord(json)) return undefined;
  const schemaVersion = text(json.schemaVersion);
  if (schemaVersion && schemaVersion !== "tcs.repo/v1") return undefined;
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(text(json.id) ? { id: text(json.id) } : {}),
    ...(text(json.modulePath) ? { modulePath: text(json.modulePath) } : {}),
    ...(text(json.kind) ? { kind: text(json.kind) as TcsListingKind } : {}),
    ...(text(json.surface)
      ? { surface: text(json.surface) as TcsListingSurface }
      : {}),
    ...(text(json.provider) ? { provider: text(json.provider) } : {}),
    ...(text(json.category) ? { category: text(json.category) } : {}),
    ...(stringArray(json.tags) ? { tags: stringArray(json.tags) } : {}),
    ...(text(json.suggestedName)
      ? { suggestedName: text(json.suggestedName) }
      : {}),
    ...(localized(json.name) ? { name: localized(json.name) } : {}),
    ...(localized(json.description)
      ? { description: localized(json.description) }
      : {}),
    ...(localized(json.badge) ? { badge: localized(json.badge) } : {}),
    ...(text(json.iconUrl) ? { iconUrl: text(json.iconUrl) } : {}),
    ...(Array.isArray(json.inputs)
      ? { inputs: json.inputs as readonly TcsListingInput[] }
      : {}),
    ...(isRecord(json.installExperience)
      ? { installExperience: json.installExperience as TcsInstallExperience }
      : {}),
    ...(Array.isArray(json.outputAllowlist)
      ? { outputAllowlist: json.outputAllowlist as readonly TcsListingOutput[] }
      : {}),
  };
}

export async function fetchTcsRepoMetadata(
  source: TcsListingSource,
  signal?: AbortSignal,
): Promise<TcsRepoMetadata | null> {
  const url = repoMetadataUrl(source);
  if (!url) return null;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`repo metadata ${res.status}`);
  return repoMetadataFromJson(await res.json()) ?? null;
}

export function mergeTcsListingRepoMetadata(
  listing: TcsListing,
  metadata: TcsRepoMetadata | null,
): TcsListing {
  if (!metadata) return listing;
  const source = {
    ...listing.source,
    path: metadata.modulePath ?? listing.source.path,
  };
  return {
    ...listing,
    source,
    ...(metadata.kind ? { kind: metadata.kind } : {}),
    ...(metadata.surface ? { surface: metadata.surface } : {}),
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.suggestedName
      ? { suggestedName: metadata.suggestedName }
      : {}),
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.badge ? { badge: metadata.badge } : {}),
    ...(metadata.iconUrl
      ? { iconUrl: repoAssetUrl(source, metadata.iconUrl) ?? metadata.iconUrl }
      : {}),
    ...(metadata.inputs ? { inputs: metadata.inputs } : {}),
    ...(metadata.installExperience
      ? { installExperience: metadata.installExperience }
      : {}),
    ...(metadata.outputAllowlist
      ? { outputAllowlist: metadata.outputAllowlist }
      : {}),
  };
}

export async function hydrateTcsListingWithRepoMetadata(
  listing: TcsListing,
  signal?: AbortSignal,
): Promise<TcsListing> {
  return mergeTcsListingRepoMetadata(
    listing,
    await fetchTcsRepoMetadata(listing.source, signal),
  );
}

/** Normalized identity tuple used for cross-server de-duplication. */
export function tcsListingIdentity(source: TcsListingSource): string {
  let host = "";
  let rest = "";
  try {
    const url = new URL(source.git);
    host = url.host.toLowerCase();
    rest = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  } catch {
    host = source.git.trim().toLowerCase();
    rest = "";
  }
  const path = normalizeTcsSourcePath(source.path);
  return `${host}${rest}#${path}`;
}

export function normalizeTcsSourcePath(path: string): string {
  const normalized = path
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}
