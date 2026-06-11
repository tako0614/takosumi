import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  allowedProjectionFamiliesForMaterialKind,
  type BillingPortMaterial,
  type HttpEndpointMaterial,
  isAccessMode,
  isOfficialMaterialKindName,
  isOfficialSensitivityClass,
  isOutputFieldTypeName,
  isProjectionAllowedForMaterialKind,
  isProjectionFamilyName,
  isSafeDefaultAccessMode,
  type McpServerMaterial,
  type ObjectStoreMaterial,
  type OfficialMaterialByKind,
  validateOfficialMaterial,
} from "./catalog.ts";

test("catalog guards pin official names", () => {
  assert.equal(isOfficialMaterialKindName("http-endpoint"), true);
  assert.equal(isOfficialMaterialKindName("mcp-server@v1"), true);
  assert.equal(isOfficialMaterialKindName("sql-connection"), false);
  assert.equal(isOutputFieldTypeName("string[]"), true);
  assert.equal(isOutputFieldTypeName("object"), false);
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

test("catalog projection matrix matches official material kinds", () => {
  assert.deepEqual(
    [...allowedProjectionFamiliesForMaterialKind("http-endpoint")],
    ["upstream", "env", "config-mount"],
  );
  assert.equal(
    isProjectionAllowedForMaterialKind("http-endpoint", "upstream"),
    true,
  );
  assert.equal(
    isProjectionAllowedForMaterialKind("service-binding", "env"),
    false,
  );
  assert.equal(
    isProjectionAllowedForMaterialKind("service-binding", "secret-env"),
    true,
  );
  assert.equal(
    isProjectionAllowedForMaterialKind("mcp-server@v1", "config-mount"),
    true,
  );
  assert.equal(
    isProjectionAllowedForMaterialKind("mcp-server@v1", "env"),
    false,
  );
});

test("catalog accepts valid official material samples", () => {
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
  assert.deepEqual(validateOfficialMaterial("http-endpoint", http), []);

  const service: OfficialMaterialByKind["service-binding"] = {
    service: "postgres",
    protocol: "postgresql",
    host: "db.internal",
    port: 5432,
    database: "app",
    username: "app",
    passwordRef: { secretRef: "secret://postgres/password" },
  };
  assert.deepEqual(
    validateOfficialMaterial("service-binding", service),
    [],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      service: "kv-sessions",
      protocol: "kv",
      tokenRef: { secretRef: "secret://kv/token" },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "sqlite",
      connectionUrl: "libsql://sqlite.example.test/app",
      tokenRef: { secretRef: "secret://sqlite/token" },
    }),
    [],
  );

  const bucket: ObjectStoreMaterial = {
    bucket: "assets",
    endpoint: "https://s3.example.test",
    accessKeyIdRef: { secretRef: "secret://bucket/access-key-id" },
    secretAccessKeyRef: { secretRef: "secret://bucket/secret-access-key" },
  };
  assert.deepEqual(validateOfficialMaterial("object-store", bucket), []);

  const billing: BillingPortMaterial = {
    portalUrl: "https://billing.example.test/session/123",
    billingSubjectRef: "acct_123",
  };
  assert.deepEqual(
    validateOfficialMaterial("billing.port@v1", billing),
    [],
  );

  assert.deepEqual(
    validateOfficialMaterial("event-channel", {
      channel: "orders",
      protocol: "cloud-events",
      endpoint: "https://events.example.test/orders",
      producerCredentialRef: { secretRef: "secret://events/producer" },
    }),
    [],
  );

  assert.deepEqual(
    validateOfficialMaterial("identity.oidc@v1", {
      issuerUrl: "https://accounts.example.test",
      clientId: "app",
      clientSecretRef: { secretRef: "secret://oidc/client-secret" },
    }),
    [],
  );

  const mcp: McpServerMaterial = {
    endpointUrl: "https://tools.example.test/mcp",
    transport: "streamable-http",
    protocolVersion: "2025-06-18",
    serverName: "docs",
    tokenRef: { secretRef: "secret://mcp/docs-token" },
  };
  assert.deepEqual(validateOfficialMaterial("mcp-server@v1", mcp), []);
});

