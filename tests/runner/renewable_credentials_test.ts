import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import {
  assertCredentialEnvAvailable,
  commandContextFromRequest,
  credentialDirPrefixForWorkspace,
  prepareProviderCredentialFiles,
  refreshRunCredentials,
} from "../../runner/lib/credentials.ts";
import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import type {
  CommandContext,
  RenewableCredentialProjection,
  RunWorkspace,
} from "../../runner/lib/types.ts";
import { redactRunnerOutput } from "../../runner/lib/redaction.ts";
import { handleRunnerRequest } from "../../runner/lib/http_server.ts";

const APPLY_RUN_ID = "apply_renewable_test";
const RUNNER_RUN_ID = "plan_renewable_test";
const INITIAL_TOKEN = "initial-token-value-unique";
const NEXT_TOKEN = "rotated-token-value-unique";
const APPLY_TOKEN = "apply-rotated-token-value-unique";

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

test("failed credential-file preparation shreds files written by earlier descriptors", async () => {
  const testWorkspace = {
    ...workspace(),
    root: `/tmp/renewable-partial-preparation-${crypto.randomUUID()}`,
  };
  const ownedPrefix = await credentialDirPrefixForWorkspace(testWorkspace);
  const before = new Set(await readdir("/tmp"));
  const first: RenewableCredentialProjection = {
    providerSource: "registry.opentofu.org/example/probe",
    connectionId: "conn_first",
    sourceEnvName: "FIRST_TOKEN",
    fileEnvName: "FIRST_TOKEN_FILE",
    expiresAt: "2099-01-01T00:00:00.000Z",
    initialValue: "partial-preparation-secret",
  };
  const invalidSecond = {
    providerSource: "registry.opentofu.org/example/probe",
    connectionId: "conn_second",
    sourceEnvName: "SECOND_TOKEN",
    fileEnvName: "SECOND_TOKEN_FILE",
    expiresAt: "2099-01-01T00:00:00.000Z",
    initialValue: undefined,
  } as unknown as RenewableCredentialProjection;
  const manifest = {
    bindings: [first, invalidSecond].map((item) => ({
      providerSource: item.providerSource,
      connectionId: item.connectionId,
      recipeId: "probe",
      authMode: "run-issued",
      envNames: [item.sourceEnvName],
      fileEnvNames: [item.fileEnvName],
      requiredEnvGroups: [[item.sourceEnvName]],
      renewableEnv: {
        sourceEnvName: item.sourceEnvName,
        fileEnvName: item.fileEnvName,
        minimumProviderVersion: "4.1.0",
      },
    })),
  };
  const context: CommandContext = {
    env: {},
    renewableCredentials: [first, invalidSecond],
    credentialManifest: manifest as CommandContext["credentialManifest"],
    credentialRefreshOwner: { kind: "plan", id: "plan_partial_preparation" },
    credentialManifestDigest: await stableJsonDigest(manifest),
  };

  await expect(prepareProviderCredentialFiles(
    context,
    testWorkspace,
    "plan_partial_preparation",
  )).rejects.toThrow(/data|buffer|write/i);

  const after = await readdir("/tmp");
  const leakedDirs = after.filter((name) =>
    name.startsWith(ownedPrefix) && !before.has(name),
  );
  expect(leakedDirs).toEqual([]);
});

