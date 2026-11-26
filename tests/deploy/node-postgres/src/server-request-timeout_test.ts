import { expect, mock, test } from "bun:test";
import { GIT_INSTALL_PLAN_RECONCILE_LEASE_MS } from "../../../../core/domains/install-plans/store.ts";
import { setReconcileRequestTimeout } from "../../../../deploy/node-postgres/src/server.ts";

test("the Bun request timeout follows the coordinator lease on Git reconcile POSTs", () => {
  const timeout = mock<(request: Request, seconds: number) => void>();
  const install = new Request("http://localhost/api/v1/install-plans/gip_example/reconcile", { method: "POST" });
  const revision = new Request("http://localhost/api/v1/revision-plans/grp_example/reconcile", { method: "POST" });
  const seconds = Math.ceil(GIT_INSTALL_PLAN_RECONCILE_LEASE_MS / 1_000);
  for (const request of [install, revision]) setReconcileRequestTimeout(request, { timeout });
  expect(timeout.mock.calls).toEqual([[install, seconds], [revision, seconds]]);
});

test("other Bun requests keep the default timeout", () => {
  const timeout = mock<(request: Request, seconds: number) => void>();
  for (const [method, path] of [
    ["GET", "/api/v1/revision-plans/grp_example/reconcile"],
    ["POST", "/api/v1/revision-plans//reconcile"],
    ["POST", "/api/v1/revision-plans/grp_example/reconcile/extra"],
    ["POST", "/api/v1/runs/plan_example/apply"],
    ["GET", "/healthz"],
  ]) {
    setReconcileRequestTimeout(new Request(`http://localhost${path}`, { method }), { timeout });
  }
  expect(timeout).not.toHaveBeenCalled();
});
