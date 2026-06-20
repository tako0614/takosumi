import { describe, expect, test } from "bun:test";

import {
  changeCountsForRun,
  changesFromLogs,
} from "../../../../dashboard/src/lib/run-logs.ts";
import type { Run } from "../../../../dashboard/src/lib/control-api.ts";

const BASE_RUN: Run = {
  id: "plan_1",
  spaceId: "space_1",
  type: "plan",
  status: "succeeded",
  createdBy: "system",
  createdAt: "2026-06-20T00:00:00.000Z",
};

describe("run log change extraction", () => {
  test("changeCountsForRun prefers the public plan summary over audit-log details", () => {
    expect(
      changeCountsForRun(
        { ...BASE_RUN, summary: { add: 22, change: 0, destroy: 0 } },
        [],
      ),
    ).toEqual({ create: 22, update: 0, delete: 0 });
  });

  test("changeCountsForRun falls back to audit-log resource changes", () => {
    const events = [
      {
        id: "evt_1",
        type: "plan.completed",
        at: 1,
        data: {
          resourceChanges: [
            { action: "create", address: "cloudflare_r2_bucket.files" },
            { action: "update", address: "cloudflare_workers_script.app" },
            { action: ["delete", "create"], address: "cloudflare_queue.jobs" },
          ],
        },
      },
    ];

    expect(changesFromLogs(events)).toEqual([
      { action: "create", label: "cloudflare_r2_bucket.files" },
      { action: "update", label: "cloudflare_workers_script.app" },
      { action: "delete", label: "cloudflare_queue.jobs" },
    ]);
    expect(changeCountsForRun(BASE_RUN, events)).toEqual({
      create: 1,
      update: 1,
      delete: 1,
    });
  });
});
