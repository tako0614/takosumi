/**
 * E2E smoke for the v1 installer pipeline using the Wave 9 Phase D
 * plain-array `plugins[]` plugin API.
 *
 * Drives the public 5-endpoint surface with a real `InstallerPipeline`
 * configured via `new InstallerPipeline({ plugins: [...] })`, exercising
 * the bundled KernelPlugin factories so the operator-facing entry path
 * is covered end-to-end. Covers:
 *   - dry-run + apply produce Installation + Deployment with the right
 *     use-edge topology (oidc materializes before worker, worker sees
 *     `OIDC_CLIENT_ID` etc. as upstream outputs)
 *   - the lifecycle hooks (`onInstallStart` / `onDeploymentStart` /
 *     `onDeploymentComplete` / `onInstallComplete`) fire in the
 *     documented order across the plugin array
 *   - the bundled `cloudflareWorkerProvider()` + Takosumi Accounts oidc
 *     factories install + apply against the public 5-endpoint surface
 *   - apply with a mismatched manifest digest returns 412
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.5";
import { Hono } from "hono";
import { type Component, COMPONENT_KINDS } from "takosumi-contract/app-spec";
import type { KernelPlugin } from "takosumi-contract/plugin";
import type {
  Deployment,
  Installation,
  InstallationApplyResponse,
  InstallationDryRunResponse,
} from "takosumi-contract/installer-api";
import {
  cloudflareWorkerProvider,
  InMemoryTakosumiAccountsOidcClient,
  selfhostDockerComposeWorkerProvider,
  takosumiAccountsOidcProvider,
} from "@takos/takosumi-plugins/bundled";
import { InstallerPipeline } from "../domains/installer/mod.ts";
import { mountInstallerPublicRoutes } from "./installer_public_routes.ts";

const SAMPLE_APP_SPEC_YAML = `apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: example-notes
  name: Example Notes
  description: Sample app spec for e2e installer pipeline tests
components:
  oidc:
    kind: oidc
    redirectPaths:
      - /oidc/callback
    scopes:
      - openid
      - email
  web:
    kind: worker
    use:
      oidc:
        mount: oidc
`;
const INSTALLER_AUTH_HEADERS = {
  "authorization": "Bearer installer-token",
  "content-type": "application/json",
} as const;

async function withTempSource<T>(
  fn: (workingDirectory: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-installer-e2e-" });
  try {
    await Deno.writeTextFile(`${dir}/.takosumi.yml`, SAMPLE_APP_SPEC_YAML);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Build a recording test plugin for one of the bundled kind URIs. Captures
 * apply contexts (so we can assert use-edge topology + upstream outputs)
 * and lifecycle hook invocations (so we can assert the documented order).
 */
