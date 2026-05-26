/**
 * E2E smoke for the v1 installer pipeline under the Phase C namespace
 * pub/sub model.
 *
 * Drives the public 5-endpoint surface with a real `InstallerPipeline`
 * configured via `new InstallerPipeline({ plugins: [...] })`. The
 * publication/listen AppSpec used here exercises:
 *   - explicit local publications such as `db.connection`
 *   - sibling `listen:` bindings resolving from the registry into
 *     `listenedMaterials` on the listener plugin's apply context
 *   - HTTP 201 on apply + status flip to 409 for the
 *     `failed_precondition` path (mismatched expected pin, pub/sub cycle)
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.5";
import { Hono } from "hono";
import type { Component } from "takosumi-contract/app-spec";
import type {
  ApplyListenContext,
  EnvInjection,
  KernelPlugin,
  NamespaceMaterial,
  PublishMaterialContext,
} from "takosumi-contract/reference/plugin";
import type {
  Deployment,
  DeploymentApplyResponse,
  Installation,
  InstallationApplyResponse,
  InstallationDryRunResponse,
  RollbackResponse,
} from "takosumi-contract/installer-api";
import { InstallerPipeline } from "../domains/installer/mod.ts";
import { InMemoryDeploymentStore } from "../domains/installer/store.ts";
import { mountInstallerPublicRoutes } from "./installer_public_routes.ts";

// Canonical AppSpec: `db` publishes `db.connection`; `web` listens with
// `as: env, prefix: DB` so the kernel default expansion produces DB_HOST /
// DB_PORT / ... env injections on the worker.
const SAMPLE_APP_SPEC_YAML = `apiVersion: v1
metadata:
  id: example-notes
  name: Example Notes
  description: Sample app spec for e2e installer pipeline tests
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

const INSTALLER_AUTH_HEADERS = {
  "authorization": "Bearer installer-token",
  "content-type": "application/json",
} as const;

const TEST_KIND_ALIASES = {
  postgres: "https://takosumi.com/kinds/v1/postgres",
  worker: "https://takosumi.com/kinds/v1/worker",
} as const;

async function withTempSource<T>(
  fn: (workingDirectory: string) => Promise<T>,
  spec: string = SAMPLE_APP_SPEC_YAML,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-installer-e2e-" });
  try {
    await Deno.writeTextFile(`${dir}/.takosumi.yml`, spec);
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

interface ApplyRecord {
  readonly componentName: string;
  readonly listenedMaterials: Readonly<Record<string, NamespaceMaterial>>;
  readonly installationId: string;
}

/**
 * Build a recording test plugin under the publication/listen model.
 * Captures `listenedMaterials` so the test can assert local publication
 * resolution and lifecycle hook invocations so we can assert ordering.
 */
