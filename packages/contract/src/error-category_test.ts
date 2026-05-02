// H6 / Phase 18.2 — provider-agnostic error category tests.
//
// Each cloud provider (AWS / GCP / Kubernetes / Cloudflare) exposes a native
// classifier that maps its error dialect onto a private enum, plus a bridge
// (`classifyXxxErrorAsProviderCategory`) that further normalises onto the
// provider-agnostic `ProviderErrorCategory`. The bridges live with the
// plugins; the contract only owns the enum + the registry-backed
// {@link normalizeProviderError} entry point. These tests cover the
// contract-side behaviour using stub classifiers — the per-cloud
// classification logic is exercised by each plugin's own test suite.

import assert from "node:assert/strict";
import {
  isFailClosedErrorCategory,
  isRetryableErrorCategory,
  listRegisteredProviders,
  normalizeProviderError,
  type ProviderErrorCategory,
  registerProviderErrorClassifier,
} from "./error-category.ts";

// Shared fixture: a hand-rolled stub classifier per cloud that maps a small
// set of synthetic errors onto categories. This lets us verify the four
// clouds collapse onto a uniform shape via `normalizeProviderError` without
// pulling in plugin-level dependencies.

interface SyntheticAwsError {
  readonly code: string;
}
function classifyStubAws(error: unknown): ProviderErrorCategory {
  const code = (error as SyntheticAwsError | null)?.code;
  if (code === "ThrottlingException") return "rate-limited";
  if (code === "ServiceUnavailable") return "transient";
  if (code === "AccessDeniedException") return "permission-denied";
  if (code === "ValidationException") return "invalid";
  if (code === "ResourceNotFoundException") return "not-found";
  return "unknown";
}

interface SyntheticGcpError {
  readonly status: string;
}
function classifyStubGcp(error: unknown): ProviderErrorCategory {
  const status = (error as SyntheticGcpError | null)?.status;
  if (status === "RESOURCE_EXHAUSTED") return "rate-limited";
  if (status === "UNAVAILABLE") return "transient";
  if (status === "PERMISSION_DENIED") return "permission-denied";
  if (status === "INVALID_ARGUMENT") return "invalid";
  if (status === "NOT_FOUND") return "not-found";
  return "unknown";
}

interface SyntheticK8sError {
  readonly reason: string;
}
function classifyStubK8s(error: unknown): ProviderErrorCategory {
  const reason = (error as SyntheticK8sError | null)?.reason;
  if (reason === "TooManyRequests") return "rate-limited";
  if (reason === "ServiceUnavailable") return "transient";
  if (reason === "Forbidden") return "permission-denied";
  if (reason === "Invalid") return "invalid";
  if (reason === "NotFound") return "not-found";
  return "unknown";
}

interface SyntheticCloudflareError {
  readonly httpStatus: number;
}
function classifyStubCloudflare(error: unknown): ProviderErrorCategory {
  const status = (error as SyntheticCloudflareError | null)?.httpStatus;
  if (status === 429) return "rate-limited";
  if (status === 503) return "transient";
  if (status === 403) return "permission-denied";
  if (status === 422) return "invalid";
  if (status === 404) return "not-found";
  return "unknown";
}

function withStubsRegistered(): void {
  registerProviderErrorClassifier("aws", classifyStubAws);
  registerProviderErrorClassifier("gcp", classifyStubGcp);
  registerProviderErrorClassifier("k8s", classifyStubK8s);
  registerProviderErrorClassifier("cloudflare", classifyStubCloudflare);
}

Deno.test("H6: AWS native errors normalise onto ProviderErrorCategory", () => {
  withStubsRegistered();
  assert.equal(
    normalizeProviderError({ code: "ThrottlingException" }, "aws"),
    "rate-limited",
  );
  assert.equal(
    normalizeProviderError({ code: "ServiceUnavailable" }, "aws"),
    "transient",
  );
  assert.equal(
    normalizeProviderError({ code: "AccessDeniedException" }, "aws"),
    "permission-denied",
  );
  assert.equal(
    normalizeProviderError({ code: "ValidationException" }, "aws"),
    "invalid",
  );
  assert.equal(
    normalizeProviderError({ code: "ResourceNotFoundException" }, "aws"),
    "not-found",
  );
});