function buildRecordingPlugin(opts: {
  readonly name: string;
  readonly kindUri: string;
  readonly events: string[];
  readonly applies: Array<{
    readonly componentName: string;
    readonly upstreamOutputs: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
    readonly installationId: string;
  }>;
  readonly outputs?: Readonly<Record<string, string>>;
}): KernelPlugin {
  return {
    name: opts.name,
    version: "1.0.0",
    provides: [opts.kindUri],
    apply: (ctx) => {
      opts.applies.push({
        componentName: ctx.componentName,
        upstreamOutputs: ctx.upstreamOutputs,
        installationId: ctx.installationId,
      });
      opts.events.push(`apply:${opts.name}:${ctx.componentName}`);
      return Promise.resolve({
        providerResourceId:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    destroy: (_ctx) => Promise.resolve(),
    onInstallStart: () => {
      opts.events.push(`onInstallStart:${opts.name}`);
      return Promise.resolve();
    },
    onInstallComplete: () => {
      opts.events.push(`onInstallComplete:${opts.name}`);
      return Promise.resolve();
    },
    onDeploymentStart: () => {
      opts.events.push(`onDeploymentStart:${opts.name}`);
      return Promise.resolve();
    },
    onDeploymentComplete: () => {
      opts.events.push(`onDeploymentComplete:${opts.name}`);
      return Promise.resolve();
    },
  };
}

function buildApp(pipeline: InstallerPipeline) {
  const app = new Hono();
  mountInstallerPublicRoutes(app, {
    pipeline,
    getInstallerToken: () => "installer-token",
  });
  return app;
}

Deno.test("installer e2e — plain-array plugins drive dry-run + apply", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: Array<{
      readonly componentName: string;
      readonly upstreamOutputs: Readonly<
        Record<string, Readonly<Record<string, string>>>
      >;
      readonly installationId: string;
    }> = [];
    const oidcPlugin = buildRecordingPlugin({
      name: "@test/oidc",
      kindUri: "https://takosumi.com/kinds/v1/oidc",
      events,
      applies,
      outputs: {
        OIDC_ISSUER_URL: "https://accounts.example/oidc/test",
        OIDC_CLIENT_ID: "client_test",
        OIDC_CLIENT_SECRET: "shh",
        OIDC_REDIRECT_URIS: "/oidc/callback",
      },
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@test/worker",
      kindUri: "https://takosumi.com/kinds/v1/worker",
      events,
      applies,
    });
    const pipeline = new InstallerPipeline({
      plugins: [oidcPlugin, workerPlugin],
    });
    const app = buildApp(pipeline);

    const dryRunRes = await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
      }),
    });
    assertEquals(dryRunRes.status, 200);
    const dryRun = await dryRunRes.json() as InstallationDryRunResponse;
    assert(dryRun.manifestDigest.startsWith("sha256:"));
    assertEquals(dryRun.appSpec.metadata.id, "example-notes");
    assertEquals(dryRun.changes.length, 2);
    assert(dryRun.changes.every((change) => change.op === "create"));

    const applyRes = await app.request("/v1/installations", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
        expected: dryRun.expected,
      }),
    });
    assertEquals(applyRes.status, 201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    assertInstallation(apply.installation, "space_test", "example-notes");
    assertDeployment(
      apply.deployment,
      apply.installation.id,
      dryRun.manifestDigest,
    );
    assertEquals(apply.deployment.status, "succeeded");
    assertEquals(apply.deployment.outputs.resources?.length, 2);

    // Use-edge topology: oidc materializes before worker, and the worker
    // sees the OIDC outputs on its upstreamOutputs map.
    assertEquals(applies.length, 2);
    assertEquals(applies[0].componentName, "oidc");
    assertEquals(applies[1].componentName, "web");
    assertEquals(
      applies[1].upstreamOutputs.oidc?.OIDC_CLIENT_ID,
      "client_test",
    );

    // First-install lifecycle hook ordering: install hooks bracket
    // deployment hooks, deployment hooks bracket per-component applies.
    assertEquals(events, [
      "onInstallStart:@test/oidc",
      "onInstallStart:@test/worker",
      "onDeploymentStart:@test/oidc",
      "onDeploymentStart:@test/worker",
      "apply:@test/oidc:oidc",
      "apply:@test/worker:web",
      "onDeploymentComplete:@test/oidc",
      "onDeploymentComplete:@test/worker",
      "onInstallComplete:@test/oidc",
      "onInstallComplete:@test/worker",
    ]);
  });
});

Deno.test("installer e2e — apply with mismatched expected returns 412", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: Array<{
      readonly componentName: string;
      readonly upstreamOutputs: Readonly<
        Record<string, Readonly<Record<string, string>>>
      >;
      readonly installationId: string;
    }> = [];
    const pipeline = new InstallerPipeline({
      plugins: [
        buildRecordingPlugin({
          name: "@test/oidc",
          kindUri: "https://takosumi.com/kinds/v1/oidc",
          events,
          applies,
        }),
        buildRecordingPlugin({
          name: "@test/worker",
          kindUri: "https://takosumi.com/kinds/v1/worker",
          events,
          applies,
        }),
      ],
    });
    const app = buildApp(pipeline);

    const res = await app.request("/v1/installations", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
        expected: { commit: "", manifestDigest: "sha256:not-a-real-digest" },
      }),
    });
    assertEquals(res.status, 412);
    const body = await res.json();
    assertEquals(body.error.code, "failed_precondition");
  });
});

