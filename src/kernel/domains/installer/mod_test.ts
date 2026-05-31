import { test } from "bun:test";
/**
 * InstallerPipeline lifecycle hook + KernelPlugin integration tests.
 *
 * Phase C rewrite: the legacy `use:` edges and `upstreamOutputs` placeholder
 * have been replaced by deterministic `connect` bindings and
 * platform-service `listen` bindings. The installer pipeline drives the
 * `KernelPlugin.materializeOutput` / `applyBinding` hooks and exposes the
 * resolved materials to plugin.apply via `inputMaterials`.
 */
import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract/reference/compat";
import type {
  ApplyInputBindingContext,
  EnvInjection,
  OutputMaterial,
  OutputMaterialContext,
} from "takosumi-contract/reference/plugin";
import {
  InstallerPipeline,
  type InstallerProviderRegistry,
  installerProviderRegistryFromPlugins,
  type ProviderApplyContext,
  type ProviderApplyResult,
} from "./mod.ts";
import {
  InMemoryDeploymentStore,
  InMemoryInstallationStore,
  InMemoryPublicationPathStore,
} from "./store.ts";

// Canonical AppSpec: a `postgres` component produces `db.connection`; a
// `worker` component connects to it with `inject: env` + `prefix: DB` so the
// kernel resolves env injections like `DB_HOST`, `DB_PORT`, ...
const SAMPLE_YAML = `apiVersion: v1
metadata:
  id: lifecycle-test
  name: Lifecycle Test
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: env
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
    readonly inputMaterials: Readonly<Record<string, OutputMaterial>>;
  }) => void;
  readonly materializeOutput?: (
    ctx: OutputMaterialContext,
  ) => Promise<OutputMaterial>;
  readonly applyBinding?: (
    ctx: ApplyInputBindingContext,
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
        inputMaterials: ctx.inputMaterials ?? ctx.listenedMaterials,
      });
      return Promise.resolve({
        resourceHandle:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    materializeOutput: opts.materializeOutput ??
      ((ctx) => Promise.resolve(defaultTestOutputMaterial(ctx))),
    applyBinding: opts.applyBinding,
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

function defaultTestOutputMaterial(
  ctx: OutputMaterialContext,
): OutputMaterial {
  if (ctx.outputName === "connection") {
    return {
      protocol: "postgresql",
      host: String(ctx.outputs.host ?? "db.local"),
      port: Number(ctx.outputs.port ?? 5432),
      ...(ctx.outputs.database
        ? { database: String(ctx.outputs.database) }
        : {}),
      ...(ctx.outputs.username
        ? { username: String(ctx.outputs.username) }
        : {}),
    };
  }
  return ctx.outputs as OutputMaterial;
}

test("installer lifecycle hooks fire onInstallStart -> onDeploymentStart -> apply -> onDeploymentComplete -> onInstallComplete", async () => {
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
    // (publisher before consumer) is db -> web.
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

test("installer lifecycle hooks fire on subsequent deployments without re-running install hooks", async () => {
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

test("InstallerPipeline resolves required platform services through operator resolver", async () => {
  const spec = `apiVersion: v1
metadata:
  id: platform-listen-test
  name: Platform Service Listen Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        inject: secret-env
        prefix: OIDC
        required: true
`;
  await withTempSource(async (dir) => {
    const seen: Array<Readonly<Record<string, OutputMaterial>>> = [];
    const resolverCalls: string[] = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => seen.push(ctx.inputMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      platformServices: {
        resolve: (ctx) => {
          resolverCalls.push(
            `${ctx.spaceId}:${ctx.appId}:${ctx.componentName}:${ctx.bindingName}:${ctx.sourceRef}`,
          );
          if (ctx.sourceRef !== "identity.primary.oidc") return undefined;
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
      "space_test:platform-listen-test:web:oidc:identity.primary.oidc",
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

test("InstallerPipeline rejects missing required platform service", async () => {
  const spec = `apiVersion: v1
metadata:
  id: missing-platform-listen-test
  name: Missing Platform Service Listen Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        inject: secret-env
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
      platformServices: { resolve: () => undefined },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /unresolved platform service "identity.primary.oidc"/,
    );
  }, spec);
});

