import assert from "node:assert/strict";
import type { ManifestResource } from "takosumi-contract";
import { buildRefDag, resolveSpecRefs } from "./ref_resolver_v2.ts";

Deno.test("buildRefDag orders independent resources alphabetically", () => {
  const resources: ManifestResource[] = [
    { shape: "x@v1", name: "z", provider: "p", spec: {} },
    { shape: "x@v1", name: "a", provider: "p", spec: {} },
    { shape: "x@v1", name: "m", provider: "p", spec: {} },
  ];
  const dag = buildRefDag(resources);
  assert.deepEqual([...dag.order], ["a", "m", "z"]);
  assert.equal(dag.issues.length, 0);
});

Deno.test("buildRefDag orders by ref dependencies", () => {
  const resources: ManifestResource[] = [
    {
      shape: "x@v1",
      name: "web",
      provider: "p",
      spec: { db: "${ref:db.url}", bucket: "${ref:store.bucket}" },
    },
    { shape: "x@v1", name: "store", provider: "p", spec: {} },
    { shape: "x@v1", name: "db", provider: "p", spec: {} },
  ];
  const dag = buildRefDag(resources);
  const webIndex = dag.order.indexOf("web");
  const dbIndex = dag.order.indexOf("db");
  const storeIndex = dag.order.indexOf("store");
  assert.ok(dbIndex < webIndex);
  assert.ok(storeIndex < webIndex);
  assert.equal(dag.issues.length, 0);
});

Deno.test("buildRefDag detects cycles", () => {
  const resources: ManifestResource[] = [
    { shape: "x@v1", name: "a", provider: "p", spec: { ref: "${ref:b.x}" } },
    { shape: "x@v1", name: "b", provider: "p", spec: { ref: "${ref:a.x}" } },
  ];
  const dag = buildRefDag(resources);
  assert.ok(dag.issues.some((i) => i.message.includes("cycle")));
});

Deno.test("buildRefDag rejects self-reference", () => {
  const resources: ManifestResource[] = [
    { shape: "x@v1", name: "a", provider: "p", spec: { ref: "${ref:a.x}" } },
  ];
  const dag = buildRefDag(resources);
  assert.ok(dag.issues.some((i) => i.message.includes("itself")));
});

Deno.test("buildRefDag rejects unknown ref source", () => {
  const resources: ManifestResource[] = [
    {
      shape: "x@v1",
      name: "a",
      provider: "p",
      spec: { ref: "${ref:missing.x}" },
    },
  ];
  const dag = buildRefDag(resources);
  assert.ok(dag.issues.some((i) => i.message.includes("missing")));
});

Deno.test("resolveSpecRefs replaces full ref expression with value", () => {
  const result = resolveSpecRefs(
    { db: "${ref:db.url}", port: 8080 },
    {
      outputs: new Map([["db", { url: "postgres://x" }]]),
    },
  );
  assert.deepEqual(result, { db: "postgres://x", port: 8080 });
});

Deno.test("resolveSpecRefs supports interpolation in strings", () => {
  const result = resolveSpecRefs(
    "host=${ref:db.host}:port=${ref:db.port}",
    {
      outputs: new Map([["db", { host: "h", port: 5432 }]]),
    },
  );
  assert.equal(result, "host=h:port=5432");
});

Deno.test("resolveSpecRefs walks nested objects and arrays", () => {
  const result = resolveSpecRefs(
    {
      env: {
        DB: "${ref:db.url}",
      },
      list: ["${ref:db.host}", "literal"],
    },
    {
      outputs: new Map([["db", { url: "u", host: "h" }]]),
    },
  );
  assert.deepEqual(result, {
    env: { DB: "u" },
    list: ["h", "literal"],
  });
});

Deno.test("resolveSpecRefs leaves unresolved refs intact", () => {
  const result = resolveSpecRefs("${ref:missing.x}", {
    outputs: new Map(),
  });
  assert.equal(result, "${ref:missing.x}");
});

Deno.test("resolveSpecRefs uses secretResolver for secret-ref expressions", () => {
  const result = resolveSpecRefs(
    "${secret-ref:db.password}",
    {
      outputs: new Map(),
      secretResolver: (source, field) => `secret:${source}/${field}`,
    },
  );
  assert.equal(result, "secret:db/password");
});
