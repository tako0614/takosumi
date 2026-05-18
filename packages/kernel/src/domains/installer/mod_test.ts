/**
 * InstallerPipeline lifecycle hook + KernelPlugin integration tests.
 *
 * Verifies that `onInstallStart` / `onDeploymentStart` /
 * `onDeploymentComplete` / `onInstallComplete` fire in the expected order,
 * that `installerProviderRegistryFromPlugins()` resolves
 * `Component.kind` to the plugin whose `provides[]` advertises it, and
 * that hook error semantics match Wave 9 Phase B (start-hook errors
 * abort apply, complete-hook errors are logged + swallowed).
 */
import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract";
import {
  InstallerPipeline,
  type InstallerProviderRegistry,
  installerProviderRegistryFromPlugins,
  type ProviderApplyContext,
  type ProviderApplyResult,
} from "./mod.ts";

const SAMPLE_YAML = `apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: lifecycle-test
  name: Lifecycle Test
components:
  oidc:
    kind: oidc
    redirectPaths:
      - /oidc/callback
  web:
    kind: worker
    use:
      oidc:
        mount: oidc
`;

async function withTempSource<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "takosumi-installer-mod-test-",
  });
  try {
    await Deno.writeTextFile(`${dir}/.takosumi.yml`, SAMPLE_YAML);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function buildRecordingPlugin(
  name: string,
  provides: readonly string[],
  recorder: string[],
): KernelPlugin {
  return {
    name,
    version: "1.0.0",
    provides,
    apply: (ctx) => {
      recorder.push(`apply:${name}:${ctx.componentName}`);
      const outputs: Record<string, string> = ctx.component.kind === "oidc" ||
          ctx.component.kind === "https://takosumi.com/kinds/v1/oidc"
        ? {
          OIDC_CLIENT_ID: `client_${ctx.installationId}`,
        }
        : {};
      return Promise.resolve({
        providerResourceId:
          `${name}://${ctx.installationId}/${ctx.componentName}`,
        outputs,
      });
    },
    onInstallStart: () => {
      recorder.push(`onInstallStart:${name}`);
      return Promise.resolve();
    },
    onInstallComplete: () => {
      recorder.push(`onInstallComplete:${name}`);
      return Promise.resolve();
    },
    onDeploymentStart: () => {
      recorder.push(`onDeploymentStart:${name}`);
      return Promise.resolve();
    },
    onDeploymentComplete: () => {
      recorder.push(`onDeploymentComplete:${name}`);
      return Promise.resolve();
    },
  };
}

Deno.test("installer lifecycle hooks fire onInstallStart -> onDeploymentStart -> apply -> onDeploymentComplete -> onInstallComplete", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const oidcPlugin = buildRecordingPlugin(
      "@example/oidc",
      ["https://takosumi.com/kinds/v1/oidc"],
      events,
    );
    const workerPlugin = buildRecordingPlugin(
      "@example/worker",
      ["https://takosumi.com/kinds/v1/worker"],
      events,
    );
    const pipeline = new InstallerPipeline({
      plugins: [oidcPlugin, workerPlugin],
    });

    const { installation, deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.equal(installation.currentDeploymentId, deployment.id);
    // First-install ordering: install hooks bracket deployment hooks,
    // which bracket the per-component apply calls.
    assert.deepEqual(events, [
      "onInstallStart:@example/oidc",
      "onInstallStart:@example/worker",
      "onDeploymentStart:@example/oidc",
      "onDeploymentStart:@example/worker",
      "apply:@example/oidc:oidc",
      "apply:@example/worker:web",
      "onDeploymentComplete:@example/oidc",
      "onDeploymentComplete:@example/worker",
      "onInstallComplete:@example/oidc",
      "onInstallComplete:@example/worker",
    ]);
  });
});

Deno.test("installer lifecycle hooks fire on subsequent deployments without re-running install hooks", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const oidcPlugin = buildRecordingPlugin(
      "@example/oidc",
      ["https://takosumi.com/kinds/v1/oidc"],
      events,
    );
    const workerPlugin = buildRecordingPlugin(
      "@example/worker",
      ["https://takosumi.com/kinds/v1/worker"],
      events,
    );
    const pipeline = new InstallerPipeline({
      plugins: [oidcPlugin, workerPlugin],
    });

    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    events.length = 0;

    const second = await pipeline.deploymentApply(first.installation.id, {});
    assert.equal(second.deployment.status, "succeeded");
    assert.deepEqual(events, [
      "onDeploymentStart:@example/oidc",
      "onDeploymentStart:@example/worker",
      "apply:@example/oidc:oidc",
      "apply:@example/worker:web",
      "onDeploymentComplete:@example/oidc",
      "onDeploymentComplete:@example/worker",
    ]);
  });
});