test("InstallerPipeline records root publish as service path declaration", async () => {
  const spec = `apiVersion: v1
metadata:
  id: service-path-declaration-test
  name: Service Path Declaration Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: {
            host: "db.local",
            port: "5432",
            database: "app",
            username: "app",
          },
        }),
      ],
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.deepEqual(deployment.outputs.extensions, {
      servicePathExposures: {
        database: {
          path: "database.primary.connection",
          output: "db.connection",
          material: {
            protocol: "postgresql",
            host: "db.local",
            port: 5432,
            database: "app",
            username: "app",
          },
        },
      },
    });
  }, spec);
});

test("InstallerPipeline materializes root publish with PublishOptions", async () => {
  const spec = `apiVersion: v1
metadata:
  id: publish-options-test
  name: Publish Options Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    kind: postgresql
    path: database.primary.connection
    labels:
      tier: primary
`;
  await withTempSource(async (dir) => {
    const seenOptions: Array<OutputMaterialContext["options"]> = [];
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local" },
          materializeOutput: (ctx) => {
            seenOptions.push(ctx.options);
            if (ctx.options) {
              return Promise.resolve({
                materialKind: ctx.options.kind ?? "unknown",
                publicationPath: ctx.options.path ?? "",
                labelTier: ctx.options.labels?.tier ?? "",
              });
            }
            return Promise.resolve({
              protocol: "postgresql",
              host: String(ctx.outputs.host),
            });
          },
        }),
      ],
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.deepEqual(seenOptions.map((options) => options?.path ?? null), [
      "database.primary.connection",
    ]);
    assert.deepEqual(deployment.outputs.extensions, {
      servicePathExposures: {
        database: {
          output: "db.connection",
          kind: "postgresql",
          path: "database.primary.connection",
          labels: { tier: "primary" },
          material: {
            materialKind: "postgresql",
            publicationPath: "database.primary.connection",
            labelTier: "primary",
          },
        },
      },
    });
  }, spec);
});

test("InstallerPipeline rejects root publish kind that does not match material kind", async () => {
  const spec = `apiVersion: v1
metadata:
  id: publish-kind-mismatch-test
  name: Publish Kind Mismatch Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    kind: object-store
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local" },
          materializeOutput: () =>
            Promise.resolve({
              materialKind: "postgresql",
              host: "db.local",
            }),
        }),
      ],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /publish\.database\.kind expects material kind "object-store"/,
    );
  }, spec);
});

test("InstallerPipeline rejects root publish material with conflicting kind fields", async () => {
  const spec = `apiVersion: v1
metadata:
  id: publish-kind-conflict-test
  name: Publish Kind Conflict Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    kind: postgresql
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local" },
          materializeOutput: () =>
            Promise.resolve({
              kind: "postgresql",
              materialKind: "object-store",
              host: "db.local",
            }),
        }),
      ],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /conflicting kind fields/,
    );
  }, spec);
});

test("InstallerPipeline rollback moves current pointer without creating a new Deployment", async () => {
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
      scope: {
        pointer: "reverted",
        resourceMaterialization: "not-reapplied",
        workloadState: "not-reverted",
      },
    });

    const [installation] = await pipeline.listInstallations("space_test");
    assert.equal(installation?.currentDeploymentId, first.deployment.id);
  });
});

test("InstallerPipeline failed redeploy keeps prior ready Installation current", async () => {
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

test("installer onInstallStart error aborts apply and surfaces InstallerPipelineError", async () => {
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

test("installer onDeploymentComplete error is swallowed (post-apply hook is best-effort)", async () => {
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
      materializeOutput: (ctx) =>
        Promise.resolve({
          protocol: "postgresql",
          host: String(ctx.outputs.host),
          port: Number(ctx.outputs.port),
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

test("installerProviderRegistryFromPlugins resolves operator alias via kind URI", async () => {
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

test("installerProviderRegistryFromPlugins accepts operator-defined kind URI", async () => {
  const plugin = buildRecordingPlugin({
    name: "@operator/lambda",
    provides: ["https://example.com/kinds/lambda"],
    recorder: [],
  });
  const registry = installerProviderRegistryFromPlugins([plugin]);

  const result = await registry.apply({
    installationId: "ins_1",
    componentName: "fn",
    component: { kind: "https://example.com/kinds/lambda" },
    source: { kind: "local", url: "/tmp/src" },
    sourceDirectory: "/tmp/src",
    listenedMaterials: {},
    resolvedBindings: [],
  });

  assert.equal(result.resource.provider, "@operator/lambda");
});

test("installerProviderRegistryFromPlugins throws when no plugin provides the kind", async () => {
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

test("installerProviderRegistryFromPlugins maps plugin apply errors to InstallerPipelineError", async () => {
  const registry = installerProviderRegistryFromPlugins([{
    name: "@example/worker",
    version: "1.0.0",
    provides: ["worker"],
    apply: () => Promise.reject(new Error("invalid projection")),
  }]);

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
    /plugin @example\/worker apply failed for component web: invalid projection/,
  );
});

test("InstallerPipeline preflights plugin-backed providers before applying earlier components", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const postgres: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `postgres://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [postgres],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /no kernel plugin advertises kind worker \(component web\)/,
    );
    assert.deepEqual(events, []);
  });
});

