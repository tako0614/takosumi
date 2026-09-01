/**
 * Takosumi Capsule Store (TCS) read client — the small open read spec a store
 * node exposes (GET /tcs/v2/listings etc.). The store is a SEPARATE product
 * (`takosumi-store`). This repository carries its own consumer implementation
 * of the open wire contract so standalone checkouts remain buildable.
 *
 * Scoped to one server base url; aggregation across many servers lives in
 * tcs-aggregate.ts. Reads are unauthenticated and cross-origin (the store sends
 * Access-Control-Allow-Origin: * on its read surface).
 */

import type { GitAddress } from "takosumi-contract";
import {
  parseTcsListingSource,
  tcsListingSourceIdentity,
} from "./tcs-listing-source";

export interface TcsLocalizedText {
  readonly ja: string;
  readonly en: string;
}

/**
 * Store discovery is adapted to Takosumi's local `url` field only after the
 * Store-owned v2 `{ git }` wire source has passed its runtime parser. Legacy
 * v1 `{ git, path }` rows are accepted for the migration read path, but the
 * path is discarded before it reaches the dashboard.
 */
export type TcsListingSource = Pick<GitAddress, "url">;

/** Operator-defined presentation tokens; neither field grants execution authority. */
export type TcsListingKind = string;
export type TcsListingSurface = string;

