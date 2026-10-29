import { expect, spyOn, test } from "bun:test";
import worker from "../../../deploy/platform/worker.ts";

for (const withContext of [false, true]) test(`a Source start-marker failure leaves later scheduled owners reachable (context=${withContext})`, async () => {
  let markerAttempts = 0;
  let laterOwnerReached = false;
  const pending: Promise<unknown>[] = [];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, {
      TAKOSUMI_CONTROL_DB: {
        prepare(sql: string) {
          if (sql.includes("insert into audit_events")) markerAttempts++;
          throw new Error("local marker storage unavailable");
        },
      },
      get TAKOSUMI_AUTO_PLAN_STALE_CAPSULES() {
        laterOwnerReached = true;
        return "0";
      },
    } as never, withContext ? { waitUntil: (task) => { pending.push(task); } } : undefined);
    await Promise.all(pending);
    expect(markerAttempts).toBe(2);
    expect(laterOwnerReached).toBe(true);
    expect(warn.mock.calls.some(([message]) =>
      typeof message === "string" && message.includes('"event":"source_maintenance_schedule_failed"'))).toBe(true);
  } finally {
    warn.mockRestore();
  }
});
