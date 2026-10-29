import { expect, test } from "bun:test";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { claimSourceMaintenanceSchedule, runSourceMaintenanceSchedule } from "../../../worker/src/source_maintenance_schedule.ts";

const HOUR = 60 * 60 * 1000;

async function database(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  return db;
}

test("source maintenance schedule appends honest start Activity rows per job", async () => {
  const db = await database();
  const now = "2026-10-28T12:00:00.000Z";

  expect(await claimSourceMaintenanceSchedule(db, "polling", now, HOUR)).toBe(true);
  expect(await claimSourceMaintenanceSchedule(db, "polling", now, HOUR)).toBe(false);
  expect(await claimSourceMaintenanceSchedule(db, "retirement", now, 24 * HOUR)).toBe(true);

  const events = await db.prepare(`
    select id, space_id, actor_id, action, target_type, target_id, run_id, record_json, created_at
    from audit_events order by target_id
  `).all<{
    id: string;
    space_id: string;
    actor_id: string | null;
    action: string;
    target_type: string;
    target_id: string;
    run_id: string | null;
    record_json: string;
    created_at: string;
  }>();
  const rows = events.results ?? [];
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: expect.stringMatching(/^act_[0-9a-f]{32}$/u),
      space_id: "__source_maintenance__",
      actor_id: null,
      action: "scheduled.source_poll.started",
      target_type: "source_maintenance",
      target_id: "polling",
      run_id: null,
      created_at: now,
    }),
    expect.objectContaining({
      space_id: "__source_maintenance__",
      action: "scheduled.source_retirement.started",
      target_type: "source_maintenance",
      target_id: "retirement",
      created_at: now,
    }),
  ]));
  const event = JSON.parse(rows[0]!.record_json) as Record<string, unknown>;
  expect(event).toMatchObject({ workspaceId: "__source_maintenance__", createdAt: now });
});

test("source maintenance claim is fresh until the exact interval boundary", async () => {
  const db = await database();
  const startedAt = "2026-10-28T11:00:00.000Z";
  const freshAt = "2026-10-28T11:59:59.999Z";
  const expiredAt = "2026-10-28T12:00:00.000Z";

  expect(await claimSourceMaintenanceSchedule(db, "polling", startedAt, HOUR)).toBe(true);
  expect(await claimSourceMaintenanceSchedule(db, "polling", freshAt, HOUR)).toBe(false);
  expect(await claimSourceMaintenanceSchedule(db, "polling", expiredAt, HOUR)).toBe(true);
});

test("overlapping source maintenance ticks allow only one fresh claim per job", async () => {
  const db = await database();
  const now = "2026-10-28T12:00:00.000Z";

  const claims = await Promise.all(Array.from({ length: 16 }, () =>
    claimSourceMaintenanceSchedule(db, "retirement", now, 24 * HOUR)));
  expect(claims.filter(Boolean)).toHaveLength(1);

  const rows = await db.prepare(`
    select count(*) as count from audit_events
    where space_id = '__source_maintenance__' and target_type = 'source_maintenance'
      and target_id = 'retirement'
  `).first<{ count: number }>();
  expect(rows?.count).toBe(1);
});

test("source maintenance schedule validates interval and timestamp", async () => {
  const db = await database();
  await expect(claimSourceMaintenanceSchedule(db, "polling", "not-a-time", HOUR))
    .rejects.toThrow("timestamp is invalid");
  await expect(claimSourceMaintenanceSchedule(db, "polling", "2026-10-28T12:00:00.000Z", 0))
    .rejects.toThrow("positive integer");
});

test("five-minute and dedicated crons share persistent claims without duplicate work", async () => {
  const db = await database();
  const now = "2026-10-28T12:00:00.000Z";
  let polls = 0;
  let sweeps = 0;
  const run = (cron: string) => runSourceMaintenanceSchedule({
    db,
    cron,
    now,
    poll: async () => { polls++; },
    sweep: async () => { sweeps++; },
  });

  await run("*/5 * * * *");
  await run("0 * * * *");
  await run("15 3 * * *");
  await run("*/5 * * * *");

  expect({ polls, sweeps }).toEqual({ polls: 1, sweeps: 1 });
  const rows = await db.prepare(`
    select target_id, count(*) as count from audit_events
    where space_id = '__source_maintenance__' and target_type = 'source_maintenance'
    group by target_id order by target_id
  `).all<{ target_id: string; count: number }>();
  expect(rows.results).toEqual([
    { target_id: "polling", count: 1 },
    { target_id: "retirement", count: 1 },
  ]);
});

test("dedicated Source crons run only at their interval and release again at the boundary", async () => {
  const db = await database();
  let polls = 0;
  let sweeps = 0;
  const run = (cron: string, now: string) => runSourceMaintenanceSchedule({
    db,
    cron,
    now,
    poll: async () => { polls++; },
    sweep: async () => { sweeps++; },
  });

  await run("5 * * * *", "2026-10-28T00:00:00.000Z");
  await run("0 * * * *", "2026-10-28T00:05:00.000Z");
  await run("15 3 * * *", "2026-10-28T00:00:00.000Z");
  await run("15 3 * * *", "2026-10-28T00:05:00.000Z");
  expect({ polls, sweeps }).toEqual({ polls: 1, sweeps: 1 });

  await run("0 * * * *", "2026-10-28T01:00:00.000Z");
  await run("15 3 * * *", "2026-10-29T00:00:00.000Z");
  expect({ polls, sweeps }).toEqual({ polls: 2, sweeps: 2 });
});

test("disabled retirement and unrelated crons do not create retirement markers", async () => {
  const db = await database();
  let polls = 0;
  let sweeps = 0;
  const run = (cron: string, retirementEnabled?: boolean) => runSourceMaintenanceSchedule({
    db,
    cron,
    retirementEnabled,
    now: "2026-10-28T12:00:00.000Z",
    poll: async () => { polls++; },
    sweep: async () => { sweeps++; },
  });

  await run("*/5 * * * *", false);
  await run("15 3 * * *", false);
  await run("1 * * * *");
  expect({ polls, sweeps }).toEqual({ polls: 1, sweeps: 0 });
  const rows = await db.prepare(`
    select target_id from audit_events
    where space_id = '__source_maintenance__' and target_type = 'source_maintenance'
  `).all<{ target_id: string }>();
  expect(rows.results).toEqual([{ target_id: "polling" }]);
});

test("a failed poll does not prevent an independently claimed retirement sweep", async () => {
  const db = await database();
  let sweeps = 0;
  await expect(runSourceMaintenanceSchedule({
    db,
    cron: "*/5 * * * *",
    now: "2026-10-28T12:00:00.000Z",
    poll: async () => { throw new Error("poll failed"); },
    sweep: async () => { sweeps++; },
  })).rejects.toThrow("source maintenance scheduled jobs failed");
  expect(sweeps).toBe(1);
});