Deno.test("H6: GCP native errors normalise onto ProviderErrorCategory", () => {
  withStubsRegistered();
  assert.equal(
    normalizeProviderError({ status: "RESOURCE_EXHAUSTED" }, "gcp"),
    "rate-limited",
  );
  assert.equal(
    normalizeProviderError({ status: "UNAVAILABLE" }, "gcp"),
    "transient",
  );
  assert.equal(
    normalizeProviderError({ status: "PERMISSION_DENIED" }, "gcp"),
    "permission-denied",
  );
  assert.equal(
    normalizeProviderError({ status: "NOT_FOUND" }, "gcp"),
    "not-found",
  );
});

Deno.test("H6: Kubernetes native errors normalise onto ProviderErrorCategory", () => {
  withStubsRegistered();
  assert.equal(
    normalizeProviderError({ reason: "TooManyRequests" }, "k8s"),
    "rate-limited",
  );
  assert.equal(
    normalizeProviderError({ reason: "ServiceUnavailable" }, "k8s"),
    "transient",
  );
  assert.equal(
    normalizeProviderError({ reason: "Forbidden" }, "k8s"),
    "permission-denied",
  );
  assert.equal(
    normalizeProviderError({ reason: "Invalid" }, "k8s"),
    "invalid",
  );
});

Deno.test("H6: Cloudflare native errors normalise onto ProviderErrorCategory", () => {
  withStubsRegistered();
  assert.equal(
    normalizeProviderError({ httpStatus: 429 }, "cloudflare"),
    "rate-limited",
  );
  assert.equal(
    normalizeProviderError({ httpStatus: 503 }, "cloudflare"),
    "transient",
  );
  assert.equal(
    normalizeProviderError({ httpStatus: 403 }, "cloudflare"),
    "permission-denied",
  );
  assert.equal(
    normalizeProviderError({ httpStatus: 404 }, "cloudflare"),
    "not-found",
  );
});

Deno.test("H6: unknown provider name returns 'unknown' (fail-closed)", () => {
  withStubsRegistered();
  // No classifier registered for 'azure' — must collapse to 'unknown' so the
  // kernel-side retry loop fails closed.
  assert.equal(
    normalizeProviderError({ httpStatus: 503 }, "azure"),
    "unknown",
  );
});

Deno.test("H6: classifier that throws is contained and surfaces 'unknown'", () => {
  registerProviderErrorClassifier("buggy", () => {
    throw new Error("classifier blew up");
  });
  // The contract guarantees normalizeProviderError never propagates a thrown
  // classifier — apply must be able to keep classifying the next operation.
  assert.equal(normalizeProviderError({}, "buggy"), "unknown");
});

Deno.test("H6: retryable / fail-closed predicates agree with the enum semantics", () => {
  // transient + rate-limited are retryable; permission-denied / invalid /
  // permanent / unknown fail-closed; conflict / not-found are neither (caller
  // decides — see the contract docstring).
  assert.equal(isRetryableErrorCategory("transient"), true);
  assert.equal(isRetryableErrorCategory("rate-limited"), true);
  assert.equal(isRetryableErrorCategory("permission-denied"), false);
  assert.equal(isRetryableErrorCategory("invalid"), false);
  assert.equal(isRetryableErrorCategory("unknown"), false);
  assert.equal(isRetryableErrorCategory("conflict"), false);
  assert.equal(isRetryableErrorCategory("not-found"), false);

  assert.equal(isFailClosedErrorCategory("permission-denied"), true);
  assert.equal(isFailClosedErrorCategory("invalid"), true);
  assert.equal(isFailClosedErrorCategory("permanent"), true);
  assert.equal(isFailClosedErrorCategory("unknown"), true);
  assert.equal(isFailClosedErrorCategory("transient"), false);
  assert.equal(isFailClosedErrorCategory("rate-limited"), false);
});

Deno.test("H6: registry tracks the four canonical providers after registration", () => {
  withStubsRegistered();
  const providers = listRegisteredProviders();
  for (const expected of ["aws", "cloudflare", "gcp", "k8s"]) {
    assert.ok(
      providers.includes(expected),
      `expected '${expected}' to be registered, got ${providers.join(",")}`,
    );
  }
});
