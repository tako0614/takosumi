/**
 * BindingResolver unit tests.
 *
 * Covers:
 *   - kernel default env expansion (`as: env` + `prefix: DB` →
 *     `DB_HOST` / `DB_PORT` style env keys)
 *   - operator-defined applyListen hook override
 *   - `as: upstream` / `as: mount` shape handling
 *   - end-to-end `resolveAppSpec` against a multi-component AppSpec
 */

import assert from "node:assert/strict";
import { APP_SPEC_API_VERSION, type AppSpec } from "takosumi-contract/app-spec";
import type {
  ApplyListenContext,
  EnvInjection,
  KernelPlugin,
  NamespaceMaterial,
} from "takosumi-contract/reference/plugin";
import { BindingResolver, defaultEnvInjection } from "./mod.ts";

Deno.test("defaultEnvInjection expands env-shape material with a prefix", () => {
  const material: NamespaceMaterial = {
    host: "db.local",
    port: "5432",
    passwordSecretRef: { secretRef: "secret://db-password" },
  };
  const injection = defaultEnvInjection(
    { from: "db.connection", as: "env", prefix: "DB" },
    material,
  );
  assert.deepEqual(injection.env, {
    DB_HOST: "db.local",
    DB_PORT: "5432",
    DB_PASSWORD_SECRET_REF: { secretRef: "secret://db-password" },
  });
});

Deno.test("defaultEnvInjection as: secret-env strips secret Ref suffix from env names", () => {
  const material: NamespaceMaterial = {
    issuerUrl: "https://accounts.example.test",
    clientId: "client_test",
    clientSecretRef: { secretRef: "secret://oidc/client-secret" },
  };
  const injection = defaultEnvInjection(
    { from: "operator.identity.oidc", as: "secret-env", prefix: "OIDC" },
    material,
  );
  assert.deepEqual(injection.env, {
    OIDC_ISSUER_URL: "https://accounts.example.test",
    OIDC_CLIENT_ID: "client_test",
    OIDC_CLIENT_SECRET: { secretRef: "secret://oidc/client-secret" },
  });
});

Deno.test("defaultEnvInjection without prefix emits bare upper-snake keys", () => {
  const material: NamespaceMaterial = { url: "https://w.example/" };
  const injection = defaultEnvInjection(
    { from: "web.http", as: "env" },
    material,
  );
  assert.deepEqual(injection.env, { URL: "https://w.example/" });
});

Deno.test("defaultEnvInjection serializes non-secret JSON material for env", () => {
  const material: NamespaceMaterial = {
    routes: [{ pathPrefix: "/", to: "app" }],
  };
  const injection = defaultEnvInjection(
    { from: "public.public", as: "env", prefix: "HTTP" },
    material,
  );
  assert.deepEqual(injection.env, {
    HTTP_ROUTES: JSON.stringify([{ pathPrefix: "/", to: "app" }]),
  });
});

Deno.test("defaultEnvInjection as: upstream surfaces material verbatim", () => {
  const material: NamespaceMaterial = { url: "https://w.example/" };
  const injection = defaultEnvInjection(
    { from: "web.http", as: "upstream" },
    material,
  );
  assert.deepEqual(injection.target, material);
});

Deno.test("defaultEnvInjection as: mount writes deterministic mount descriptor", () => {
  const material: NamespaceMaterial = {
    fqdn: "notes.example.com",
    certificateId: "cert_123",
  };
  const injection = defaultEnvInjection(
    { from: "domain.tls", as: "mount", mount: "/srv" },
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
    options: { from: "database.connection", as: "env", prefix: "DB" },
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
    options: { from: "database.connection", as: "env", prefix: "DB" },
    material: { host: "db.local", port: "5432" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].bindingName, "db");
  assert.equal(captured[0].sourceRef, "database.connection");
  assert.deepEqual(binding.envInjections, { CUSTOM_HOST: "db.local" });
});

Deno.test("BindingResolver.resolveAppSpec emits one binding per listen edge", async () => {
  const resolver = new BindingResolver();
  const appSpec: AppSpec = {
    apiVersion: APP_SPEC_API_VERSION,
    metadata: { id: "demo", name: "Demo" },
    components: {
      db: { kind: "postgres" },
      web: {
        kind: "worker",
        publish: { http: { as: "http-endpoint" } },
        listen: {
          db: { from: "db.connection", as: "env", prefix: "DB" },
        },
      },
      router: {
        kind: "gateway",
        listen: { app: { from: "web.http", as: "upstream" } },
      },
    },
  };
  const materials: Record<string, NamespaceMaterial> = {
    "db.connection": { host: "db.local", port: "5432" },
    "web.http": { url: "https://web.local/" },
  };
  const bindings = await resolver.resolveAppSpec(appSpec, materials);
  assert.equal(bindings.length, 2);
  const byListener = new Map(bindings.map((b) => [b.listenerComponent, b]));
  assert.deepEqual(byListener.get("web")?.envInjections, {
    DB_HOST: "db.local",
    DB_PORT: "5432",
  });
  assert.deepEqual(byListener.get("router")?.target, {
    url: "https://web.local/",
  });
});

Deno.test("BindingResolver.resolveAppSpec silently skips listens to unknown paths", async () => {
  const resolver = new BindingResolver();
  const appSpec: AppSpec = {
    apiVersion: APP_SPEC_API_VERSION,
    metadata: { id: "demo", name: "Demo" },
    components: {
      web: {
        kind: "worker",
        listen: {
          oidc: { from: "operator.identity.oidc", as: "env" },
        },
      },
    },
  };
  const bindings = await resolver.resolveAppSpec(appSpec, {});
  assert.deepEqual(bindings, []);
});
