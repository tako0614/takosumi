/**
 * InstallerPipeline lifecycle hook + KernelPlugin integration tests.
 *
 * Phase C rewrite: the legacy `use:` edges and `upstreamOutputs` placeholder
 * have been replaced by the namespace pub/sub model. Each Component
 * publishes to (a) the auto-namespace `<app-id>.<component-name>` and any
 * explicit `publish:` paths, and (b) listens to declared namespace paths
 * via `Component.listen[<path>]`. The installer pipeline drives the
 * `KernelPlugin.publishMaterial` / `applyListen` hooks and exposes the
 * resolved materials to plugin.apply via `listenedMaterials`.
 */
import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract";
import type {
  ApplyListenContext,
  EnvInjection,
  NamespaceMaterial,
  PublishMaterialContext,
} from "takosumi-contract/plugin";
import {
  InstallerPipeline,
  type InstallerProviderRegistry,
  installerProviderRegistryFromPlugins,
  type ProviderApplyContext,
  type ProviderApplyResult,
} from "./mod.ts";

// Canonical AppSpec for the pub/sub flow: a `postgres` component publishes
// connection material at `lifecycle-test.db`; a `worker` component listens
// on the same path with `as: env` + `prefix: DB` so the kernel auto-
// resolves env injections like `DB_HOST`, `DB_PORT`, ...
const SAMPLE_YAML = `apiVersion: takosumi.dev/v1
kind: App
metadata:
  id: lifecycle-test
  name: Lifecycle Test
components:
  db:
    kind: postgres
  web:
    kind: worker
    listen:
      lifecycle-test.db:
        as: env
        prefix: DB
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

function buildRecordingPlugin(opts: {
  readonly name: string;
  readonly provides: readonly string[];
  readonly recorder: string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly captureApply?: (ctx: {
    readonly componentName: string;
    readonly listenedMaterials: Readonly<Record<string, NamespaceMaterial>>;
  }) => void;
  readonly publishMaterial?: (
    ctx: PublishMaterialContext,
  ) => Promise<NamespaceMaterial>;
  readonly applyListen?: (
    ctx: ApplyListenContext,
  ) => Promise<EnvInjection>;
}): KernelPlugin {
  return {
    name: opts.name,
    version: "1.0.0",
    provides: opts.provides,
    apply: (ctx) => {
      opts.recorder.push(`apply:${opts.name}:${ctx.componentName}`);
      opts.captureApply?.({
        componentName: ctx.componentName,
        listenedMaterials: ctx.listenedMaterials,
      });
      return Promise.resolve({
        providerResourceId:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    publishMaterial: opts.publishMaterial,
    applyListen: opts.applyListen,
    onInstallStart: () => {
      opts.recorder.push(`onInstallStart:${opts.name}`);
      return Promise.resolve();
    },
    onInstallComplete: () => {
      opts.recorder.push(`onInstallComplete:${opts.name}`);
      return Promise.resolve();
    },
    onDeploymentStart: () => {
      opts.recorder.push(`onDeploymentStart:${opts.name}`);
      return Promise.resolve();
    },
    onDeploymentComplete: () => {
      opts.recorder.push(`onDeploymentComplete:${opts.name}`);
      return Promise.resolve();
    },
  };
}

Deno.test("installer lifecycle hooks fire onInstallStart -> onDeploymentStart -> apply -> onDeploymentComplete -> onInstallComplete", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const dbPlugin = buildRecordingPlugin({
      name: "@example/postgres",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      recorder: events,
      outputs: {
        host: "db.local",
        port: "5432",
        database: "app",
        username: "app",
      },
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: events,
    });
    const pipeline = new InstallerPipeline({
      plugins: [dbPlugin, workerPlugin],
    });

    const { installation, deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.equal(installation.currentDeploymentId, deployment.id);
    // First-install ordering: install hooks bracket deployment hooks,
    // which bracket the per-component apply calls. Topological order
    // (publisher before listener) is db → web.
    assert.deepEqual(events, [
      "onInstallStart:@example/postgres",
      "onInstallStart:@example/worker",
      "onDeploymentStart:@example/postgres",
      "onDeploymentStart:@example/worker",
      "apply:@example/postgres:db",
      "apply:@example/worker:web",
      "onDeploymentComplete:@example/postgres",
      "onDeploymentComplete:@example/worker",
      "onInstallComplete:@example/postgres",
      "onInstallComplete:@example/worker",
    ]);
  });
});

Deno.test("installer lifecycle hooks fire on subsequent deployments without re-running install hooks", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const dbPlugin = buildRecordingPlugin({
      name: "@example/postgres",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      recorder: events,
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: events,
    });
    const pipeline = new InstallerPipeline({
      plugins: [dbPlugin, workerPlugin],
    });

    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    events.length = 0;

    const second = await pipeline.deploymentApply(first.installation.id, {});
    assert.equal(second.deployment.status, "succeeded");
    assert.deepEqual(events, [
      "onDeploymentStart:@example/postgres",
      "onDeploymentStart:@example/worker",
      "apply:@example/postgres:db",
      "apply:@example/worker:web",
      "onDeploymentComplete:@example/postgres",
      "onDeploymentComplete:@example/worker",
    ]);
  });
});

Deno.test("installer onInstallStart error aborts apply and surfaces InstallerPipelineError", async () => {
  await withTempSource(async (dir) => {
    const db: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () => Promise.resolve({ providerResourceId: "x", outputs: {} }),
      onInstallStart: () => Promise.reject(new Error("boom")),
    };
    const worker = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
    });
    const pipeline = new InstallerPipeline({ plugins: [db, worker] });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /plugin @example\/postgres onInstallStart failed: boom/,
    );
  });
});

Deno.test("installer onDeploymentComplete error is swallowed (post-apply hook is best-effort)", async () => {
  await withTempSource(async (dir) => {
    const db: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () =>
        Promise.resolve({
          providerResourceId: "postgres://x",
          outputs: { host: "db.local", port: "5432" },
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
    const pipeline = new InstallerPipeline({ plugins: [db, worker] });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    // Hook failure must not corrupt the persisted Deployment status.
    assert.equal(deployment.status, "succeeded");
  });
});

Deno.test("installerProviderRegistryFromPlugins resolves built-in short name kind via canonical URI", async () => {
  const plugin = buildRecordingPlugin({
    name: "@example/worker",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    recorder: [],
  });
  const registry = installerProviderRegistryFromPlugins([plugin]);

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "web",
    component: { kind: "worker" },
    listenedMaterials: {},
    resolvedBindings: [],
  });

  assert.equal(result.resource.provider, "@example/worker");
  assert.equal(
    result.resource.providerResourceId,
    "@example/worker://ins_1/web",
  );
});

Deno.test("installerProviderRegistryFromPlugins accepts operator-defined kind URI", async () => {
  const plugin = buildRecordingPlugin({
    name: "@operator/lambda",
    provides: ["https://operator.example.com/kinds/lambda"],
    recorder: [],
  });
  const registry = installerProviderRegistryFromPlugins([plugin]);

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "fn",
    component: { kind: "https://operator.example.com/kinds/lambda" },
    listenedMaterials: {},
    resolvedBindings: [],
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
      listenedMaterials: {},
      resolvedBindings: [],
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