test("InstallerPipeline preflights plugin component validation before provider apply", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const postgres: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `postgres://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const worker: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      validateComponent: () => {
        throw new Error("unsupported binding projection");
      },
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `worker://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [postgres, worker],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /plugin @example\/worker rejected component web: unsupported binding projection/,
    );
    assert.deepEqual(events, []);
  });
});

test("InstallerPipeline does not run install hooks before deployment preflight", async () => {
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const postgres = buildRecordingPlugin({
      name: "@example/postgres",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      recorder: events,
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [postgres],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /no kernel plugin advertises kind worker \(component web\)/,
    );
    assert.deepEqual(events, []);
  });
});

test("InstallerPipeline does not plugin-preflight custom providers", async () => {
  await withTempSource(async (dir) => {
    const recorded: string[] = [];
    const providers: InstallerProviderRegistry = {
      apply(ctx: ProviderApplyContext): Promise<ProviderApplyResult> {
        recorded.push(ctx.componentName);
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
    const postgres: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () =>
        Promise.resolve({ resourceHandle: "postgres://x", outputs: {} }),
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [postgres],
      providers,
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(recorded, ["db", "web"]);
  });
});

test("InstallerPipeline falls back to noop provider when no plugins / providers supplied", async () => {
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

test("InstallerPipeline lets test code override providers directly without plugins", async () => {
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

test("InstallerPipeline skips missing platform service refs by default", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: optional-platform-service-test
  name: Optional Platform Service Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        inject: env
        prefix: OIDC
`;
  await withTempSource(async (dir) => {
    const captures: Array<Readonly<Record<string, OutputMaterial>>> = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => captures.push(ctx.inputMaterials),
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

test("InstallerPipeline fails required missing platform service refs", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: required-platform-service-test
  name: Required Platform Service Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        inject: env
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
      /web\.listen\.oidc refers to unresolved platform service "identity\.primary\.oidc"/,
    );
  }, yaml);
});

test("InstallerPipeline preflights required listens before provider apply", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: required-listen-preflight-test
  name: Required Listen Preflight Test
components:
  db:
    kind: postgres
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        inject: env
        required: true
`;
  await withTempSource(async (dir) => {
    const events: string[] = [];
    let resolverCalls = 0;
    const dbPlugin: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `postgres://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const workerPlugin: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `worker://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
      platformServices: {
        resolve: () => {
          resolverCalls += 1;
          return undefined;
        },
      },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /web\.listen\.oidc refers to unresolved platform service "identity\.primary\.oidc"/,
    );
    assert.equal(resolverCalls, 1);
    assert.deepEqual(events, []);
  }, yaml);
});

test("InstallerPipeline binds discovery listen collections", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: mcp-discovery-test
  name: MCP Discovery Test
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server
        labels:
          capability: docs
        many: true
        inject: config-mount
`;
  await withTempSource(async (dir) => {
    const captures: Array<Readonly<Record<string, OutputMaterial>>> = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => captures.push(ctx.inputMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      platformServices: {
        resolve: (ctx) => {
          assert.equal(ctx.kind, "mcp-server");
          assert.deepEqual(ctx.labels, { capability: "docs" });
          assert.equal(ctx.many, true);
          return [
            { materialKind: "mcp-server", url: "https://one.example.test/mcp" },
            { materialKind: "mcp-server", url: "https://two.example.test/mcp" },
          ];
        },
      },
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(captures, [
      {
        tools: {
          kind: "collection",
          items: [
            {
              materialKind: "mcp-server",
              url: "https://one.example.test/mcp",
            },
            {
              materialKind: "mcp-server",
              url: "https://two.example.test/mcp",
            },
          ],
        },
      },
    ]);
  }, yaml);
});

test("InstallerPipeline resolves platform listens per consumer binding", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: per-consumer-listen-test
  name: Per Consumer Listen Test
components:
  api:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        kind: oidc-issuer
        inject: env
        required: true
  admin:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        kind: oidc-issuer
        inject: env
        required: true
`;
  await withTempSource(async (dir) => {
    const resolverCalls: string[] = [];
    const captures = new Map<
      string,
      Readonly<Record<string, OutputMaterial>>
    >();
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) =>
        captures.set(ctx.componentName, ctx.inputMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      platformServices: {
        resolve: (ctx) => {
          resolverCalls.push(ctx.componentName);
          return {
            materialKind: "oidc-issuer",
            clientId: `client-${ctx.componentName}`,
          };
        },
      },
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(resolverCalls, ["api", "admin"]);
    assert.equal(captures.get("api")?.oidc?.clientId, "client-api");
    assert.equal(captures.get("admin")?.oidc?.clientId, "client-admin");
  }, yaml);
});

test("InstallerPipeline binds empty discovery result as empty collection when many is true", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: empty-discovery-test
  name: Empty Discovery Test
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server
        many: true
        inject: upstream
`;
  await withTempSource(async (dir) => {
    const captures: Array<Readonly<Record<string, OutputMaterial>>> = [];
    const workerPlugin = buildRecordingPlugin({
      name: "@example/worker",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      recorder: [],
      captureApply: (ctx) => captures.push(ctx.inputMaterials),
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      platformServices: {
        resolve: () => [],
      },
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(deployment.status, "succeeded");
    assert.deepEqual(captures, [
      { tools: { kind: "collection", items: [] } },
    ]);
  }, yaml);
});

test("InstallerPipeline preflights discovery cardinality before provider apply", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: discovery-cardinality-preflight-test
  name: Discovery Cardinality Preflight Test
components:
  db:
    kind: postgres
  web:
    kind: worker
    listen:
      tools:
        kind: mcp-server
        inject: env
`;
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const dbPlugin: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `postgres://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const workerPlugin: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `worker://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
      platformServices: {
        resolve: () => [
          { materialKind: "mcp-server", url: "https://one.example.test/mcp" },
          { materialKind: "mcp-server", url: "https://two.example.test/mcp" },
        ],
      },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /matched 2 entries; expected exactly one or set many: true/,
    );
    assert.deepEqual(events, []);
  }, yaml);
});

