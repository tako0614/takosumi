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

import type { GitAddress } from "takosumi-contract";

export interface TcsLocalizedText {
  readonly ja: string;
  readonly en: string;
}

/**
 * Store discovery points at the same canonical Git coordinate vocabulary as a
 * Takosumi Source. A Store may offer `ref` as a display hint, but install/run
 * code must require the user or a reviewed plan to select the effective ref.
 */
export type TcsListingSource = Pick<GitAddress, "url" | "path"> &
  Partial<Pick<GitAddress, "ref">>;

/** Operator-defined presentation tokens; neither field grants execution authority. */
export type TcsListingKind = string;
export type TcsListingSurface = string;

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
  readonly name?: TcsLocalizedText;
  readonly description?: TcsLocalizedText;
  readonly badge?: TcsLocalizedText;
  readonly iconUrl?: string;
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
  return sanitizeTcsListingsPage((await res.json()) as TcsListingsPage);
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
  return sanitizeTcsListing((await res.json()) as TcsListing);
}

export function sanitizeTcsListing(listing: TcsListing): TcsListing {
  const unsafe = listing as TcsListing & Record<string, unknown>;
  const {
    inputs: _inputs,
    installExperience: _installExperience,
    outputAllowlist: _outputAllowlist,
    primaryServer: _primaryServer,
    primaryDefault: _primaryDefault,
    seenOn: _seenOn,
    iconUrl: unsafeIconUrl,
    ...rest
  } = unsafe;
  const iconUrl = safePresentationHttpsUrl(unsafeIconUrl);
  return {
    ...rest,
    source: sanitizeTcsListingSource(unsafe.source),
    ...(iconUrl ? { iconUrl } : {}),
  } as unknown as TcsListing;
}

function sanitizeTcsListingSource(value: unknown): TcsListingSource {
  if (!isRecord(value)) throw new Error("listing source must be an object");
  // Input-only migration for pre-v1 TCS nodes. `git` is normalized to the
  // canonical `url` field only when `url` is absent; it is never returned or
  // allowed to coexist with the canonical field.
  const allowedKeys = new Set(["url", "git", "ref", "path"]);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `listing source has unsupported fields: ${unexpected.join(", ")}`,
    );
  }
  const canonicalUrl = text(value.url);
  const legacyGit = text(value.git);
  const hasCanonicalUrl = value.url !== undefined;
  const hasLegacyGit = value.git !== undefined;
  if (hasCanonicalUrl && hasLegacyGit) {
    throw new Error("listing source must not declare both url and legacy git");
  }
  if (hasCanonicalUrl && !canonicalUrl) {
    throw new Error("listing source url must be a non-empty string");
  }
  if (hasLegacyGit && !legacyGit) {
    throw new Error("listing source legacy git must be a non-empty string");
  }
  const url = safeListingGitUrl(hasCanonicalUrl ? canonicalUrl : legacyGit);
  const path = safeListingSourcePath(value.path);
  const ref = value.ref === undefined ? undefined : safeListingRef(value.ref);
  if (!url || !path) {
    throw new Error(
      "listing source requires a credential-free HTTPS url and repo-relative path",
    );
  }
  if (value.ref !== undefined && !ref)
    throw new Error("listing source ref is unsafe");
  return { url, ...(ref ? { ref } : {}), path };
}

function safeListingGitUrl(value: string | undefined): string | undefined {
  if (!value || /[\0\r\n]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function safeListingSourcePath(value: unknown): string | undefined {
  const raw = text(value);
  if (
    !raw ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    /[\0\r\n]/u.test(raw)
  ) {
    return undefined;
  }
  const segments = raw.replace(/\/+$/u, "").split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return undefined;
  }
  return segments.filter((segment) => segment !== ".").join("/") || ".";
}

function safeListingRef(value: unknown): string | undefined {
  const ref = text(value);
  return ref && !ref.startsWith("-") && !/[\0\r\n]/u.test(ref)
    ? ref
    : undefined;
}

function sanitizeTcsListingsPage(page: TcsListingsPage): TcsListingsPage {
  return {
    ...page,
    items: page.items.map(sanitizeTcsListing),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safePresentationHttpsUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.toString()
      : undefined;
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

export function parseTcsRepoMetadata(
  json: unknown,
): TcsRepoMetadata | undefined {
  if (!isRecord(json)) return undefined;
  const schemaVersion = text(json.schemaVersion);
  if (schemaVersion && schemaVersion !== "tcs.repo/v1") return undefined;
  const iconUrl = safePresentationHttpsUrl(json.iconUrl);
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(localized(json.name) ? { name: localized(json.name) } : {}),
    ...(localized(json.description)
      ? { description: localized(json.description) }
      : {}),
    ...(localized(json.badge) ? { badge: localized(json.badge) } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

export function mergeTcsListingRepoMetadata(
  listing: TcsListing,
  metadata: TcsRepoMetadata | null,
): TcsListing {
  if (!metadata) return listing;
  const iconUrl = safePresentationHttpsUrl(metadata.iconUrl);
  return {
    ...listing,
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.badge ? { badge: metadata.badge } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

/** Normalized identity tuple used for cross-server de-duplication. */
export function tcsListingIdentity(source: TcsListingSource): string {
  let host = "";
  let rest = "";
  try {
    const url = new URL(source.url);
    host = url.host.toLowerCase();
    rest = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  } catch {
    host = source.url.trim().toLowerCase();
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
