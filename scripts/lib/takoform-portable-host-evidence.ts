import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

import type {
  InstalledFormReference,
  JsonObject,
  ResourceObject,
} from "takosumi-contract";
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../../core/adapters/takoform/canonical_json.ts";

export const TAKOFORM_ERROR_PROBE_HEADER =
  "Takoform-Conformance-Probe-Error";
export const TAKOFORM_AUTHORIZATION_PROBE_HEADER =
  "Takoform-Conformance-Probe-Authorization";
export const TAKOFORM_AUTHORIZATION_PROBE_CREDENTIAL_REVOKED =
  "credential-revoked";
export const TAKOFORM_AUTHORIZATION_PROBE_PERMISSION_REVOKED =
  "permission-revoked";
export const TAKOFORM_AUTHORIZATION_PROBE_POLICY_REVOKED =
  "policy-revoked";
export const TAKOFORM_RAW_JSON_PROBE_HEADER =
  "Takoform-Conformance-Probe-Raw-JSON";
export const TAKOFORM_RAW_JSON_PROBE_DUPLICATE_ERROR_CODE =
  "duplicate-error-code";
export const TAKOFORM_PLAN_BINDING_PROBE_HEADER =
  "Takoform-Conformance-Probe-Plan-Binding";
export const TAKOFORM_PLAN_BINDING_RESULT_HEADER =
  "Takoform-Conformance-Probe-Plan-Binding-Result";
export const TAKOFORM_PLAN_BINDING_REJECTED = "rejected";
export const TAKOFORM_PLAN_BINDING_ACCEPTED_NO_MUTATION =
  "accepted-no-mutation";
export const TAKOFORM_RUNNER_PRIMARY_TOKEN =
  "takosumi-host-evidence-primary";
export const TAKOFORM_RUNNER_ALTERNATE_TOKEN =
  "takosumi-host-evidence-alternate";
export const TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN =
  "takosumi-host-evidence-alternate-tenant";
export const TAKOFORM_RUNNER_PRIMARY_TOKEN_ENV =
  "TAKOSUMI_HOST_EVIDENCE_PRIMARY_TOKEN";
export const TAKOFORM_RUNNER_ALTERNATE_TOKEN_ENV =
  "TAKOSUMI_HOST_EVIDENCE_ALTERNATE_TOKEN";
export const TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN_ENV =
  "TAKOSUMI_HOST_EVIDENCE_ALTERNATE_TENANT_TOKEN";
export const TAKOFORM_PORTABLE_HOST_REPORT_FORMAT =
  "takoform.portable-host-runner-report@v1";
export const TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT =
  "takoform.portable-host-conformance-runner@v1";
export const TAKOFORM_PORTABLE_HOST_RUNNER_INPUT_DIGEST =
  "sha256:13f979938678571b5dcfed492bfa39557d445fad889f41f0ad2fa0022a7a7607";
export const TAKOFORM_PORTABLE_HOST_RUNNER_CLASSIFICATION =
  "disposable-endpoint-conformance-run";

const API_PATH = "/apis/forms.takoform.com/v1alpha1";
const DISCOVERY_PATH = "/.well-known/takoform";
const INTERFACES_PATH = `${API_PATH}/interfaces`;
const RESOURCE_PATH = `${API_PATH}/resources`;
const REQUEST_ID = "req_takoform_portable_host_evidence";
const MAX_RUNNER_OUTPUT_BYTES = 8 << 20;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const TAKOFORM_PLAN_BINDING_INSTRUMENTED_INPUTS = [
  "resource.apiVersion",
  "resource.kind",
  "resource.metadata.name",
  "resource.form.formRef.apiVersion",
  "resource.form.formRef.kind",
  "resource.form.formRef.definitionVersion",
  "resource.form.formRef.schemaDigest",
  "resource.form.packageDigest",
] as const;
const PLAN_BINDING_INPUTS = new Set<string>(
  TAKOFORM_PLAN_BINDING_INSTRUMENTED_INPUTS,
);
export const TAKOFORM_PLAN_BINDING_PURE_INPUTS = [
  "specDigest",
  "resource.metadata.space",
  "resource.metadata.resourceVersion",
] as const;
export const TAKOFORM_IDEMPOTENCY_ISOLATION_DIMENSIONS = [
  "authenticated-principal",
  "authenticated-tenant",
  "space",
] as const;
export const TAKOFORM_IDEMPOTENCY_REPLAY_DENIALS = [
  "unauthenticated",
  "permission_denied",
  "policy_denied",
] as const;