test("InstallerPipeline rejects empty discovery result without many before provider apply", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: empty-single-discovery-test
  name: Empty Single Discovery Test
components:
  web:
    kind: worker
    listen:
      tool:
        kind: mcp-server
        inject: env
`;
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const workerPlugin: KernelPlugin = {
      name: "@example/worker",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/worker"],
      apply: (ctx) => {
        events.push(`apply:${ctx.componentName}`);
        return Promise.resolve({
          resourceHandle: `worker://${ctx.componentName}`,
          outputs: {},
        });
      },
    };
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [workerPlugin],
      platformServices: {
        resolve: () => [],
      },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /matched 0 entries; expected exactly one/,
    );
    assert.deepEqual(events, []);
  }, yaml);
});

test("InstallerPipeline enforces listen.kind compatibility at apply time", async () => {
  // `listen.path` with an explicit `kind` is a compatibility assertion: the
  // resolved material must advertise the same `kind`. The real deployment
  // pipeline (not just the test-only resolveAppSpec) must reject a mismatch.
  const yaml = `apiVersion: v1
metadata:
  id: listen-kind-mismatch-test
  name: Listen Kind Mismatch Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        kind: oidc-issuer
        inject: env
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
      platformServices: {
        // Operator returns a material advertising a different kind.
        resolve: () => ({ kind: "object-store", url: "https://x.test" }),
      },
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /expects kind "oidc-issuer" but material .* advertises kind "object-store"/,
    );
  }, yaml);
});

test("InstallerPipeline binds listen.kind when material kind matches", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: listen-kind-match-test
  name: Listen Kind Match Test
components:
  web:
    kind: worker
    listen:
      oidc:
        path: identity.primary.oidc
        kind: oidc-issuer
        inject: env
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
      platformServices: {
        resolve: () => ({ kind: "oidc-issuer", issuerUrl: "https://i.test" }),
      },
    });

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(deployment.status, "succeeded");
  }, yaml);
});

test("InstallerPipeline rejects a second Installation publishing a path another already owns", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-conflict-test
  name: Publish Path Conflict Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  const makePipeline = () =>
    new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });
  await withTempSource(async (dir) => {
    const pipeline = makePipeline();
    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(first.installation.status, "ready");

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /publish_path_conflict/,
    );
  }, yaml);
});

test("InstallerPipeline exposes root publish paths to other Installation listens", async () => {
  const publisherYaml = `apiVersion: v1
metadata:
  id: publish-listen-path-publisher
  name: Publish Listen Path Publisher
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  const consumerYaml = `apiVersion: v1
metadata:
  id: publish-listen-path-consumer
  name: Publish Listen Path Consumer
components:
  web:
    kind: worker
    listen:
      db:
        path: database.primary.connection
        inject: env
        required: true
`;
  await withTempSource(async (publisherDir) => {
    await withTempSource(async (consumerDir) => {
      let captured: Readonly<Record<string, OutputMaterial>> | undefined;
      const pipeline = new InstallerPipeline({
        kindAliases: TEST_KIND_ALIASES,
        plugins: [
          buildRecordingPlugin({
            name: "@example/postgres",
            provides: ["https://takosumi.com/kinds/v1/postgres"],
            recorder: [],
            outputs: { host: "published-db.local", port: "5432" },
          }),
          buildRecordingPlugin({
            name: "@example/worker",
            provides: ["https://takosumi.com/kinds/v1/worker"],
            recorder: [],
            captureApply: (ctx) => {
              captured = ctx.inputMaterials;
            },
          }),
        ],
      });

      await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: publisherDir },
      });
      await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: consumerDir },
      });

      assert.deepEqual(captured?.db, {
        protocol: "postgresql",
        host: "published-db.local",
        port: 5432,
      });
    }, consumerYaml);
  }, publisherYaml);
});

