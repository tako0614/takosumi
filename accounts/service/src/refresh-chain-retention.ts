import type { RefreshChainPruneResult } from "./store.ts";

export const REFRESH_CHAIN_RETENTION_PHASES = [
  "chain_links",
  "chain_access_tokens",
  "revoked_roots",
  "consumed_codes",
  "auth_code_token_links",
  "authorization_code_redemptions",
] as const;

export type RefreshChainRetentionPhase =
  (typeof REFRESH_CHAIN_RETENTION_PHASES)[number];

export interface RefreshChainRetentionCursor {
  readonly phase: RefreshChainRetentionPhase;
  /**
   * Backend-owned stable ordering key. Callers must treat it as opaque and
   * pass it back unchanged.
   */
  readonly after?: string;
}

export interface RefreshChainRetentionPageInput {
  readonly chainBefore: number;
  readonly consumedCodeBefore: number;
  /** Maximum rows deleted by this page across all phases. */
  readonly limit: number;
  readonly cursor?: RefreshChainRetentionCursor;
}

export interface RefreshChainRetentionPageResult
  extends RefreshChainPruneResult {
  /** Number of candidate rows inspected by this page. Never exceeds limit. */
  readonly scanned: number;
  readonly done: boolean;
  readonly cursor?: RefreshChainRetentionCursor;
}

/** Narrow bounded maintenance contract shared by every Accounts adapter. */
export interface RefreshChainRetentionPageStore {
  pruneRefreshChainPage(
    input: RefreshChainRetentionPageInput,
  ): Promise<RefreshChainRetentionPageResult>;
}

export interface RunRefreshChainRetentionOptions {
  readonly now?: number;
  readonly refreshTokenTtlMs?: number;
  readonly authorizationCodeTtlMs?: number;
  /** Total candidate/deletion budget for one operator invocation. */
  readonly maxRows?: number;
  /** Per-query page cap. */
  readonly pageSize?: number;
  readonly cursor?: RefreshChainRetentionCursor;
}

export interface RefreshChainRetentionRunResult
  extends RefreshChainPruneResult {
  readonly scanned: number;
  readonly pages: number;
  readonly done: boolean;
  readonly cursor?: RefreshChainRetentionCursor;
}

export const DEFAULT_REFRESH_TOKEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_AUTHORIZATION_CODE_RETENTION_MS = 5 * 60 * 1_000;
export const DEFAULT_REFRESH_CHAIN_RETENTION_MAX_ROWS = 100;
export const DEFAULT_REFRESH_CHAIN_RETENTION_PAGE_SIZE = 25;
export const MAX_REFRESH_CHAIN_RETENTION_ROWS = 1_000;

const ZERO_COUNTS: RefreshChainPruneResult = {
  chainLinks: 0,
  chainAccessTokens: 0,
  revokedRoots: 0,
  consumedCodes: 0,
  authCodeTokenLinks: 0,
  authorizationCodeRedemptions: 0,
};

/**
 * Runs one bounded retention slice. A slow or very large tenant population
 * cannot turn one cron tick into an unbounded D1/Postgres query or delete
 * loop: both the aggregate budget and every backend page are capped.
 */
