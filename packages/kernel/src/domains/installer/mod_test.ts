/**
 * InstallerPipeline lifecycle hook + KernelPlugin integration tests.
 *
 * Phase C rewrite: the legacy `use:` edges and `upstreamOutputs` placeholder
 * have been replaced by local publications and listen bindings. Each
 * component publishes declared `publish.<name>` materials and listens via
 * `listen.<binding>.from`. The installer pipeline drives the
 * `KernelPlugin.publishMaterial` / `applyListen` hooks and exposes the
 * resolved materials to plugin.apply via `listenedMaterials`.
 */
import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract/reference/compat";
import type {
  ApplyListenContext,
  EnvInjection,
  NamespaceMaterial,
  PublishMaterialContext,
} from "takosumi-contract/reference/plugin";
import {
  InstallerPipeline,
  type InstallerProviderRegistry,
  installerProviderRegistryFromPlugins,
  type ProviderApplyContext,
  type ProviderApplyResult,
} from "./mod.ts";
import { InMemoryDeploymentStore } from "./store.ts";

// Canonical AppSpec: a `postgres` component publishes `db.connection`; a
// `worker` component listens to it with `as: env` + `prefix: DB` so the
// kernel resolves env injections like `DB_HOST`, `DB_PORT`, ...
const SAMPLE_YAML = `apiVersion: v1
metadata:
  id: lifecycle-test
  name: Lifecycle Test
components:
  db:
    kind: postgres
    publish:
      connection:
        as: service-binding
  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
`;

const TEST_KIND_ALIASES = {
  postgres: "https://takosumi.com/kinds/v1/postgres",
  worker: "https://takosumi.com/kinds/v1/worker",
} as const;

async function withTempSource<T>(
  fn: (dir: string) => Promise<T>,
  yaml = SAMPLE_YAML,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "takosumi-installer-mod-test-",
  });
  try {
    await Deno.writeTextFile(`${dir}/.takosumi.yml`, yaml);
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
        resourceHandle:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    publishMaterial: opts.publishMaterial ??
      ((ctx) => Promise.resolve(ctx.outputs as NamespaceMaterial)),
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
      kindAliases: TEST_KIND_ALIASES,
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
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
    });

    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    events.length = 0;

    const second = await pipeline.deploymentApply(first.installation.id, {
      source: { kind: "local", url: dir },
    });
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

