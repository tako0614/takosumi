import assert from "node:assert/strict";
import {
  extractRefs,
  extractRefsFromValue,
  parseRef,
  type ResolvedRef,
  TAKOSUMI_MANIFEST_JSONLD_CONTEXT,
  validateManifestEnvelope,
} from "./manifest-resource.ts";

Deno.test("validateManifestEnvelope accepts JSON-LD @context", () => {
  const issues: { path: string; message: string }[] = [];
  validateManifestEnvelope({
    "@context": TAKOSUMI_MANIFEST_JSONLD_CONTEXT,
    apiVersion: "1.0",
    kind: "Manifest",
    resources: [{
      shape: "object-store@v1",
      name: "assets",
      provider: "@takos/selfhost-filesystem",
      spec: { name: "assets" },
    }],
  }, issues);
  assert.deepEqual(issues, []);
});

Deno.test("validateManifestEnvelope accepts Shape resource without provider pin", () => {
  const issues: { path: string; message: string }[] = [];
  validateManifestEnvelope({
    "@context": TAKOSUMI_MANIFEST_JSONLD_CONTEXT,
    apiVersion: "1.0",
    kind: "Manifest",
    resources: [{
      shape: "object-store@v1",
      name: "assets",
      spec: { name: "assets" },
    }],
  }, issues);
  assert.deepEqual(issues, []);
});

Deno.test("validateManifestEnvelope rejects removed service import fields", () => {
  const issues: { path: string; message: string }[] = [];
  validateManifestEnvelope({
    apiVersion: "1.0",
    kind: "Manifest",
    namespace: "takosumi",
    services: [{
      id: "takosumi.account.auth",
      version: "v1",
      contract: "takosumi.account.auth@v1",
      endpoints: [{
        role: "oidc-issuer",
        url: "${refs.account-auth.outputs.url}",
        path: "/",
      }],
      metadata: { pairwiseSubjectMode: true },
      publish: {
        anchors: ["https://anchor.example.com/v1/services/"],
        signing: { privateKeyRef: "${secrets.provider-key}" },
      },
    }],
    serviceResolvers: [{
      kind: "anchor",
      url: "https://anchor.example.com/v1/services/",
      publicKey: "${secrets.anchor-publickey}",
    }],
    imports: [{
      alias: "account-auth",
      service: "takosumi.account.auth@v1",
      refreshPolicy: { kind: "ttl", ttl: "300s" },
    }],
    resources: [],
  }, issues);

  assert.deepEqual(issues.map((issue) => issue.path), [
    "$.services",
    "$.serviceResolvers",
    "$.imports",
  ]);
});

Deno.test("validateManifestEnvelope rejects service import pin metadata", () => {
  const issues: { path: string; message: string }[] = [];
  validateManifestEnvelope({
    apiVersion: "1.0",
    kind: "Manifest",
    metadata: {
      name: "logs",
      takosumiServiceImports: {
        kind: "takosumi.service-import-pins@v1",
        pins: [],
      },
    },
    resources: [],
  }, issues);

  assert.deepEqual(issues.map((issue) => issue.path), [
    "$.metadata.takosumiServiceImports",
  ]);
});

Deno.test("validateManifestEnvelope rejects malformed JSON-LD @context", () => {
  const issues: { path: string; message: string }[] = [];
  validateManifestEnvelope({
    "@context": [],
    apiVersion: "1.0",
    kind: "Manifest",
    resources: [],
  }, issues);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, '$["@context"]');
});

Deno.test("parseRef accepts ${ref:source.field}", () => {
  assert.deepEqual(parseRef("${ref:db.connection-string}"), {
    kind: "ref",
    source: "db",
    field: "connection-string",
  });
});

Deno.test("parseRef accepts ${secret-ref:source.field}", () => {
  assert.deepEqual(parseRef("${secret-ref:db.password}"), {
    kind: "secret-ref",
    source: "db",
    field: "password",
  });
});

Deno.test("parseRef rejects partial / interpolated strings", () => {
  assert.equal(parseRef("prefix-${ref:db.url}"), undefined);
  assert.equal(parseRef("${ref:db.url}-suffix"), undefined);
  assert.equal(parseRef("plain string"), undefined);
  assert.equal(parseRef(""), undefined);
});

Deno.test("parseRef rejects malformed names", () => {
  assert.equal(parseRef("${ref:db}"), undefined);
  assert.equal(parseRef("${ref:.field}"), undefined);
  assert.equal(parseRef("${ref:db.}"), undefined);
  assert.equal(parseRef("${unknown:db.field}"), undefined);
});

Deno.test("extractRefs finds all refs in interpolated string", () => {
  const refs = extractRefs(
    "postgres://${ref:db.username}:${secret-ref:db.password}@${ref:db.host}:5432",
  );
  assert.equal(refs.length, 3);
  assert.equal(refs[0].kind, "ref");
  assert.equal(refs[0].source, "db");
  assert.equal(refs[0].field, "username");
  assert.equal(refs[1].kind, "secret-ref");
  assert.equal(refs[1].field, "password");
  assert.equal(refs[2].field, "host");
});

Deno.test("extractRefs returns empty for plain strings", () => {
  assert.deepEqual(extractRefs("no refs here"), []);
});

Deno.test("extractRefsFromValue walks nested JSON tree", () => {
  const refs = extractRefsFromValue({
    image: "ghcr.io/me/api:latest",
    env: {
      DB_URL: "${ref:db.connection-string}",
      BUCKET: "${ref:assets.bucket}",
    },
    secrets: ["${secret-ref:db.password}"],
    plain: "value",
    count: 3,
    enabled: true,
  });
  assert.equal(refs.length, 3);
  const sources = new Set(refs.map((r: ResolvedRef) => r.source));
  assert.ok(sources.has("db"));
  assert.ok(sources.has("assets"));
});

Deno.test("extractRefs handles consecutive refs without separator", () => {
  const refs = extractRefs("${ref:a.x}${ref:b.y}");
  assert.equal(refs.length, 2);
  assert.equal(refs[0].source, "a");
  assert.equal(refs[1].source, "b");
});
