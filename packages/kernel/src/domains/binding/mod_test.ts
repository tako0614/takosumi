/**
 * BindingResolver unit tests.
 *
 * Covers:
 *   - kernel default env expansion (`inject: env` + `prefix: DB` →
 *     `DB_HOST` / `DB_PORT` style env keys)
 *   - operator-defined applyBinding / applyListen hook overrides
 *   - `inject: upstream` / `inject: config-mount` shape handling
 *   - end-to-end `resolveAppSpec` against a multi-component AppSpec
 */

import assert from "node:assert/strict";
import { APP_SPEC_API_VERSION, type AppSpec } from "takosumi-contract/app-spec";
import type {
  ApplyInputBindingContext,
  ApplyListenContext,
  EnvInjection,
  KernelPlugin,
  OutputMaterial,
} from "takosumi-contract/reference/plugin";
import { PROJECTION_FAMILY_NAMES } from "takosumi-contract/catalog";
import {
  BindingResolutionError,
  BindingResolver,
  defaultEnvInjection,
} from "./mod.ts";

Deno.test("defaultEnvInjection implements exactly the official projection families", () => {
  assert.deepEqual([...PROJECTION_FAMILY_NAMES].sort(), [
    "config-mount",
    "env",
    "secret-env",
    "upstream",
  ]);

  const material: OutputMaterial = {
    url: "https://service.internal",
    clientSecretRef: { secretRef: "secret://client-secret" },
  };

  assert.deepEqual(
    defaultEnvInjection({ output: "service.http", inject: "env" }, material)
      .env,
    {
      URL: "https://service.internal",
      CLIENT_SECRET_REF: { secretRef: "secret://client-secret" },
    },
  );
  assert.deepEqual(
    defaultEnvInjection(
      { output: "service.http", inject: "secret-env" },
      material,
    ).env,
    {
      URL: "https://service.internal",
      CLIENT_SECRET: { secretRef: "secret://client-secret" },
    },
  );
  assert.deepEqual(
    defaultEnvInjection(
      { output: "service.http", inject: "upstream" },
      material,
    )
      .target,
    material,
  );
  assert.deepEqual(
    Object.keys(
      defaultEnvInjection({
        output: "service.http",
        inject: "config-mount",
        mount: "/bindings/service",
      }, material).mounts ?? {},
    ),
    ["/bindings/service"],
  );
});

Deno.test("defaultEnvInjection treats non-official projection names as env expansion", () => {
  const material: OutputMaterial = {
    url: "https://service.internal",
  };
  const injection = defaultEnvInjection(
    { output: "service.http", inject: "target", prefix: "UPSTREAM" },
    material,
  );
  assert.deepEqual(injection, {
    env: { UPSTREAM_URL: "https://service.internal" },
  });
});

Deno.test("defaultEnvInjection expands env-shape material with a prefix", () => {
  const material: OutputMaterial = {
    host: "db.local",
    port: "5432",
    passwordSecretRef: { secretRef: "secret://db-password" },
  };
  const injection = defaultEnvInjection(
    { output: "db.connection", inject: "env", prefix: "DB" },
    material,
  );
  assert.deepEqual(injection.env, {
    DB_HOST: "db.local",
    DB_PORT: "5432",
    DB_PASSWORD_SECRET_REF: { secretRef: "secret://db-password" },
  });
});

Deno.test("defaultEnvInjection inject: secret-env strips secret Ref suffix from env names", () => {
  const material: OutputMaterial = {
    issuerUrl: "https://accounts.example.test",
    clientId: "client_test",
    clientSecretRef: { secretRef: "secret://oidc/client-secret" },
  };
  const injection = defaultEnvInjection(
    {
      output: "identity.primary.oidc",
      inject: "secret-env",
      prefix: "OIDC",
    },
    material,
  );
  assert.deepEqual(injection.env, {
    OIDC_ISSUER_URL: "https://accounts.example.test",
    OIDC_CLIENT_ID: "client_test",
    OIDC_CLIENT_SECRET: { secretRef: "secret://oidc/client-secret" },
  });
});

