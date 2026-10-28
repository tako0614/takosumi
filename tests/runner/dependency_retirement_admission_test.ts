import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { handleRunnerRequestWithDependencies } from "../../runner/lib/http_server.ts";
import { RUN_ROOT } from "../../runner/lib/constants.ts";

test("container HTTP refuses legacy dependency fields before workspace or credential setup", async () => {
  for (const mutationCustodyMode of ["cloudflare-do", "local-http"] as const) {
    for (const action of ["plan", "apply", "destroy"] as const) {
      for (const payload of [
        { depStates: [] }, { depStates: null }, { depStates: "malformed" },
        { planRun: { id: "old", dependencySnapshotId: "depsnap_old" } },
        { planRun: { id: "old", dependencySnapshotId: null } },
      ]) {
        const runId = `legacy_${action}_${crypto.randomUUID().replaceAll("-", "")}`;
        const response = await handleRunnerRequestWithDependencies(
          new Request(`https://runner/runs/${runId}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, runId, request: payload }),
          }),
          { mutationCustodyMode },
        );
        expect(response.status).toBe(409);
        expect((await response.json() as { errorCode: string }).errorCode).toBe("dependency_retired");
        expect(existsSync(join(RUN_ROOT, runId))).toBe(false);
      }
    }
  }
});