const STABLE_ERROR_SEMANTICS = {
  invalid_argument: { status: 400, retryable: false },
  unauthenticated: { status: 401, retryable: false },
  permission_denied: { status: 403, retryable: false },
  form_unknown: { status: 404, retryable: false },
  form_not_installed: { status: 409, retryable: false },
  form_unavailable: { status: 503, retryable: false },
  form_identity_conflict: { status: 409, retryable: false },
  resource_not_found: { status: 404, retryable: false },
  resource_version_conflict: { status: 412, retryable: false },
  resource_busy: { status: 409, retryable: true },
  import_conflict: { status: 409, retryable: false },
  policy_denied: { status: 403, retryable: false },
  backend_unavailable: { status: 503, retryable: true },
  interface_identity_ambiguous: { status: 409, retryable: false },
  interface_instance_ambiguous: { status: 409, retryable: false },
  internal_error: { status: 500, retryable: false },
} as const;

/**
 * Compatibility lock for the reviewed portable-host-v1 runner evidence.
 * These values are intentionally exact: a contract change must update this
 * adapter and its signed-candidate consumer together.
 */
export const TAKOFORM_PORTABLE_HOST_REQUIRED_RUNNER_CHECKS = [
  "discovery",
  "exact-availability",
  "preview",
  "desired-negative-fixtures",
  "resource-version-bounds",
  "preview-plan-spec-binding",
  "preview-plan-resource-identity-binding",
  "preview-plan-space-binding",
  "preview-plan-form-ref-binding",
  "preview-plan-package-digest-binding",
  "unknown-top-level-request-field-rejected-before-mutation",
  "unknown-metadata-field-rejected-before-mutation",
  "unknown-desired-authority-field-rejected-before-mutation",
  "duplicate-metadata-space-rejected-before-typed-decode",
  "duplicate-resource-version-rejected-before-typed-decode",
  "duplicate-spec-rejected-before-typed-decode",
  "non-utf8-request-rejected-before-typed-decode",
  "duplicate-error-code-response-rejected-before-typed-decode",
  "apply-headers-required",
  "apply",
  "apply-idempotency",
  "idempotency-cross-principal-isolated",
  "idempotency-cross-tenant-isolated",
  "idempotency-replay-authentication-before-cache",
  "idempotency-replay-permission-before-cache",
  "idempotency-replay-policy-before-cache",
  "resource-cross-space-read-isolated",
  "idempotency-cross-space-isolated",
  "resource-cross-space-mutation-isolated",
  "connection-cross-space-target-not-found",
  "connection-missing-target-no-source-mutation",
  "connection-same-space-resolves",
  "idempotency-key-reuse-rejected",
  "create-precondition-conflict",
  "update-headers-required",
  "update",
  "update-idempotency",
  "interface-ready-after-update",
  "stale-update-rejected",
  "read",
  "canonical-resource-parity",
  "exact-digest-substitution-rejected",
  "invalid-argument-normalization",
  "observe",
  "observe-idempotency",
  "observe-headers-required",
  "observe-generation-fence",
  "refresh",
  "refresh-idempotency",
  "refresh-headers-required",
  "refresh-generation-fence",
  "stale-delete-rejected",
  "retryable-code-semantics",
  "stable-error-http-status-mapping",
  "interface-required-feature-advertised",
  "interface-endpoint-same-origin",
  "interface-space-required",
  "interface-query-vocabulary-closed",
  "interface-absent-before-ready",
  "interface-ready-projection",
  "portable-interface-routes-reject-writes",
  "interface-space-isolation",
  "interface-ready-projection-exactly-matches-form-descriptors",
  "interface-exact-pair-read",
  "interface-omitted-version-unique-resolves",
  "interface-exact-resource-instance-read",
  "interface-multi-resource-instance-fails-closed",
  "interface-document-exact-copy",
  "interface-document-schema-valid",
  "interface-required-ready-projection-present",
  "interface-projection-contains-no-authority-fields",
  "delete-headers-required",
  "delete",
  "delete-idempotency",
  "interface-absent-after-delete",
  "import-headers-required",
  "import",
  "import-idempotency",
  "interface-ready-after-import",
  "import-update-headers-required",
  "import-update-stale-rejected",
  "import-update",
  "interface-ready-after-import-update",
  "post-import-delete-readback",
] as const;

export const TAKOFORM_PORTABLE_HOST_REQUIRED_INTERFACE_CHECKS = [
  "interface-required-feature-advertised",
  "interface-endpoint-same-origin",
  "interface-space-required",
  "interface-query-vocabulary-closed",
  "interface-absent-before-ready",
  "interface-ready-projection",
  "portable-interface-routes-reject-writes",
  "interface-space-isolation",
  "interface-ready-projection-exactly-matches-form-descriptors",
  "interface-exact-pair-read",
  "interface-omitted-version-unique-resolves",
  "interface-exact-resource-instance-read",
  "interface-multi-resource-instance-fails-closed",
  "interface-document-exact-copy",
  "interface-document-schema-valid",
  "interface-required-ready-projection-present",
  "interface-projection-contains-no-authority-fields",
  "interface-absent-after-delete",
] as const;

