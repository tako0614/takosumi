/**
 * CLIENT-SIDE aggregation across TCS store servers. Fans the read spec out to
 * every known server, merges, and de-duplicates by normalized (git,path)
 * identity (annotating `seenOn`). A slow/failed/non-conforming server is dropped
 * from the render (best-effort) and never blocks the others. No server-to-server
 * traffic — the merge happens here, in the dashboard.
 */
import {
  fetchTcsListingsPage,
  sanitizeTcsListing,
  TcsNotSupportedError,
  tcsListingIdentity,
  type TcsListing,
  type TcsPageQuery,
  type TcsSort,
} from "./tcs-client.ts";
import type { TcsServer } from "./tcs-servers.ts";

export type TcsLocale = "ja" | "en";

export interface AggregatedTcsListing extends TcsListing {
  readonly seenOn: string[];
  readonly primaryServer: string;
  readonly primaryDefault: boolean;
}

export interface TcsServerStatus {
  readonly base: string;
  readonly isDefault: boolean;
  readonly ok: boolean;
  readonly supported: boolean;
  readonly error?: string;
}

export interface TcsAggregateState {
  readonly servers: readonly TcsServer[];
  readonly sort: TcsSort;
  readonly locale: TcsLocale;
  readonly q?: string;
  readonly limitPerServer: number;
  readonly cursors: Record<string, string | null | undefined>;
  readonly items: readonly AggregatedTcsListing[];
  readonly status: readonly TcsServerStatus[];
  readonly done: boolean;
  readonly loading: boolean;
}

export function initTcsState(
  servers: readonly TcsServer[],
  opts: {
    sort: TcsSort;
    locale: TcsLocale;
    q?: string;
    limitPerServer?: number;
  },
): TcsAggregateState {
  return {
    servers,
    sort: opts.sort,
    locale: opts.locale,
    q: opts.q,
    limitPerServer: opts.limitPerServer ?? 24,
    cursors: {},
    items: [],
    status: servers.map((s) => ({
      base: s.base,
      isDefault: s.isDefault,
      ok: true,
      supported: true,
    })),
    done: false,
    loading: false,
  };
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function isBetterPrimary(
  candidate: AggregatedTcsListing,
  current: AggregatedTcsListing,
): boolean {
  if (candidate.primaryDefault !== current.primaryDefault) {
    return candidate.primaryDefault;
  }
  return candidate.updatedAt > current.updatedAt;
}

export interface TcsListingBatch {
  readonly base: string;
  readonly isDefault: boolean;
  readonly items: readonly TcsListing[];
}

export function mergeTcsListingBatches(
  existing: readonly AggregatedTcsListing[],
  incoming: readonly TcsListingBatch[],
): AggregatedTcsListing[] {
  const map = new Map<string, AggregatedTcsListing>();
  for (const item of existing) map.set(tcsListingIdentity(item.source), item);
  for (const { base, isDefault, items } of incoming) {
    for (const item of items) {
      const listing = sanitizeTcsListing(item);
      const key = tcsListingIdentity(listing.source);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          ...listing,
          seenOn: [base],
          primaryServer: base,
          primaryDefault: isDefault,
        });
        continue;
      }
      const seenOn = prev.seenOn.includes(base)
        ? prev.seenOn
        : [...prev.seenOn, base];
      const candidate: AggregatedTcsListing = {
        ...listing,
        seenOn,
        primaryServer: base,
        primaryDefault: isDefault,
      };
      map.set(
        key,
        isBetterPrimary(candidate, prev) ? candidate : { ...prev, seenOn },
      );
    }
  }
  return [...map.values()];
}

export function sortTcsItems(
  items: readonly AggregatedTcsListing[],
  sort: TcsSort,
  locale: TcsLocale,
): AggregatedTcsListing[] {
  const copy = [...items];
  copy.sort((a, b) => {
    if (sort === "name") {
      const an = (locale === "ja" ? a.name.ja : a.name.en).toLowerCase();
      const bn = (locale === "ja" ? b.name.ja : b.name.en).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : 1;
    }
    const af = sort === "created" ? a.createdAt : a.updatedAt;
    const bf = sort === "created" ? b.createdAt : b.updatedAt;
    if (af !== bf) return af < bf ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return copy;
}

/** Fetch the next page from every not-yet-exhausted server and merge. */
export async function loadMoreTcs(
  state: TcsAggregateState,
  timeoutMs = 8000,
): Promise<TcsAggregateState> {
  const targets = state.servers.filter((s) => state.cursors[s.base] !== null);
  if (targets.length === 0) return { ...state, done: true, loading: false };

  const settled = await Promise.all(
    targets.map(async (server) => {
      const cursor = state.cursors[server.base];
      const query: TcsPageQuery = {
        sort: state.sort,
        limit: state.limitPerServer,
        ...(state.q ? { q: state.q } : {}),
        ...(typeof cursor === "string" ? { cursor } : {}),
      };
      const { signal, cancel } = withTimeout(timeoutMs);
      try {
        const page = await fetchTcsListingsPage(server.base, {
          ...query,
          signal,
        });
        return {
          server,
          ok: true,
          supported: true,
          items: page.items,
          nextCursor: page.nextCursor ?? null,
        };
      } catch (err) {
        const unsupported = err instanceof TcsNotSupportedError;
        return {
          server,
          ok: unsupported,
          supported: !unsupported,
          items: [] as readonly TcsListing[],
          nextCursor: null,
          error: unsupported
            ? undefined
            : String((err as Error)?.message ?? err),
        };
      } finally {
        cancel();
      }
    }),
  );

  const cursors = { ...state.cursors };
  for (const r of settled) cursors[r.server.base] = r.nextCursor;

  const merged = mergeTcsListingBatches(
    state.items,
    settled
      .filter((r) => r.items.length > 0)
      .map((r) => ({
        base: r.server.base,
        isDefault: r.server.isDefault,
        items: r.items,
      })),
  );

  const statusByBase = new Map<string, TcsServerStatus>();
  for (const s of state.status) statusByBase.set(s.base, s);
  for (const r of settled) {
    statusByBase.set(r.server.base, {
      base: r.server.base,
      isDefault: r.server.isDefault,
      ok: r.ok,
      supported: r.supported,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  const done = state.servers.every((s) => cursors[s.base] === null);
  return {
    ...state,
    cursors,
    items: sortTcsItems(merged, state.sort, state.locale),
    status: [...statusByBase.values()],
    done,
    loading: false,
  };
}
