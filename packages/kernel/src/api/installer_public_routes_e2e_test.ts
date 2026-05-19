/**
 * E2E smoke for the v1 installer pipeline under the Phase C namespace
 * pub/sub model.
 *
 * Drives the public 5-endpoint surface with a real `InstallerPipeline`
 * configured via `new InstallerPipeline({ plugins: [...] })`. The
 * pub/sub-flavoured AppSpec used here exercises:
 *   - kernel auto-namespacing of `<app-id>.<component-name>`
 *   - sibling `listen:` edges resolving from the registry into
 *     `listenedMaterials` on the listener plugin's apply context
 *   - HTTP 201 on apply + status flip to 409 for the
 *     `failed_precondition` path (mismatched expected pin, pub/sub cycle)
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.5";
import { Hono } from "hono";
import { type Component, COMPONENT_KINDS } from "takosumi-contract/app-spec";
import type {
  ApplyListenContext,
  EnvInjection,
  KernelPlugin,
  NamespaceMaterial,
  PublishMaterialContext,
} from "takosumi-contract/plugin";
import type {
  Deployment,
  Installation,
  InstallationApplyResponse,
  InstallationDryRunResponse,
} from "takosumi-contract/installer-api";
import { InstallerPipeline } from "../domains/installer/mod.ts";
import { mountInstallerPublicRoutes } from "./installer_public_routes.ts";

// Canonical pub/sub AppSpec: `db` publishes its connection material at
// the auto-namespace `example-notes.db`; `web` listens with
// `as: env, prefix: DB` so the kernel default expansion produces
// DB_HOST / DB_PORT / ... env injections on the worker.
const SAMPLE_APP_SPEC_YAML = `apiVersion: takosumi.dev/v1
metadata:
  id: example-notes
  name: Example Notes
  description: Sample app spec for e2e installer pipeline tests
components:
  db:
    kind: postgres
  web:
    kind: worker
    listen:
      example-notes.db:
        as: env
        prefix: DB
`;

const INSTALLER_AUTH_HEADERS = {
  "authorization": "Bearer installer-token",
  "content-type": "application/json",
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
 * Build a recording test plugin under the new namespace pub/sub model.
 * Captures `listenedMaterials` so the test can assert auto-namespace
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
        providerResourceId:
          `${opts.name}://${ctx.installationId}/${ctx.componentName}`,
        outputs: opts.outputs ?? {},
      });
    },
    publishMaterial: opts.publishMaterial,
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

Deno.test("installer e2e — plain-array plugins drive dry-run + apply with pub/sub auto-namespacing", async () => {
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
      // Use the canonical postgres publish material shape (per the JSON-LD
      // contract: host / port / database / username / passwordSecretRef /
      // connectionString).
      publishMaterial: (ctx: PublishMaterialContext) =>
        Promise.resolve({
          host: ctx.outputs.host,
          port: ctx.outputs.port,
          database: ctx.outputs.database,
          username: ctx.outputs.username,
          passwordSecretRef: ctx.outputs.passwordSecretRef,
          connectionString: ctx.outputs.connectionString,
        }),
    });
    const workerPlugin = buildRecordingPlugin({
      name: "@test/worker",
      kindUri: "https://takosumi.com/kinds/v1/worker",
      events,
      applies,
    });
    const pipeline = new InstallerPipeline({
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
    assertEquals(apply.deployment.outputs.resources?.length, 2);

    // Topology: db (publisher) → web (listener via auto-namespace).
    assertEquals(applies.length, 2);
    assertEquals(applies[0].componentName, "db");
    assertEquals(applies[1].componentName, "web");
    // The worker apply context surfaces the resolved db material at the
    // auto-namespace path `example-notes.db`.
    const dbMaterial = applies[1].listenedMaterials["example-notes.db"];
    assert(dbMaterial, "worker should see db material on auto-namespace path");
    assertEquals(dbMaterial.host, "db.local");
    assertEquals(dbMaterial.port, "5432");
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
            DB_PORT: ctx.material.port as string,
          },
        });
      },
    });
    const pipeline = new InstallerPipeline({
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
    // The listener plugin's applyListen hook saw exactly one edge for
    // the auto-namespace path with the AppSpec listen options.
    assertEquals(captured.length, 1);
    assertEquals(captured[0].namespacePath, "example-notes.db");
    assertEquals(captured[0].options.as, "env");
    assertEquals(captured[0].options.prefix, "DB");
    assertEquals(captured[0].material.host, "h");
  });
});

Deno.test("installer e2e — apply with mismatched expected returns 409 (Phase A status flip)", async () => {
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const pipeline = new InstallerPipeline({
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
        expected: { commit: "", manifestDigest: "sha256:not-a-real-digest" },
      }),
    });
    // Phase A docs flip: failed_precondition surfaces as 409 Conflict
    // (the request's expected pin conflicts with the resolved source).
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error.code, "failed_precondition");
  });
});

Deno.test("installer e2e — pub/sub cycle aborts apply with non-2xx error envelope", async () => {
  // a publishes p1, b listens p1 and publishes p2, a listens p2 → cycle.
  // The yaml-parser rejects this at parse time with validationPhase
  // = publish-listen.
  const cyclicSpec = `apiVersion: takosumi.dev/v1
metadata:
  id: cyclic-app
  name: Cyclic App
components:
  a:
    kind: worker
    publish:
      - com.example.p1
    listen:
      com.example.p2:
        as: env
        prefix: P2
  b:
    kind: worker
    publish:
      - com.example.p2
    listen:
      com.example.p1:
        as: env
        prefix: P1
`;
  await withTempSource(async (workingDirectory) => {
    const events: string[] = [];
    const applies: ApplyRecord[] = [];
    const pipeline = new InstallerPipeline({
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

Deno.test("installer e2e — auto-namespacing also exposes explicit publish paths", async () => {
  // db publishes its material at both the auto path AND an explicit
  // operator-defined path; worker listens on the explicit path.
  const spec = `apiVersion: takosumi.dev/v1
metadata:
  id: explicit-pub
  name: Explicit Pub
components:
  db:
    kind: postgres
    publish:
      - operator.databases.primary
  web:
    kind: worker
    listen:
      operator.databases.primary:
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
    // Worker saw the db material via the explicit path it listens on.
    const dbMaterial =
      applies[1].listenedMaterials["operator.databases.primary"];
    assert(
      dbMaterial,
      "worker should see db material on the explicit publish path",
    );
    assertEquals(dbMaterial.host, "db.local");
  }, spec);
});

Deno.test("AppSpec frozen kind catalog excludes oidc (moved to Takosumi Accounts)", () => {
  const expected = ["worker", "postgres", "object-store", "custom-domain"];
  for (const kind of expected) {
    assert(
      (COMPONENT_KINDS as readonly string[]).includes(kind),
      `${kind} should be in COMPONENT_KINDS`,
    );
  }
  assert(
    !(COMPONENT_KINDS as readonly string[]).includes("oidc"),
    "oidc should no longer be a built-in kernel kind",
  );
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
      resource.kind.startsWith("https://")
    ),
  );
  // Silence unused-import warning by referencing Component.
  const _component: Component | undefined = undefined;
  void _component;
}
