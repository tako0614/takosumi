import assert from "node:assert/strict";
import {
  allowedProjectionFamiliesForOutputType,
  type BillingPortMaterial,
  type HttpEndpointMaterial,
  isAccessMode,
  isOfficialOutputTypeName,
  isOfficialSensitivityClass,
  isProjectionAllowedForOutputType,
  isProjectionFamilyName,
  isSafeDefaultAccessMode,
  type ObjectStoreMaterial,
  type OfficialOutputMaterialByType,
  validateOfficialOutputMaterial,
} from "./type-catalog.ts";

Deno.test("type catalog guards pin official names", () => {
  assert.equal(isOfficialOutputTypeName("http-endpoint"), true);
  assert.equal(isOfficialOutputTypeName("sql-connection"), false);
  assert.equal(isProjectionFamilyName("secret-env"), true);
  assert.equal(isProjectionFamilyName("plain-env"), false);
  assert.equal(isAccessMode("read-write"), true);
  assert.equal(isAccessMode("owner"), false);
  assert.equal(isOfficialSensitivityClass("secret-bearing"), true);
  assert.equal(isOfficialSensitivityClass("private"), false);
  assert.equal(isSafeDefaultAccessMode(null), true);
  assert.equal(isSafeDefaultAccessMode("read"), true);
  assert.equal(isSafeDefaultAccessMode("read-write"), false);
});

Deno.test("type catalog projection matrix matches official output types", () => {
  assert.deepEqual(
    [...allowedProjectionFamiliesForOutputType("http-endpoint")],
    ["upstream", "env", "config-mount"],
  );
  assert.equal(
    isProjectionAllowedForOutputType("http-endpoint", "upstream"),
    true,
  );
  assert.equal(
    isProjectionAllowedForOutputType("service-binding", "env"),
    false,
  );
  assert.equal(
    isProjectionAllowedForOutputType("service-binding", "secret-env"),
    true,
  );
});

Deno.test("type catalog accepts valid official material samples", () => {
  const http: HttpEndpointMaterial = {
    targets: [{
      name: "default",
      url: "https://web.internal",
      visibility: "private",
    }],
    endpoints: [{
      url: "https://app.example.test",
      scheme: "https",
      host: "app.example.test",
      listener: "public",
      visibility: "public",
      primary: true,
      routes: [{ pathPrefix: "/", to: "app" }],
    }],
  };
  assert.deepEqual(validateOfficialOutputMaterial("http-endpoint", http), []);

  const service: OfficialOutputMaterialByType["service-binding"] = {
    service: "postgres",
    protocol: "postgresql",
    host: "db.internal",
    port: 5432,
    database: "app",
    username: "app",
    passwordRef: { secretRef: "secret://postgres/password" },
  };
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", service),
    [],
  );

  const bucket: ObjectStoreMaterial = {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    accessKeyIdRef: { secretRef: "secret://bucket/access-key-id" },
    secretAccessKeyRef: { secretRef: "secret://bucket/secret-access-key" },
  };
  assert.deepEqual(validateOfficialOutputMaterial("object-store", bucket), []);

  const billing: BillingPortMaterial = {
    portalUrl: "https://billing.example.test/session/123",
    billingSubjectRef: "acct_123",
  };
  assert.deepEqual(
    validateOfficialOutputMaterial("billing.port@v1", billing),
    [],
  );
});

Deno.test("type catalog rejects ambiguous official material", () => {
  assert.deepEqual(validateOfficialOutputMaterial("http-endpoint", {}), [{
    path: "$",
    message: "http-endpoint requires at least one target or endpoint",
  }]);
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
      port: "5432",
    }),
    [{ path: "$.port", message: "must be a finite number" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("identity.oidc@v1", {
      issuerUrl: "https://accounts.example.test",
      clientId: "app",
      clientSecretRef: "secret://oidc/client-secret",
    }),
    [{
      path: "$.clientSecretRef",
      message: "must be a secretRef object",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      accessKeyRef: { secretRef: "secret://bucket/access-key" },
    }),
    [{ path: "$.accessKeyRef", message: "unknown field" }],
  );
});

Deno.test("type catalog rejects invalid http endpoint material values", () => {
  assert.deepEqual(
    validateOfficialOutputMaterial("http-endpoint", {
      targets: [{
        url: "ftp://web.internal",
        port: 70000,
        visibility: "world",
      }],
      endpoints: [{
        url: "https://app.example.test",
        scheme: "ftp",
        visibility: "edge",
        routes: [{ pathPrefix: "api?x=1", to: "app/service" }],
      }],
    }),
    [
      { path: "$.targets[0].url", message: "must use http or https" },
      {
        path: "$.targets[0].port",
        message: "must be an integer port from 1 to 65535",
      },
      {
        path: "$.targets[0].visibility",
        message: 'must be "private", "space", "public", or "internal"',
      },
      { path: "$.endpoints[0].scheme", message: 'must be "http" or "https"' },
      {
        path: "$.endpoints[0].visibility",
        message: 'must be "private", "space", "public", or "internal"',
      },
      {
        path: "$.endpoints[0].routes[0].pathPrefix",
        message: 'must start with "/" and must not contain "?" or "#"',
      },
      {
        path: "$.endpoints[0].routes[0].to",
        message:
          "must start with an ASCII letter or digit and contain only ASCII letters, digits, _, ., or -",
      },
    ],
  );
});
