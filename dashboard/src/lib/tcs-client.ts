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
  readonly ref: string;
  readonly path: string;
  readonly resolvedCommit?: string;
}

export interface TcsListingInput {
  readonly name: string;
  readonly type?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly defaultValue?: string;
  readonly label: TcsLocalizedText;
  readonly helper?: TcsLocalizedText;
  readonly placeholder?: string;
}

export interface TcsListingOutput {
  readonly key: string;
  readonly from: string;
  readonly type: "string" | "url" | "hostname" | "number" | "boolean" | "json";
  readonly required?: boolean;
}

export type TcsListingKind = "worker" | "storage" | "site";
export type TcsListingSurface = "service" | "building_block" | "example";

export interface TcsListing {
  readonly id: string;
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
  readonly inputs: readonly TcsListingInput[];
  readonly outputAllowlist: readonly TcsListingOutput[];
  readonly publisher?: {
    readonly handle: string;
    readonly displayName?: string;
  };
  readonly badges?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
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
  const path = source.path
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  const ref = (source.resolvedCommit ?? source.ref).trim().toLowerCase();
  return `${host}${rest}@${ref}#${path}`;
}