function buildRecordingPlugin(opts: {
  readonly name: string;
  readonly kindUri: string;
  readonly events: string[];
  readonly applies: ApplyRecord[];
  readonly outputs?: Readonly<Record<string, string>>;
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
    provides: [opts.kindUri],
    apply: (ctx) => {
      opts.applies.push({
        componentName: ctx.componentName,
        listenedMaterials: ctx.listenedMaterials,
        installationId: ctx.installationId,
      });
      opts.events.push(`apply:${opts.name}:${ctx.componentName}`);
      return Promise.resolve({
        resourceHandle:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    publishMaterial: opts.publishMaterial ??
      ((ctx) => Promise.resolve(defaultE2ePublishMaterial(ctx))),
    applyListen: opts.applyListen,
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

Deno.test("installer e2e — plain-array plugins drive dry-run + apply with local publications", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const dbPlugin = buildRecordingPlugin({
      name: "@test/postgres",
      kindUri: "https://takosumi.com/kinds/v1/postgres",
      events,
      applies,
      outputs: {
        host: "db.local",
        port: "5432",
        database: "notes",
        username: "notes",
        passwordSecretRef: "secret://db-password",
        connectionString: "postgres://notes:***@db.local:5432/notes",
      },
      // Use the official service-binding material shape. Provider-local
      // output names such as passwordSecretRef / connectionString are
      // projected before publication.
      publishMaterial: (ctx: PublishMaterialContext) =>
        Promise.resolve({
          protocol: "postgresql",
          host: requireStringOutput(ctx, "host"),
          port: Number(requireStringOutput(ctx, "port")),
          database: requireStringOutput(ctx, "database"),
          username: requireStringOutput(ctx, "username"),
          passwordRef: {
            secretRef: requireStringOutput(ctx, "passwordSecretRef"),
          },
          connectionUrl: requireStringOutput(ctx, "connectionString"),
        }),
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@test/worker",
      kindUri: "https://takosumi.com/kinds/v1/worker",
      events,
      applies,
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
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
    assertEquals(Object.keys(apply.deployment.outputs.components ?? {}), [
      "db",
    ]);
    assertEquals(
      apply.deployment.outputs.components?.db?.connection,
      {
        protocol: "postgresql",
        host: "db.local",
        port: 5432,
        database: "notes",
        username: "notes",
        passwordRef: { secretRef: "secret://db-password" },
        connectionUrl: "postgres://notes:***@db.local:5432/notes",
      },
    );

    // Topology: db (publisher) -> web (listener via db.connection).
    assertEquals(applies.length, 2);
    assertEquals(applies[0].componentName, "db");
    assertEquals(applies[1].componentName, "web");
    const dbMaterial = applies[1].listenedMaterials.db;
    assert(dbMaterial, "worker should see db material on the db binding");
    assertEquals(dbMaterial.host, "db.local");
    assertEquals(dbMaterial.port, 5432);
    assertEquals(dbMaterial.database, "notes");

    // First-install lifecycle hook ordering: install hooks bracket
    // deployment hooks, deployment hooks bracket per-component applies.
    assertEquals(events, [
      "onInstallStart:@test/postgres",
      "onInstallStart:@test/worker",
      "onDeploymentStart:@test/postgres",
      "onDeploymentStart:@test/worker",
      "apply:@test/postgres:db",
      "apply:@test/worker:web",
      "onDeploymentComplete:@test/postgres",
      "onDeploymentComplete:@test/worker",
      "onInstallComplete:@test/postgres",
      "onInstallComplete:@test/worker",
    ]);
  });
});

Deno.test("installer e2e — listener applyListen receives material with prefixed env", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const captured: ApplyListenContext[] = [];
    const dbPlugin = buildRecordingPlugin({
      name: "@test/postgres",
      kindUri: "https://takosumi.com/kinds/v1/postgres",
      events,
      applies,
      outputs: { host: "h", port: "5432" },
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@test/worker",
      kindUri: "https://takosumi.com/kinds/v1/worker",
      events,
      applies,
      applyListen: (ctx) => {
        captured.push(ctx);
        return Promise.resolve({
          env: {
            DB_HOST: ctx.material.host as string,
            DB_PORT: String(ctx.material.port),
          },
        });
      },
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
    });
    const app = buildApp(pipeline);

    const dryRun = await (await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
      }),
    })).json() as InstallationDryRunResponse;

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
    // The listener plugin's applyListen hook saw exactly one binding with
    // the AppSpec listen options.
    assertEquals(captured.length, 1);
    assertEquals(captured[0].bindingName, "db");
    assertEquals(captured[0].sourceRef, "db.connection");
    assertEquals(captured[0].options.as, "env");
    assertEquals(captured[0].options.prefix, "DB");
    assertEquals(captured[0].material.host, "h");
  });
});

Deno.test("installer e2e — rollback is pointer-only and does not re-apply providers", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const deployments = new InMemoryDeploymentStore();
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      deployments,
      plugins: [
        buildRecordingPlugin({
          name: "@test/postgres",
          kindUri: "https://takosumi.com/kinds/v1/postgres",
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

    const installRes = await app.request("/v1/installations", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
      }),
    });
    assertEquals(installRes.status, 201);
    const install = await installRes.json() as InstallationApplyResponse;

    const deployRes = await app.request(
      `/v1/installations/${install.installation.id}/deployments`,
      {
        method: "POST",
        headers: INSTALLER_AUTH_HEADERS,
        body: JSON.stringify({
          source: { kind: "local", url: workingDirectory },
        }),
      },
    );
    assertEquals(deployRes.status, 201);
    const deploy = await deployRes.json() as DeploymentApplyResponse;
    assertEquals(applies.length, 4);
    const before = await deployments.listForInstallation(
      install.installation.id,
    );
    assertEquals(before.length, 2);

    const rollbackRes = await app.request(
      `/v1/installations/${install.installation.id}/rollback`,
      {
        method: "POST",
        headers: INSTALLER_AUTH_HEADERS,
        body: JSON.stringify({ deploymentId: install.deployment.id }),
      },
    );
    assertEquals(rollbackRes.status, 200);
    const rollback = await rollbackRes.json() as RollbackResponse;

    const after = await deployments.listForInstallation(
      install.installation.id,
    );
    assertEquals(after.length, 2);
    assertEquals(applies.length, 4);
    assertEquals(rollback.deployment.id, install.deployment.id);
    assertEquals(
      rollback.installation.currentDeploymentId,
      install.deployment.id,
    );
    assertEquals(rollback.installation.status, "ready");
    assertEquals(rollback.rollback, {
      rolledBackFrom: deploy.deployment.id,
      rolledBackTo: install.deployment.id,
    });
    assert(!events.some((event) => event.includes("rollback")));
  });
});