test("InstallerPipeline discovers pathless root publish materials by kind and labels", async () => {
  const publisherYaml = `apiVersion: v1
metadata:
  id: publish-listen-discovery-publisher
  name: Publish Listen Discovery Publisher
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    kind: service-binding
    labels:
      role: primary
`;
  const consumerYaml = `apiVersion: v1
metadata:
  id: publish-listen-discovery-consumer
  name: Publish Listen Discovery Consumer
components:
  web:
    kind: worker
    listen:
      db:
        kind: service-binding
        labels:
          role: primary
        inject: env
        required: true
`;
  await withTempSource(async (publisherDir) => {
    await withTempSource(async (consumerDir) => {
      let captured: Readonly<Record<string, OutputMaterial>> | undefined;
      const pipeline = new InstallerPipeline({
        kindAliases: TEST_KIND_ALIASES,
        plugins: [
          buildRecordingPlugin({
            name: "@example/postgres",
            provides: ["https://takosumi.com/kinds/v1/postgres"],
            recorder: [],
            outputs: { host: "discovered-db.local", port: "5432" },
            materializeOutput: (ctx) =>
              Promise.resolve({
                materialKind: "service-binding",
                ...defaultTestOutputMaterial(ctx),
              }),
          }),
          buildRecordingPlugin({
            name: "@example/worker",
            provides: ["https://takosumi.com/kinds/v1/worker"],
            recorder: [],
            captureApply: (ctx) => {
              captured = ctx.inputMaterials;
            },
          }),
        ],
      });

      await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: publisherDir },
      });
      await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: consumerDir },
      });

      assert.deepEqual(captured?.db, {
        materialKind: "service-binding",
        protocol: "postgresql",
        host: "discovered-db.local",
        port: 5432,
      });
    }, consumerYaml);
  }, publisherYaml);
});