test("catalog rejects ambiguous official material", () => {
  assert.deepEqual(validateOfficialMaterial("http-endpoint", {}), [{
    path: "$",
    message: "http-endpoint requires at least one target or endpoint",
  }]);
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
      port: "5432",
    }),
    [{ path: "$.port", message: "must be a finite number" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("identity.oidc@v1", {
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
    validateOfficialMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
      port: 5432,
      passwordRef: {
        secretRef: "secret://postgres/password",
        name: "password",
      },
    }),
    [{ path: "$.passwordRef.name", message: "unknown field" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "kv",
    }),
    [{
      path: "$",
      message:
        "service-binding requires service, connectionUrl, or host + port",
    }],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
    }),
    [{
      path: "$",
      message: "service-binding host and port must appear together",
    }],
  );
  assert.deepEqual(
    validateOfficialMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      accessKeyIdRef: { secretRef: "secret://bucket/access-key" },
    }),
    [{
      path: "$",
      message:
        "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
    }],
  );
  assert.deepEqual(
    validateOfficialMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      sessionTokenRef: { secretRef: "secret://bucket/session-token" },
    }),
    [
      {
        path: "$.sessionTokenRef",
        message:
          "sessionTokenRef requires accessKeyIdRef and secretAccessKeyRef",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      accessKeyRef: { secretRef: "secret://bucket/access-key" },
    }),
    [{ path: "$.accessKeyRef", message: "unknown field" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
      port: 5432,
      connectionUrl: "not a uri",
      tokenRefs: {
        "read/write": { secretRef: "secret://db/read-write-token" },
      },
    }),
    [
      { path: "$.connectionUrl", message: "must be an absolute URI" },
      {
        path: "$.tokenRefs.read/write",
        message:
          "must start with an ASCII letter or digit and contain only ASCII letters, digits, _, ., or -",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
      port: 5432,
      connectionUrl: "postgresql://app:secret@db.internal:5432/app",
    }),
    [{
      path: "$.connectionUrl",
      message: "must not include an embedded password",
    }],
  );
});

test("catalog rejects invalid official material URL values", () => {
  assert.deepEqual(
    validateOfficialMaterial("object-store", {
      bucket: "assets",
      endpoint: "assets",
      publicBaseUrl: "ftp://assets.example.test",
    }),
    [
      { path: "$.endpoint", message: "must be an absolute URI" },
      { path: "$.publicBaseUrl", message: "must use http or https" },
    ],
  );
  assert.deepEqual(
    validateOfficialMaterial("identity.oidc@v1", {
      issuerUrl: "accounts.example.test",
      discoveryUrl: "ftp://accounts.example.test/.well-known/openid",
      clientId: "app",
      redirectOrigin: "/callback",
    }),
    [
      { path: "$.issuerUrl", message: "must be an absolute http(s) URL" },
      { path: "$.discoveryUrl", message: "must use http or https" },
      {
        path: "$.redirectOrigin",
        message: "must be an absolute http(s) URL",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialMaterial("billing.port@v1", {
      billingSubjectRef: "acct_123",
      portalUrl: "ftp://billing.example.test/session/123",
    }),
    [{ path: "$.portalUrl", message: "must use http or https" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("mcp-server@v1", {
      endpointUrl: "mcp://tools.example.test",
      transport: "sse",
    }),
    [
      { path: "$.endpointUrl", message: "must use http or https" },
      { path: "$.transport", message: 'must be "streamable-http"' },
    ],
  );
});

test("catalog rejects embedded credentials in public URL fields", () => {
  assert.deepEqual(
    validateOfficialMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://user:pass@s3.example.test",
    }),
    [{ path: "$.endpoint", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("identity.oidc@v1", {
      issuerUrl: "https://user:pass@accounts.example.test",
      clientId: "app",
    }),
    [{ path: "$.issuerUrl", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("billing.port@v1", {
      billingSubjectRef: "acct_123",
      portalUrl: "https://user:pass@billing.example.test/session/123",
    }),
    [{ path: "$.portalUrl", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialMaterial("mcp-server@v1", {
      endpointUrl: "https://user:pass@tools.example.test/mcp",
      transport: "streamable-http",
    }),
    [{
      path: "$.endpointUrl",
      message: "must not contain embedded credentials",
    }],
  );
});

test("catalog rejects incoherent http endpoint material", () => {
  assert.deepEqual(
    validateOfficialMaterial("http-endpoint", {
      endpoints: [{
        url: "https://app.example.test",
        scheme: "http",
        host: "other.example.test",
      }],
    }),
    [
      {
        path: "$.endpoints[0].scheme",
        message: "must match the scheme in url",
      },
      {
        path: "$.endpoints[0].host",
        message: "must match the host in url",
      },
    ],
  );
});

test("catalog rejects invalid http endpoint material values", () => {
  assert.deepEqual(
    validateOfficialMaterial("http-endpoint", {
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
      {
        path: "$.targets[0]",
        message: "target host and port must appear together",
      },
      { path: "$.endpoints[0].scheme", message: 'must be "http" or "https"' },
      {
        path: "$.endpoints[0].visibility",
        message: 'must be "private", "space", "public", or "internal"',
      },
      {
        path: "$.endpoints[0].scheme",
        message: "must match the scheme in url",
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
  assert.deepEqual(
    validateOfficialMaterial("http-endpoint", {
      targets: [{
        url: "https://web.internal",
        basePath: "/api",
      }],
    }),
    [{
      path: "$.targets[0]",
      message: "target protocol/basePath requires host + port",
    }],
  );
  assert.deepEqual(
    validateOfficialMaterial("event-channel", {
      channel: "orders",
      protocol: "cloud-events",
      endpoint: "events/orders",
    }),
    [{ path: "$.endpoint", message: "must be an absolute URI" }],
  );
});
