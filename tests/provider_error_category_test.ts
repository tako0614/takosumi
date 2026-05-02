// Phase 18.2 / H6 — provider-agnostic error category cross-cloud parity tests.
//
// Verify that AWS / GCP / Kubernetes / Cloudflare classifiers all map their
// native dialect onto the same provider-agnostic ProviderErrorCategory enum
// for each well-known canonical condition (rate-limited, transient, etc.).

import assert from "node:assert/strict";
import {
  isFailClosedErrorCategory,
  isRetryableErrorCategory,
  type ProviderErrorCategory,
} from "takosumi-contract";
import {
  awsErrorCategoryToProviderCategory,
  classifyAwsErrorAsProviderCategory,
} from "../src/providers/aws/support.ts";
import {
  classifyGcpErrorAsProviderCategory,
  gcpStatusToProviderCategory,
} from "../src/providers/gcp/_runtime.ts";
import {
  classifyK8sErrorAsProviderCategory,
  K8sConflictError,
  K8sForbiddenError,
  K8sNotFoundError,
  K8sThrottledError,
  K8sTimeoutError,
} from "../src/providers/k8s/errors.ts";
import {
  classifyCloudflareErrorAsProviderCategory,
  CloudflareProviderError,
} from "../src/providers/cloudflare/errors.ts";

Deno.test("isRetryableErrorCategory only retries transient + rate-limited", () => {
  assert.equal(isRetryableErrorCategory("transient"), true);
  assert.equal(isRetryableErrorCategory("rate-limited"), true);
  assert.equal(isRetryableErrorCategory("conflict"), false);
  assert.equal(isRetryableErrorCategory("not-found"), false);
  assert.equal(isRetryableErrorCategory("permanent"), false);
  assert.equal(isRetryableErrorCategory("permission-denied"), false);
  assert.equal(isRetryableErrorCategory("invalid"), false);
  assert.equal(isRetryableErrorCategory("unknown"), false);
});

Deno.test("isFailClosedErrorCategory captures the hard-fail set", () => {
  assert.equal(isFailClosedErrorCategory("permanent"), true);
  assert.equal(isFailClosedErrorCategory("permission-denied"), true);
  assert.equal(isFailClosedErrorCategory("invalid"), true);
  assert.equal(isFailClosedErrorCategory("unknown"), true);
  assert.equal(isFailClosedErrorCategory("transient"), false);
  assert.equal(isFailClosedErrorCategory("rate-limited"), false);
  assert.equal(isFailClosedErrorCategory("not-found"), false);
  assert.equal(isFailClosedErrorCategory("conflict"), false);
});

Deno.test("AWS throttling maps to provider-agnostic rate-limited", () => {
  assert.equal(
    awsErrorCategoryToProviderCategory("throttling"),
    "rate-limited",
  );
  // Sanity: classify a real-shaped AWS throttling error and ensure the same
  // category is produced through the convenience wrapper.
  const awsErr = { code: "ThrottlingException", message: "Rate exceeded" };
  assert.equal(classifyAwsErrorAsProviderCategory(awsErr), "rate-limited");
});

Deno.test("GCP / k8s / cloudflare rate-limit all normalise to rate-limited", () => {
  // GCP `RESOURCE_EXHAUSTED` -> rate-limited.
  assert.equal(gcpStatusToProviderCategory("rate-limited"), "rate-limited");
  const gcpErr = new Error("quota exhausted") as Error & { status?: string };
  gcpErr.status = "RESOURCE_EXHAUSTED";
  assert.equal(classifyGcpErrorAsProviderCategory(gcpErr), "rate-limited");

  // k8s 429 → throttled → rate-limited.
  const throttled = new K8sThrottledError("api throttled");
  assert.equal(classifyK8sErrorAsProviderCategory(throttled), "rate-limited");

  // Cloudflare 429 → rate-limited.
  const cfErr = new CloudflareProviderError("rate-limited", "too many", {
    httpStatus: 429,
  });
  assert.equal(
    classifyCloudflareErrorAsProviderCategory(cfErr),
    "rate-limited",
  );
});

Deno.test("transient categories agree across all four clouds", () => {
  // AWS service-unavailable / internal / timeout → transient.
  assert.equal(
    awsErrorCategoryToProviderCategory("service-unavailable"),
    "transient",
  );
  assert.equal(awsErrorCategoryToProviderCategory("internal"), "transient");
  assert.equal(awsErrorCategoryToProviderCategory("timeout"), "transient");

  // GCP unavailable / internal / deadline-exceeded → transient.
  assert.equal(gcpStatusToProviderCategory("unavailable"), "transient");
  assert.equal(gcpStatusToProviderCategory("internal"), "transient");
  assert.equal(gcpStatusToProviderCategory("deadline-exceeded"), "transient");

  // k8s timeout / unavailable → transient.
  const t = new K8sTimeoutError("op timed out");
  assert.equal(classifyK8sErrorAsProviderCategory(t), "transient");

  // Cloudflare 503 → transient.
  const cfUnavailable = new CloudflareProviderError(
    "service-unavailable",
    "down",
    { httpStatus: 503 },
  );
  assert.equal(
    classifyCloudflareErrorAsProviderCategory(cfUnavailable),
    "transient",
  );
});