Deno.test("defaultEnvInjection without prefix emits bare upper-snake keys", () => {
  const material: OutputMaterial = { url: "https://w.example/" };
  const injection = defaultEnvInjection(
    { output: "web.http", inject: "env" },
    material,
  );
  assert.deepEqual(injection.env, { URL: "https://w.example/" });
});

Deno.test("defaultEnvInjection rejects material fields that collide on the same env key", () => {
  // `fooBar` and `foo_bar` both normalize to FOO_BAR. Silently last-write-wins
  // would inject only one (arbitrary) value, so the resolver throws instead.
  const material: OutputMaterial = { fooBar: "camel", foo_bar: "snake" };
  assert.throws(
    () => defaultEnvInjection({ output: "svc.out", inject: "env" }, material),
    (error: unknown) =>
      error instanceof BindingResolutionError &&
      error.code === "binding_env_key_collision",
  );
});

Deno.test("defaultEnvInjection secret-env rejects clientSecret / clientSecretRef collision", () => {
  // Under stripSecretRefSuffix both `clientSecret` and `clientSecretRef` map
  // to CLIENT_SECRET; surfacing the collision avoids injecting the wrong
  // secret value into the consumer's env.
  const material: OutputMaterial = {
    clientSecret: "plaintext",
    clientSecretRef: { secretRef: "secret://client-secret" },
  };
  assert.throws(
    () =>
      defaultEnvInjection(
        { output: "svc.out", inject: "secret-env" },
        material,
      ),
    (error: unknown) =>
      error instanceof BindingResolutionError &&
      error.code === "binding_env_key_collision",
  );
});

Deno.test("defaultEnvInjection serializes non-secret JSON material for env", () => {
  const material: OutputMaterial = {
    routes: [{ pathPrefix: "/", to: "app" }],
  };
  const injection = defaultEnvInjection(
    { output: "public.public", inject: "env", prefix: "HTTP" },
    material,
  );
  assert.deepEqual(injection.env, {
    HTTP_ROUTES: JSON.stringify([{ pathPrefix: "/", to: "app" }]),
  });
});

Deno.test("defaultEnvInjection inject: upstream surfaces material verbatim", () => {
  const material: OutputMaterial = {
    targets: [{ name: "default", url: "https://w.example/" }],
  };
  const injection = defaultEnvInjection(
    { output: "web.http", inject: "upstream" },
    material,
  );
  assert.deepEqual(injection.target, material);
});

Deno.test("defaultEnvInjection inject: config-mount writes deterministic mount descriptor", () => {
  const material: OutputMaterial = {
    fqdn: "notes.example.com",
    certificateId: "cert_123",
  };
  const injection = defaultEnvInjection(
    { output: "domain.tls", inject: "config-mount", mount: "/srv" },
    material,
  );
  assert.deepEqual(Object.keys(injection.mounts ?? {}), ["/srv"]);
});

Deno.test("BindingResolver falls back to kernel default when no materializer found", async () => {
  const resolver = new BindingResolver();
  const binding = await resolver.resolveEdge({
    installationId: "ins_x",
    listenerComponent: "web",
    listenerKind: "worker",
    listenerComponentRef: { kind: "worker" },
    bindingName: "db",
    sourceRef: "database.connection",
    options: { output: "database.connection", inject: "env", prefix: "DB" },
    material: { host: "db.local", port: "5432" },
  });
  assert.equal(binding.bindingName, "db");
  assert.equal(binding.sourceRef, "database.connection");
  assert.equal(binding.listenerComponent, "web");
  assert.deepEqual(binding.envInjections, {
    DB_HOST: "db.local",
    DB_PORT: "5432",
  });
});

