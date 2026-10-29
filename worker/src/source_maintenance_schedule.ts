import type { D1Database } from "./bindings.ts";

const MAINTENANCE_WORKSPACE_ID = "__source_maintenance__";
const MAINTENANCE_TARGET_TYPE = "source_maintenance";
const SOURCE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const SOURCE_RETIREMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SOURCE_POLL_CRONS = new Set(["0 * * * *", "5 * * * *"]);
const SOURCE_RETIREMENT_CRON = "15 3 * * *";
const SOURCE_MAINTENANCE_CRON = "*/5 * * * *";

/**
 * Atomically claim one scheduled Source-maintenance job using an append-only
 * Activity row as its durable start marker. A start at exactly the interval
 * boundary is expired and can be claimed again.
 */
export async function claimSourceMaintenanceSchedule(
  db: D1Database,
  job: "polling" | "retirement",
  now: string,
  intervalMs: number,
): Promise<boolean> {
  if (job !== "polling" && job !== "retirement") {
    throw new TypeError("invalid source maintenance job");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("source maintenance interval must be a positive integer");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("source maintenance timestamp is invalid");
  const createdAt = new Date(nowMs).toISOString();
  const cutoffMs = nowMs - intervalMs;
  if (!Number.isFinite(cutoffMs) || Math.abs(cutoffMs) > 8_640_000_000_000_000) {
    throw new TypeError("source maintenance interval is outside the timestamp range");
  }
  const cutoff = new Date(cutoffMs).toISOString();
  const action = job === "polling"
    ? "scheduled.source_poll.started"
    : "scheduled.source_retirement.started";
  const id = `act_${crypto.randomUUID().replaceAll("-", "")}`;
  const event = {
    id,
    workspaceId: MAINTENANCE_WORKSPACE_ID,
    action,
    targetType: MAINTENANCE_TARGET_TYPE,
    targetId: job,
    metadata: { intervalMs },
    createdAt,
  };
  const result = await db.prepare(`
    insert into audit_events
      (id, space_id, actor_id, action, target_type, target_id, run_id, record_json, created_at)
    select ?, ?, null, ?, ?, ?, null, ?, ?
    where not exists (
      select 1 from audit_events
      where space_id = ? and action = ? and target_type = ? and target_id = ?
        and created_at > ?
    )
  `).bind(
    id,
    MAINTENANCE_WORKSPACE_ID,
    action,
    MAINTENANCE_TARGET_TYPE,
    job,
    JSON.stringify(event),
    createdAt,
    MAINTENANCE_WORKSPACE_ID,
    action,
    MAINTENANCE_TARGET_TYPE,
    job,
    cutoff,
  ).run();
  return result.meta?.changes === 1;
}

/** Dispatches only Source jobs assigned to this exact maintenance cron. */
export async function runSourceMaintenanceSchedule(input: {
  readonly db: D1Database;
  readonly cron: unknown;
  readonly retirementEnabled?: boolean;
  readonly now?: string;
  readonly poll: () => Promise<void>;
  readonly sweep: () => Promise<void>;
}): Promise<void> {
  const jobs: ("polling" | "retirement")[] = input.cron === SOURCE_MAINTENANCE_CRON
    ? ["polling", "retirement"]
    : SOURCE_POLL_CRONS.has(input.cron as string)
      ? ["polling"]
      : input.cron === SOURCE_RETIREMENT_CRON ? ["retirement"] : [];
  const enabledJobs = jobs.filter((job) => job !== "retirement" || input.retirementEnabled !== false);
  if (enabledJobs.length === 0) return;

  const now = input.now ?? new Date().toISOString();
  const failures: unknown[] = [];
  const claims = await Promise.allSettled(enabledJobs.map((job) =>
    claimSourceMaintenanceSchedule(input.db, job, now,
      job === "polling" ? SOURCE_POLL_INTERVAL_MS : SOURCE_RETIREMENT_INTERVAL_MS)));
  const dueJobs: ("polling" | "retirement")[] = [];
  claims.forEach((claim, index) => {
    if (claim.status === "rejected") failures.push(claim.reason);
    else if (claim.value) dueJobs.push(enabledJobs[index]!);
  });

  const runs = await Promise.allSettled(dueJobs.map((job) =>
    job === "polling" ? input.poll() : input.sweep()));
  for (const run of runs) if (run.status === "rejected") failures.push(run.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "source maintenance scheduled jobs failed");
  }
}
