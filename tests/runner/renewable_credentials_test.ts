import { expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import {
  assertCredentialEnvAvailable,
  commandContextFromRequest,
  prepareProviderCredentialFiles,
  refreshRunCredentials,
} from "../../runner/lib/credentials.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";
import { redactRunnerOutput } from "../../runner/lib/redaction.ts";
import { handleRunnerRequest } from "../../runner/lib/http_server.ts";

const APPLY_RUN_ID = "apply_renewable_test";
const RUNNER_RUN_ID = "plan_renewable_test";
const INITIAL_TOKEN = "initial-token-value-unique";
const NEXT_TOKEN = "rotated-token-value-unique";

test("runner health advertises the exact renewable credential transport capability", async () => {
  const response = await handleRunnerRequest(new Request("http://runner/healthz"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    runner: "opentofu",
    capabilities: ["takosumi.runner-credential-refresh@v1"],
  });
});

test("credential refresh endpoint refuses an update after its run session is terminal", async () => {
  const response = await handleRunnerRequest(new Request(
    `http://runner/runs/${RUNNER_RUN_ID}/credentials`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: { kind: "apply", id: APPLY_RUN_ID },
        runnerRunId: RUNNER_RUN_ID,
        manifestDigest: `sha256:${"a".repeat(64)}`,
        sequence: 1,
        credentials: [{ value: "must-not-echo-token" }],
      }),
    },
  ));
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("must-not-echo-token");
});

function workspace(): RunWorkspace {
  return {
    root: "/tmp/renewable-test-workspace",
    sourceRoot: "/tmp/renewable-test-workspace/source",
    moduleDir: "/tmp/renewable-test-workspace/module",
    planPath: "/tmp/renewable-test-workspace/tfplan",
    providerLockfilePath: "/tmp/renewable-test-workspace/lock.hcl",
    restoredStatePath: "/tmp/renewable-test-workspace/state.json",
    moduleInfoPath: "/tmp/renewable-test-workspace/module.json",
    generatedRootDir: "/tmp/renewable-test-workspace/generated",
    childModuleDir: "/tmp/renewable-test-workspace/child",
    artifactDir: "/tmp/renewable-test-workspace/artifacts",
    depsDir: "/tmp/renewable-test-workspace/deps",
  };
}

test("renewable credentials use a private file and rotate atomically with bounded redaction", async () => {
  const manifest = {
    bindings: [{
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_probe",
      recipeId: "probe",
      authMode: "run-issued",
      envNames: ["PROBE_TOKEN"],
      fileEnvNames: ["PROBE_TOKEN_FILE"],
      requiredEnvGroups: [["PROBE_TOKEN"]],
      renewableEnv: {
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        minimumProviderVersion: "4.1.0",
      },
    }],
  };
  const context = commandContextFromRequest({
    applyRun: { id: APPLY_RUN_ID },
    credentials: {
      env: { PROBE_TOKEN: INITIAL_TOKEN },
      manifest,
      manifestDigest: await stableJsonDigest(manifest),
      renewable: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_probe",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
    },
  }, undefined, undefined, RUNNER_RUN_ID);
  const prepared = await prepareProviderCredentialFiles(
    context,
    workspace(),
    RUNNER_RUN_ID,
  );
  const path = prepared.context.env.PROBE_TOKEN_FILE!;
  try {
    expect(prepared.context.env.PROBE_TOKEN).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(INITIAL_TOKEN);
    const initialStat = await lstat(path);
    expect(initialStat.isFile()).toBe(true);
    expect(initialStat.isSymbolicLink()).toBe(false);
    expect(initialStat.mode & 0o777).toBe(0o600);
    expect(path.startsWith("/tmp/takosumi-run-credentials-")).toBe(true);
    assertCredentialEnvAvailable(["registry.opentofu.org/example/probe"], {}, prepared.context.env, prepared.context.credentialManifest);

    await refreshRunCredentials(RUNNER_RUN_ID, {
      owner: { kind: "apply", id: APPLY_RUN_ID },
      runnerRunId: RUNNER_RUN_ID,
      manifestDigest: context.credentialManifestDigest!,
      sequence: 1,
      credentials: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_probe",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-02-01T00:00:00.000Z",
        value: NEXT_TOKEN,
      }],
    });
    expect(await readFile(path, "utf8")).toBe(NEXT_TOKEN);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(redactRunnerOutput(`provider said ${INITIAL_TOKEN} then ${NEXT_TOKEN}`, prepared.context.redactionValues))
      .not.toContain(INITIAL_TOKEN);
    expect(redactRunnerOutput(`provider said ${INITIAL_TOKEN} then ${NEXT_TOKEN}`, prepared.context.redactionValues))
      .not.toContain(NEXT_TOKEN);

    await expect(refreshRunCredentials(RUNNER_RUN_ID, {
      owner: { kind: "apply", id: APPLY_RUN_ID },
      runnerRunId: RUNNER_RUN_ID,
      manifestDigest: context.credentialManifestDigest!,
      sequence: 2,
      credentials: [
        {
          providerSource: "registry.opentofu.org/example/probe",
          connectionId: "conn_probe",
          sourceEnvName: "PROBE_TOKEN",
          fileEnvName: "PROBE_TOKEN_FILE",
          expiresAt: "2099-03-01T00:00:00.000Z",
          value: "batch-one-token",
        },
        {
          providerSource: "registry.opentofu.org/example/probe",
          connectionId: "conn_probe",
          sourceEnvName: "PROBE_TOKEN",
          fileEnvName: "PROBE_TOKEN_FILE",
          expiresAt: "2099-03-01T00:00:00.000Z",
          value: "batch-two-token",
        },
      ],
    })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(NEXT_TOKEN);

    await expect(refreshRunCredentials(RUNNER_RUN_ID, {
      owner: { kind: "apply", id: APPLY_RUN_ID },
      runnerRunId: RUNNER_RUN_ID,
      manifestDigest: context.credentialManifestDigest!,
      sequence: 3,
      credentials: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_probe",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-03-01T00:00:00.000Z",
        value: "skipped-sequence-token",
      }],
    })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(NEXT_TOKEN);
  } finally {
    await prepared.cleanup();
  }
  await expect(readFile(path, "utf8")).rejects.toThrow();
  await expect(refreshRunCredentials(RUNNER_RUN_ID, {
    owner: { kind: "apply", id: APPLY_RUN_ID },
    runnerRunId: RUNNER_RUN_ID,
    manifestDigest: context.credentialManifestDigest!,
    sequence: 2,
    credentials: [{
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_probe",
      sourceEnvName: "PROBE_TOKEN",
      fileEnvName: "PROBE_TOKEN_FILE",
      expiresAt: "2099-03-01T00:00:00.000Z",
      value: "post-terminal-token",
    }],
  })).rejects.toThrow();
});