export const TAKOFORM_PORTABLE_HOST_EXPECTED_NEGATIVE_FIXTURES = [
  {
    name: "reject-missing-name",
    stage: "desired",
    sha256:
      "sha256:cef4dd9e6148c7f95fc29655265723aa1f9fb06c52c28697b1e49e69f2397ab3",
  },
  {
    name: "reject-storage_class",
    stage: "desired",
    sha256:
      "sha256:141c8cb7dcfbdfe5921c56eb94bb609c2dad0c9ca10d6285668252f994e2f77b",
  },
  {
    name: "reject-access_protocols",
    stage: "desired",
    sha256:
      "sha256:26cf6afb901f0af78e915b026c7c604bc20781ba322d59adb84222fbd87d4e6b",
  },
] as const;

export const TAKOFORM_PORTABLE_HOST_EXPECTED_GENERATION_TRANSITIONS = [
  "1",
  "2",
  "1",
  "2",
] as const;

export type TakoformStableErrorCode = keyof typeof STABLE_ERROR_SEMANTICS;

export interface TakoformPortableHostRunnerReport extends JsonObject {
  readonly format: typeof TAKOFORM_PORTABLE_HOST_REPORT_FORMAT;
  readonly classification: typeof TAKOFORM_PORTABLE_HOST_RUNNER_CLASSIFICATION;
  readonly publicationReady: false;
  readonly status: "passed";
  readonly subject: string;
  readonly runnerSubject: typeof TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT;
  readonly runnerInputDigest: string;
  readonly checks: readonly string[];
  readonly errorProbes: readonly {
    readonly code: string;
    readonly httpStatus: number;
    readonly retryable: boolean;
  }[];
  readonly negativeFixtures: readonly {
    readonly name: string;
    readonly stage: string;
    readonly sha256: string;
  }[];
  readonly generationTransitions: readonly string[];
  readonly planBindingEvidence: {
    readonly pureBlackBoxInputs: readonly string[];
    readonly instrumentedAdapterInputs: readonly string[];
  };
  readonly idempotencyEvidence: {
    readonly isolationDimensions: readonly string[];
    readonly replayAuthorizationDenials: readonly string[];
    readonly successReplayPreservedAfterDenials: boolean;
  };
  readonly interfaceEvidence: {
    readonly checks: readonly string[];
    readonly absentBeforeReady: boolean;
    readonly exactReadyProjection: boolean;
    readonly absentAfterDelete: boolean;
  };
}

export interface TakoformPortableHostEvidenceAdapterOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  /**
   * Reuses the host composition's bearer authority before any disposable
   * probe, state read, or replay lookup. The returned identity is also the
   * only authority for tenant/principal replay scoping.
   */
  readonly authorizeBearer: (input: {
    readonly token: string;
    readonly request: Request;
  }) =>
    | TakoformPortableHostAuthority
    | undefined
    | Promise<TakoformPortableHostAuthority | undefined>;
  readonly readResource: (
    space: string,
    kind: string,
    name: string,
  ) => ResourceObject | undefined | Promise<ResourceObject | undefined>;
  readonly validatePlanBinding: (input: {
    readonly authorization: string | null;
    readonly resource: JsonObject;
    readonly planDigest: string;
  }) => boolean | Promise<boolean>;
}

export interface TakoformPortableHostAuthority {
  readonly tenant: string;
  readonly principal: string;
}

/**
 * Disposable compatibility seam for the reviewed black-box runner.
 *
 * The probe headers and wire normalization deliberately live outside the
 * production route tree. The wrapped app still performs its ordinary bearer,
 * Form availability, Space, generation, and lifecycle authorization.
 */