export interface TcsListing {
  readonly id: string;
  /** Dashboard aggregation hint used to rehydrate `/new` hand-offs. */
  readonly primaryServer?: string;
  readonly source: TcsListingSource;
  /** Optional v2 presentation facets; absence must not affect install policy. */
  readonly kind?: TcsListingKind;
  readonly surface?: TcsListingSurface;
  readonly provider?: string;
  readonly category?: string;
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

/** Sort values accepted by the canonical TCS 2.0 listing routes. */
export type TcsSort = "updated" | "created";

export interface TcsListingsPage {
  readonly items: readonly TcsListing[];
  readonly nextCursor?: string;
}

export interface TcsServerInfo {
  readonly spec: {
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly compatibleVersions?: readonly string[];
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
  readonly kinds?: readonly { readonly key: string; readonly count: number }[];
  readonly providers?: readonly {
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

/**
 * TCS v2 is the canonical read surface. During the wire migration an older
 * node may expose only v1, so a missing v2 route gets one read-only fallback.
 * We intentionally do not fall back for a live v2 response (including 405),
 * a server error, or a 501 search result:
 * those statuses describe a live v2 endpoint and must retain their meaning.
 */
async function fetchTcsRead(
  base: string,
  v2Path: string,
  options: RequestInit,
  v1Path = v2Path.replace("/tcs/v2/", "/tcs/v1/"),
): Promise<Response> {
  const primary = await fetch(joinBase(base, v2Path), options);
  if (primary.status !== 404) return primary;
  return fetch(joinBase(base, v1Path), options);
}

interface TcsListingsPageInFlight {
  readonly controller: AbortController;
  readonly promise: Promise<TcsListingsPage>;
  subscribers: number;
  settled: boolean;
}

const tcsListingsPageInFlight = new Map<string, TcsListingsPageInFlight>();

function canonicalTcsListingsPageKey(base: string, path: string): string {
  const actualUrl = joinBase(base, path);
  try {
    return new URL(actualUrl).href;
  } catch {
    // Keep the existing fetch behavior for a relative or malformed base while
    // still using the canonical absolute URL whenever one can be constructed.
    return actualUrl;
  }
}

function serializeTcsListingsPagePath(query: TcsPageQuery): string {
  const params = new URLSearchParams();
  // TCS 2.0 deliberately dropped the v1 name sort. Keep the runtime guard in
  // addition to the narrow type because the browser select is DOM data at the
  // boundary and stale callers may still pass an old value.
  if (query.sort === "updated" || query.sort === "created") {
    params.set("sort", query.sort);
  }
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const path = query.q ? "/tcs/v2/listings/search" : "/tcs/v2/listings";
  if (query.q) params.set("q", query.q);
  const queryString = params.toString();
  return `${path}${queryString ? `?${queryString}` : ""}`;
}

async function requestTcsListingsPage(
  base: string,
  path: string,
  signal: AbortSignal,
): Promise<TcsListingsPage> {
  const res = await fetchTcsRead(
    base,
    path,
    {
      headers: { accept: "application/json" },
      signal,
    },
  );
  if (res.status === 501)
    throw new TcsNotSupportedError("search not supported");
  if (!res.ok) throw new Error(`listings ${res.status}`);
  return sanitizeTcsListingsPage((await res.json()) as TcsListingsPage);
}

function getTcsListingsPageInFlight(
  key: string,
  base: string,
  path: string,
): TcsListingsPageInFlight {
  const existing = tcsListingsPageInFlight.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  const entry: TcsListingsPageInFlight = {
    controller,
    promise: requestTcsListingsPage(base, path, controller.signal),
    subscribers: 0,
    settled: false,
  };
  tcsListingsPageInFlight.set(key, entry);

  const onSettled = () => {
    entry.settled = true;
    if (tcsListingsPageInFlight.get(key) === entry) {
      tcsListingsPageInFlight.delete(key);
    }
  };
  entry.promise.then(onSettled, onSettled);
  return entry;
}

function subscribeToTcsListingsPage(
  key: string,
  entry: TcsListingsPageInFlight,
  signal?: AbortSignal,
): Promise<TcsListingsPage> {
  entry.subscribers += 1;

  let cleaned = false;
  let onAbort: (() => void) | undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    entry.subscribers -= 1;
    if (entry.subscribers === 0 && !entry.settled) {
      if (tcsListingsPageInFlight.get(key) === entry) {
        tcsListingsPageInFlight.delete(key);
      }
      entry.controller.abort();
    }
  };

  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // The initial check in fetchTcsListingsPage avoids creating a subscriber
    // for an already-aborted signal. Recheck after listener installation to
    // close the race with an abort that happens during subscription setup.
    if (signal.aborted) onAbort?.();
  }

  const settled = abortPromise
    ? Promise.race([entry.promise, abortPromise])
    : entry.promise;
  return settled.then((page) => structuredClone(page)).finally(cleanup);
}

export async function fetchTcsServerInfo(
  base: string,
  signal?: AbortSignal,
): Promise<TcsServerInfo> {
  const res = await fetchTcsRead(
    base,
    "/tcs/v2/server-info",
    { headers: { accept: "application/json" }, signal },
    "/.well-known/tcs",
  );
  if (!res.ok) throw new Error(`server-info ${res.status}`);
  return (await res.json()) as TcsServerInfo;
}

export async function fetchTcsListingsPage(
  base: string,
  query: TcsPageQuery = {},
): Promise<TcsListingsPage> {
  if (query.signal?.aborted) throw query.signal.reason;
  const path = serializeTcsListingsPagePath(query);
  const key = canonicalTcsListingsPageKey(base, path);
  const entry = getTcsListingsPageInFlight(key, base, path);
  return await subscribeToTcsListingsPage(key, entry, query.signal);
}

export async function fetchTcsListing(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<TcsListing | null> {
  const segments = id.split("/");
  const scope = segments[0]?.trim();
  const slug = segments[1]?.trim();
  if (segments.length !== 2 || !scope || !slug) {
    throw new Error("listing id must be a non-empty scope/slug pair");
  }
  const res = await fetchTcsRead(
    base,
    `/tcs/v2/listings/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`,
    { headers: { accept: "application/json" }, signal },
    `/tcs/v1/listings/${encodeURIComponent(id)}`,
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
      "listing source must be the canonical TCS v2 { git } source",
    );
  }
  return { url: source.git };
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
  });
  if (!identity) throw new Error("invalid canonical TCS listing source");
  return identity;
}