Deno.test("installer e2e — apply with mismatched expected returns 409 (Phase A status flip)", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
        buildRecordingPlugin({
          name: "@test/postgres",
          kindUri: "https://takosumi.com/kinds/v1/postgres",
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
        expected: { manifestDigest: "sha256:not-a-real-digest" },
      }),
    });
    // Phase A docs flip: failed_precondition surfaces as 409 Conflict
    // (the request's expected pin conflicts with the resolved source).
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error.code, "failed_precondition");
  });
});

Deno.test("installer e2e — publish/listen cycle aborts apply with non-2xx error envelope", async () => {
  // a publishes a.out, b listens a.out and publishes b.out, a listens b.out.
  // The yaml-parser rejects this at parse time with validationPhase
  // = publish-listen.
  const cyclicSpec = `apiVersion: v1
metadata:
  id: cyclic-app
  name: Cyclic App
components:
  a:
    kind: worker
    publish:
      out:
        as: http-endpoint
    listen:
      peer:
        from: b.out
        as: env
        prefix: P2
  b:
    kind: worker
    publish:
      out:
        as: http-endpoint
    listen:
      peer:
        from: a.out
        as: env
        prefix: P1
`;
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [
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
      }),
    });
    // Parse-time cycle detection bubbles up via the route handler as a
    // 4xx / 5xx error envelope with a typed error code.
    assert(
      res.status >= 400 && res.status < 600,
      `expected error status, got ${res.status}`,
    );
    const body = await res.json();
    assert(typeof body.error.code === "string");
    // No applies ran — the parse rejected before topology computation.
    assertEquals(applies.length, 0);
  }, cyclicSpec);
});

Deno.test("installer e2e — declared local publication name resolves", async () => {
  // db publishes a local `db.primary` material; worker listens through a
  // local binding named `database`.
  const spec = `apiVersion: v1
metadata:
  id: explicit-pub
  name: Explicit Pub
components:
  db:
    kind: postgres
    publish:
      primary:
        as: service-binding
  web:
    kind: worker
    listen:
      database:
        from: db.primary
        as: env
        prefix: DB
`;
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const dbPlugin = buildRecordingPlugin({
      name: "@test/postgres",
      kindUri: "https://takosumi.com/kinds/v1/postgres",
      events,
      applies,
      outputs: { host: "db.local", port: "5432" },
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@test/worker",
      kindUri: "https://takosumi.com/kinds/v1/worker",
      events,
      applies,
    });
    const pipeline = new InstallerPipeline({
      kindAliases: TEST_KIND_ALIASES,
      plugins: [dbPlugin, workerPlugin],
    });
    const app = buildApp(pipeline);

    const dryRun = await (await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
      }),
    })).json() as InstallationDryRunResponse;

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
    // Worker saw the db material via the declared local binding.
    const dbMaterial = applies[1].listenedMaterials.database;
    assert(
      dbMaterial,
      "worker should see db material on the database binding",
    );
    assertEquals(dbMaterial.host, "db.local");
  }, spec);
});

function defaultE2ePublishMaterial(
  ctx: PublishMaterialContext,
): NamespaceMaterial {
  if (ctx.options.as === "service-binding") {
    const material: Record<string, NamespaceMaterial[string]> = {
      protocol: "postgresql",
      host: String(ctx.outputs.host ?? "db.local"),
      port: Number(ctx.outputs.port ?? 5432),
    };
    if (typeof ctx.outputs.database === "string") {
      material.database = ctx.outputs.database;
    }
    if (typeof ctx.outputs.username === "string") {
      material.username = ctx.outputs.username;
    }
    if (typeof ctx.outputs.passwordSecretRef === "string") {
      material.passwordRef = { secretRef: ctx.outputs.passwordSecretRef };
    }
    if (typeof ctx.outputs.connectionString === "string") {
      material.connectionUrl = ctx.outputs.connectionString;
    }
    return material;
  }
  const material: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.outputs)) {
    if (typeof value !== "string") {
      throw new TypeError(`expected ${key} output to be a string`);
    }
    material[key] = value;
  }
  return material;
}

function requireStringOutput(
  ctx: PublishMaterialContext,
  key: string,
): string {
  const value = ctx.outputs[key];
  if (typeof value !== "string") {
    throw new TypeError(`expected ${key} output to be a string`);
  }
  return value;
}

function assertInstallation(
  installation: Installation,
  spaceId: string,
  appId: string,
): void {
  assert(installation.id.startsWith("ins_"));
  assertEquals(installation.spaceId, spaceId);
  assertEquals(installation.appId, appId);
  assertEquals(installation.status, "ready");
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
    deployment.outputs.components === undefined ||
      typeof deployment.outputs.components === "object",
  );
  // Silence unused-import warning by referencing Component.
  const _component: Component | undefined = undefined;
  void _component;
}
