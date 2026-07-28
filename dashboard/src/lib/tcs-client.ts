/**
 * Takosumi Capsule Store (TCS) read client — the small open read spec a store
 * node exposes (GET /tcs/v1/listings etc.). The store is a SEPARATE product
 * (`takosumi-store`). The Store-owned runtime parser is consumed from the
 * adjacent source workspace so the two products execute the same wire rules.
 *
 * Scoped to one server base url; aggregation across many servers lives in
 * tcs-aggregate.ts. Reads are unauthenticated and cross-origin (the store sends
 * Access-Control-Allow-Origin: * on its read surface).
 */

import type { GitAddress } from "takosumi-contract";
import {
  parseTcsListingSource,
  tcsListingSourceIdentity,
} from "../../../../takosumi-store/spec/listing-source.ts";

export interface TcsLocalizedText {
  readonly ja: string;
  readonly en: string;
}

/**
 * Store discovery is adapted to Takosumi's local `url` field only after the
 * Store-owned `{ git, path }` wire tuple has passed its runtime parser.
 */
export type TcsListingSource = Pick<GitAddress, "url" | "path">;

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

export function sanitizeTcsListingSource(value: unknown): TcsListingSource {
  const source = parseTcsListingSource(value);
  if (!source) {
    throw new Error(
      "listing source must be the canonical TCS { git, path } tuple",
    );
  }
  return { url: source.git, path: source.path };
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
  const identity = tcsListingSourceIdentity({
    git: source.url,
    path: source.path,
  });
  if (!identity) throw new Error("invalid canonical TCS listing source");
  return identity;
}
