import { expect, test } from "bun:test";
import type { ReleaseActivationInput } from "../../../core/domains/deploy-control/mod.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  createCompositeReleaseActivator,
  createRunnerReleaseActivator,
  createWebhookReleaseActivator,
  releaseActivatorFromEnv,
} from "../../../worker/src/release_activator.ts";

test("webhook release activator posts minimal non-secret apply evidence", async () => {
  let capturedRequest: Request | undefined;
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json({
        status: "succeeded",
        kind: "operator.release",
        launchUrl: "https://app.example.test",
        metadata: { route: "app.example.test/*" },
      });
    },
  });

  const result = await activator.activate(fakeOperatorActivationInput());

  expect(result).toEqual({
    status: "succeeded",
    kind: "operator.release",
    launchUrl: "https://app.example.test",
    metadata: { route: "app.example.test/*" },
  });
  expect(capturedRequest?.method).toBe("POST");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer release-token",
  );
  expect(capturedRequest?.headers.get("content-type")).toBe("application/json");

  const payload = (await capturedRequest!.json()) as Record<string, unknown>;
  expect(payload).toMatchObject({
    kind: "takosumi.operator.release-activation@v1",
    planRunId: "run_plan_1",
    applyRunId: "run_apply_1",
    spaceId: "space_1",
    installation: {
      id: "inst_1",
      name: "site",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    },
    deployment: {
      id: "dep_1",
      sourceSnapshotId: "snap_1",
      stateGeneration: 3,
      outputSnapshotId: "out_1",
      status: "active",
    },
    outputSnapshot: {
      id: "out_1",
      stateGeneration: 3,
      outputDigest: "sha256:outputs",
    },
    sourceSnapshot: {
      id: "snap_1",
      origin: "git",
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`,
      resolvedCommit: "abc123",
      path: ".",
    },
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
      worker_script_name: "site-worker",
    },
    commands: [
      {
        id: "activate",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "app:activate"],
      },
    ],
  });
  expect(payload).not.toHaveProperty("planRun");
  expect(payload).not.toHaveProperty("applyRun");
});

test("runner release activator runs opaque post-apply commands", async () => {
  let capturedJob:
    | Parameters<
        NonNullable<
          Parameters<typeof createRunnerReleaseActivator>[0]["release"]
        >
      >[0]
    | undefined;
  const activator = createRunnerReleaseActivator({
    release: async (job) => {
      capturedJob = job;
      return {
        status: "succeeded",
        runId: job.runId,
        commandCount: job.commands.length,
      };
    },
  });

  expect(activator).toBeDefined();
  const result = await activator!.activate(fakeRunnerActivationInput());

  expect(result).toEqual({
    status: "succeeded",
    kind: "takosumi.release-commands@v1",
    message: "ran 1 post-apply release command(s)",
    metadata: {
      releaseRunId: "release_run_apply_1",
      commandCount: 1,
    },
  });
  expect(capturedJob).toMatchObject({
    runId: "release_run_apply_1",
    applyRunId: "run_apply_1",
    installationId: "inst_1",
    deploymentId: "dep_1",
    sourceSnapshot: {
      id: "snap_1",
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    },
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
      worker_script_name: "site-worker",
    },
    commands: [
      {
        id: "activate",
        phase: "post_apply",
        command: ["bun", "run", "app:activate"],
      },
    ],
  });
});

test("webhook release activator leaves runner commands pending without posting", async () => {
  let called = false;
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => {
      called = true;
      return Response.json({ status: "succeeded" });
    },
  });

  const result = await activator.activate(fakeRunnerActivationInput());

  expect(called).toBe(false);
  expect(result).toEqual({
    status: "pending",
    kind: "takosumi.operator.release-activation@v1",
    message:
      "operator release activator only accepts executor=operator commands",
    metadata: {
      commandCount: 1,
      runnerCommandCount: 1,
    },
  });
});

test("composite release activator routes runner and operator commands by executor", async () => {
  let capturedRunnerJob:
    | Parameters<
        NonNullable<
          Parameters<typeof createRunnerReleaseActivator>[0]["release"]
        >
      >[0]
    | undefined;
  let capturedWebhookPayload: Record<string, unknown> | undefined;
  const runner = createRunnerReleaseActivator({
    release: async (job) => {
      capturedRunnerJob = job;
      return {
        status: "succeeded",
        runId: job.runId,
        commandCount: job.commands.length,
      };
    },
  });
  const operator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      capturedWebhookPayload = (await request.json()) as Record<
        string,
        unknown
      >;
      return Response.json({ status: "succeeded", kind: "operator.release" });
    },
  });
  const activator = createCompositeReleaseActivator({ runner, operator });

  const result = await activator!.activate(
    fakeActivationInput([
      {
        id: "runner-activate",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "app:activate"],
      },
      {
        id: "operator-publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "publish"],
      },
    ]),
  );

  expect(result).toEqual({
    status: "succeeded",
    kind: "takosumi.release-activation.composite@v1",
    message: "ran 1 post-apply release command(s)",
    metadata: {
      runnerCommandCount: 1,
      operatorCommandCount: 1,
      runnerStatus: "succeeded",
      operatorStatus: "succeeded",
    },
  });
  expect(capturedRunnerJob?.commands).toEqual([
    {
      id: "runner-activate",
      phase: "post_apply",
      executor: "runner",
      command: ["bun", "run", "app:activate"],
    },
  ]);
  expect(capturedWebhookPayload?.commands).toEqual([
    {
      id: "operator-publish",
      phase: "post_apply",
      executor: "operator",
      command: ["bun", "run", "publish"],
    },
  ]);
});

test("runner release activator leaves commands pending without source archive", async () => {
  let called = false;
  const activator = createRunnerReleaseActivator({
    release: async () => {
      called = true;
      throw new Error("runner should not be called");
    },
  });

  const result = await activator!.activate({
    ...fakeRunnerActivationInput(),
    sourceSnapshot: undefined,
  });

  expect(called).toBe(false);
  expect(result).toEqual({
    status: "pending",
    kind: "takosumi.release-commands@v1",
    message: "post-apply release commands require a source snapshot archive",
  });
});

test("runner release activator leaves operator commands pending", async () => {
  let called = false;
  const activator = createRunnerReleaseActivator({
    release: async () => {
      called = true;
      throw new Error("runner should not be called");
    },
  });

  const result = await activator!.activate({
    ...fakeActivationInput(),
    commands: [
      {
        id: "publish-worker",
        phase: "post_apply",
        command: ["bunx", "wrangler", "deploy"],
        executor: "operator",
      },
    ],
  });

  expect(called).toBe(false);
  expect(result).toEqual({
    status: "pending",
    kind: "takosumi.operator.release-activation@v1",
    message:
      "post-apply release commands require an operator release activator",
    metadata: {
      commandCount: 1,
      operatorCommandCount: 1,
    },
  });
});

test("webhook release activator treats 204 as succeeded", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => new Response(null, { status: 204 }),
  });

  await expect(
    activator.activate(fakeOperatorActivationInput()),
  ).resolves.toEqual({
    status: "succeeded",
  });
});

test("webhook release activator fails closed on non-2xx responses", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => Response.json({ error: "denied" }, { status: 403 }),
  });

  await expect(
    activator.activate(fakeOperatorActivationInput()),
  ).rejects.toThrow(
    'release activator request failed: 403: {"error":"denied"}',
  );
});

test("webhook release activator validates response status", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => Response.json({ status: "activated" }),
  });

  await expect(
    activator.activate(fakeOperatorActivationInput()),
  ).rejects.toThrow("release activator response status is invalid");
});

test("releaseActivatorFromEnv is disabled without a URL", () => {
  expect(
    releaseActivatorFromEnv({} as CloudflareWorkerEnv, {}),
  ).toBeUndefined();
});

test("releaseActivatorFromEnv requires a secret token when URL is set", () => {
  expect(() =>
    releaseActivatorFromEnv(
      {
        TAKOSUMI_RELEASE_ACTIVATOR_URL:
          "https://materializer.example.test/activate",
      } as CloudflareWorkerEnv,
      {},
    ),
  ).toThrow(
    "TAKOSUMI_RELEASE_ACTIVATOR_TOKEN is required when TAKOSUMI_RELEASE_ACTIVATOR_URL is set",
  );
});

test("releaseActivatorFromEnv requires https outside local dev", () => {
  expect(() =>
    releaseActivatorFromEnv(
      {
        TAKOSUMI_RELEASE_ACTIVATOR_URL:
          "http://materializer.localhost/activate",
        TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "release-token",
      } as CloudflareWorkerEnv,
      {},
    ),
  ).toThrow("release activator URL must use https");
});

test("releaseActivatorFromEnv allows http only in explicit local dev", async () => {
  let capturedRequest: Request | undefined;
  const activator = releaseActivatorFromEnv(
    {
      TAKOSUMI_RELEASE_ACTIVATOR_URL: "http://materializer.localhost/activate",
      TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "release-token",
    } as CloudflareWorkerEnv,
    { TAKOSUMI_DEV_MODE: "1" },
  );
  expect(activator).toBeDefined();

  const localActivator = createWebhookReleaseActivator({
    url: "http://materializer.localhost/activate",
    token: "release-token",
    allowInsecure: true,
    fetcher: async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json({ status: "pending", message: "queued" });
    },
  });

  await expect(
    localActivator.activate(fakeOperatorActivationInput()),
  ).resolves.toEqual({
    status: "pending",
    message: "queued",
  });
  expect(capturedRequest?.url).toBe("http://materializer.localhost/activate");
});

function fakeRunnerActivationInput(): ReleaseActivationInput {
  return fakeActivationInput([
    {
      id: "activate",
      phase: "post_apply",
      command: ["bun", "run", "app:activate"],
    },
  ]);
}

function fakeOperatorActivationInput(): ReleaseActivationInput {
  return fakeActivationInput([
    {
      id: "activate",
      phase: "post_apply",
      executor: "operator",
      command: ["bun", "run", "app:activate"],
    },
  ]);
}

function fakeActivationInput(
  commands: ReleaseActivationInput["commands"],
): ReleaseActivationInput {
  return {
    planRun: { id: "run_plan_1" },
    applyRun: { id: "run_apply_1", spaceId: "space_1" },
    installation: {
      id: "inst_1",
      name: "site",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    },
    deployment: {
      id: "dep_1",
      sourceSnapshotId: "snap_1",
      stateGeneration: 3,
      outputSnapshotId: "out_1",
      status: "active",
    },
    outputSnapshot: {
      id: "out_1",
      stateGeneration: 3,
      outputDigest: "sha256:outputs",
    },
    sourceSnapshot: {
      id: "snap_1",
      origin: "git",
      spaceId: "space_1",
      sourceId: "src_1",
      url: "https://github.com/acme/site.git",
      ref: "main",
      resolvedCommit: "abc123",
      path: ".",
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`,
      archiveSizeBytes: 128,
      fetchedByRunId: "source_sync_1",
      fetchedAt: "2026-06-07T00:00:00.000Z",
    },
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
      worker_script_name: "site-worker",
    },
    commands,
  } as unknown as ReleaseActivationInput;
}