Deno.test("installer onInstallStart error aborts apply and surfaces InstallerPipelineError", async () => {
  await withTempSource(async (dir) => {
    const oidc: KernelPlugin = {
      name: "@example/oidc",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/oidc"],
      apply: () => Promise.resolve({ providerResourceId: "x", outputs: {} }),
      onInstallStart: () => Promise.reject(new Error("boom")),
    };
    const worker = buildRecordingPlugin(
      "@example/worker",
      ["https://takosumi.com/kinds/v1/worker"],
      [],
    );
    const pipeline = new InstallerPipeline({ plugins: [oidc, worker] });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /plugin @example\/oidc onInstallStart failed: boom/,
    );
  });
});

Deno.test("installer onDeploymentComplete error is swallowed (post-apply hook is best-effort)", async () => {
  await withTempSource(async (dir) => {
    const oidc: KernelPlugin = {
      name: "@example/oidc",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/oidc"],
      apply: () =>
        Promise.resolve({
          providerResourceId: "oidc://x",
          outputs: { OIDC_CLIENT_ID: "client_x" },
        }),
      onDeploymentComplete: () =>
        Promise.reject(new Error("post-deploy hook failed")),
    };
    const worker: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: () =>
        Promise.resolve({
          providerResourceId: "worker://x",
          outputs: {},
        }),
    };
    const pipeline = new InstallerPipeline({ plugins: [oidc, worker] });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    // Hook failure must not corrupt the persisted Deployment status.
    assert.equal(deployment.status, "succeeded");
  });
});

Deno.test("installerProviderRegistryFromPlugins resolves built-in short name kind via canonical URI", async () => {
  const plugin = buildRecordingPlugin(
    "@example/worker",
    ["https://takosumi.com/kinds/v1/worker"],
    [],
  );
  const registry = installerProviderRegistryFromPlugins([plugin]);

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "web",
    component: { kind: "worker" },
    upstreamOutputs: {},
  });

  assert.equal(result.resource.provider, "@example/worker");
  assert.equal(
    result.resource.providerResourceId,
    "@example/worker://ins_1/web",
  );
});

Deno.test("installerProviderRegistryFromPlugins accepts operator-defined kind URI", async () => {
  const plugin = buildRecordingPlugin(
    "@operator/lambda",
    ["https://operator.example.com/kinds/lambda"],
    [],
  );
  const registry = installerProviderRegistryFromPlugins([plugin]);

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "fn",
    component: { kind: "https://operator.example.com/kinds/lambda" },
    upstreamOutputs: {},
  });

  assert.equal(result.resource.provider, "@operator/lambda");
});

Deno.test("installerProviderRegistryFromPlugins throws when no plugin provides the kind", async () => {
  const registry = installerProviderRegistryFromPlugins([]);

  await assert.rejects(
    registry.apply({
      installationId: "ins_1",
      componentName: "web",
      component: { kind: "worker" },
      upstreamOutputs: {},
    }),
    /no kernel plugin advertises kind worker \(component web\)/,
  );
});

Deno.test("InstallerPipeline falls back to noop provider when no plugins / providers supplied", async () => {
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline();
    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(deployment.status, "succeeded");
    assert.equal(deployment.outputs.resources?.length, 2);
    assert.ok(
      deployment.outputs.resources?.every((r) => r.provider === "noop"),
    );
  });
});

Deno.test("InstallerPipeline lets test code override providers directly without plugins", async () => {
  await withTempSource(async (dir) => {
    const recorded: ProviderApplyContext[] = [];
    const providers: InstallerProviderRegistry = {
      apply(ctx: ProviderApplyContext): Promise<ProviderApplyResult> {
        recorded.push(ctx);
        return Promise.resolve({
          resource: {
            component: ctx.componentName,
            kind: ctx.component.kind,
            provider: "test-direct",
            providerResourceId: `test://${ctx.componentName}`,
          },
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({ providers });
    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(deployment.status, "succeeded");
    assert.equal(recorded.length, 2);
  });
});
