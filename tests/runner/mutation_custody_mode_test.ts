import { expect, test } from "bun:test";
import { handleRunnerRequestWithDependencies } from "../../runner/entrypoint.ts";

const health = () => new Request("http://runner/healthz");
const reservation = () => new Request("http://runner/runs/apply_fixture/mutation-reservation", {
  method: "PUT",
  headers: { "content-type": "application/json", "x-takosumi-mutation-custody-mode": "local-http" },
  body: JSON.stringify({ action: "apply", runId: "apply_fixture", request: { applyRun: { id: "apply_fixture" } } }),
});

test("runner defaults to DO authority and a caller cannot select local custody", async () => {
  const old = Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE;
  delete Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE;
  try {
    expect((await (await handleRunnerRequestWithDependencies(health())).json()).mutationCustodyMode).toBe("cloudflare-do");
    expect((await handleRunnerRequestWithDependencies(reservation())).status).toBe(404);
    expect((await handleRunnerRequestWithDependencies(new Request("http://runner/runs/apply_fixture/completion"))).status).toBe(404);
  } finally {
    if (old === undefined) delete Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE;
    else Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE = old;
  }
});

test("operator-selected local custody rejects tokenless mutation and invalid configuration", async () => {
  expect((await (await handleRunnerRequestWithDependencies(health(), { mutationCustodyMode: "local-http" })).json()).mutationCustodyMode).toBe("local-http");
  for (const action of ["apply", "destroy"]) {
    const rejected = await handleRunnerRequestWithDependencies(new Request("http://runner/runs/apply_fixture", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", action, runId: "apply_fixture", request: { applyRun: { id: "apply_fixture" } } }),
    }), { mutationCustodyMode: "local-http" });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).errorCode).toBe("runner_mutation_indeterminate");
  }
  const old = Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE;
  Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE = "typo";
  try {
    const refused = await handleRunnerRequestWithDependencies(health());
    expect(refused.status).toBe(503);
    expect((await refused.json()).errorCode).toBe("runner_mutation_custody_mode_invalid");
  } finally {
    if (old === undefined) delete Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE;
    else Bun.env.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE = old;
  }
});
