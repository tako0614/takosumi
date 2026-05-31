import { expect, test } from "bun:test";
/**
 * E2E smoke for the v1 installer pipeline under the Phase C component-output
 * connection model.
 *
 * Drives the public 5-endpoint surface with a real `InstallerPipeline`
 * configured via `new InstallerPipeline({ plugins: [...] })`. The
 * connect/listen AppSpec used here exercises:
 *   - explicit component output refs such as `db.connection`
 *   - sibling `connect:` bindings resolving from the registry into
 *     `inputMaterials` on the consumer plugin's apply context
 *   - HTTP 201 on apply + status flip to 409 for the
 *     `failed_precondition` path (mismatched expected pin, connect cycle)
 */

import { Hono } from "hono";
import type { Component } from "takosumi-contract/app-spec";
import type {
  ApplyInputBindingContext,
  EnvInjection,
  KernelPlugin,
  OutputMaterial,
  OutputMaterialContext,
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

// Canonical AppSpec: `db` produces `db.connection`; `web` connects with
// `inject: env, prefix: DB` so the kernel default expansion produces DB_HOST /
// DB_PORT / ... env injections on the worker.
const SAMPLE_APP_SPEC_YAML = `apiVersion: v1
metadata:
  id: example-notes
  name: Example Notes
  description: Sample app spec for e2e installer pipeline tests
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
  readonly inputMaterials: Readonly<Record<string, OutputMaterial>>;
  readonly installationId: string;
}

/**
 * Build a recording test plugin under the connect/listen model.
 * Captures `inputMaterials` so the test can assert local output
 * resolution and lifecycle hook invocations so we can assert ordering.
 */
function buildRecordingPlugin(opts: {
  readonly name: string;
  readonly kindUri: string;
  readonly events: string[];
  readonly applies: ApplyRecord[];
  readonly outputs?: Readonly<Record<string, string>>;
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
    provides: [opts.kindUri],
    apply: (ctx) => {
      opts.applies.push({
        componentName: ctx.componentName,
        inputMaterials: ctx.inputMaterials ?? ctx.listenedMaterials,
        installationId: ctx.installationId,
      });
      opts.events.push(`apply:${opts.name}:${ctx.componentName}`);
      return Promise.resolve({
        resourceHandle:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    materializeOutput: opts.materializeOutput ??
      ((ctx) => Promise.resolve(defaultE2ePublishMaterial(ctx))),
    applyBinding: opts.applyBinding,
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

test("installer e2e — plain-array plugins drive dry-run + apply with local outputs", async () => {
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
        connectionString: "postgres://notes@db.local:5432/notes",
      },
      // The kind implementation decides how its `connection` output is
      // projected from implementation-local provider outputs.
      materializeOutput: (ctx: OutputMaterialContext) =>
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
    expect(dryRunRes.status).toEqual(200);
    const dryRun = await dryRunRes.json() as InstallationDryRunResponse;
    expect(dryRun.manifestDigest.startsWith("sha256:")).toBeTruthy();
    expect(dryRun.appSpec.metadata.id).toEqual("example-notes");
    expect(dryRun.changes.length).toEqual(2);
    expect(dryRun.changes.every((change) => change.op === "create")).toBeTruthy();

    const applyRes = await app.request("/v1/installations", {
      method: "POST",
      headers: INSTALLER_AUTH_HEADERS,
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: workingDirectory },
        expected: dryRun.expected,
      }),
    });
    expect(applyRes.status).toEqual(201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    assertInstallation(apply.installation, "space_test", "example-notes");
    assertDeployment(
      apply.deployment,
      apply.installation.id,
      dryRun.manifestDigest,
    );
    expect(apply.deployment.status).toEqual("succeeded");
    expect(Object.keys(apply.deployment.outputs.components ?? {})).toEqual([
      "db",
    ]);
    expect(apply.deployment.outputs.components?.db?.connection).toEqual({
        protocol: "postgresql",
        host: "db.local",
        port: 5432,
        database: "notes",
        username: "notes",
        passwordRef: { secretRef: "secret://db-password" },
        connectionUrl: "postgres://notes@db.local:5432/notes",
      });

    // Topology: db (producer) -> web (consumer via db.connection).
    expect(applies.length).toEqual(2);
    expect(applies[0].componentName).toEqual("db");
    expect(applies[1].componentName).toEqual("web");
    const dbMaterial = applies[1].inputMaterials.db;
    expect(dbMaterial).toBeTruthy();
    expect(dbMaterial.host).toEqual("db.local");
    expect(dbMaterial.port).toEqual(5432);
    expect(dbMaterial.database).toEqual("notes");

    // First-install lifecycle hook ordering: install hooks bracket
    // deployment hooks, deployment hooks bracket per-component applies.
    expect(events).toEqual([
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

test("installer e2e — applyBinding receives material with prefixed env", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const captured: ApplyInputBindingContext[] = [];
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
      applyBinding: (ctx) => {
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
    expect(applyRes.status).toEqual(201);
    // The consumer plugin's applyBinding hook saw exactly one binding with
    // the AppSpec connect options.
    expect(captured.length).toEqual(1);
    expect(captured[0].bindingName).toEqual("db");
    expect(captured[0].sourceRef).toEqual("db.connection");
    expect(captured[0].options.inject).toEqual("env");
    expect(captured[0].options.prefix).toEqual("DB");
    expect(captured[0].material.host).toEqual("h");
  });
});

test("installer e2e — rollback is pointer-only and does not re-apply providers", async () => {
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
    expect(installRes.status).toEqual(201);
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
    expect(deployRes.status).toEqual(201);
    const deploy = await deployRes.json() as DeploymentApplyResponse;
    expect(applies.length).toEqual(4);
    const before = await deployments.listForInstallation(
      install.installation.id,
    );
    expect(before.length).toEqual(2);

    const rollbackRes = await app.request(
      `/v1/installations/${install.installation.id}/rollback`,
      {
        method: "POST",
        headers: INSTALLER_AUTH_HEADERS,
        body: JSON.stringify({ deploymentId: install.deployment.id }),
      },
    );
    expect(rollbackRes.status).toEqual(200);
    const rollback = await rollbackRes.json() as RollbackResponse;

    const after = await deployments.listForInstallation(
      install.installation.id,
    );
    expect(after.length).toEqual(2);
    expect(applies.length).toEqual(4);
    expect(rollback.deployment.id).toEqual(install.deployment.id);
    expect(rollback.installation.currentDeploymentId).toEqual(install.deployment.id);
    expect(rollback.installation.status).toEqual("ready");
    expect(rollback.rollback).toEqual({
      rolledBackFrom: deploy.deployment.id,
      rolledBackTo: install.deployment.id,
      scope: {
        pointer: "reverted",
        resourceMaterialization: "not-reapplied",
        workloadState: "not-reverted",
      },
    });
    expect(!events.some((event) => event.includes("rollback"))).toBeTruthy();
  });
});

test("installer e2e — apply with mismatched expected returns 409 (Phase A status flip)", async () => {
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
    expect(res.status).toEqual(409);
    const body = await res.json();
    expect(body.error.code).toEqual("failed_precondition");
  });
});

test("installer e2e — connect cycle aborts apply with non-2xx error envelope", async () => {
  // a connects to b.out and b connects to a.out.
  // The yaml-parser rejects this at parse time with validationPhase
  // = connection-resolution.
  const cyclicSpec = `apiVersion: v1
metadata:
  id: cyclic-app
  name: Cyclic App
components:
  a:
    kind: worker
    connect:
      peer:
        output: b.out
        inject: env
        prefix: P2
  b:
    kind: worker
    connect:
      peer:
        output: a.out
        inject: env
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
    // Parse-time cycle detection (validationPhase=connection-resolution) is
    // surfaced on the closed error envelope as `invalid_argument` / HTTP 400,
    // not a generic 500 internal_error.
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.error.code).toEqual("invalid_argument");
    // No applies ran — the parse rejected before topology computation.
    expect(applies.length).toEqual(0);
  }, cyclicSpec);
});

