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
  validateOfficialOutputMaterialMapping,
  validateOfficialOutputMaterialMappingOutputTypes,
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

  assert.deepEqual(
    validateOfficialOutputMaterial("event-channel", {
      channel: "orders",
      protocol: "cloud-events",
      endpoint: "https://events.example.test/orders",
      producerCredentialRef: { secretRef: "secret://events/producer" },
    }),
    [],
  );

  assert.deepEqual(
    validateOfficialOutputMaterial("identity.oidc@v1", {
      issuerUrl: "https://accounts.example.test",
      clientId: "app",
      clientSecretRef: { secretRef: "secret://oidc/client-secret" },
    }),
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

Deno.test("type catalog rejects invalid official material URL values", () => {
  assert.deepEqual(
    validateOfficialOutputMaterial("object-store", {
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
    validateOfficialOutputMaterial("identity.oidc@v1", {
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
    validateOfficialOutputMaterial("billing.port@v1", {
      billingSubjectRef: "acct_123",
      portalUrl: "ftp://billing.example.test/session/123",
    }),
    [{ path: "$.portalUrl", message: "must use http or https" }],
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

Deno.test("type catalog accepts valid official material mapping samples", () => {
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("http-endpoint", {
      targets: [{
        name: "default",
        url: "$outputs.url",
        visibility: "private",
      }],
      endpoints: [{
        url: "$outputs.publicUrl",
        scheme: "$outputs.scheme",
        host: "$outputs.host",
        listener: "$outputs.listener",
        primary: true,
        routes: "$outputs.routes",
      }],
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      service: "$outputs.host",
      protocol: "postgresql",
      host: "$outputs.host",
      port: "$outputs.port",
      database: "$outputs.database",
      passwordRef: { secretRef: "$outputs.passwordSecretRef" },
      tokenRefs: {
        admin: { secretRef: "$outputs.adminTokenSecretRef" },
      },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "$outputs.endpoint",
      accessKeyIdRef: { secretRef: "$outputs.accessKeyRef" },
      secretAccessKeyRef: { secretRef: "$outputs.secretKeyRef" },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("event-channel", {
      channel: "$outputs.channel",
      protocol: "cloud-events",
      endpoint: "$outputs.endpoint",
      deliveryPolicyRefs: ["policy://at-least-once"],
      producerCredentialRef: { secretRef: "$outputs.producerSecretRef" },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("identity.oidc@v1", {
      issuerUrl: "$outputs.issuerUrl",
      clientId: "$outputs.clientId",
      clientSecretRef: { secretRef: "$outputs.clientSecretRef" },
    }),
    [],
  );
});

Deno.test("type catalog checks output marker types in material mappings", () => {
  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "http-endpoint",
      {
        targets: [{
          url: "$outputs.url",
          port: "$outputs.port",
        }],
        endpoints: [{
          url: "$outputs.publicUrl",
          primary: "$outputs.primary",
          routes: "$outputs.routes",
        }],
      },
      [
        { name: "url", type: "string" },
        { name: "port", type: "integer" },
        { name: "publicUrl", type: "string" },
        { name: "primary", type: "boolean" },
        { name: "routes", type: "object[]" },
      ],
    ),
    [],
  );

  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "service-binding",
      {
        protocol: "postgresql",
        host: "$outputs.host",
        port: "$outputs.host",
        passwordRef: { secretRef: "$outputs.missingSecretRef" },
      },
      [
        { name: "host", type: "string" },
      ],
    ),
    [
      {
        path: "$.port",
        message:
          "$outputs.host has output type string, expected number or integer",
      },
      {
        path: "$.passwordRef.secretRef",
        message: "$outputs.missingSecretRef is not declared in outputs[]",
      },
    ],
  );

  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "object-store",
      {
        bucket: "$outputs.bucket",
        pathStyle: "$outputs.bucket",
        policyRefs: "$outputs.policy",
      },
      [
        { name: "bucket", type: "string" },
        { name: "policy", type: "string" },
      ],
    ),
    [
      {
        path: "$.pathStyle",
        message: "$outputs.bucket has output type string, expected boolean",
      },
      {
        path: "$.policyRefs",
        message: "$outputs.policy has output type string, expected string[]",
      },
    ],
  );
});

Deno.test("type catalog rejects drifted material mapping shapes", () => {
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("http-endpoint", {
      urls: ["$outputs.url"],
    }),
    [
      { path: "$.urls", message: "unknown field" },
      {
        path: "$",
        message: "http-endpoint mapping requires targets or endpoints",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "postgresql",
      host: "$outputs.host",
      port: "$outputs.",
    }),
    [{
      path: "$.port",
      message: "must be a number value or $outputs.<field> marker",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "$outputs.endpoint",
      accessKeyRef: { secretRef: "$outputs.secret" },
    }),
    [{ path: "$.accessKeyRef", message: "unknown field" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "postgresql",
      host: "$outputs.host",
      port: "5432",
    }),
    [{
      path: "$.port",
      message: "must be a number value or $outputs.<field> marker",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "postgresql",
      host: "$outputs.host",
      port: 70000,
      passwordRef: { secretRef: 42 },
    }),
    [
      {
        path: "$.port",
        message: "must be an integer port from 1 to 65535",
      },
      {
        path: "$.passwordRef.secretRef",
        message: "must be a string value or $outputs.<field> marker",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
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
    validateOfficialOutputMaterialMapping("identity.oidc@v1", {
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
    validateOfficialOutputMaterialMapping("billing.port@v1", {
      billingSubjectRef: "acct_123",
      portalUrl: "ftp://billing.example.test/session/123",
    }),
    [{ path: "$.portalUrl", message: "must use http or https" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("http-endpoint", {
      endpoints: [{
        url: "https://app.example.test",
        scheme: "ftp",
        visibility: "edge",
        primary: "true",
        routes: [{ pathPrefix: "api?x=1", to: "app/service" }],
      }],
    }),
    [
      { path: "$.endpoints[0].scheme", message: 'must be "http" or "https"' },
      {
        path: "$.endpoints[0].visibility",
        message: 'must be "private", "space", "public", or "internal"',
      },
      {
        path: "$.endpoints[0].primary",
        message: "must be a boolean value or $outputs.<field> marker",
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
