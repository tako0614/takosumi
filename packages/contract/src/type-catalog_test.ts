import assert from "node:assert/strict";
import {
  allowedProjectionFamiliesForOutputType,
  type BillingPortMaterial,
  type HttpEndpointMaterial,
  isAccessMode,
  isOfficialOutputTypeName,
  isOfficialSensitivityClass,
  isOutputFieldTypeName,
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
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", {
      service: "kv-sessions",
      protocol: "kv",
      tokenRef: { secretRef: "secret://kv/token" },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", {
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
    validateOfficialOutputMaterial("service-binding", {
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
    validateOfficialOutputMaterial("service-binding", {
      protocol: "kv",
    }),
    [{
      path: "$",
      message:
        "service-binding requires service, connectionUrl, or host + port",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", {
      protocol: "postgresql",
      host: "db.internal",
    }),
    [{
      path: "$",
      message: "service-binding host and port must appear together",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("object-store", {
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
    validateOfficialOutputMaterial("object-store", {
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
    validateOfficialOutputMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://s3.example.test",
      accessKeyRef: { secretRef: "secret://bucket/access-key" },
    }),
    [{ path: "$.accessKeyRef", message: "unknown field" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("service-binding", {
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
    validateOfficialOutputMaterial("service-binding", {
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

Deno.test("type catalog rejects embedded credentials in public URL fields", () => {
  assert.deepEqual(
    validateOfficialOutputMaterial("object-store", {
      bucket: "assets",
      endpoint: "https://user:pass@s3.example.test",
    }),
    [{ path: "$.endpoint", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("identity.oidc@v1", {
      issuerUrl: "https://user:pass@accounts.example.test",
      clientId: "app",
    }),
    [{ path: "$.issuerUrl", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterial("billing.port@v1", {
      billingSubjectRef: "acct_123",
      portalUrl: "https://user:pass@billing.example.test/session/123",
    }),
    [{ path: "$.portalUrl", message: "must not contain embedded credentials" }],
  );
});

Deno.test("type catalog rejects incoherent http endpoint material", () => {
  assert.deepEqual(
    validateOfficialOutputMaterial("http-endpoint", {
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

Deno.test("type catalog rejects embedded credentials in literal material mappings", () => {
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "https://user:pass@s3.example.test",
    }),
    [{ path: "$.endpoint", message: "must not contain embedded credentials" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("http-endpoint", {
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
    validateOfficialOutputMaterial("http-endpoint", {
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
    validateOfficialOutputMaterial("event-channel", {
      channel: "orders",
      protocol: "cloud-events",
      endpoint: "events/orders",
    }),
    [{ path: "$.endpoint", message: "must be an absolute URI" }],
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
    validateOfficialOutputMaterialMapping("service-binding", {
      service: "$outputs.storeId",
      protocol: "kv",
      tokenRef: { secretRef: "$outputs.tokenSecretRef" },
    }),
    [],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "$outputs.endpoint",
      accessKeyIdRef: { secretRef: "$outputs.accessKeyIdRef" },
      secretAccessKeyRef: { secretRef: "$outputs.secretAccessKeyRef" },
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
          url: "$outputs.optionalUrl",
          port: "$outputs.port",
        }],
        endpoints: [{
          url: "$outputs.publicUrl",
          primary: "$outputs.primary",
          routes: "$outputs.routes",
        }],
      },
      [
        { name: "optionalUrl", type: "string", required: false },
        { name: "port", type: "integer", required: true },
        { name: "publicUrl", type: "string", required: true },
        { name: "primary", type: "boolean", required: true },
        { name: "routes", type: "object[]", required: true },
      ],
    ),
    [{
      path: "$.targets[0].url",
      message:
        "$outputs.optionalUrl must reference a required output when target has no required host + port fallback",
    }],
  );

  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "http-endpoint",
      {
        targets: [{
          host: "$outputs.host",
          port: "$outputs.port",
        }],
      },
      [
        { name: "host", type: "string", required: false },
        { name: "port", type: "integer", required: true },
      ],
    ),
    [{
      path: "$.targets[0].host",
      message:
        "$outputs.host must reference a required output when used as target host",
    }],
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
      {
        path: "$.host",
        message:
          "$outputs.host must reference a required output when service-binding mapping has no required service or connectionUrl fallback",
      },
      {
        path: "$.port",
        message:
          "$outputs.host must reference a required output when service-binding mapping has no required service or connectionUrl fallback",
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
        path: "$.bucket",
        message: "$outputs.bucket must reference a required output",
      },
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

  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "billing.port@v1",
      {
        billingSubjectRef: "$outputs.subject",
        portalUrl: "$outputs.portalUrl",
      },
      [
        { name: "subject", type: "string", required: true },
        { name: "portalUrl", type: "string", required: false },
      ],
    ),
    [{
      path: "$.portalUrl",
      message:
        "$outputs.portalUrl must reference a required output when billing mapping has no required usageReportEndpoint fallback",
    }],
  );

  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "billing.port@v1",
      {
        billingSubjectRef: "$outputs.subject",
        portalUrl: "$outputs.portalUrl",
        usageReportEndpoint: "$outputs.usageReportEndpoint",
      },
      [
        { name: "subject", type: "string", required: true },
        { name: "portalUrl", type: "string", required: false },
        { name: "usageReportEndpoint", type: "string", required: true },
      ],
    ),
    [],
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
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "kv",
    }),
    [{
      path: "$",
      message:
        "service-binding mapping requires service, connectionUrl, or host + port",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMappingOutputTypes(
      "service-binding",
      {
        service: "$outputs.service",
        protocol: "kv",
      },
      [
        { name: "service", type: "string", required: false },
      ],
    ),
    [{
      path: "$.service",
      message:
        "$outputs.service must reference a required output when service-binding mapping has no required connectionUrl or host + port fallback",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "postgresql",
      host: "$outputs.host",
      port: 5432,
      connectionUrl: "not a uri",
      tokenRefs: {
        "read/write": { secretRef: "$outputs.token" },
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
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "$outputs.endpoint",
      accessKeyRef: { secretRef: "$outputs.secret" },
    }),
    [{ path: "$.accessKeyRef", message: "unknown field" }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("object-store", {
      bucket: "$outputs.bucket",
      endpoint: "$outputs.endpoint",
      secretAccessKeyRef: { secretRef: "$outputs.secret" },
    }),
    [{
      path: "$",
      message:
        "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("service-binding", {
      protocol: "postgresql",
      host: "$outputs.host",
      port: 5432,
      connectionUrl: "postgresql://app:secret@db.internal:5432/app",
    }),
    [{
      path: "$.connectionUrl",
      message: "must not include an embedded password",
    }],
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
      targets: [{
        host: "$outputs.host",
      }],
      endpoints: [{
        url: "https://app.example.test",
        scheme: "ftp",
        visibility: "edge",
        primary: "true",
        routes: [{ pathPrefix: "api?x=1", to: "app/service" }],
      }],
    }),
    [
      {
        path: "$.targets[0]",
        message: "target must map url or host + port",
      },
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
      {
        path: "$.endpoints[0].scheme",
        message: "must match the scheme in url",
      },
    ],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("http-endpoint", {
      targets: [{
        url: "$outputs.url",
        basePath: "/api",
      }],
    }),
    [{
      path: "$.targets[0]",
      message: "target protocol/basePath mapping requires host + port",
    }],
  );
  assert.deepEqual(
    validateOfficialOutputMaterialMapping("event-channel", {
      channel: "$outputs.channel",
      protocol: "cloud-events",
      endpoint: "events/orders",
    }),
    [{ path: "$.endpoint", message: "must be an absolute URI" }],
  );
});