export function createTakoformPortableHostEvidenceAdapter(
  options: TakoformPortableHostEvidenceAdapterOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const portableApiRequest =
      url.pathname === API_PATH || url.pathname.startsWith(`${API_PATH}/`);
    let authority: TakoformPortableHostAuthority | undefined;
    if (portableApiRequest) {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
      if (!token) {
        return stableError(
          "unauthenticated",
          "portable host evidence bearer is missing or invalid",
        );
      }
      try {
        authority = await options.authorizeBearer({ token, request });
      } catch {
        return stableError(
          "internal_error",
          "portable host evidence authorization is unavailable",
        );
      }
      if (
        !authority ||
        !validAuthorityComponent(authority.tenant) ||
        !validAuthorityComponent(authority.principal)
      ) {
        return stableError(
          "unauthenticated",
          "portable host evidence bearer is invalid",
        );
      }
    }

    const rawJsonProbe = request.headers.get(
      TAKOFORM_RAW_JSON_PROBE_HEADER,
    );
    if (portableApiRequest && rawJsonProbe !== null) {
      if (rawJsonProbe !== TAKOFORM_RAW_JSON_PROBE_DUPLICATE_ERROR_CODE) {
        return stableError(
          "invalid_argument",
          "portable host evidence raw JSON probe is unknown",
        );
      }
      return new Response(
        '{"error":{"code":"invalid_argument","code":"invalid_argument","message":"duplicate error code probe","requestId":"req_takoform_portable_host_evidence","retryable":false}}',
        {
          status: 400,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    const requestedError = request.headers.get(TAKOFORM_ERROR_PROBE_HEADER);
    if (portableApiRequest && requestedError !== null) {
      return isStableErrorCode(requestedError)
        ? stableError(
            requestedError,
            `portable host evidence probe requested ${requestedError}`,
          )
        : stableError(
            "invalid_argument",
            "portable host evidence probe requested an unknown error code",
          );
    }
    if (portableApiRequest) {
      const authorizationProbe = request.headers.get(
        TAKOFORM_AUTHORIZATION_PROBE_HEADER,
      );
      if (authorizationProbe !== null) {
        switch (authorizationProbe) {
          case TAKOFORM_AUTHORIZATION_PROBE_CREDENTIAL_REVOKED:
            return stableError(
              "unauthenticated",
              "portable host evidence credential is revoked",
            );
          case TAKOFORM_AUTHORIZATION_PROBE_PERMISSION_REVOKED:
            return stableError(
              "permission_denied",
              "portable host evidence permission is revoked",
            );
          case TAKOFORM_AUTHORIZATION_PROBE_POLICY_REVOKED:
            return stableError(
              "policy_denied",
              "portable host evidence policy denies the request",
            );
          default:
            return stableError(
              "invalid_argument",
              "portable host evidence authorization probe is unknown",
            );
        }
      }
    }

    const planBindingProbe = request.headers.get(
      TAKOFORM_PLAN_BINDING_PROBE_HEADER,
    );
    if (portableApiRequest && planBindingProbe !== null) {
      return instrumentPlanBinding({
        request,
        url,
        probe: planBindingProbe,
        fetch: options.fetch,
        validatePlanBinding: options.validatePlanBinding,
      });
    }
    if (url.pathname === INTERFACES_PATH) {
      const invalid = validateInterfaceQuery(url, true);
      if (invalid) return invalid;
    } else if (url.pathname.startsWith(`${INTERFACES_PATH}/`)) {
      const invalid = validateInterfaceQuery(url, false);
      if (invalid) return invalid;
    }
    if (
      url.pathname === INTERFACES_PATH ||
      url.pathname.startsWith(`${INTERFACES_PATH}/`)
    ) {
      if (request.method !== "GET") {
        return stableError(
          "invalid_argument",
          "portable Interface declarations are read-only",
        );
      }
    }

    let response: Response;
    try {
      response = await options.fetch(request);
    } catch {
      return stableError(
        "internal_error",
        "portable host evidence adapter could not execute the request",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return await normalizeError(request, response);
    }
    if (response.status === 204) return response;

    const body = await responseJson(response);
    if (!isObject(body)) return response;
    try {
      const projected = await projectSuccess({
        request,
        url,
        body,
        readResource: options.readResource,
      });
      return jsonResponse(projected, response.status, response.headers);
    } catch {
      return stableError(
        "internal_error",
        "portable host evidence projection is unavailable",
      );
    }
  };
}

function validAuthorityComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

async function instrumentPlanBinding(input: {
  readonly request: Request;
  readonly url: URL;
  readonly probe: string;
  readonly fetch: TakoformPortableHostEvidenceAdapterOptions["fetch"];
  readonly validatePlanBinding:
    TakoformPortableHostEvidenceAdapterOptions["validatePlanBinding"];
}): Promise<Response> {
  let document: unknown;
  try {
    const raw = new TextEncoder().encode(await input.request.clone().text());
    document = parseCanonicalJson(raw);
  } catch {
    document = undefined;
  }
  const documentRecord = isObject(document) ? document : undefined;
  const instrumentedResource = documentRecord
    ? isObject(documentRecord.resource)
      ? documentRecord.resource
      : Object.fromEntries(
          Object.entries(documentRecord).filter(([key]) => key !== "review"),
        )
    : undefined;
  const requestedSpace =
    isObject(instrumentedResource?.metadata) &&
    typeof instrumentedResource.metadata.space === "string" &&
    isPortableSpaceId(instrumentedResource.metadata.space)
      ? instrumentedResource.metadata.space
      : "portable-plan-binding-auth";
  const authUrl = new URL(input.url);
  authUrl.pathname = `${API_PATH}/forms`;
  authUrl.search = "";
  authUrl.searchParams.set("space", requestedSpace);
  const authHeaders = new Headers();
  const authorization = input.request.headers.get("authorization");
  if (authorization !== null) {
    authHeaders.set("authorization", authorization);
  }
  authHeaders.set("accept", "application/json");
  const authRequest = new Request(authUrl, {
    method: "GET",
    headers: authHeaders,
  });
  let authResponse: Response;
  try {
    authResponse = await input.fetch(authRequest);
  } catch {
    return stableError(
      "internal_error",
      "portable plan-binding authorization check failed",
    );
  }
  if (!authResponse.ok) {
    return normalizeError(authRequest, authResponse);
  }
  if (
    !PLAN_BINDING_INPUTS.has(input.probe) ||
    input.request.method !== "PUT" ||
    !input.url.pathname.startsWith(`${RESOURCE_PATH}/`)
  ) {
    return stableError(
      "invalid_argument",
      "portable plan-binding probe is invalid",
    );
  }

  if (!document) {
    return stableError(
      "invalid_argument",
      "portable plan-binding apply body is invalid",
    );
  }
  if (!documentRecord || !instrumentedResource) {
    return stableError(
      "invalid_argument",
      "portable plan-binding apply body is invalid",
    );
  }
  const resource = instrumentedResource as JsonObject;
  const review = isObject(documentRecord.review)
    ? documentRecord.review
    : undefined;
  const planDigest =
    typeof review?.planDigest === "string" ? review.planDigest : undefined;
  if (!resource || !planDigest) {
    return stableError(
      "invalid_argument",
      "portable plan-binding apply body is invalid",
    );
  }
  let accepted = false;
  try {
    accepted = await input.validatePlanBinding({
      authorization,
      resource,
      planDigest,
    });
  } catch {
    return stableError(
      "internal_error",
      "canonical portable plan-binding validation is unavailable",
    );
  }
  if (!accepted) {
    const rejected = stableError(
      "invalid_argument",
      "reviewed plan does not bind this exact portable Resource",
    );
    rejected.headers.set(
      TAKOFORM_PLAN_BINDING_RESULT_HEADER,
      TAKOFORM_PLAN_BINDING_REJECTED,
    );
    return rejected;
  }
  return new Response(null, {
    status: 204,
    headers: {
      [TAKOFORM_PLAN_BINDING_RESULT_HEADER]:
        TAKOFORM_PLAN_BINDING_ACCEPTED_NO_MUTATION,
    },
  });
}

export async function executeExactTakoformPortableHostRunner(input: {
  readonly takoformRoot: string;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}): Promise<TakoformPortableHostRunnerReport> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    fetch: input.fetch,
  });
  try {
    const contractRoot = resolve(
      input.takoformRoot,
      "conformance/portable-host-v1",
    );
    const child = Bun.spawn(
      [
        "go",
        "run",
        "./cmd/portable-host-conformance",
        "run",
        "--contract",
        contractRoot,
        "--endpoint",
        server.url.origin,
        "--token-env",
        TAKOFORM_RUNNER_PRIMARY_TOKEN_ENV,
        "--alternate-token-env",
        TAKOFORM_RUNNER_ALTERNATE_TOKEN_ENV,
        "--alternate-tenant-token-env",
        TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN_ENV,
      ],
      {
        cwd: resolve(input.takoformRoot),
        env: {
          ...process.env,
          [TAKOFORM_RUNNER_PRIMARY_TOKEN_ENV]:
            TAKOFORM_RUNNER_PRIMARY_TOKEN,
          [TAKOFORM_RUNNER_ALTERNATE_TOKEN_ENV]:
            TAKOFORM_RUNNER_ALTERNATE_TOKEN,
          [TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN_ENV]:
            TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new TypeError(
        `exact Takoform portable-host runner failed: ${stderr.trim() || `exit ${exitCode}`}`,
      );
    }
    if (new TextEncoder().encode(stdout).byteLength > MAX_RUNNER_OUTPUT_BYTES) {
      throw new TypeError("exact Takoform portable-host runner output is too large");
    }
    const report = JSON.parse(stdout) as unknown;
    assertPortableHostRunnerReport(report);
    return report;
  } finally {
    server.stop(true);
  }
}

export function assertPortableHostRunnerReport(
  value: unknown,
): asserts value is TakoformPortableHostRunnerReport {
  if (
    !isObject(value) ||
    value.format !== TAKOFORM_PORTABLE_HOST_REPORT_FORMAT ||
    value.classification !== TAKOFORM_PORTABLE_HOST_RUNNER_CLASSIFICATION ||
    value.publicationReady !== false ||
    value.status !== "passed" ||
    typeof value.subject !== "string" ||
    !/^host:http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(value.subject) ||
    value.runnerSubject !== TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT ||
    value.runnerInputDigest !==
      TAKOFORM_PORTABLE_HOST_RUNNER_INPUT_DIGEST ||
    !sameStringSequence(
      value.checks,
      TAKOFORM_PORTABLE_HOST_REQUIRED_RUNNER_CHECKS,
    ) ||
    !Array.isArray(value.errorProbes) ||
    !sameNegativeFixtureSequence(
      value.negativeFixtures,
      TAKOFORM_PORTABLE_HOST_EXPECTED_NEGATIVE_FIXTURES,
    ) ||
    !sameStringSequence(
      value.generationTransitions,
      TAKOFORM_PORTABLE_HOST_EXPECTED_GENERATION_TRANSITIONS,
    ) ||
    !isObject(value.planBindingEvidence) ||
    !sameStringSequence(
      value.planBindingEvidence.pureBlackBoxInputs,
      TAKOFORM_PLAN_BINDING_PURE_INPUTS,
    ) ||
    !sameStringSequence(
      value.planBindingEvidence.instrumentedAdapterInputs,
      TAKOFORM_PLAN_BINDING_INSTRUMENTED_INPUTS,
    ) ||
    !isObject(value.idempotencyEvidence) ||
    !sameStringSequence(
      value.idempotencyEvidence.isolationDimensions,
      TAKOFORM_IDEMPOTENCY_ISOLATION_DIMENSIONS,
    ) ||
    !sameStringSequence(
      value.idempotencyEvidence.replayAuthorizationDenials,
      TAKOFORM_IDEMPOTENCY_REPLAY_DENIALS,
    ) ||
    value.idempotencyEvidence.successReplayPreservedAfterDenials !== true ||
    !isObject(value.interfaceEvidence) ||
    !sameStringSequence(
      value.interfaceEvidence.checks,
      TAKOFORM_PORTABLE_HOST_REQUIRED_INTERFACE_CHECKS,
    ) ||
    value.interfaceEvidence.absentBeforeReady !== true ||
    value.interfaceEvidence.exactReadyProjection !== true ||
    value.interfaceEvidence.absentAfterDelete !== true
  ) {
    throw new TypeError("exact Takoform portable-host runner report is invalid");
  }
  const probes = new Map<string, { status: number; retryable: boolean }>();
  for (const probe of value.errorProbes) {
    if (
      !isObject(probe) ||
      typeof probe.code !== "string" ||
      !isStableErrorCode(probe.code) ||
      typeof probe.httpStatus !== "number" ||
      typeof probe.retryable !== "boolean" ||
      probes.has(probe.code)
    ) {
      throw new TypeError(
        "exact Takoform portable-host runner error evidence is invalid",
      );
    }
    probes.set(probe.code, {
      status: probe.httpStatus,
      retryable: probe.retryable,
    });
  }
  for (const [code, semantics] of Object.entries(STABLE_ERROR_SEMANTICS)) {
    const probe = probes.get(code);
    if (
      !probe ||
      probe.status !== semantics.status ||
      probe.retryable !== semantics.retryable
    ) {
      throw new TypeError(
        `exact Takoform portable-host runner omitted stable error ${code}`,
      );
    }
  }
}

function validateInterfaceQuery(
  url: URL,
  list: boolean,
): Response | undefined {
  const allowed = list
    ? new Set(["space"])
    : new Set(["space", "version", "resourceKind", "resourceName"]);
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key);
    if (
      !allowed.has(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value?.trim() ||
      (key === "space" && !isPortableSpaceId(value))
    ) {
      return stableError(
        "invalid_argument",
        "portable Interface query vocabulary is closed",
      );
    }
  }
  if (url.searchParams.getAll("space").length !== 1) {
    return stableError(
      "invalid_argument",
      "portable Interface query requires one Space",
    );
  }
  const resourceKind = url.searchParams.get("resourceKind");
  const resourceName = url.searchParams.get("resourceName");
  if ((resourceKind === null) !== (resourceName === null)) {
    return stableError(
      "invalid_argument",
      "resourceKind and resourceName must be provided together",
    );
  }
  return undefined;
}

function isPortableSpaceId(value: string): boolean {
  const codePoints = [...value];
  if (codePoints.length < 1 || codePoints.length > 255) return false;
  if (
    isSpaceIdBoundaryWhitespace(codePoints[0]!) ||
    isSpaceIdBoundaryWhitespace(codePoints.at(-1)!)
  ) {
    return false;
  }
  return !codePoints.some((candidate) => {
    const codePoint = candidate.codePointAt(0)!;
    return (
      candidate === "/" ||
      (codePoint >= 0x00 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    );
  });
}

function isSpaceIdBoundaryWhitespace(value: string): boolean {
  const codePoint = value.codePointAt(0)!;
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

async function normalizeError(
  request: Request,
  response: Response,
): Promise<Response> {
  const body = await responseJson(response);
  const error = isObject(body) && isObject(body.error) ? body.error : undefined;
  const hostCode =
    typeof error?.hostCode === "string" && error.hostCode.trim()
      ? error.hostCode
      : undefined;
  let code =
    hostCode === "deployment_plan_changed"
      ? "invalid_argument"
      : hostCode === "connection_not_found"
        ? "resource_not_found"
      : isStableErrorCode(hostCode)
        ? hostCode
        : stableCode(error?.code, response.status);
  if (
    request.headers.get("if-match") !== null &&
    code === "resource_not_found"
  ) {
    code = "resource_version_conflict";
  }
  if (
    request.headers.get("if-match") !== null &&
    code === "invalid_argument" &&
    error?.message ===
      "metadata.resourceVersion does not match the HTTP precondition"
  ) {
    code = "resource_version_conflict";
  }
  if (
    request.headers.get("if-none-match") === "*" &&
    code === "resource_busy"
  ) {
    code = "resource_version_conflict";
  }
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message
      : `portable host request failed with ${code}`;
  return stableError(code, message, hostCode);
}

function stableCode(value: unknown, status: number): TakoformStableErrorCode {
  if (isStableErrorCode(value)) return value;
  switch (value) {
    case "unauthorized":
      return "unauthenticated";
    case "forbidden":
      return "permission_denied";
    case "not_found":
      return "resource_not_found";
    case "conflict":
      return status === 412
        ? "resource_version_conflict"
        : "resource_busy";
  }
  switch (status) {
    case 400:
      return "invalid_argument";
    case 401:
      return "unauthenticated";
    case 403:
      return "permission_denied";
    case 404:
      return "resource_not_found";
    case 409:
      return "resource_busy";
    case 412:
      return "resource_version_conflict";
    case 503:
      return "backend_unavailable";
    default:
      return "internal_error";
  }
}

async function projectSuccess(input: {
  readonly request: Request;
  readonly url: URL;
  readonly body: Record<string, unknown>;
  readonly readResource: TakoformPortableHostEvidenceAdapterOptions["readResource"];
}): Promise<JsonObject> {
  if (input.url.pathname === DISCOVERY_PATH) {
    return projectDiscovery(input.url, input.body);
  }

  if (
    input.url.pathname === INTERFACES_PATH ||
    input.url.pathname.startsWith(`${INTERFACES_PATH}/`)
  ) {
    if (Array.isArray(input.body.interfaces)) {
      return {
        interfaces: input.body.interfaces.map(projectInterface),
      } as JsonObject;
    }
    return projectInterface(input.body);
  }

  if (input.url.pathname === `${RESOURCE_PATH}/preview`) {
    const resource = requiredObject(input.body.resource, "preview.resource");
    const review = requiredObject(input.body.review, "preview.review");
    const projectedResource = projectPortableResource(resource);
    return {
      resource: projectedResource,
      review: {
        planDigest: requiredString(review.planDigest, "review.planDigest"),
        specDigest: digestCanonicalJson(
          (projectedResource.spec ?? {}) as CanonicalJsonValue,
        ),
      },
    };
  }

  if (input.url.pathname === RESOURCE_PATH && Array.isArray(input.body.resources)) {
    const resources = [];
    for (const value of input.body.resources) {
      const resource = requiredObject(value, "resources[]");
      resources.push(
        await projectReadyResource(
          resource,
          input.readResource,
        ),
      );
    }
    return {
      resources,
      ...(typeof input.body.nextCursor === "string"
        ? { nextCursor: input.body.nextCursor }
        : {}),
    } as JsonObject;
  }

  if (input.url.pathname.startsWith(`${RESOURCE_PATH}/`)) {
    const resource = isObject(input.body.resource)
      ? input.body.resource
      : input.body;
    const projected = await projectReadyResource(
      resource,
      input.readResource,
    );
    return isObject(input.body.resource)
      ? ({ resource: projected } as JsonObject)
      : projected;
  }
  return input.body as JsonObject;
}

function projectDiscovery(
  url: URL,
  value: Record<string, unknown>,
): JsonObject {
  if (
    !Array.isArray(value.api_versions) ||
    !value.api_versions.includes("forms.takoform.com/v1alpha1")
  ) {
    throw new TypeError("portable Takoform API version is unavailable");
  }
  const features = requiredObject(value.features, "discovery.features");
  for (const feature of [
    "service_forms",
    "exact_form_ref",
    "optimistic_concurrency",
    "idempotent_lifecycle",
    "interface_declarations",
  ]) {
    if (features[feature] !== true) {
      throw new TypeError(`portable discovery feature ${feature} is unavailable`);
    }
  }
  return {
    api_versions: ["forms.takoform.com/v1alpha1"],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      interface_declarations: true,
    },
    endpoints: {
      api: `${url.origin}${API_PATH}`,
      forms: `${url.origin}${API_PATH}/forms`,
      interfaces: `${url.origin}${INTERFACES_PATH}`,
    },
  };
}

async function projectReadyResource(
  portable: Record<string, unknown>,
  readResource: TakoformPortableHostEvidenceAdapterOptions["readResource"],
): Promise<JsonObject> {
  const projected = projectPortableResource(portable);
  const metadata = requiredObject(projected.metadata, "resource.metadata");
  const kind = requiredString(projected.kind, "resource.kind");
  const space = requiredString(metadata.space, "resource.metadata.space");
  const name = requiredString(metadata.name, "resource.metadata.name");
  const canonical = await readResource(space, kind, name);
  if (
    !canonical?.status ||
    canonical.status.phase !== "Ready" ||
    canonical.status.observedGeneration !== canonical.metadata.generation ||
    !isObject(canonical.status.outputs)
  ) {
    throw new TypeError("canonical Ready Resource outputs are unavailable");
  }
  const output = structuredClone(canonical.status.outputs);
  const generation = canonical.metadata.generation;
  const id =
    typeof output.id === "string" ? output.id : `${canonical.kind}/${name}`;
  const portability =
    typeof output.portability === "string"
      ? output.portability
      : (canonical.status.resolution?.portability ?? "portable");
  const imported =
    canonical.status.conditions?.some(
      (condition) =>
        condition.reason === "Imported" &&
        condition.status === "true" &&
        condition.observedGeneration === generation,
    ) ?? false;
  return {
    ...projected,
    status: {
      observed: {
        driftedFields: [],
        generation,
        id,
        imported,
        portability,
        ready: true,
      },
      output,
    },
  };
}

function projectPortableResource(
  value: Record<string, unknown>,
): JsonObject {
  const metadata = requiredObject(value.metadata, "resource.metadata");
  const resourceVersion =
    typeof metadata.resourceVersion === "string" &&
    metadata.resourceVersion !== "0" &&
    metadata.resourceVersion !== ""
      ? metadata.resourceVersion
      : undefined;
  return {
    apiVersion: requiredString(value.apiVersion, "resource.apiVersion"),
    kind: requiredString(value.kind, "resource.kind"),
    ...(isObject(value.form) ? { form: projectPortableForm(value.form) } : {}),
    metadata: {
      name: requiredString(metadata.name, "resource.metadata.name"),
      space: requiredString(metadata.space, "resource.metadata.space"),
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    ...(isObject(value.spec) ? { spec: value.spec as JsonObject } : {}),
  };
}

function projectInterface(value: unknown): JsonObject {
  const declaration = requiredObject(value, "Interface declaration");
  const resource = requiredObject(
    declaration.resource,
    "Interface declaration resource",
  );
  return {
    name: requiredString(declaration.name, "Interface name"),
    version: requiredString(declaration.version, "Interface version"),
    resource: {
      kind: requiredString(resource.kind, "Interface resource kind"),
      name: requiredString(resource.name, "Interface resource name"),
    },
    document: isObject(declaration.document)
      ? (declaration.document as JsonObject)
      : {},
    values: isObject(declaration.values)
      ? (declaration.values as JsonObject)
      : {},
    ...(typeof declaration.resourceUri === "string"
      ? { resourceUri: declaration.resourceUri }
      : {}),
    ...(isObject(declaration.form)
      ? {
          form: projectPortableForm(
            declaration.form,
            requiredString(resource.kind, "Interface resource kind"),
          ),
        }
      : {}),
  };
}

function projectPortableForm(
  value: Record<string, unknown>,
  kindHint?: string,
): JsonObject {
  if (isObject(value.formRef)) {
    return {
      formRef: {
        apiVersion: requiredString(
          value.formRef.apiVersion,
          "formRef.apiVersion",
        ),
        kind: requiredString(value.formRef.kind, "formRef.kind"),
        definitionVersion: requiredString(
          value.formRef.definitionVersion,
          "formRef.definitionVersion",
        ),
        schemaDigest: requiredString(
          value.formRef.schemaDigest,
          "formRef.schemaDigest",
        ),
      },
      packageDigest: requiredString(
        value.packageDigest,
        "form.packageDigest",
      ),
    };
  }
  const internal = value as Partial<InstalledFormReference>;
  return {
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: requiredString(kindHint, "form kind"),
      definitionVersion: requiredString(
        internal.version,
        "form definitionVersion",
      ),
      schemaDigest: requiredString(
        internal.schemaDigest,
        "form schemaDigest",
      ),
    },
    packageDigest: requiredString(
      internal.packageDigest,
      "form packageDigest",
    ),
  };
}

function stableError(
  code: TakoformStableErrorCode,
  message: string,
  hostCode?: string,
): Response {
  const semantics = STABLE_ERROR_SEMANTICS[code];
  return jsonResponse(
    {
      error: {
        code,
        message,
        requestId: REQUEST_ID,
        retryable: semantics.retryable,
        ...(hostCode && hostCode !== code ? { hostCode } : {}),
      },
    },
    semantics.status,
  );
}

function digestCanonicalJson(value: CanonicalJsonValue): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonBytes(value))
    .digest("hex")}`;
}

function jsonResponse(
  value: unknown,
  status: number,
  sourceHeaders?: Headers,
): Response {
  const headers = new Headers(sourceHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(JSON.stringify(value), { status, headers });
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isStableErrorCode(value: unknown): value is TakoformStableErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(STABLE_ERROR_SEMANTICS, value)
  );
}

function sameStringSequence(
  value: unknown,
  expected: readonly string[],
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function sameNegativeFixtureSequence(
  value: unknown,
  expected: readonly {
    readonly name: string;
    readonly stage: string;
    readonly sha256: string;
  }[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => {
      const wanted = expected[index];
      return (
        wanted !== undefined &&
        isObject(item) &&
        Object.keys(item).length === 3 &&
        item.name === wanted.name &&
        item.stage === wanted.stage &&
        item.sha256 === wanted.sha256
      );
    })
  );
}

function uniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