Deno.test("not-found agrees across clouds", () => {
  const matrix: Array<[ProviderErrorCategory, ProviderErrorCategory]> = [
    [awsErrorCategoryToProviderCategory("not-found"), "not-found"],
    [gcpStatusToProviderCategory("not-found"), "not-found"],
    [
      classifyK8sErrorAsProviderCategory(new K8sNotFoundError("nope")),
      "not-found",
    ],
    [
      classifyCloudflareErrorAsProviderCategory(
        new CloudflareProviderError("not-found", "missing", {
          httpStatus: 404,
        }),
      ),
      "not-found",
    ],
  ];
  for (const [actual, expected] of matrix) assert.equal(actual, expected);
});

Deno.test("permission-denied agrees across clouds", () => {
  assert.equal(
    awsErrorCategoryToProviderCategory("access-denied"),
    "permission-denied",
  );
  assert.equal(
    gcpStatusToProviderCategory("permission-denied"),
    "permission-denied",
  );
  assert.equal(
    classifyK8sErrorAsProviderCategory(new K8sForbiddenError("rbac")),
    "permission-denied",
  );
  assert.equal(
    classifyCloudflareErrorAsProviderCategory(
      new CloudflareProviderError("permission-denied", "no", {
        httpStatus: 403,
      }),
    ),
    "permission-denied",
  );
});

Deno.test("conflict agrees across clouds", () => {
  assert.equal(awsErrorCategoryToProviderCategory("conflict"), "conflict");
  assert.equal(gcpStatusToProviderCategory("conflict"), "conflict");
  assert.equal(
    classifyK8sErrorAsProviderCategory(new K8sConflictError("etag mismatch")),
    "conflict",
  );
  assert.equal(
    classifyCloudflareErrorAsProviderCategory(
      new CloudflareProviderError("conflict", "exists", { httpStatus: 409 }),
    ),
    "conflict",
  );
});

Deno.test("invalid agrees across clouds", () => {
  assert.equal(awsErrorCategoryToProviderCategory("validation"), "invalid");
  assert.equal(gcpStatusToProviderCategory("invalid-argument"), "invalid");
  assert.equal(
    classifyCloudflareErrorAsProviderCategory(
      new CloudflareProviderError("validation", "bad", { httpStatus: 422 }),
    ),
    "invalid",
  );
});

Deno.test("unknown is the safe fallback", () => {
  assert.equal(awsErrorCategoryToProviderCategory("unknown"), "unknown");
  assert.equal(gcpStatusToProviderCategory("unknown"), "unknown");
  // k8s: a plain Error with no recognisable signature → unknown.
  assert.equal(
    classifyK8sErrorAsProviderCategory(new Error("???")),
    "unknown",
  );
  // Cloudflare: empty object → unknown.
  assert.equal(classifyCloudflareErrorAsProviderCategory({}), "unknown");
});

Deno.test("retry policy is identical regardless of cloud (cross-cloud parity)", () => {
  // For each native provider: classify → ProviderErrorCategory →
  // isRetryableErrorCategory(). Identical inputs across clouds must produce
  // identical retry decisions.
  const transientShapes: Array<[ProviderErrorCategory, boolean]> = [
    [awsErrorCategoryToProviderCategory("service-unavailable"), true],
    [gcpStatusToProviderCategory("unavailable"), true],
    [
      classifyK8sErrorAsProviderCategory(new K8sTimeoutError("t")),
      true,
    ],
    [
      classifyCloudflareErrorAsProviderCategory(
        new CloudflareProviderError("internal", "x", { httpStatus: 500 }),
      ),
      true,
    ],
  ];
  for (const [category, shouldRetry] of transientShapes) {
    assert.equal(isRetryableErrorCategory(category), shouldRetry);
  }
  // Permanent shapes should never retry across any cloud.
  const permanentShapes: ProviderErrorCategory[] = [
    awsErrorCategoryToProviderCategory("validation"),
    gcpStatusToProviderCategory("permission-denied"),
    classifyK8sErrorAsProviderCategory(new K8sForbiddenError("rbac")),
    classifyCloudflareErrorAsProviderCategory(
      new CloudflareProviderError("permission-denied", "no", {
        httpStatus: 403,
      }),
    ),
  ];
  for (const category of permanentShapes) {
    assert.equal(isRetryableErrorCategory(category), false);
  }
});