test("InstallerPipeline checks publish path conflicts before deployment hook and provider apply", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-preflight-test
  name: Publish Path Preflight Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const events: string[] = [];
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: events,
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });
    await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    events.length = 0;

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /publish_path_conflict/,
    );
    assert.equal(
      events.some((event) => event.startsWith("onDeploymentStart:")),
      false,
    );
    assert.equal(events.some((event) => event.startsWith("apply:")), false);
  }, yaml);
});

test("InstallerPipeline expires stale provisional publish path claims", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-expired-claim-test
  name: Publish Path Expired Claim Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const installations = new InMemoryInstallationStore();
    const publicationPaths = new InMemoryPublicationPathStore();
    await installations.put({
      id: "ins_stale",
      spaceId: "space_test",
      appId: "stale.app",
      currentDeploymentId: null,
      status: "installing",
      createdAt: 0,
    });
    await publicationPaths.claim({
      spaceId: "space_test",
      path: "database.primary.connection",
      installationId: "ins_stale",
      deploymentId: "dep_stale",
      publishName: "database",
      updatedAt: 0,
      leaseExpiresAt: 100,
    });
    let now = 50;
    const pipeline = new InstallerPipeline({
      installations,
      publicationPaths,
      now: () => now,
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });

    await assert.rejects(
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      /publish_path_conflict/,
    );

    now = 101;
    const applied = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(applied.deployment.status, "succeeded");
  }, yaml);
});

test("InstallerPipeline ignores stale active publish path claims without a succeeded Deployment", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-orphan-claim-test
  name: Publish Path Orphan Claim Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const installations = new InMemoryInstallationStore();
    const publicationPaths = new InMemoryPublicationPathStore();
    await installations.put({
      id: "ins_orphan",
      spaceId: "space_test",
      appId: "orphan.app",
      currentDeploymentId: "dep_missing",
      status: "ready",
      createdAt: 0,
    });
    await publicationPaths.claim({
      spaceId: "space_test",
      path: "database.primary.connection",
      installationId: "ins_orphan",
      deploymentId: "dep_missing",
      publishName: "database",
      updatedAt: 0,
    });
    const pipeline = new InstallerPipeline({
      installations,
      publicationPaths,
      now: () => 1,
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });

    const applied = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(applied.deployment.status, "succeeded");
  }, yaml);
});

test("InstallerPipeline expires active publish claims that never became current", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-uncurrent-claim-test
  name: Publish Path Uncurrent Claim Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const installations = new InMemoryInstallationStore();
    const deployments = new InMemoryDeploymentStore();
    const publicationPaths = new InMemoryPublicationPathStore();
    await installations.put({
      id: "ins_uncurrent",
      spaceId: "space_test",
      appId: "uncurrent.app",
      currentDeploymentId: null,
      status: "installing",
      createdAt: 0,
    });
    await deployments.put({
      id: "dep_uncurrent",
      installationId: "ins_uncurrent",
      source: { kind: "local", url: dir },
      manifestDigest: "sha256:uncurrent",
      status: "succeeded",
      outputs: {},
      createdAt: 0,
    });
    await publicationPaths.claim({
      spaceId: "space_test",
      path: "database.primary.connection",
      installationId: "ins_uncurrent",
      deploymentId: "dep_uncurrent",
      publishName: "database",
      updatedAt: 0,
    });
    const pipeline = new InstallerPipeline({
      installations,
      deployments,
      publicationPaths,
      now: () => 10 * 60 * 1000 + 1,
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });

    const applied = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    assert.equal(applied.deployment.status, "succeeded");
  }, yaml);
});

test("InstallerPipeline lets an Installation keep its pathful publish on redeploy", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-redeploy-test
  name: Publish Path Redeploy Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });
    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    const second = await pipeline.deploymentApply(first.installation.id, {
      source: { kind: "local", url: dir },
    });

    assert.equal(second.deployment.status, "succeeded");
    assert.deepEqual(second.deployment.outputs.extensions, {
      servicePathExposures: {
        database: {
          output: "db.connection",
          path: "database.primary.connection",
          material: {
            protocol: "postgresql",
            host: "db.local",
            port: 5432,
          },
        },
      },
    });
  }, yaml);
});

