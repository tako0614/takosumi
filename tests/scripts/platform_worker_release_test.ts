import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertConfigTargetsSource,
  bindingNames,
  parsePlatformWorkerReleaseArgs,
  parseServingVersion,
  platformTargetForEnvironment,
  selectRecoveredVersion,
} from "../../scripts/platform-worker-release.ts";

const root = resolve(import.meta.dir, "../..");

test("platform release owns isolated staging and production targets", () => {
  expect(platformTargetForEnvironment("staging")).toEqual({
    origin: "https://app-staging.takosumi.com",
    workerName: "takosumi-staging",
    hostedService: "takosumi-hosted-staging",
  });
  expect(platformTargetForEnvironment("production")).toEqual({
    origin: "https://app.takosumi.com",
    workerName: "takosumi",
    hostedService: "takosumi-hosted",
  });
});

test("production config must bind the isolated production Hosted service", () => {
  const source = (
    service: string,
    main = resolve(root, "deploy/platform/takoserver_hosted_worker.ts"),
    includeBroker = true,
  ) => `
name = "takosumi"
main = "${main}"
[assets]
directory = "${resolve(root, "dashboard/dist")}"
[[services]]
binding = "HOSTED"
service = "${service}"
[vars]
TAKOSUMI_ENVIRONMENT = "production"
TAKOSUMI_PLATFORM_EXTENSIONS = '${JSON.stringify([{
    id: "takosumi-hosted-sponsorship",
    basePath: "/v1/hosted/subscription",
    handlerKey: "HOSTED",
    authDelivery: "context",
    ownsPathSubtree: true,
    workspaceContext: "query-required",
    requiredScopes: [],
    capabilities: ["takosumi.hosted.subscription.v1"],
    ...(includeBroker ? {
      runCredential: {
        audience: "takosumi-hosted.takoserver.takoform.v1",
        requiredScopes: ["takoform.run"],
      },
      providerCredentialBroker: {
        connectionId: "conn_takoserver_takoform_v1",
        recipeId: "takoserver-takoform-run-v1",
        providerSource: "registry.terraform.io/tako0614/takoform",
        displayName: "Takoserver",
        exchangePath: "/provider-credentials/takoform",
        envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      },
    } : {}),
  }])}'
`;
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted"),
      "/private/wrangler.toml",
      "production",
    ),
  ).not.toThrow();
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted-staging"),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        resolve(root, "deploy/platform/worker.ts"),
      ),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        resolve(root, "deploy/platform/takoserver_hosted_worker.ts"),
        false,
      ),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
});

test("platform release parser exposes only reviewed plan and execute actions", () => {
  expect(
    parsePlatformWorkerReleaseArgs([
      "plan",
      "--config",
      "/private/wrangler.staging.toml",
      "--plan-out",
      "/private/plan.json",
    ]),
  ).toEqual({
    action: "plan",
    config: "/private/wrangler.staging.toml",
    planOut: "/private/plan.json",
  });
  expect(() =>
    parsePlatformWorkerReleaseArgs([
      "execute",
      "--plan",
      "/private/plan.json",
      "--confirm",
      "sha256:sentinel",
      "--review",
      "operator:reviewer",
      "--evidence",
      "/private/evidence.json",
      "--unknown",
      "sentinel",
    ]),
  ).toThrow("platform_worker_release_arguments_invalid");
  expect(
    parsePlatformWorkerReleaseArgs([
      "recover",
      "--plan",
      "/private/plan.json",
      "--confirm",
      "sha256:confirmation",
      "--review",
      "operator:reviewer",
      "--evidence",
      "/private/recovered.json",
    ]),
  ).toEqual({
    action: "recover",
    plan: "/private/plan.json",
    confirmation: "sha256:confirmation",
    reviewer: "operator:reviewer",
    evidence: "/private/recovered.json",
  });
});

test("platform release selects exactly one 100 percent serving Version", () => {
  expect(
    parseServingVersion(
      JSON.stringify({
        deployments: [
          {
            versions: [
              {
                version_id: "11111111-1111-4111-8111-111111111111",
                percentage: 100,
              },
            ],
          },
        ],
      }),
    ),
  ).toBe("11111111-1111-4111-8111-111111111111");
  expect(() =>
    parseServingVersion(
      JSON.stringify([
        { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
        { version_id: "22222222-2222-4222-8222-222222222222", percentage: 50 },
      ]),
    ),
  ).toThrow("platform_worker_release_serving_version_invalid");
});

test("lost acknowledgement recovery selects one post-plan Version and exact bindings", () => {
  expect(
    selectRecoveredVersion(
      JSON.stringify([
        {
          id: "11111111-1111-4111-8111-111111111111",
          metadata: { created_on: "2026-08-18T16:00:00Z" },
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          metadata: { created_on: "2026-08-18T16:30:00Z" },
        },
      ]),
      "2026-08-18T16:29:00Z",
    ),
  ).toBe("22222222-2222-4222-8222-222222222222");
  expect(
    bindingNames(
      JSON.stringify({
        resources: [
          { name: "ASSETS" },
          { binding: "HOSTED" },
        ],
      }),
    ),
  ).toEqual(["ASSETS", "HOSTED"]);
});
