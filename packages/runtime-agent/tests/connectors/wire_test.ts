/**
 * Tests for the shared wire-shape validators in
 * `src/connectors/_wire.ts`. The validators sit between `JSON.parse` and the
 * `Direct*Lifecycle` consumers, so they need to:
 *   - accept well-formed payloads and return narrowed values, and
 *   - reject malformed payloads with a `ConnectorContractError` carrying the
 *     offending field path.
 */

import assert from "node:assert/strict";
import {
  ConnectorContractError,
  parseCloudflareEnvelope,
  parseCloudflareSubdomainResult,
  parseCloudRunServiceResponse,
  parseCloudSqlInstanceResponse,
  parseGcsBucketResponse,
  parseK8sDeploymentResponse,
  parseK8sObjectResponse,
  parseK8sServiceResponse,
  passthroughObjectResult,
} from "../../src/connectors/_wire.ts";

const CTX = "wire-test:Op";

Deno.test("parseCloudflareEnvelope accepts well-formed payload", () => {
  const env = parseCloudflareEnvelope(
    {
      success: true,
      result: { foo: "bar" },
      errors: [{ code: 10, message: "informational" }],
    },
    CTX,
    passthroughObjectResult,
  );
  assert.equal(env.success, true);
  assert.deepEqual(env.result, { foo: "bar" });
  assert.equal(env.errors?.[0].code, 10);
});

Deno.test("parseCloudflareEnvelope rejects non-object root", () => {
  assert.throws(
    () => parseCloudflareEnvelope("nope", CTX, passthroughObjectResult),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$");
      return true;
    },
  );
});

Deno.test("parseCloudflareEnvelope rejects non-boolean success", () => {
  assert.throws(
    () =>
      parseCloudflareEnvelope(
        { success: "yes", result: {} },
        CTX,
        passthroughObjectResult,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.success");
      return true;
    },
  );
});

Deno.test("parseCloudflareEnvelope rejects malformed error entry", () => {
  assert.throws(
    () =>
      parseCloudflareEnvelope(
        {
          success: false,
          result: null,
          errors: [{ code: "not-a-number", message: "x" }],
        },
        CTX,
        passthroughObjectResult,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.errors[0].code");
      return true;
    },
  );
});

Deno.test("parseCloudflareSubdomainResult extracts subdomain", () => {
  const result = parseCloudflareSubdomainResult(
    { subdomain: "acme" },
    CTX,
    "$.result",
  );
  assert.equal(result?.subdomain, "acme");
});

Deno.test("parseCloudflareSubdomainResult rejects non-string subdomain", () => {
  assert.throws(
    () =>
      parseCloudflareSubdomainResult(
        { subdomain: 42 },
        CTX,
        "$.result",
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.result.subdomain");
      return true;
    },
  );
});

Deno.test("parseCloudRunServiceResponse extracts uri and container port", () => {
  const parsed = parseCloudRunServiceResponse(
    {
      uri: "https://app-abc-uc.a.run.app",
      template: {
        containers: [{ ports: [{ containerPort: 8080 }] }],
      },
    },
    CTX,
  );
  assert.equal(parsed?.uri, "https://app-abc-uc.a.run.app");
  assert.equal(
    parsed?.template?.containers?.[0]?.ports?.[0]?.containerPort,
    8080,
  );
});

Deno.test("parseCloudRunServiceResponse rejects non-finite port", () => {
  assert.throws(
    () =>
      parseCloudRunServiceResponse(
        {
          template: {
            containers: [{ ports: [{ containerPort: "8080" }] }],
          },
        },
        CTX,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(
        err.path,
        "$.template.containers[0].ports[0].containerPort",
      );
      return true;
    },
  );
});

Deno.test("parseCloudSqlInstanceResponse parses ipAddresses", () => {
  const parsed = parseCloudSqlInstanceResponse(
    {
      databaseVersion: "POSTGRES_16",
      ipAddresses: [{ ipAddress: "10.0.0.5", type: "PRIMARY" }],
    },
    CTX,
  );
  assert.equal(parsed?.databaseVersion, "POSTGRES_16");
  assert.equal(parsed?.ipAddresses?.[0].ipAddress, "10.0.0.5");
});

Deno.test("parseCloudSqlInstanceResponse rejects non-array ipAddresses", () => {
  assert.throws(
    () =>
      parseCloudSqlInstanceResponse(
        { ipAddresses: "10.0.0.5" },
        CTX,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.ipAddresses");
      return true;
    },
  );
});

Deno.test("parseGcsBucketResponse extracts location", () => {
  const parsed = parseGcsBucketResponse(
    { name: "my-bucket", location: "US" },
    CTX,
  );
  assert.equal(parsed?.location, "US");
});

Deno.test("parseGcsBucketResponse rejects numeric location", () => {
  assert.throws(
    () => parseGcsBucketResponse({ location: 42 }, CTX),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.location");
      return true;
    },
  );
});

Deno.test("parseK8sDeploymentResponse extracts replicas", () => {
  const parsed = parseK8sDeploymentResponse(
    { spec: { replicas: 3 }, status: { replicas: 2 } },
    CTX,
  );
  assert.equal(parsed?.spec?.replicas, 3);
  assert.equal(parsed?.status?.replicas, 2);
});

Deno.test("parseK8sDeploymentResponse rejects non-number replicas", () => {
  assert.throws(
    () =>
      parseK8sDeploymentResponse(
        { spec: { replicas: "3" } },
        CTX,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.spec.replicas");
      return true;
    },
  );
});

Deno.test("parseK8sServiceResponse extracts ports", () => {
  const parsed = parseK8sServiceResponse(
    { spec: { clusterIP: "10.1.2.3", ports: [{ port: 8080 }] } },
    CTX,
  );
  assert.equal(parsed?.spec?.clusterIP, "10.1.2.3");
  assert.equal(parsed?.spec?.ports?.[0].port, 8080);
});

Deno.test("parseK8sServiceResponse rejects non-finite service port", () => {
  assert.throws(
    () =>
      parseK8sServiceResponse(
        { spec: { ports: [{ port: "8080" }] } },
        CTX,
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$.spec.ports[0].port");
      return true;
    },
  );
});

Deno.test("parseK8sObjectResponse returns undefined for null", () => {
  assert.equal(parseK8sObjectResponse(null, CTX), undefined);
});

Deno.test("parseK8sObjectResponse extracts clusterIP", () => {
  const parsed = parseK8sObjectResponse(
    { spec: { clusterIP: "10.0.0.7" } },
    CTX,
  );
  assert.equal(parsed?.spec?.clusterIP, "10.0.0.7");
});

Deno.test("parseK8sObjectResponse rejects non-object root", () => {
  assert.throws(
    () => parseK8sObjectResponse(42, CTX),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorContractError);
      assert.equal(err.path, "$");
      return true;
    },
  );
});