Deno.test("InstallerPipeline resolves required external publications through operator resolver", async () => {
  const spec = `apiVersion: v1
metadata:
  id: external-listen-test
  name: External Listen Test
components:
  web:
    kind: worker
    listen:
      oidc:
        from: operator.identity.oidc
        as: secret-env
        prefix: OIDC
        required: true
`;
  await withTempSource(async (dir) => {
    const seen: Array<Readonly<Record<string, NamespaceMaterial>>> = [];
    const resolverCalls: string[] = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => seen.push(ctx.listenedMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      externalPublications: {
        resolve: (ctx) => {
          resolverCalls.push(
            `${ctx.spaceId}:${ctx.appId}:${ctx.componentName}:${ctx.bindingName}:${ctx.sourceRef}`,
          );
          if (ctx.sourceRef !== "operator.identity.oidc") return undefined;
          return {
            issuerUrl: "https://accounts.example.test",
            clientId: "client_test",
            clientSecretRef: { secretRef: "secret://oidc/client-secret" },
          };
        },
      },
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(resolverCalls, [
      "space_test:external-listen-test:web:oidc:operator.identity.oidc",
    ]);
    assert.deepEqual(seen, [{
      oidc: {
        issuerUrl: "https://accounts.example.test",
        clientId: "client_test",
        clientSecretRef: { secretRef: "secret://oidc/client-secret" },
      },
    }]);
  }, spec);
});

Deno.test("InstallerPipeline rejects missing required external publication", async () => {
  const spec = `apiVersion: v1
metadata:
  id: missing-external-listen-test
  name: Missing External Listen Test
components:
  web:
    kind: worker
    listen:
      oidc:
        from: operator.identity.oidc
        as: secret-env
        required: true
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/worker",
          provides: ["https://takosumi.com/kinds/v1/worker"],
          recorder: [],
        }),
      ],
      externalPublications: { resolve: () => undefined },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /unresolved publication "operator.identity.oidc"/,
    );
  }, spec);
});

Deno.test("InstallerPipeline rollback moves current pointer without creating a new Deployment", async () => {
  await withTempSource(async (dir) => {
    const deployments = new InMemoryDeploymentStore();
    let nextId = 0;
    const pipeline = new InstallerPipeline({
      deployments,
      newId: (prefix) => `${prefix}_${++nextId}`,
      now: () => 0,
    });

    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    const second = await pipeline.deploymentApply(first.installation.id, {
      source: { kind: "local", url: dir },
    });

    const before = await deployments.listForInstallation(
      first.installation.id,
    );
    assert.equal(before.length, 2);

    const rollback = await pipeline.rollback(first.installation.id, {
      deploymentId: first.deployment.id,
    });

    const after = await deployments.listForInstallation(first.installation.id);
    const rollbackEvents = await deployments.listRollbackEvents(
      first.installation.id,
    );
    assert.equal(after.length, 2);
    assert.deepEqual(rollbackEvents, [{
      installationId: first.installation.id,
      rolledBackFrom: second.deployment.id,
      rolledBackTo: first.deployment.id,
      createdAt: 0,
    }]);
    assert.equal(rollback.deployment.id, first.deployment.id);
    assert.equal(
      rollback.installation.currentDeploymentId,
      first.deployment.id,
    );
    assert.equal(rollback.installation.status, "ready");
    assert.deepEqual(rollback.rollback, {
      rolledBackFrom: second.deployment.id,
      rolledBackTo: first.deployment.id,
    });

    const [installation] = await pipeline.listInstallations("space_test");
    assert.equal(installation?.currentDeploymentId, first.deployment.id);
  });
});

Deno.test("InstallerPipeline failed redeploy keeps prior ready Installation current", async () => {
  await withTempSource(async (dir) => {
    const deployments = new InMemoryDeploymentStore();
    let applyCalls = 0;
    const providers: InstallerProviderRegistry = {
      apply(ctx: ProviderApplyContext): Promise<ProviderApplyResult> {
        applyCalls += 1;
        if (applyCalls > 2) {
          throw new Error(`provider failed during ${ctx.componentName}`);
        }
        return Promise.resolve({
          resource: {
            component: ctx.componentName,
            kind: ctx.component.kind,
            provider: "test-direct",
            resourceHandle: `test://${ctx.componentName}`,
          },
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({ deployments, providers });
    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    await assert.rejects(
      pipeline.deploymentApply(first.installation.id, {
        source: { kind: "local", url: dir },
      }),
      /provider failed during db/,
    );

    const [installation] = await pipeline.listInstallations("space_test");
    assert.equal(installation?.status, "ready");
    assert.equal(installation?.currentDeploymentId, first.deployment.id);
    const history = await deployments.listForInstallation(
      first.installation.id,
    );
    assert.equal(history.length, 2);
    assert.equal(
      history.find((deployment) => deployment.status === "failed")
        ?.id.startsWith("dep_"),
      true,
    );
  });
});

Deno.test("installer onInstallStart error aborts apply and surfaces InstallerPipelineError", async () => {
  await withTempSource(async (dir) => {
    const db: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () => Promise.resolve({ resourceHandle: "x", outputs: {} }),
      onInstallStart: () => Promise.reject(new Error("boom")),
    };
    const worker = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [db, worker],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /plugin @example\/postgres onInstallStart failed: boom/,
    );

    const [installation] = await pipeline.listInstallations("space_test");
    assert.equal(installation?.status, "failed");
    assert.equal(installation?.currentDeploymentId, null);
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
          resourceHandle: "postgres://x",
          outputs: { host: "db.local", port: "5432" },
        }),
      publishMaterial: (ctx) =>
        Promise.resolve(ctx.outputs as NamespaceMaterial),
      onDeploymentComplete: () =>
        Promise.reject(new Error("post-deploy hook failed")),
    };
    const worker: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: () =>
        Promise.resolve({
          resourceHandle: "worker://x",
          outputs: {},
        }),
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [db, worker],
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    // Hook failure must not corrupt the persisted Deployment status.
    assert.equal(deployment.status, "succeeded");
  });
});