test("refresh received during blocked source-build is promoted into the later Plan and Apply files", async () => {
  const planRunId = `plan_pending_refresh_${crypto.randomUUID()}`;
  const runWorkspace = workspaceForRun(planRunId);
  const fakeBinDir = join(runWorkspace.root, "test-bin");
  const originalPath = Bun.env.PATH;
  const sourceRoot = runWorkspace.sourceRoot;
  const manifest = {
    bindings: [{
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "conn_pending",
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
  const manifestDigest = await stableJsonDigest(manifest);
  let sourceBuildEntered!: () => void;
  let applySourceBuildEntered!: () => void;
  let releaseSourceBuild!: () => void;
  let releaseApplySourceBuild!: () => void;
  const buildEntered = new Promise<void>((resolve) => { sourceBuildEntered = resolve; });
  const buildGate = new Promise<void>((resolve) => { releaseSourceBuild = resolve; });
  const applyBuildEntered = new Promise<void>((resolve) => { applySourceBuildEntered = resolve; });
  const applyBuildGate = new Promise<void>((resolve) => { releaseApplySourceBuild = resolve; });
  let sourceBuildCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/wait-for-test-release") {
        return new Response("not found", { status: 404 });
      }
      const invocation = sourceBuildCount++;
      if (invocation === 0) {
        sourceBuildEntered();
        await buildGate;
      } else if (invocation === 1) {
        applySourceBuildEntered();
        await applyBuildGate;
      }
      return new Response("released");
    },
  });
  const markerPath = join(runWorkspace.root, "latest-credential-consumed.txt");
  const fakeTofu = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "init" ]; then exit 0; fi',
    'if [ "$1" = "plan" ]; then',
    '  if [ "${PROBE_TOKEN-}" != "" ] || [ -z "${PROBE_TOKEN_FILE-}" ]; then exit 31; fi',
    `  if [ "$(cat "$PROBE_TOKEN_FILE")" != ${JSON.stringify(NEXT_TOKEN)} ]; then exit 32; fi`,
    `  printf latest > ${JSON.stringify(markerPath)}`,
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = "-out" ]; then shift; printf plan > "$1"; fi',
    '    shift',
    '  done',
    '  exit 0',
    'fi',
    'if [ "$1" = "apply" ]; then',
    '  if [ "${PROBE_TOKEN-}" != "" ] || [ -z "${PROBE_TOKEN_FILE-}" ]; then exit 41; fi',
    `  if [ "$(cat "$PROBE_TOKEN_FILE")" != ${JSON.stringify(APPLY_TOKEN)} ]; then exit 42; fi`,
    `  printf apply-latest > ${JSON.stringify(markerPath)}`,
    '  exit 3',
    'fi',
    'if [ "$1" = "show" ]; then printf "{}"; exit 0; fi',
    'exit 0',
  ].join("\n");
  let runPromise: Promise<Response> | undefined;
  let applyPromise: Promise<Response> | undefined;
  try {
    await mkdir(join(sourceRoot, "module"), { recursive: true });
    await writeFile(join(sourceRoot, "module", "main.tf"), 'output "message" { value = "ok" }\n');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(fakeBinDir, "tofu"), fakeTofu, { mode: 0o755 });
    Bun.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    const requestPayload = {
      planRun: {
        operation: "create",
        source: { kind: "git", url: "https://example.test/repo.git", modulePath: "module" },
      },
      sourceBuild: {
        commands: [{
          argv: [
            process.execPath,
            "-e",
            [
              `if (Bun.env.PROBE_TOKEN !== undefined || Bun.env.PROBE_TOKEN_FILE !== undefined) process.exit(23)`,
              `const response = await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/wait-for-test-release`)})`,
              `if (!response.ok) process.exit(24)`,
              `const { mkdirSync } = await import("node:fs")`,
              `mkdirSync("dist", { recursive: true })`,
              `await Bun.write("dist/source-build-safe.txt", "safe")`,
            ].join(";"),
          ],
        }],
        outputs: ["dist/source-build-safe.txt"],
      },
      generatedRoot: {
        files: {
          "main.tf": 'module "child" { source = "./module" }\n',
        },
      },
      runnerProfile: {
        id: "renewable-test",
        allowedProviders: [],
        requireProviderBindings: false,
        resourceLimits: { maxRunSeconds: 60 },
      },
      credentials: {
        env: { PROBE_TOKEN: INITIAL_TOKEN },
        manifest,
        manifestDigest,
        refreshSequence: 5,
        renewable: [{
          providerSource: "registry.opentofu.org/example/probe",
          connectionId: "conn_pending",
          sourceEnvName: "PROBE_TOKEN",
          fileEnvName: "PROBE_TOKEN_FILE",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }],
      },
    };
    const encodedRequest = JSON.stringify({ action: "plan", runId: planRunId, request: requestPayload });
    runPromise = handleRunnerRequest(new Request(`http://runner/runs/${planRunId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodedRequest,
    }));
    await Promise.race([
      buildEntered,
      runPromise.then(async (response) => {
        const result = await response.clone().json().catch(() => undefined) as unknown;
        throw new Error(`runner ended before sourceBuild gate (status ${response.status}, result ${JSON.stringify(result)})`);
      }),
    ]);
    const ownedPrefix = await credentialDirPrefixForWorkspace(runWorkspace);
    expect((await readdir("/tmp")).filter((name) => name.startsWith(ownedPrefix))).toEqual([]);
    const readiness = await handleRunnerRequest(new Request(
      `http://runner/runs/${planRunId}/credentials`,
      { method: "GET" },
    ));
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({
      owner: { kind: "plan", id: planRunId },
      runnerRunId: planRunId,
      manifestDigest,
      sequence: 5,
    });

    const accepted = await handleRunnerRequest(new Request(
      `http://runner/runs/${planRunId}/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: { kind: "plan", id: planRunId },
          runnerRunId: planRunId,
          manifestDigest,
          sequence: 6,
          credentials: [{
            providerSource: "registry.opentofu.org/example/probe",
            connectionId: "conn_pending",
            sourceEnvName: "PROBE_TOKEN",
            fileEnvName: "PROBE_TOKEN_FILE",
            expiresAt: "2099-02-01T00:00:00.000Z",
            value: NEXT_TOKEN,
          }],
        }),
      },
    ));
    expect(accepted.status).toBe(200);
    expect((await (await handleRunnerRequest(new Request(
      `http://runner/runs/${planRunId}/credentials`, { method: "GET" },
    ))).json()).sequence).toBe(6);
    releaseSourceBuild();
    const runResponse = await runPromise;
    expect(runResponse.status).toBe(200);
    const planResult = await runResponse.json() as { status: string; planDigest?: string };
    expect(planResult.status).toBe("succeeded");
    expect(await readFile(markerPath, "utf8")).toBe("latest");
    const sourceObservation = await readFile(join(sourceRoot, "dist", "source-build-safe.txt"), "utf8");
    expect(sourceObservation).toBe("safe");
    expect((await readdir("/tmp")).filter((name) => name.startsWith(ownedPrefix))).toEqual([]);

    const applyRequestPayload = {
      ...requestPayload,
      applyRun: { id: APPLY_RUN_ID },
      planArtifact: { kind: "runner-local", digest: planResult.planDigest },
      credentials: {
        env: { PROBE_TOKEN: NEXT_TOKEN },
        manifest,
        manifestDigest,
        refreshSequence: 0,
        renewable: [{
          providerSource: "registry.opentofu.org/example/probe",
          connectionId: "conn_pending",
          sourceEnvName: "PROBE_TOKEN",
          fileEnvName: "PROBE_TOKEN_FILE",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }],
      },
    };
    applyPromise = handleRunnerRequest(new Request(`http://runner/runs/${planRunId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply", runId: planRunId, request: applyRequestPayload }),
    }));
    await Promise.race([
      applyBuildEntered,
      applyPromise.then(async (response) => {
        const result = await response.clone().json().catch(() => undefined) as unknown;
        throw new Error(`runner ended before Apply sourceBuild gate (status ${response.status}, result ${JSON.stringify(result)})`);
      }),
    ]);
    const applyReadiness = await handleRunnerRequest(new Request(
      `http://runner/runs/${planRunId}/credentials`,
      { method: "GET" },
    ));
    expect(await applyReadiness.json()).toEqual({
      owner: { kind: "apply", id: APPLY_RUN_ID },
      runnerRunId: planRunId,
      manifestDigest,
      sequence: 0,
    });
    const applyRefresh = await handleRunnerRequest(new Request(
      `http://runner/runs/${planRunId}/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: { kind: "apply", id: APPLY_RUN_ID },
          runnerRunId: planRunId,
          manifestDigest,
          sequence: 1,
          credentials: [{
            providerSource: "registry.opentofu.org/example/probe",
            connectionId: "conn_pending",
            sourceEnvName: "PROBE_TOKEN",
            fileEnvName: "PROBE_TOKEN_FILE",
            expiresAt: "2099-02-01T00:00:00.000Z",
            value: APPLY_TOKEN,
          }],
        }),
      },
    ));
    expect(applyRefresh.status).toBe(200);
    releaseApplySourceBuild();
    const applyResponse = await applyPromise;
    expect(applyResponse.status).toBe(500);
    expect((await applyResponse.json()).status).toBe("failed");
    expect(await readFile(markerPath, "utf8")).toBe("apply-latest");
    expect((await readdir("/tmp")).filter((name) => name.startsWith(ownedPrefix))).toEqual([]);
  } finally {
    releaseSourceBuild();
    releaseApplySourceBuild();
    await runPromise?.catch(() => {});
    await applyPromise?.catch(() => {});
    server.stop(true);
    Bun.env.PATH = originalPath ?? "";
    const ownedPrefix = await credentialDirPrefixForWorkspace(runWorkspace);
    const ownedDirs = (await readdir("/tmp")).filter((name) => name.startsWith(ownedPrefix));
    await Promise.all(ownedDirs.map((name) => rm(join("/tmp", name), { recursive: true, force: true })));
    await rm(runWorkspace.root, { recursive: true, force: true });
    await rm(runWorkspace.depsDir, { recursive: true, force: true });
  }
}, 120_000);
