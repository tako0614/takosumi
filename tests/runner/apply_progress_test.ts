/**
 * Apply progress parsed from OpenTofu's own streamed narration. The counter
 * backs the install screen's "creating resources (3 of 7)"; a line it does not
 * recognize must produce no progress rather than a wrong count.
 */
import { expect, test } from "bun:test";

import {
  ApplyProgressTracker,
  beginApplyProgress,
  endApplyProgress,
  readApplyProgress,
} from "../../runner/lib/apply_progress.ts";
import { handleRunnerRequest } from "../../runner/lib/http_server.ts";

function track(output: string): ApplyProgressTracker {
  const tracker = new ApplyProgressTracker();
  tracker.push(output);
  tracker.finish();
  return tracker;
}

test("counts finished resources and the one still in flight", () => {
  const tracker = track(
    [
      "cloudflare_workers_script.app: Creating...",
      "cloudflare_workers_script.app: Creation complete after 3s [id=app]",
      "cloudflare_d1_database.db: Creating...",
      "cloudflare_d1_database.db: Still creating... [10s elapsed]",
      "",
    ].join("\n"),
  );
  expect(tracker.progress()).toEqual({
    completed: 1,
    inFlight: 1,
    currentResource: "cloudflare_d1_database.db",
  });
});

test("modify and destroy narration counts too", () => {
  const tracker = track(
    [
      "cloudflare_record.www: Modifying... [id=rec]",
      "cloudflare_record.www: Modifications complete after 1s [id=rec]",
      "cloudflare_record.old: Destroying... [id=old]",
      "cloudflare_record.old: Destruction complete after 1s",
      "",
    ].join("\n"),
  );
  expect(tracker.progress().completed).toBe(2);
  expect(tracker.progress().inFlight).toBe(0);
});

test("a slow resource re-narrated many times is still ONE resource", () => {
  const lines = ["cloudflare_d1_database.db: Creating..."];
  for (let i = 1; i <= 20; i++) {
    lines.push(`cloudflare_d1_database.db: Still creating... [${i}0s elapsed]`);
  }
  lines.push("cloudflare_d1_database.db: Creation complete after 200s [id=db]");
  const tracker = track(`${lines.join("\n")}\n`);
  // Counting narration lines instead of addresses would report 21 here.
  expect(tracker.progress()).toEqual({
    completed: 1,
    inFlight: 0,
    currentResource: "cloudflare_d1_database.db",
  });
});

test("chunk boundaries mid-line do not lose or duplicate a resource", () => {
  const tracker = new ApplyProgressTracker();
  tracker.push("cloudflare_workers_script.app: Creation compl");
  expect(tracker.progress().completed).toBe(0);
  tracker.push("ete after 3s [id=app]\ncloudflare_d1_database.db: Creat");
  expect(tracker.progress().completed).toBe(1);
  tracker.push("ion complete after 1s [id=db]\n");
  expect(tracker.progress().completed).toBe(2);
});

test("unrecognized output produces no progress rather than a wrong count", () => {
  const tracker = track(
    [
      "Acquiring state lock. This may take a few moments...",
      "Terraform used the selected providers to generate the following execution plan.",
      "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.",
      "",
    ].join("\n"),
  );
  expect(tracker.progress()).toEqual({ completed: 0, inFlight: 0 });
});

test("the progress route reports a tracked run and stays quiet for others", async () => {
  const tracker = beginApplyProgress("run_progress_1");
  tracker.push("cloudflare_workers_script.app: Creation complete after 1s\n");

  const tracked = await handleRunnerRequest(
    new Request("https://runner.test/runs/run_progress_1/progress"),
  );
  expect(tracked.status).toBe(200);
  expect(await tracked.json()).toEqual({
    runId: "run_progress_1",
    progress: {
      completed: 1,
      inFlight: 0,
      currentResource: "cloudflare_workers_script.app",
    },
  });

  const unknown = await handleRunnerRequest(
    new Request("https://runner.test/runs/run_absent/progress"),
  );
  expect(unknown.status).toBe(200);
  expect(await unknown.json()).toEqual({ runId: "run_absent" });

  endApplyProgress("run_progress_1");
  expect(readApplyProgress("run_progress_1")).toBeUndefined();
});