test("Plan sessions require the PlanRun owner discriminant", async () => {
  const planRunId = "plan_refresh_owner_test";
  const manifest = {
    bindings: [{
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_plan",
      recipeId: "probe",
      authMode: "run-issued",
      envNames: ["PROBE_TOKEN"],
      fileEnvNames: ["PROBE_TOKEN_FILE"],
      requiredEnvGroups: [["PROBE_TOKEN"]],
      renewableEnv: {
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        minimumProviderVersion: "4.1.0",
      },
    }],
  };
  const context = commandContextFromRequest({
    credentials: {
      env: { PROBE_TOKEN: INITIAL_TOKEN },
      manifest,
      manifestDigest: await stableJsonDigest(manifest),
      renewable: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_plan",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
    },
  }, undefined, undefined, planRunId);
  expect(context.credentialRefreshOwner).toEqual({ kind: "plan", id: planRunId });
  const prepared = await prepareProviderCredentialFiles(context, workspace(), planRunId);
  const filePath = prepared.context.env.PROBE_TOKEN_FILE!;
  try {
    expect(prepared.context.env.PROBE_TOKEN).toBeUndefined();
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    const mismatched = refreshRunCredentials(planRunId, {
      owner: { kind: "apply", id: APPLY_RUN_ID },
      runnerRunId: planRunId,
      manifestDigest: context.credentialManifestDigest!,
      sequence: 1,
      credentials: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_plan",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-02-01T00:00:00.000Z",
        value: NEXT_TOKEN,
      }],
    });
    await expect(mismatched).rejects.toThrow();
    await refreshRunCredentials(planRunId, {
      owner: { kind: "plan", id: planRunId },
      runnerRunId: planRunId,
      manifestDigest: context.credentialManifestDigest!,
      sequence: 1,
      credentials: [{
        providerSource: "registry.opentofu.org/example/probe",
        connectionId: "conn_plan",
        sourceEnvName: "PROBE_TOKEN",
        fileEnvName: "PROBE_TOKEN_FILE",
        expiresAt: "2099-02-01T00:00:00.000Z",
        value: NEXT_TOKEN,
      }],
    });
    expect(await readFile(filePath, "utf8")).toBe(NEXT_TOKEN);
  } finally {
    await prepared.cleanup();
  }
  await expect(refreshRunCredentials(planRunId, {
    owner: { kind: "plan", id: planRunId },
    runnerRunId: planRunId,
    manifestDigest: context.credentialManifestDigest!,
    sequence: 2,
    credentials: [{
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_plan",
      sourceEnvName: "PROBE_TOKEN",
      fileEnvName: "PROBE_TOKEN_FILE",
      expiresAt: "2099-03-01T00:00:00.000Z",
      value: "post-terminal-plan-token",
    }],
  })).rejects.toThrow();
});