Deno.test("installerProviderRegistryFromPlugins resolves operator alias via kind URI", async () => {
  const plugin = buildRecordingPlugin({
    name: "@example/worker",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    recorder: [],
  });
  const registry = installerProviderRegistryFromPlugins([plugin], {
    worker: "https://takosumi.com/kinds/v1/worker",
  });

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "web",
    component: { kind: "worker" },
    source: { kind: "local", url: "/tmp/src" },
    sourceDirectory: "/tmp/src",
    listenedMaterials: {},
    resolvedBindings: [],
  });

  assert.equal(result.resource.provider, "@example/worker");
  assert.equal(
    result.resource.resourceHandle,
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
    source: { kind: "local", url: "/tmp/src" },
    sourceDirectory: "/tmp/src",
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
      source: { kind: "local", url: "/tmp/src" },
      sourceDirectory: "/tmp/src",
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
    assert.deepEqual(Object.keys(deployment.outputs.components ?? {}), [
      "db",
    ]);
    assert.deepEqual(deployment.outputs.components?.db, { connection: {} });
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
            resourceHandle: `test://${ctx.componentName}`,
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

Deno.test("InstallerPipeline skips missing external publication refs by default", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: optional-publication-test
  name: Optional Publication Test
components:
  web:
    kind: worker
    listen:
      oidc:
        from: operator.identity.oidc
        as: env
        prefix: OIDC
`;
  await withTempSource(async (dir) => {
    const captures: Array<Readonly<Record<string, NamespaceMaterial>>> = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => captures.push(ctx.listenedMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(captures, [{}]);
  }, yaml);
});

Deno.test("InstallerPipeline fails required missing external publication refs", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: required-publication-test
  name: Required Publication Test
components:
  web:
    kind: worker
    listen:
      oidc:
        from: operator.identity.oidc
        as: env
        prefix: OIDC
        required: true
`;
  await withTempSource(async (dir) => {
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /web\.listen\.oidc\.from refers to unresolved publication "operator\.identity\.oidc"/,
    );
  }, yaml);
});

Deno.test("InstallerPipeline rejects unmapped provider outputs for declared publish", async () => {
  await withTempSource(async (dir) => {
    const dbPlugin: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () =>
        Promise.resolve({
          resourceHandle: "postgres://x",
          outputs: { host: "db.local", port: "5432" },
        }),
    };
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /publish\.connection requires the component materializer/,
    );
  });
});

Deno.test("InstallerPipeline accepts prepared source tar with source digest pin", async () => {
  const prepared = await makePreparedSource();
  try {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
        }),
        buildRecordingPlugin({
          name: "@example/worker",
          provides: ["https://takosumi.com/kinds/v1/worker"],
          recorder: [],
        }),
      ],
    });

    const dryRun = await pipeline.installationDryRun({
      spaceId: "space_test",
      source: {
        kind: "prepared",
        url: prepared.archive,
        digest: prepared.digest,
      },
    });
    assert.equal(dryRun.source.digest, prepared.digest);
    assert.equal(dryRun.expected.sourceDigest, prepared.digest);

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: {
        kind: "prepared",
        url: prepared.archive,
        digest: prepared.digest,
      },
      expected: dryRun.expected,
    });
    assert.equal(deployment.status, "succeeded");
    assert.equal(deployment.source.digest, prepared.digest);
  } finally {
    await prepared.cleanup();
  }
});

async function makePreparedSource(): Promise<{
  readonly archive: string;
  readonly digest: string;
  readonly cleanup: () => Promise<void>;
}> {
  const sourceDir = await Deno.makeTempDir({
    prefix: "takosumi-installer-prepared-src-",
  });
  const archive = await Deno.makeTempFile({
    prefix: "takosumi-installer-prepared-",
    suffix: ".tar",
  });
  await Deno.writeTextFile(`${sourceDir}/.takosumi.yml`, SAMPLE_YAML);
  const { code, stderr } = await new Deno.Command("tar", {
    args: ["-c", "-f", archive, "-C", sourceDir, ".takosumi.yml"],
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr));
  }
  const digest = await sha256Hex(await Deno.readFile(archive));
  return {
    archive,
    digest,
    cleanup: async () => {
      await Deno.remove(sourceDir, { recursive: true });
      await Deno.remove(archive);
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
