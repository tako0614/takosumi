/**
 * E2E smoke for the v1 installer pipeline.
 *
 * Drives the public 5-endpoint surface with an in-memory pipeline + a
 * local source containing a real `.takosumi.yml`. Covers dry-run + apply +
 * a 412 mismatch on the manifestDigest pin.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.5";
import { Hono } from "hono";
import {
  type Component,
  COMPONENT_KINDS,
} from "takosumi-contract/app-spec";
import type {
  Deployment,
  Installation,
  InstallationApplyResponse,
  InstallationDryRunResponse,
} from "takosumi-contract/installer-api";
import {
  InstallerPipeline,
  type InstallerProviderRegistry,
  type ProviderApplyContext,
  type ProviderApplyResult,
} from "../domains/installer/mod.ts";
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

class RecordingProviderRegistry implements InstallerProviderRegistry {
  readonly calls: ProviderApplyContext[] = [];

  apply(context: ProviderApplyContext): Promise<ProviderApplyResult> {
    this.calls.push(context);
    const outputs: Record<string, string> = context.component.kind === "oidc"
      ? {
        OIDC_ISSUER_URL:
          `https://accounts.example/oidc/${context.installationId}`,
        OIDC_CLIENT_ID: `client_${context.installationId}`,
        OIDC_CLIENT_SECRET: "shh",
        OIDC_REDIRECT_URIS: "/oidc/callback",
      }
      : {};
    return Promise.resolve({
      resource: {
        component: context.componentName,
        kind: context.component.kind,
        provider: "test",
        providerResourceId:
          `test://${context.installationId}/${context.componentName}`,
      },
      outputs,
    });
  }
}

function buildApp(pipeline: InstallerPipeline) {
  const app = new Hono();
  mountInstallerPublicRoutes(app, { pipeline });
  return app;
}

Deno.test("installer e2e — dry-run + apply produce Installation + Deployment", async () => {
  await withTempSource(async (workingDirectory) => {
    const providers = new RecordingProviderRegistry();
    const pipeline = new InstallerPipeline({ providers });
    const app = buildApp(pipeline);

    const dryRunRes = await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
        expected: dryRun.expected,
      }),
    });
    assertEquals(applyRes.status, 201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    assertInstallation(apply.installation, "space_test", "example-notes");
    assertDeployment(apply.deployment, apply.installation.id, dryRun.manifestDigest);
    assertEquals(apply.deployment.status, "succeeded");
    assertEquals(apply.deployment.outputs.resources?.length, 2);

    // Provider apply order respects use-edge topology: oidc before worker.
    assertEquals(providers.calls.length, 2);
    assertEquals(providers.calls[0].componentName, "oidc");
    assertEquals(providers.calls[1].componentName, "web");
    assertEquals(
      providers.calls[1].upstreamOutputs.oidc?.OIDC_CLIENT_ID,
      `client_${apply.installation.id}`,
    );
  });
});

Deno.test("installer e2e — apply with mismatched expected returns 412", async () => {
  await withTempSource(async (workingDirectory) => {
    const pipeline = new InstallerPipeline({
      providers: new RecordingProviderRegistry(),
    });
    const app = buildApp(pipeline);

    const res = await app.request("/v1/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
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

Deno.test("AppSpec frozen kind catalog includes oidc", () => {
  const expected = ["worker", "postgres", "object-store", "oidc", "custom-domain"];
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
