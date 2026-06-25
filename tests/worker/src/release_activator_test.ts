import { expect, test } from "bun:test";
import type { ReleaseActivationInput } from "../../../core/domains/deploy-control/mod.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
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
        kind: "takos.cloudflare.worker",
        launchUrl: "https://app.example.test",
        metadata: { route: "app.example.test/*" },
      });
    },
  });

  const result = await activator.activate(fakeActivationInput());

  expect(result).toEqual({
    status: "succeeded",
    kind: "takos.cloudflare.worker",
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
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
      worker_script_name: "site-worker",
    },
    commands: [
      {
        id: "migrate",
        phase: "post_apply",
        command: ["bun", "run", "takos:migrate"],
      },
    ],
  });
  expect(payload).not.toHaveProperty("planRun");
  expect(payload).not.toHaveProperty("applyRun");
});

test("webhook release activator treats 204 as succeeded", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => new Response(null, { status: 204 }),
  });

  await expect(activator.activate(fakeActivationInput())).resolves.toEqual({
    status: "succeeded",
  });
});

test("webhook release activator fails closed on non-2xx responses", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => Response.json({ error: "denied" }, { status: 403 }),
  });

  await expect(activator.activate(fakeActivationInput())).rejects.toThrow(
    "release activator request failed: 403",
  );
});

test("webhook release activator validates response status", async () => {
  const activator = createWebhookReleaseActivator({
    url: "https://materializer.example.test/activate",
    token: "release-token",
    fetcher: async () => Response.json({ status: "activated" }),
  });

  await expect(activator.activate(fakeActivationInput())).rejects.toThrow(
    "release activator response status is invalid",
  );
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

  await expect(localActivator.activate(fakeActivationInput())).resolves.toEqual(
    {
      status: "pending",
      message: "queued",
    },
  );
  expect(capturedRequest?.url).toBe("http://materializer.localhost/activate");
});

function fakeActivationInput(): ReleaseActivationInput {
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
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
      worker_script_name: "site-worker",
    },
    commands: [
      {
        id: "migrate",
        phase: "post_apply",
        command: ["bun", "run", "takos:migrate"],
      },
    ],
  } as unknown as ReleaseActivationInput;
}
