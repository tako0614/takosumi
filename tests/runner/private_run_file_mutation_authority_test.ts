import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local mutation preparation ignores only reminted private Run file grants before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-run-mutation-"));
  const runRoot = join(root, "runs");
  await mkdir(runRoot);
  // The runner freezes its run root when it first loads, for every later test
  // in this process; consumers use the runner's RUN_ROOT. Restore the variable.
  const previousRunRoot = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT;
  Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT = runRoot;
  const {
    reserveLocalMutationPreparation,
    consumeLocalMutationPreparation,
    claimLocalMutation,
  } = await import("../../runner/lib/run_completion.ts");
  const runId = `apply_${crypto.randomUUID().replaceAll("-", "")}`;
  const attemptId = crypto.randomUUID();
  const baseRequest = {
    applyRun: { id: runId },
    capsule: { id: "cap-one", environment: "preview" },
    privateRunFiles: [{
      slot: "worker-state",
      endpoint: "https://core.example/internal/private-run-files/v1",
      grant: "signed-grant-one",
    }],
  };
  const rotatedGrantRequest = {
    ...baseRequest,
    privateRunFiles: [{ ...baseRequest.privateRunFiles[0]!, grant: "signed-grant-two" }],
  };

  try {
    const firstEpoch = await reserveLocalMutationPreparation(
      runId,
      "apply",
      baseRequest,
      attemptId,
    );
    expect(firstEpoch).toBe(1);
    expect(await reserveLocalMutationPreparation(
      runId,
      "apply",
      rotatedGrantRequest,
      attemptId,
    )).toBe(firstEpoch);

    expect(await reserveLocalMutationPreparation(
      runId,
      "apply",
      {
        ...rotatedGrantRequest,
        privateRunFiles: [{ ...rotatedGrantRequest.privateRunFiles[0]!, slot: "other-slot" }],
      },
      attemptId,
    )).toBeUndefined();
    expect(await reserveLocalMutationPreparation(
      runId,
      "apply",
      {
        ...rotatedGrantRequest,
        privateRunFiles: [{
          ...rotatedGrantRequest.privateRunFiles[0]!,
          endpoint: "https://other.example/private-run-files/v1",
        }],
      },
      attemptId,
    )).toBeUndefined();
    expect(await reserveLocalMutationPreparation(
      runId,
      "apply",
      { ...rotatedGrantRequest, capsule: { id: "cap-two", environment: "preview" } },
      attemptId,
    )).toBeUndefined();

    expect(await consumeLocalMutationPreparation(
      runId,
      "apply",
      rotatedGrantRequest,
      undefined,
      attemptId,
      String(firstEpoch),
    )).toBe(true);
    expect(await reserveLocalMutationPreparation(
      runId,
      "apply",
      { ...rotatedGrantRequest, privateRunFiles: [{ ...rotatedGrantRequest.privateRunFiles[0]!, grant: "signed-grant-three" }] },
      crypto.randomUUID(),
    )).toBeUndefined();
    expect(await claimLocalMutation(
      runId,
      "apply",
      rotatedGrantRequest,
    )).toMatchObject({ status: "indeterminate" });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousRunRoot === undefined) delete Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT;
    else Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT = previousRunRoot;
  }
});