test("InstallerPipeline rejects rollback when target publish path is now owned by another Installation", async () => {
  const pathful = `apiVersion: v1
metadata:
  id: rollback-path-conflict-test
  name: Rollback Path Conflict Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  const pathless = `apiVersion: v1
metadata:
  id: rollback-path-conflict-test
  name: Rollback Path Conflict Test
components:
  db:
    kind: postgres
`;
  await withTempSource(async (pathfulDir) => {
    await withTempSource(async (pathlessDir) => {
      const pipeline = new InstallerPipeline({
        kindAliases: TEST_KIND_ALIASES,
        plugins: [
          buildRecordingPlugin({
            name: "@example/postgres",
            provides: ["https://takosumi.com/kinds/v1/postgres"],
            recorder: [],
            outputs: { host: "db.local", port: "5432" },
          }),
        ],
      });
      const first = await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: pathfulDir },
      });
      await pipeline.deploymentApply(first.installation.id, {
        source: { kind: "local", url: pathlessDir },
      });
      await pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: pathfulDir },
      });

      await assert.rejects(
        pipeline.rollback(first.installation.id, {
          deploymentId: first.deployment.id,
        }),
        /publish_path_conflict/,
      );
    }, pathless);
  }, pathful);
});

test("InstallerPipeline serializes concurrent same-path fresh installs in one Space", async () => {
  // Two fresh installs of the same pathful publish started concurrently must
  // not both succeed: the per-Space mutation chain serializes them so the
  // second observes the first's publication and is rejected.
  const yaml = `apiVersion: v1
metadata:
  id: publish-path-race-test
  name: Publish Path Race Test
components:
  db:
    kind: postgres
publish:
  database:
    output: db.connection
    path: database.primary.connection
`;
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@example/postgres",
          provides: ["https://takosumi.com/kinds/v1/postgres"],
          recorder: [],
          outputs: { host: "db.local", port: "5432" },
        }),
      ],
    });
    const results = await Promise.allSettled([
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
      pipeline.installationApply({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(
      fulfilled.length,
      1,
      "exactly one install should own the path",
    );
    assert.equal(rejected.length, 1, "the racing install should be rejected");
  }, yaml);
});

test("InstallerPipeline rejects unmapped provider outputs for connected output", async () => {
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
      /output connection requires the component materializer/,
    );
  });
});

test("InstallerPipeline rejects missing output slots even when provider outputs are empty", async () => {
  await withTempSource(async (dir) => {
    const dbPlugin: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () =>
        Promise.resolve({
          resourceHandle: "postgres://x",
          outputs: {},
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
      /output connection requires the component materializer/,
    );
  });
});

test("InstallerPipeline preserves output slot named outputs when recording raw provider outputs", async () => {
  const yaml = `apiVersion: v1
metadata:
  id: output-slot-collision-test
  name: Output Slot Collision Test
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      data:
        output: db.outputs
        inject: upstream
`;
  await withTempSource(async (dir) => {
    const dbPlugin: KernelPlugin = {
      name: "@example/postgres",
      version: "1.0.0",
      provides: ["https://takosumi.com/kinds/v1/postgres"],
      apply: () =>
        Promise.resolve({
          resourceHandle: "postgres://x",
          outputs: { rawUrl: "postgres://raw" },
        }),
      materializeOutput: (ctx) =>
        Promise.resolve({
          materialKind: "db.outputs",
          value: String(ctx.outputs.rawUrl),
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

    const { deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.deepEqual(deployment.outputs.components?.db?.outputs, {
      materialKind: "db.outputs",
      value: "postgres://raw",
    });
    assert.deepEqual(deployment.outputs.components?.db?.providerOutputs, {
      rawUrl: "postgres://raw",
    });
  }, yaml);
});

test("InstallerPipeline accepts prepared source tar with source digest pin", async () => {
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
  const bytes = await Deno.readFile(archive);
  const digest = await sha256Hex(bytes);
  const tarBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const originalFetch = globalThis.fetch;
  const url = `https://example.test/prepared/${
    digest.slice("sha256:".length)
  }.tar`;
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (target === url) {
      return Promise.resolve(
        new Response(tarBuffer, {
          status: 200,
          headers: { "content-type": "application/x-tar" },
        }),
      );
    }
    return originalFetch(input as Request | URL | string, init);
  };
  return {
    archive: url,
    digest,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
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
