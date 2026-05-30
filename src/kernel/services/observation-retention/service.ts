import type { SqlClient, SqlQueryResult } from "../../adapters/storage/sql.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

/**
 * ObservationRetentionService — daily GC for `provider_observations` and
 * `runtime_provider_observations` so the kernel does not accumulate
 * unbounded drift-detection history.
 *
 * Phase 17A introduced unbounded retention for provider observations; that
 * grew the table linearly with deploys and put disk pressure on the control
 * plane database. The Phase 18.3 retention policy is:
 *
 *   - Recent observations (within `recentRetentionDays`, default 30d) stay
 *     in the live table for fast drift queries.
 *   - Older observations are flagged `archived = true` so dashboards can
 *     filter them out without losing audit history.
 *   - Archived observations are deleted once they cross the
 *     `archiveCapDays` cap (default 90d) — at that point an operator is
 *     expected to have exported the cold-line copy elsewhere.
 *   - Observations belonging to the **most recent** deployment per group
 *     are exempt from archival even if they are older than
 *     `recentRetentionDays`. This guarantees that drift queries against
 *     the current head always see the latest provider snapshot.
 */
export interface ObservationRetentionPolicy {
  readonly recentRetentionDays: number;
  readonly archiveCapDays: number;
}

export const DEFAULT_OBSERVATION_RETENTION_POLICY: ObservationRetentionPolicy =
  Object.freeze({
    recentRetentionDays: 30,
    archiveCapDays: 90,
  });

export interface ObservationRetentionRunReport {
  readonly archivedDeploy: number;
  readonly archivedRuntime: number;
  readonly deletedDeploy: number;
  readonly deletedRuntime: number;
  readonly executedAt: IsoTimestamp;
}

export interface ObservationRetentionServiceOptions {
  readonly client: SqlClient;
  readonly clock?: () => Date;
  readonly policy?: Partial<ObservationRetentionPolicy>;
}

export class ObservationRetentionService {
  readonly #client: SqlClient;
  readonly #clock: () => Date;
  readonly #policy: ObservationRetentionPolicy;

  constructor(options: ObservationRetentionServiceOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#policy = {
      ...DEFAULT_OBSERVATION_RETENTION_POLICY,
      ...options.policy,
    };
    if (this.#policy.recentRetentionDays <= 0) {
      throw new Error("recentRetentionDays must be positive");
    }
    if (this.#policy.archiveCapDays <= this.#policy.recentRetentionDays) {
      throw new Error(
        "archiveCapDays must be greater than recentRetentionDays",
      );
    }
  }

  policy(): ObservationRetentionPolicy {
    return { ...this.#policy };
  }

  /**
   * Run a single retention pass. Idempotent — repeated calls within a
   * window perform no work because all matching rows have already been
   * archived/deleted.
   */
  async run(): Promise<ObservationRetentionRunReport> {
    const now = this.#clock();
    const archiveCutoff = isoDaysAgo(now, this.#policy.recentRetentionDays);
    const deleteCutoff = isoDaysAgo(now, this.#policy.archiveCapDays);

    const archivedDeploy = await this.#archiveDeployObservations(archiveCutoff);
    const archivedRuntime = await this.#archiveRuntimeObservations(
      archiveCutoff,
    );
    const deletedDeploy = await this.#deleteDeployObservations(deleteCutoff);
    const deletedRuntime = await this.#deleteRuntimeObservations(deleteCutoff);

    return {
      archivedDeploy,
      archivedRuntime,
      deletedDeploy,
      deletedRuntime,
      executedAt: now.toISOString(),
    };
  }

  async #archiveDeployObservations(cutoff: IsoTimestamp): Promise<number> {
    // Mark observations older than the recent-retention cutoff as archived,
    // EXCEPT those that belong to the current deployment of any group.
    // The current deployment is the one referenced by `group_heads`.
    const result = await safeQuery(
      this.#client,
      `update provider_observations
          set archived = true
        where archived = false
          and observed_at < :cutoff
          and deployment_id not in (
            select current_deployment_id from group_heads
            where current_deployment_id is not null
          )`,
      { cutoff },
    );
    return result.rowCount;
  }

  async #archiveRuntimeObservations(cutoff: IsoTimestamp): Promise<number> {
    const result = await safeQuery(
      this.#client,
      `update runtime_provider_observations
          set archived = true
        where archived = false
          and observed_at < :cutoff`,
      { cutoff },
    );
    return result.rowCount;
  }

  async #deleteDeployObservations(cutoff: IsoTimestamp): Promise<number> {
    const result = await safeQuery(
      this.#client,
      `delete from provider_observations
        where archived = true and observed_at < :cutoff`,
      { cutoff },
    );
    return result.rowCount;
  }

  async #deleteRuntimeObservations(cutoff: IsoTimestamp): Promise<number> {
    const result = await safeQuery(
      this.#client,
      `delete from runtime_provider_observations
        where archived = true and observed_at < :cutoff`,
      { cutoff },
    );
    return result.rowCount;
  }
}

/**
 * Cron-style runner. Wraps `ObservationRetentionService.run` with
 * `setInterval` so the kernel boot path can schedule daily GC without
 * dragging in a third-party scheduler. `start` returns a `stop` callback
 * for graceful shutdown / tests.
 *
 * `intervalMs` defaults to 24h. The first run executes immediately on
 * `start` so an operator can observe progress without waiting a full day.
 */
export interface ObservationRetentionJobOptions {
  readonly service: ObservationRetentionService;
  readonly intervalMs?: number;
  readonly onReport?: (report: ObservationRetentionRunReport) => void;
  readonly onError?: (error: Error) => void;
}

export interface ObservationRetentionJobHandle {
  readonly stop: () => Promise<void>;
}

const DAY_MS = 86_400_000;

export function startObservationRetentionJob(
  options: ObservationRetentionJobOptions,
): ObservationRetentionJobHandle {
  const intervalMs = options.intervalMs ?? DAY_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive finite number");
  }
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();

  const tick = () => {
    if (stopped) return;
    pending = (async () => {
      try {
        const report = await options.service.run();
        options.onReport?.(report);
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
  };
  tick();
  const handle = setInterval(tick, intervalMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(handle);
      await pending;
    },
  };
}

function isoDaysAgo(now: Date, days: number): IsoTimestamp {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * Wrap `client.query` so missing tables (e.g. on a fresh test DB without
 * the runtime_provider_observations migration) do not bring the GC job
 * down. The job is best-effort: a missing table simply contributes 0
 * rows to the report.
 */
async function safeQuery(
  client: SqlClient,
  sql: string,
  params?: Record<string, unknown>,
): Promise<SqlQueryResult> {
  try {
    return await client.query(sql, params as Record<string, never>);
  } catch (error) {
    if (isMissingRelation(error) || isMissingColumn(error)) {
      return { rows: [], rowCount: 0 };
    }
    throw error;
  }
}

function isMissingRelation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code === "42P01") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /(does not exist|no such (table|relation))/i.test(message);
}

function isMissingColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code === "42703") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /(no such column|column .* does not exist)/i.test(message);
}
