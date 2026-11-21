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
 * Store-owned v2 `{ git, path? }` wire source has passed its runtime parser.
 * The reviewed module travels as `path`, which the add flow revalidates
 * against the immutable snapshot scan before it becomes a module.
 */
export interface TcsListingSource {
  readonly url: string;
  readonly path?: string;
}

export interface TcsRating {
  readonly average: number;
  readonly count: number;
}

export interface TcsGalleryItem {
  readonly kind: "image" | "video";
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly alt?: TcsLocalizedText;
}

export interface TcsReview {
  readonly id: string;
  readonly stars: number;
  readonly text?: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TcsReviewsPage {
  readonly items: readonly TcsReview[];
  readonly nextCursor?: string;
}

/** Operator-defined presentation tokens; neither field grants execution authority. */
export type TcsListingKind = string;
export type TcsListingSurface = string;

export interface TcsListing {
  readonly id: string;
  /** Dashboard aggregation hint used to rehydrate `/new` hand-offs. */
  readonly primaryServer?: string;
  /** Module the listing reviewed, when the catalog names a non-root one. */
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
  /** Display-only listing metadata. It never affects install inputs or policy. */
  readonly rating?: TcsRating;
  readonly gallery?: readonly TcsGalleryItem[];
  readonly releaseNotes?: TcsLocalizedText;
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
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

function joinBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function readOptions(signal?: AbortSignal): RequestInit {
  return {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
    signal,
  };
}

/**
 * TCS v2 is the canonical read surface. During the wire migration an older
 * node may expose only v1, so a missing v2 route gets one read-only fallback.
 * We intentionally do not fall back for a live v2 response (including 405)
 * or a server error: those statuses describe a live v2 endpoint and must
 * retain their meaning.
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
  const params = new URLSearchParams();
  // TCS 2.0 deliberately dropped the v1 name sort. Keep the runtime guard in
  // addition to the narrow type because the browser select is DOM data at the
  // boundary and stale callers may still pass an old value.
  if (query.sort === "updated" || query.sort === "created") {
    params.set("sort", query.sort);
  }
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const queryString = params.toString();
  const res = await fetchTcsRead(
    base,
    `/tcs/v2/listings${queryString ? `?${queryString}` : ""}`,
    readOptions(query.signal),
  );
  if (!res.ok) throw new Error(`listings ${res.status}`);
  return sanitizeTcsListingsPage((await res.json()) as TcsListingsPage, base);
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
    readOptions(signal),
    `/tcs/v1/listings/${encodeURIComponent(id)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return sanitizeTcsListing((await res.json()) as TcsListing, base);
}

export async function fetchTcsReviewsPage(
  base: string,
  id: string,
  query: Pick<TcsPageQuery, "cursor" | "signal"> = {},
): Promise<TcsReviewsPage | null> {
  const path = tcsListingPath(id);
  if (!path) throw new Error("listing id must be a non-empty scope/slug pair");
  const params = query.cursor ? `?${new URLSearchParams({ cursor: query.cursor })}` : "";
  const res = await fetch(
    joinBase(base, `/tcs/v2/listings${path}/reviews${params}`),
    readOptions(query.signal),
  );
  if (res.status === 404 || res.status === 501) return null;
  if (!res.ok) throw new Error(`reviews ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error("invalid reviews page");
  return {
    items: body.items.flatMap((item) => {
      const review = sanitizeTcsReview(item);
      return review ? [review] : [];
    }),
    ...cursorField(body),
  };
}

/** A public listing page link never carries dashboard state or authentication. */
export function tcsListingPageHref(
  base: string,
  id: string,
  section?: "reviews" | "save",
): string | undefined {
  const path = tcsListingPath(id);
  if (!path) return undefined;
  const url = safeStoreUrl(base);
  if (!url) return undefined;
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
  if (section) url.hash = section;
  return url.href;
}

function tcsListingPath(id: string): string | undefined {
  const segments = id.split("/");
  if (segments.length !== 2 || segments.some((part) =>
    !/^[A-Za-z0-9_@.-]+$/u.test(part) || part === "." || part === ".."
  )) return undefined;
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

export function sanitizeTcsListing(listing: TcsListing, base?: string): TcsListing {
  const unsafe = listing as TcsListing & Record<string, unknown>;
  const {
    inputs: _inputs,
    installExperience: _installExperience,
    outputAllowlist: _outputAllowlist,
    primaryServer: _primaryServer,
    primaryDefault: _primaryDefault,
    seenOn: _seenOn,
    iconUrl: unsafeIconUrl,
    gallery: unsafeGallery,
    rating: unsafeRating,
    releaseNotes: unsafeReleaseNotes,
    ...rest
  } = unsafe;
  const iconUrl = safePresentationHttpsUrl(unsafeIconUrl);
  const rating = sanitizeRating(unsafeRating);
  const gallery = base ? sanitizeGallery(unsafeGallery, base) : [];
  const releaseNotes = localized(unsafeReleaseNotes);
  return {
    ...rest,
    source: sanitizeTcsListingSource(unsafe.source),
    ...(iconUrl ? { iconUrl } : {}),
    ...(rating ? { rating } : {}),
    ...(gallery.length > 0 ? { gallery } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
  } as unknown as TcsListing;
}

export function sanitizeTcsListingSource(value: unknown): TcsListingSource {
  const source = parseTcsListingSource(value);
  if (!source) {
    throw new Error(
      "listing source must be the canonical TCS v2 { git, path? } source",
    );
  }
  return {
    url: source.git,
    ...(source.path ? { path: source.path } : {}),
  };
}

function sanitizeTcsListingsPage(page: unknown, base: string): TcsListingsPage {
  if (!isRecord(page) || !Array.isArray(page.items)) throw new Error("invalid listings page");
  return {
    items: page.items.map((listing) => sanitizeTcsListing(listing as TcsListing, base)),
    ...(typeof page.nextCursor === "string" && page.nextCursor.length > 0
      ? { nextCursor: page.nextCursor }
      : {}),
  };
}

function cursorField(body: Record<string, unknown>): { nextCursor?: string } {
  return typeof body.nextCursor === "string" && body.nextCursor.length > 0
    ? { nextCursor: body.nextCursor }
    : {};
}

function sanitizeRating(value: unknown): TcsRating | undefined {
  if (!isRecord(value)) return undefined;
  const { average, count } = value;
  return typeof average === "number" && Number.isFinite(average) &&
      typeof count === "number" && Number.isSafeInteger(count) &&
      ((count === 0 && average === 0) || (count > 0 && average >= 1 && average <= 5))
    ? { average, count }
    : undefined;
}

function safeStoreUrl(raw: string, base?: string): URL | undefined {
  try {
    const url = new URL(raw, base);
    const isLocal = url.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|\[::1\])$/u.test(url.hostname);
    if ((!isLocal && url.protocol !== "https:") || !url.hostname ||
      url.username || url.password || url.search || url.hash
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function sanitizeGallery(value: unknown, base: string): TcsGalleryItem[] {
  const store = safeStoreUrl(base);
  if (!Array.isArray(value) || !store) return [];
  return value.slice(0, 9).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { kind, width, height } = entry;
    const raw = text(entry.url);
    const url = raw ? safeStoreUrl(raw, `${store.href.replace(/\/+$/u, "")}/`) : undefined;
    // Dashboard CSP permits HTTPS images but does not grant remote media-src.
    // Keep the requested image gallery useful without rendering blocked video.
    if (!url || url.origin !== store.origin || kind !== "image" ||
      typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0 || width > 12000 ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0 || height > 12000
    ) return [];
    const alt = localized(entry.alt);
    return [{ kind, url: url.href, width, height, ...(alt ? { alt } : {}) }];
  });
}

function sanitizeTcsReview(value: unknown): TcsReview | undefined {
  if (!isRecord(value)) return undefined;
  const { stars } = value;
  const id = text(value.id);
  const author = text(value.author);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  const message = text(value.text);
  if (!id || !author || !createdAt || !updatedAt ||
    typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5
  ) return undefined;
  return { id, author, createdAt, updatedAt, stars, ...(message ? { text: message } : {}) };
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