export async function runRefreshChainRetention(
  store: RefreshChainRetentionPageStore,
  options: RunRefreshChainRetentionOptions = {},
): Promise<RefreshChainRetentionRunResult> {
  const now = finiteTimestamp(options.now ?? Date.now(), "now");
  const refreshTokenTtlMs = positiveInteger(
    options.refreshTokenTtlMs,
    DEFAULT_REFRESH_TOKEN_RETENTION_MS,
    "refreshTokenTtlMs",
  );
  const authorizationCodeTtlMs = positiveInteger(
    options.authorizationCodeTtlMs,
    DEFAULT_AUTHORIZATION_CODE_RETENTION_MS,
    "authorizationCodeTtlMs",
  );
  const maxRows = boundedPositiveInteger(
    options.maxRows,
    DEFAULT_REFRESH_CHAIN_RETENTION_MAX_ROWS,
    "maxRows",
  );
  const pageSize = Math.min(
    maxRows,
    boundedPositiveInteger(
      options.pageSize,
      DEFAULT_REFRESH_CHAIN_RETENTION_PAGE_SIZE,
      "pageSize",
    ),
  );
  const totals = { ...ZERO_COUNTS };
  let scanned = 0;
  let pages = 0;
  let cursor = options.cursor;
  let done = false;

  while (scanned < maxRows && !done) {
    const limit = Math.min(pageSize, maxRows - scanned);
    const page = await store.pruneRefreshChainPage({
      chainBefore: now - refreshTokenTtlMs,
      consumedCodeBefore: now - authorizationCodeTtlMs,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    assertPageResult(page, limit);
    addCounts(totals, page);
    scanned += page.scanned;
    pages += 1;
    cursor = page.cursor;
    done = page.done;
    if (!done && page.scanned === 0 && cursor === undefined) {
      throw new TypeError(
        "refresh-chain retention page made no progress without a cursor",
      );
    }
  }

  return {
    ...totals,
    scanned,
    pages,
    done,
    ...(cursor ? { cursor } : {}),
  };
}

export function emptyRefreshChainPruneResult(): RefreshChainPruneResult {
  return { ...ZERO_COUNTS };
}

export function nextRefreshChainRetentionPhase(
  phase: RefreshChainRetentionPhase,
): RefreshChainRetentionPhase | undefined {
  const index = REFRESH_CHAIN_RETENTION_PHASES.indexOf(phase);
  return REFRESH_CHAIN_RETENTION_PHASES[index + 1];
}

export function isRefreshChainRetentionPhase(
  value: unknown,
): value is RefreshChainRetentionPhase {
  return (
    typeof value === "string" &&
    REFRESH_CHAIN_RETENTION_PHASES.includes(
      value as RefreshChainRetentionPhase,
    )
  );
}

function assertPageResult(
  page: RefreshChainRetentionPageResult,
  limit: number,
): void {
  if (
    !Number.isSafeInteger(page.scanned) ||
    page.scanned < 0 ||
    page.scanned > limit
  ) {
    throw new TypeError(
      `refresh-chain retention page scanned must be an integer between 0 and ${limit}`,
    );
  }
  const deleted = countDeleted(page);
  if (deleted > page.scanned) {
    throw new TypeError(
      "refresh-chain retention page deleted more rows than it scanned",
    );
  }
  if (!page.done && !page.cursor) {
    throw new TypeError(
      "refresh-chain retention page must return a cursor until done",
    );
  }
}

function countDeleted(result: RefreshChainPruneResult): number {
  return (
    result.chainLinks +
    result.chainAccessTokens +
    result.revokedRoots +
    result.consumedCodes +
    result.authCodeTokenLinks +
    result.authorizationCodeRedemptions
  );
}

function addCounts(
  target: {
    chainLinks: number;
    chainAccessTokens: number;
    revokedRoots: number;
    consumedCodes: number;
    authCodeTokenLinks: number;
    authorizationCodeRedemptions: number;
  },
  source: RefreshChainPruneResult,
): void {
  target.chainLinks += source.chainLinks;
  target.chainAccessTokens += source.chainAccessTokens;
  target.revokedRoots += source.revokedRoots;
  target.consumedCodes += source.consumedCodes;
  target.authCodeTokenLinks += source.authCodeTokenLinks;
  target.authorizationCodeRedemptions +=
    source.authorizationCodeRedemptions;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = positiveInteger(value, fallback, label);
  if (resolved > MAX_REFRESH_CHAIN_RETENTION_ROWS) {
    throw new TypeError(
      `${label} must not exceed ${MAX_REFRESH_CHAIN_RETENTION_ROWS}`,
    );
  }
  return resolved;
}

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite timestamp`);
  }
  return value;
}