test("installer e2e — declared component output name resolves", async () => {
  // db produces a local `db.primary` material; worker connects through a
  // local binding named `database`.
  const spec = `apiVersion: v1
metadata:
  id: explicit-pub
  name: Explicit Pub
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      database:
        output: db.primary
        inject: env
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
    expect(applyRes.status).toEqual(201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    expect(apply.deployment.status).toEqual("succeeded");
    // Worker saw the db material via the declared local binding.
    const dbMaterial = applies[1].inputMaterials.database;
    expect(dbMaterial).toBeTruthy();
    expect(dbMaterial.host).toEqual("db.local");
  }, spec);
});

function defaultE2ePublishMaterial(
  ctx: OutputMaterialContext,
): OutputMaterial {
  if (ctx.outputName === "connection" || ctx.outputName === "primary") {
    const material: Record<string, OutputMaterial[string]> = {
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
  ctx: OutputMaterialContext,
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
  expect(installation.id.startsWith("ins_")).toBeTruthy();
  expect(installation.spaceId).toEqual(spaceId);
  expect(installation.appId).toEqual(appId);
  expect(installation.status).toEqual("ready");
  expect(typeof installation.createdAt === "number").toBeTruthy();
}

function assertDeployment(
  deployment: Deployment,
  installationId: string,
  manifestDigest: string,
): void {
  expect(deployment.id.startsWith("dep_")).toBeTruthy();
  expect(deployment.installationId).toEqual(installationId);
  expect(deployment.manifestDigest).toEqual(manifestDigest);
  expect(typeof deployment.createdAt === "number").toBeTruthy();
  expect(deployment.outputs.components === undefined ||
      typeof deployment.outputs.components === "object").toBeTruthy();
  // Silence unused-import warning by referencing Component.
  const _component: Component | undefined = undefined;
  void _component;
}