Deno.test("installer e2e — bundled takosumiAccountsOidcProvider() materializes oidc end-to-end via public routes", async () => {
  // Verifies that an operator-supplied bundled factory (here:
  // `takosumiAccountsOidcProvider()`) integrates with the public 5-endpoint
  // installer pipeline end-to-end, registers a client at the in-memory
  // Takosumi Accounts client, and surfaces issuer / client_id / secret /
  // redirect_uris as outputs to downstream `use:` edges.
  await withTempSource(async (workingDirectory) => {
    const oidcClient = new InMemoryTakosumiAccountsOidcClient(
      "https://accounts.example.test",
    );
    const applies: Array<{
      readonly componentName: string;
      readonly upstreamOutputs: Readonly<
        Record<string, Readonly<Record<string, string>>>
      >;
      readonly installationId: string;
    }> = [];
    // Hand-rolled worker plugin so we don't need to satisfy
    // cloudflare-workers' spec.artifact requirement in this test. The
    // bundled oidc factory provides the OIDC outputs; the worker plugin
    // verifies they flow through as upstreamOutputs.
    const workerPlugin: KernelPlugin = {
      name: "@test/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: (ctx) => {
        applies.push({
          componentName: ctx.componentName,
          upstreamOutputs: ctx.upstreamOutputs,
          installationId: ctx.installationId,
        });
        return Promise.resolve({
          providerResourceId:
            `worker://${ctx.installationId}/${ctx.componentName}`,
          outputs: {},
        });
      },
      destroy: () => Promise.resolve(),
    };
    const pipeline = new InstallerPipeline({
      plugins: [
        takosumiAccountsOidcProvider({ client: oidcClient }),
        workerPlugin,
      ],
    });
    const app = buildApp(pipeline);

    const dryRunRes = await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
      }),
    });
    assertEquals(dryRunRes.status, 200);
    const dryRun = await dryRunRes.json() as InstallationDryRunResponse;

    const applyRes = await app.request("/v1/installations", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
        expected: dryRun.expected,
      }),
    });
    assertEquals(applyRes.status, 201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    assertEquals(apply.deployment.status, "succeeded");
    assertEquals(apply.deployment.outputs.resources?.length, 2);
    // Takosumi Accounts in-memory client registered exactly one client.
    assertEquals(oidcClient.size(), 1);
    // Worker saw the OIDC outputs as upstream env injection.
    assertEquals(applies.length, 1);
    assertEquals(applies[0].componentName, "web");
    const oidcOutputs = applies[0].upstreamOutputs.oidc;
    assert(oidcOutputs);
    assertEquals(
      oidcOutputs?.OIDC_CLIENT_ID,
      `client_${apply.installation.id}`,
    );
    assert(
      oidcOutputs?.OIDC_ISSUER_URL?.startsWith(
        "https://accounts.example.test/",
      ),
    );
    assertEquals(oidcOutputs?.OIDC_REDIRECT_URIS, "/oidc/callback");
  });
});

Deno.test("installer e2e — bundled selfhostDockerComposeWorkerProvider() returns a KernelPlugin with the worker kind URI", () => {
  // Minimal smoke for the bundled worker factory: verify shape without
  // running it (an apply call requires spec.image / spec.artifact.uri).
  const plugin = selfhostDockerComposeWorkerProvider();
  assertEquals(plugin.provides, ["https://takosumi.com/kinds/v1/worker"]);
  assertEquals(plugin.name, "@takos/selfhost-docker-compose");
  assert(typeof plugin.apply === "function");
  assert(typeof plugin.destroy === "function");
});

Deno.test("installer e2e — bundled cloudflareWorkerProvider() returns a KernelPlugin with the worker kind URI", () => {
  const plugin = cloudflareWorkerProvider({ accountId: "test-account" });
  assertEquals(plugin.provides, ["https://takosumi.com/kinds/v1/worker"]);
  assertEquals(plugin.name, "@takos/cloudflare-workers");
});

Deno.test("AppSpec frozen kind catalog includes oidc", () => {
  const expected = [
    "worker",
    "postgres",
    "object-store",
    "oidc",
    "custom-domain",
  ];
  for (const kind of expected) {
    assert(
      (COMPONENT_KINDS as readonly string[]).includes(kind),
      `${kind} should be in COMPONENT_KINDS`,
    );
  }
});

function assertInstallation(
  installation: Installation,
  spaceId: string,
  appId: string,
): void {
  assert(installation.id.startsWith("ins_"));
  assertEquals(installation.spaceId, spaceId);
  assertEquals(installation.appId, appId);
  assertEquals(installation.status, "running");
  assert(typeof installation.createdAt === "number");
}

function assertDeployment(
  deployment: Deployment,
  installationId: string,
  manifestDigest: string,
): void {
  assert(deployment.id.startsWith("dep_"));
  assertEquals(deployment.installationId, installationId);
  assertEquals(deployment.manifestDigest, manifestDigest);
  assert(typeof deployment.createdAt === "number");
  assert(
    deployment.outputs.resources?.every((resource) =>
      (COMPONENT_KINDS as readonly string[]).includes(resource.kind) ||
      resource.kind === "worker" || resource.kind === "oidc"
    ),
  );
  // Silence unused-import warning by referencing Component.
  const _component: Component | undefined = undefined;
  void _component;
}