Deno.test("BindingResolver invokes plugin.applyListen when present", async () => {
  const captured: ApplyListenContext[] = [];
  const plugin: KernelPlugin = {
    name: "@test/worker",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    apply: () => Promise.resolve({ resourceHandle: "x", outputs: {} }),
    applyListen: (ctx): Promise<EnvInjection> => {
      captured.push(ctx);
      return Promise.resolve({
        env: { CUSTOM_HOST: ctx.material.host as string },
      });
    },
  };
  const resolver = new BindingResolver({
    findMaterializer: () => plugin,
  });
  const binding = await resolver.resolveEdge({
    installationId: "ins_x",
    listenerComponent: "web",
    listenerKind: "worker",
    listenerComponentRef: { kind: "worker" },
    bindingName: "db",
    sourceRef: "database.connection",
    options: { output: "database.connection", inject: "env", prefix: "DB" },
    material: { host: "db.local", port: "5432" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].bindingName, "db");
  assert.equal(captured[0].sourceRef, "database.connection");
  assert.deepEqual(binding.envInjections, { CUSTOM_HOST: "db.local" });
});

Deno.test("BindingResolver prefers plugin.applyBinding over legacy applyListen", async () => {
  const captured: ApplyInputBindingContext[] = [];
  const plugin: KernelPlugin = {
    name: "@test/worker",
    version: "1.0.0",
    provides: ["https://takosumi.com/kinds/v1/worker"],
    apply: () => Promise.resolve({ resourceHandle: "x", outputs: {} }),
    applyBinding: (ctx): Promise<EnvInjection> => {
      captured.push(ctx);
      return Promise.resolve({ env: { FROM_BINDING: "yes" } });
    },
    applyListen: () => Promise.resolve({ env: { FROM_LISTEN: "no" } }),
  };
  const resolver = new BindingResolver({
    findMaterializer: () => plugin,
  });
  const binding = await resolver.resolveEdge({
    installationId: "ins_x",
    listenerComponent: "web",
    listenerKind: "worker",
    listenerComponentRef: { kind: "worker" },
    bindingName: "db",
    sourceRef: "database.connection",
    options: { output: "database.connection", inject: "env", prefix: "DB" },
    material: { host: "db.local" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].bindingName, "db");
  assert.deepEqual(binding.envInjections, { FROM_BINDING: "yes" });
});

Deno.test("BindingResolver.resolveAppSpec emits one binding per connect/listen edge", async () => {
  const resolver = new BindingResolver();
  const appSpec: AppSpec = {
    apiVersion: APP_SPEC_API_VERSION,
    metadata: { id: "demo", name: "Demo" },
    components: {
      db: { kind: "postgres" },
      web: {
        kind: "worker",
        connect: {
          db: { output: "db.connection", inject: "env", prefix: "DB" },
        },
      },
      router: {
        kind: "gateway",
        connect: { app: { output: "web.http", inject: "upstream" } },
      },
    },
  };
  const materials: Record<string, OutputMaterial> = {
    "db.connection": { host: "db.local", port: "5432" },
    "web.http": {
      targets: [{ name: "default", url: "https://web.local/" }],
    },
  };
  const bindings = await resolver.resolveAppSpec(appSpec, materials);
  assert.equal(bindings.length, 2);
  const byListener = new Map(bindings.map((b) => [b.listenerComponent, b]));
  assert.deepEqual(byListener.get("web")?.envInjections, {
    DB_HOST: "db.local",
    DB_PORT: "5432",
  });
  assert.deepEqual(byListener.get("router")?.target, {
    targets: [{ name: "default", url: "https://web.local/" }],
  });
});

Deno.test("BindingResolver.resolveAppSpec silently skips unresolved platform listens", async () => {
  const resolver = new BindingResolver();
  const appSpec: AppSpec = {
    apiVersion: APP_SPEC_API_VERSION,
    metadata: { id: "demo", name: "Demo" },
    components: {
      web: {
        kind: "worker",
        listen: {
          oidc: { path: "identity.primary.oidc", inject: "env" },
        },
      },
    },
  };
  const bindings = await resolver.resolveAppSpec(appSpec, {});
  assert.deepEqual(bindings, []);
});
