#!/usr/bin/env bun
/**
 * Takosumi control-plane Layer-2 smoke.
 *
 * This proves the product control-plane loop, not only the raw provider/module:
 * signed-in Account session -> Workspace ProviderConnection -> Git Source/Capsule ->
 * plan/apply -> Run / StateVersion / Output ledger ->
 * Cloudflare verification -> destroy-plan/approval/destroy-apply.
 *
 * Secret values are read only from the operator environment or files and are
 * never printed in the result.
 */

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { lookup as lookupDns } from "node:dns/promises";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import process from "node:process";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  CapsuleInterfaceBindingProposal,
  CapsuleInterfaceBlueprint,
  CapsuleInterfaceBlueprintInput,
  Interface,
  InterfaceBinding,
} from "../contract/interfaces.ts";
import type { JsonObject, JsonValue } from "../contract/types.ts";
import {
  canonicalProviderSource,
  isOpenTofuIdentifier,
} from "../contract/provider-env-rules.ts";
import {
  assertNewOwnerPrivateEvidenceTarget,
  readOwnerPrivateTextFile,
  writeNewPrivateEvidenceJson,
} from "./lib/private-evidence-file.ts";

export const PLATFORM_CONTROL_PLANE_SMOKE_KIND =
  "takosumi.platform-control-plane-smoke@v3" as const;
export const CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS = 180_000;
export const PUBLIC_URL_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_PUBLIC_URL_RESPONSE_BYTES = 512 * 1024;
const RESPONSE_BODY_CANCEL_TIMEOUT_MS = 50;

const TAKOSUMI_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "providers/cloudflare/modules/cloudflare-hello-worker/module",
);
const DEFAULT_PROVIDERLESS_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "examples/opentofu-basic",
);
const DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID = "opentofu-default";
const DEFAULT_DEPLOY_TIMEOUT_SECONDS = 300;
const PRIVATE_INPUT_MAX_BYTES = 64 * 1024;
const CONTROL_PLANE_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SERVICE_IDENTITY_MAX_BYTES = 1024;
const API_PREFIX = "/api/v1";
const CLOUDFLARE_PROVIDER_SOURCE =
  "registry.opentofu.org/cloudflare/cloudflare";
const EXACT_PROVIDER_SOURCE_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/u;
const MAX_SMOKE_PROVIDER_BINDINGS = 64;
const MAX_SMOKE_INTERFACE_BLUEPRINTS = 64;
const MAX_SMOKE_INTERFACE_TOKEN_BYTES = 16 * 1024;
const HELLO_WORKER_INTERFACE_TYPE = "mcp.server";
const HELLO_WORKER_INTERFACE_VERSION = "2025-11-25";
const HELLO_WORKER_INTERFACE_PERMISSION = "mcp.invoke";
const interfaceTransportScope = Symbol("takosumi.interface-transport-scope");
const publicUrlTransportScope = Symbol("takosumi.public-url-transport-scope");
const publicUrlLifecycleScope = Symbol("takosumi.public-url-lifecycle-scope");
const publicUrlCheckProgress = new WeakMap<
  object,
  ConfiguredPublicUrlProgress
>();
const controlPlaneTransportContext =
  new AsyncLocalStorage<ControlPlaneTransportDependencies>();
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "waiting_approval",
]);
type SmokeCheckStatus = "passed" | "denied" | "not_reached";
type SmokeVerificationMode = "cloudflare-worker" | "opentofu";
type SmokeProviderConnectionMode = "guided" | "generic-env" | "none";
type SmokeAuthTokenKind = "session" | "pat";
type CloudflareResourcePreflightMode =
  "none" | "workers" | "d1" | "account-resources";
type ReleaseActivationRequirement = "any" | "pending" | "succeeded" | "failed";
type SecretInputSource = "env" | "file" | "not_required";
type NonSecretInputSource = "env" | "file" | "arg" | "not_required";
type JsonSmokeValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonSmokeValue[]
  | { readonly [key: string]: JsonSmokeValue };
type SmokeOutputAllowlistType =
  "string" | "url" | "hostname" | "number" | "boolean" | "json";
type SmokeOutputAllowlist = Readonly<
  Record<
    string,
    {
      readonly from: string;
      readonly type: SmokeOutputAllowlistType;
      readonly required?: boolean;
    }
  >
>;
export type PublicUrlCheck = {
  readonly name: string;
  readonly output: string;
  readonly path: string;
  readonly expectedStatus: number;
  readonly bodyIncludes: readonly string[];
  readonly destroyExpectation: PublicUrlDestroyExpectation;
};

export type PublicUrlDestroyExpectation =
  | { readonly kind: "http-404" }
  | {
      readonly kind: "not-verifiable";
      readonly reason: string;
    };

export type PublicUrlCheckResult = {
  readonly name: string;
  readonly output: string;
  readonly url: string;
  readonly status: number;
  readonly ok: true;
  readonly bodyIncludes: readonly string[];
  readonly bodyDigest: string;
  readonly destroyExpectation: PublicUrlDestroyExpectation;
};

export type PublicUrlDestroyCheckResult = {
  readonly name: string;
  readonly output: string;
  readonly url?: string;
  readonly expectation: PublicUrlDestroyExpectation;
  readonly applyStatus: "planned" | "passed" | "unverified";
  readonly status: "planned" | "passed" | "not_claimed" | "inconclusive";
  readonly observedStatus?: number;
  readonly error?: string;
};

type RegisteredPublicUrlCheck = {
  readonly check: PublicUrlCheck;
  readonly url?: string;
  applyResult?: PublicUrlCheckResult;
  applyError?: string;
};

type ConfiguredPublicUrlProgress = {
  readonly registrations: readonly RegisteredPublicUrlCheck[];
  readonly results: readonly PublicUrlCheckResult[];
};
type CapsuleFunctionalProbeResult = {
  readonly kind: "takosumi.capsule-functional-probe@v1";
  readonly status: "passed";
  readonly product: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed";
  }[];
  readonly cleanupVerified?: boolean;
  readonly cleanupDelegatedToDestroy?: boolean;
};
type CapsuleFunctionalProbeEvidence = {
  readonly product: string;
  readonly checkNames: readonly string[];
  readonly cleanupVerified: boolean;
  readonly cleanupMode: "probe" | "opentofu-destroy";
  readonly resultDigest: string;
  readonly scriptDigest: string;
  readonly durationMs: number;
};
type SmokeStepTiming = {
  readonly step: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
};
type SmokeRunTiming = {
  readonly name: string;
  readonly runId: string;
  readonly type: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly queueMs?: number;
  readonly executionMs?: number;
  readonly totalMs?: number;
};

export interface SmokeProviderBindingInput {
  /** Exact canonical provider source required by the selected module. */
  readonly provider: string;
  /** Exact local provider name in the selected module, when declared. */
  readonly moduleLocalName?: string;
  /** Alias expected by the selected module; omitted means its default. */
  readonly childAlias?: string;
  /** Alias of the generated root provider block; omitted means its default. */
  readonly rootAlias?: string;
  /** Existing Workspace ProviderConnection selected explicitly by the operator. */
  readonly connectionId: string;
}

export interface SmokeCompatibilityRootProviderRequirement {
  readonly source: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
}

export interface PlatformControlPlaneSmokeOptions {
  readonly url: string;
  readonly accountSessionToken: string;
  readonly accountSessionTokenSource: "env" | "file";
  readonly accountAuthTokenKind: SmokeAuthTokenKind;
  readonly cloudflareApiToken: string;
  readonly cloudflareApiTokenSource: SecretInputSource;
  readonly cloudflareAccountId: string;
  readonly cloudflareAccountIdSource: NonSecretInputSource;
  readonly cloudflareWorkersSubdomain: string;
  readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
  readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
  /** Existing workspace/provider connection to bind without creating or revoking it. */
  readonly providerConnectionId?: string;
  /**
   * Explicit 0..N ProviderBindings for the selected module. The singular
   * providerConnectionId remains a compatibility shorthand for one default
   * binding whose provider source is read from that connection.
   */
  readonly providerBindings: readonly SmokeProviderBindingInput[];
  /** True when the operator supplied the 0..N binding set, including `[]`. */
  readonly providerBindingsExplicit: boolean;
  readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
  readonly runnerProfileId?: string;
  readonly workspace: string;
  readonly appName: string;
  readonly environment: string;
  readonly sourceMode: "git";
  readonly capsuleDir: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly vars: Readonly<Record<string, JsonSmokeValue>>;
  readonly outputAllowlist: SmokeOutputAllowlist;
  readonly publicUrlChecks: readonly PublicUrlCheck[];
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScript?: string;
  readonly functionalProbeScriptDigest?: string;
  readonly functionalProbeEnvNames: readonly string[];
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly installConfigId?: string;
  /** Install-time Interface declarations sent with the Capsule create call. */
  readonly interfaceBlueprints?: readonly CapsuleInterfaceBlueprint[];
  /** True when the operator explicitly supplied or disabled Interface proof. */
  readonly interfaceBlueprintsExplicit?: boolean;
  /** Skip the built-in Cloudflare hello-worker Interface proof explicitly. */
  readonly noInterfaceProof?: boolean;
  /** Request an optional OAuth Interface token exchange (never implicit). */
  readonly interfaceTokenProofRequested?: boolean;
  /** Runtime OAuth credential loaded from a private file; never serialized. */
  readonly interfaceRuntimeToken?: string;
  readonly interfaceRuntimeTokenSource?: SecretInputSource;
  readonly storeMetadata?: Readonly<Record<string, JsonSmokeValue>>;
  readonly sourceName?: string;
  readonly timeoutSeconds: number;
  readonly deployTimeoutSeconds: number;
  readonly pollIntervalMs: number;
  readonly dryRun: boolean;
  readonly noDefaultVars: boolean;
  readonly json: boolean;
  readonly outFile?: string;
  readonly requireReleaseActivation?: ReleaseActivationRequirement;
  readonly keepConnection: boolean;
  readonly ensureWorkspace: boolean;
  readonly backupRestoreRehearsal: boolean;
  readonly workspaceDisplayName?: string;
  readonly expectedServiceIdentity?: {
    readonly headerName: string;
    readonly value: string;
  };
}

export interface PlatformControlPlaneSmokeResult {
  readonly kind: typeof PLATFORM_CONTROL_PLANE_SMOKE_KIND;
  readonly status: "passed" | "dry_run" | "failed";
  readonly generatedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly serviceUrl: string;
  readonly scratchWorkspaceId: string;
  readonly capsuleModule: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly credentialPath: "workspace_scoped_provider_connection" | "none";
  readonly providerConnectionMode: SmokeProviderConnectionMode;
  readonly serviceIdentity?: {
    readonly headerName: string;
    readonly identityDigest: `sha256:${string}`;
    readonly sampleCount: number;
    readonly result: "planned" | "passed" | "failed";
  };
  /** Required end-to-end checkpoints for this smoke shape. */
  readonly steps: readonly string[];
  /** Checkpoints that were actually completed before the result was written. */
  readonly completedSteps: readonly string[];
  /** Per-checkpoint wall-clock timings for deploy-speed regressions. */
  readonly stepTimings: readonly SmokeStepTiming[];
  /** Run-ledger timings split queue latency from OpenTofu execution time. */
  readonly runTimings: readonly SmokeRunTiming[];
  readonly appName: string;
  readonly environment: string;
  readonly connectionId?: string;
  readonly providerConnectionId?: string;
  readonly sourceId?: string;
  readonly sourceSyncRunId?: string;
  readonly sourceSnapshotId?: string;
  readonly sourceSnapshotTransport?: SourceSnapshotTransportEvidence;
  readonly installConfigId?: string;
  readonly compatibilityReportId?: string;
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly applyRunId?: string;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly stateVersionLedger?: StateVersionLedgerVerificationResult;
  readonly interfaceMaterialization?: InterfaceMaterializationVerificationResult;
  readonly interfaceMaterializations?: readonly InterfaceMaterializationVerificationResult[];
  readonly runEventSequence?: CanonicalRunEventSequenceVerificationResult;
  readonly releaseActivation?: ReleaseActivationVerificationResult;
  readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
  readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
  readonly publicUrlDestroyChecks?: readonly PublicUrlDestroyCheckResult[];
  readonly functionalProbe?: CapsuleFunctionalProbeEvidence;
  readonly capsuleGateStatus: SmokeCheckStatus;
  readonly policyStatus: SmokeCheckStatus;
  readonly workerUrl: string;
  readonly opentofuApplyVerified: boolean;
  readonly runtimeVerified: boolean;
  readonly publicUrlVerified: boolean;
  readonly stateVersionLedgerVerified: boolean;
  readonly destroyVerified: boolean;
  readonly connectionRevoked?: boolean;
  readonly timedOutRunId?: string;
  readonly runCancellationStatus?: "cancelled" | "already_terminal" | "failed";
  readonly runCancellationError?: string;
  readonly connectionRevokeSkippedReason?: string;
  readonly failureCleanup?: FailureCleanupResult;
  readonly error?: string;
  readonly nextAction?: string;
  readonly inputs: {
    readonly accountSessionTokenSource: "env" | "file";
    readonly accountAuthTokenKind: SmokeAuthTokenKind;
    readonly cloudflareApiTokenSource: SecretInputSource;
    readonly cloudflareAccountIdSource: NonSecretInputSource;
    readonly cloudflareAccountIdDigest: string;
    readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
    readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
    readonly providerConnectionId?: string;
    readonly providerBindingCount: number;
    readonly providerBindingsExplicit: boolean;
    readonly providerBindingsDigest?: string;
    readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
    readonly runnerProfileId?: string;
    readonly sourceMode: "git";
    readonly verificationMode: SmokeVerificationMode;
    readonly varsDigest: string;
    readonly outputAllowlistNames: readonly string[];
    readonly publicUrlCheckNames: readonly string[];
    readonly publicUrlDestroyExpectations: readonly {
      readonly name: string;
      readonly expectation: PublicUrlDestroyExpectation;
    }[];
    readonly cloudflareWorkerNameOutput?: string;
    readonly runtimePublicUrlOutput?: string;
    readonly functionalProbeScriptDigest?: string;
    readonly functionalProbeEnvNames: readonly string[];
    readonly capsuleDir?: string;
    readonly sourceGitUrlDigest?: string;
    readonly sourceRef?: string;
    readonly sourcePath?: string;
    readonly modulePath?: string;
    readonly installConfigId?: string;
    readonly interfaceBlueprintCount: number;
    readonly interfaceBlueprintsExplicit: boolean;
    readonly interfaceProof: "required" | "disabled" | "not_requested";
    readonly interfaceTokenProofRequested: boolean;
    readonly interfaceRuntimeTokenSource?: SecretInputSource;
    readonly storeMetadataDigest?: string;
  };
}

export interface SourceSnapshotTransportEvidence {
  readonly sourceSnapshotId: string;
  readonly resolvedCommit: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly fetchedByRunId: string;
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly dryRun?: boolean;
  readonly noDefaultVars?: boolean;
  readonly json?: boolean;
  readonly outFile?: string;
  readonly keepConnection?: boolean;
  readonly ensureWorkspace?: boolean;
  readonly backupRestoreRehearsal?: boolean;
  readonly url?: string;
  readonly sessionTokenFile?: string;
  readonly patTokenFile?: string;
  readonly authTokenKind?: string;
  readonly cloudflareApiTokenFile?: string;
  readonly cloudflareAccountId?: string;
  readonly cloudflareAccountIdFile?: string;
  readonly cloudflareWorkersSubdomain?: string;
  readonly cloudflareWorkersSubdomainFile?: string;
  readonly cloudflareConnectionMode?: string;
  readonly providerConnectionId?: string;
  readonly providerBindingsJson?: string;
  readonly providerBindingsJsonFile?: string;
  readonly cloudflareResourcePreflight?: string;
  readonly runnerProfileId?: string;
  readonly workspace?: string;
  readonly workspaceDisplayName?: string;
  readonly appName?: string;
  readonly environment?: string;
  readonly capsuleDir?: string;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly installConfigId?: string;
  readonly interfaceBlueprintsJson?: string;
  readonly interfaceBlueprintsJsonFile?: string;
  readonly noInterfaceProof?: boolean;
  readonly interfaceTokenProof?: boolean;
  readonly interfaceRuntimeTokenFile?: string;
  readonly storeMetadataJson?: string;
  readonly storeMetadataJsonFile?: string;
  readonly sourceName?: string;
  readonly verificationMode?: string;
  readonly varsJson?: string;
  readonly varsJsonFile?: string;
  readonly outputAllowlistJson?: string;
  readonly outputAllowlistJsonFile?: string;
  readonly publicUrlChecksJson?: string;
  readonly publicUrlChecksJsonFile?: string;
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScript?: string;
  readonly functionalProbeEnv?: string;
  readonly timeoutSeconds?: string;
  readonly deployTimeoutSeconds?: string;
  readonly pollIntervalMs?: string;
  readonly requireReleaseActivation?: string;
  readonly expectedServiceIdentityHeader?: string;
  readonly expectedServiceIdentity?: string;
}

interface RequestOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly binary?: Uint8Array;
  readonly allowEmpty?: boolean;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
}

class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${path} did not return within ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

class RequestResponseTooLargeError extends Error {
  constructor(readonly method: string, readonly path: string) {
    super(`${method} ${path} response body exceeded the maximum size`);
    this.name = "RequestResponseTooLargeError";
  }
}

class RequestRedirectError extends Error {
  constructor(readonly method: string, readonly path: string) {
    super(`${method} ${path} rejected a redirect response`);
    this.name = "RequestRedirectError";
  }
}

class RequestTransportError extends Error {
  constructor(readonly method: string, readonly path: string) {
    super(`${method} ${path} request failed`);
    this.name = "RequestTransportError";
  }
}

class CloudflareApiTimeoutError extends Error {
  constructor() {
    super("Cloudflare API request timed out");
    this.name = "CloudflareApiTimeoutError";
  }
}

class CloudflareApiRedirectError extends Error {
  constructor() {
    super("Cloudflare API rejected a redirect response");
    this.name = "CloudflareApiRedirectError";
  }
}

class CloudflareApiResponseTooLargeError extends Error {
  constructor() {
    super("Cloudflare API response body exceeded the maximum size");
    this.name = "CloudflareApiResponseTooLargeError";
  }
}

class CloudflareApiRequestError extends Error {
  constructor() {
    super("Cloudflare API request failed");
    this.name = "CloudflareApiRequestError";
  }
}

class PublicUrlCheckTimeoutError extends Error {
  constructor(name: string) {
    super(`public URL check ${name} request timed out`);
    this.name = "TimeoutError";
  }
}

class PublicUrlResponseTooLargeError extends Error {
  constructor(name: string) {
    super(`public URL check ${name} response body exceeded the maximum size`);
    this.name = "ResponseTooLargeError";
  }
}

class PublicUrlDnsResolutionError extends Error {
  constructor(label: string) {
    super(`${label} DNS resolution failed`);
    this.name = "DnsResolutionError";
  }
}

class PublicUrlNonPublicAddressError extends Error {
  constructor(label: string) {
    super(`${label} resolved to a non-public address`);
    this.name = "NonPublicAddressError";
  }
}

class InterfaceBearerRedirectError extends Error {
  constructor() {
    super("Interface bearer resource rejected a redirect response");
    this.name = "InterfaceBearerRedirectError";
  }
}

class RunPollTimeoutError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} did not reach a terminal state`);
    this.name = "RunPollTimeoutError";
  }
}

class ApplyStartIndeterminateError extends Error {
  constructor(
    readonly planRunId: string,
    readonly reason: "run_authority_unavailable" | "no_exact_run" | "ambiguous_exact_runs",
  ) {
    const detail = reason === "run_authority_unavailable"
      ? "the Workspace Run authority could not be read"
      : reason === "ambiguous_exact_runs"
        ? "the Workspace Run authority returned multiple exact matches"
        : "the Workspace Run authority returned no exact match";
    super(
      `Apply POST acknowledgement was lost and no exact ApplyRun could be reconciled for plan ${planRunId}: ${detail}`,
    );
    this.name = "ApplyStartIndeterminateError";
  }
}

class CloudflareResourcePreflightError extends Error {
  constructor(
    readonly reason: "request_failed" | "capability_denied",
    message: string,
  ) {
    super(message);
    this.name = "CloudflareResourcePreflightError";
  }
}

class InterfaceTokenUseStillAuthorizedError extends Error {
  constructor(readonly resource: string, readonly status: number) {
    super(`retired Interface resource remained authorized after destroy`);
    this.name = "InterfaceTokenUseStillAuthorizedError";
  }
}

interface RunRecord {
  readonly id: string;
  readonly workspaceId?: string;
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly status: string;
  readonly type: string;
  readonly sourceSnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly policyStatus?: string;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoredStateVersionId?: string;
  readonly restoredFromStateVersionId?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

interface DeployResponse {
  readonly capsule: { readonly id: string; readonly name?: string };
  readonly run: RunRecord;
  readonly planRun?: RunRecord;
  readonly applyRun?: RunRecord;
  readonly created?: boolean;
}

export interface InstallConfigRecord {
  readonly id?: string;
  readonly name?: string;
  readonly workspaceId?: string;
  readonly internal?: { readonly reason?: string };
}

export interface SmokeProviderConnectionListEntry {
  readonly id?: string;
  readonly providerSource?: string;
  readonly displayName?: string;
}

interface CapsuleLedgerRecord {
  readonly id?: string;
  readonly name?: string;
  readonly workspaceId?: string;
  readonly status?: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration?: number;
}

interface CapsuleLedgerResponse {
  readonly capsule?: CapsuleLedgerRecord;
}

interface StateVersionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly createdByRunId: string;
  readonly generation: number;
  readonly createdAt: string;
}

interface OutputRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly stateGeneration: number;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly outputDigest: string;
  readonly createdAt: string;
}

interface StateVersionLedgerVerificationResult {
  readonly capsuleStatus: string;
  readonly stateVersionId: string;
  readonly generation: number;
  readonly applyRunId: string;
  readonly outputId?: string;
  readonly outputDigest?: string;
  readonly publicOutputNames: readonly string[];
  readonly publicOutputDigest: string;
  readonly publicOutputs?: Readonly<Record<string, unknown>>;
}

/** Credential-free proof that a Plan-pinned Capsule blueprint materialized. */
export interface InterfaceMaterializationVerificationResult {
  readonly interfaceId: string;
  readonly interfaceName: string;
  readonly interfaceKey: string;
  readonly interfaceType: string;
  readonly interfaceVersion: string;
  readonly interfacePhase: string;
  readonly interfaceGeneration: number;
  readonly resolvedRevision: number;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly outputId?: string;
  readonly outputGeneration: number;
  readonly outputDigest: string;
  readonly bindingId?: string;
  readonly bindingPhase?: string;
  readonly bindingGeneration?: number;
  readonly bindingPermission?: string;
  readonly bindingDelivery?: string;
  readonly endpointUse?: "passed" | "skipped";
  readonly tokenProof?: InterfaceTokenProofEvidence;
  readonly retiredPhase?: string;
  readonly revokedBindingPhase?: string;
  readonly tokenRevoked?: boolean;
  readonly endpointRetired?: boolean;
}

export interface InterfaceTokenProofEvidence {
  readonly status: "passed" | "skipped";
  readonly permission?: string;
  readonly resourceDigest?: string;
  readonly tokenDigest?: string;
  readonly expiresIn?: number;
  readonly postDestroyTokenDenied?: boolean;
  readonly postDestroyUseDenied?: boolean;
}

export interface CanonicalRunEventEvidence {
  readonly id: string;
  readonly action: string;
  readonly outcome: "planned" | "approved" | "applied" | "destroyed";
  readonly runId: string;
  readonly targetId: string;
  readonly operation?: string;
  readonly metadataKeys: readonly string[];
}

export interface CanonicalRunEventSequenceVerificationResult {
  readonly plan: CanonicalRunEventEvidence;
  readonly apply: CanonicalRunEventEvidence;
  readonly destroyPlan: CanonicalRunEventEvidence;
  readonly destroyApply: CanonicalRunEventEvidence;
}

interface ReleaseActivationVerificationResult {
  readonly eventId: string;
  readonly action: string;
  readonly status: Exclude<ReleaseActivationStatus, "skipped">;
  readonly targetId: string;
  readonly runId: string;
  readonly activationKind?: string;
  readonly commandCount?: number;
  readonly outputCount?: number;
  readonly metadataKeys: readonly string[];
}

interface CloudflareResourcePreflightResult {
  readonly mode: CloudflareResourcePreflightMode;
  readonly status: "passed";
  readonly checks: readonly string[];
}

const CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS = [
  {
    id: "cloudflare.workers.script.list",
    label: "Worker scripts",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts?per_page=1`,
  },
  {
    id: "cloudflare.d1.database.list",
    label: "D1 databases",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=1`,
  },
  {
    id: "cloudflare.kv.namespace.list",
    label: "KV namespaces",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=1`,
  },
  {
    id: "cloudflare.r2.bucket.list",
    label: "R2 buckets",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=1`,
  },
  {
    id: "cloudflare.queue.list",
    label: "Queues",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/queues?per_page=1`,
  },
  {
    id: "cloudflare.workflow.list",
    label: "Workflows",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workflows?per_page=1`,
  },
  {
    id: "cloudflare.vectorize.index.list",
    label: "Vectorize indexes",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes?per_page=1`,
  },
] as const;

interface FailureCleanupResult {
  readonly attempted: true;
  readonly cloudflareWorkerGone: boolean;
  readonly capsuleMarkedError: boolean;
  readonly destroyAttempted?: boolean;
  readonly retainedForOperatorRecovery?: true;
  readonly destroyApplyAttempted?: boolean;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly destroySucceeded?: boolean;
  readonly destroyError?: string;
  readonly destroyVerification?: SmokeDestroyVerification;
  readonly error?: string;
}

interface SmokeDestroyVerification {
  readonly status: "passed" | "inconclusive";
  readonly cloudflareWorkerGone: boolean;
  readonly publicUrlDestroyChecks?: readonly PublicUrlDestroyCheckResult[];
  readonly error?: string;
}

interface DestroySmokeCapsuleResult {
  readonly destroyPlanRun: RunRecord;
  readonly destroyApplyRun: RunRecord;
  readonly destroyVerification?: SmokeDestroyVerification;
}

interface DestroySmokeCapsuleProgress {
  destroyPlanRun?: RunRecord;
  destroyApplyRun?: RunRecord;
  destroyApplyAttempted: boolean;
}

interface ActivityEventRecord {
  readonly id?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly runId?: string;
  readonly metadata?: Record<string, unknown>;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.selfTest) {
    await runSelfTest();
    return 0;
  }

  const options = await resolveOptions(args, process.env);
  if (options.dryRun) {
    const result = dryRunResult(options);
    await writeResult(result, options);
    return 0;
  }

  const result = await runPlatformControlPlaneSmoke(options);
  await writeResult(result, options);
  return result.status === "failed" ? 1 : 0;
}

export async function resolveOptions(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): Promise<PlatformControlPlaneSmokeOptions> {
  if (args.backupRestoreRehearsal === true) {
    throw new Error(
      "--backup-restore-rehearsal is unavailable: the control export has no manifest-bound restore importer",
    );
  }
  const rawUrl = args.url ?? env.TAKOSUMI_PLATFORM_URL;
  if (!rawUrl) {
    throw new Error("--url or TAKOSUMI_PLATFORM_URL is required");
  }
  // Canonicalize the selected authority before reading any authentication or
  // provider material. DNS is deliberately resolved later, once for the
  // canonical authority and retained for the complete smoke lifecycle, so no
  // secret-bearing bytes can leave on an unsafe or subsequently changed
  // answer.
  const url = normalizeBaseUrl(rawUrl);
  const workspace = args.workspace ?? env.TAKOSUMI_SMOKE_WORKSPACE;
  if (!workspace) {
    throw new Error("--workspace or TAKOSUMI_SMOKE_WORKSPACE is required");
  }
  const expectedServiceIdentity = parseExpectedServiceIdentity(
    args.expectedServiceIdentityHeader ??
      env.TAKOSUMI_SMOKE_EXPECTED_SERVICE_IDENTITY_HEADER,
    args.expectedServiceIdentity ??
      env.TAKOSUMI_SMOKE_EXPECTED_SERVICE_IDENTITY,
  );
  const outFile = args.outFile
    ? await assertNewOwnerPrivateEvidenceTarget(args.outFile, {
        sourceRoots: [TAKOSUMI_ROOT],
        label: "platform control-plane smoke evidence",
      })
    : undefined;
  const cloudflareConnectionMode = parseCloudflareConnectionMode(
    args.cloudflareConnectionMode ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_CONNECTION_MODE,
  );
  const providerConnectionId = optionalProviderConnectionId(
    args.providerConnectionId ?? env.TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID,
  );
  const providerBindingsInline =
    args.providerBindingsJson ?? env.TAKOSUMI_SMOKE_PROVIDER_BINDINGS_JSON;
  const providerBindingsFile =
    args.providerBindingsJsonFile ??
    env.TAKOSUMI_SMOKE_PROVIDER_BINDINGS_JSON_FILE;
  if (
    providerBindingsInline !== undefined &&
    providerBindingsFile !== undefined
  ) {
    throw new Error(
      "--provider-bindings-json cannot be combined with --provider-bindings-json-file",
    );
  }
  const providerBindingsExplicit =
    providerBindingsInline !== undefined || providerBindingsFile !== undefined;
  const providerBindings = parseSmokeProviderBindings(
    await readJsonValueInput({
      inline: providerBindingsInline,
      file: providerBindingsFile,
      label: "provider bindings",
      fallback: [],
    }),
  );
  if (providerConnectionId !== undefined && providerBindingsExplicit) {
    throw new Error(
      "--provider-connection-id cannot be combined with --provider-bindings-json or --provider-bindings-json-file",
    );
  }
  if (
    (providerConnectionId !== undefined || providerBindingsExplicit) &&
    cloudflareConnectionMode !== "none"
  ) {
    throw new Error(
      "existing ProviderBindings require --cloudflare-connection-mode none; they cannot be combined with guided or generic-env",
    );
  }
  const verificationMode = parseVerificationMode(
    args.verificationMode ?? env.TAKOSUMI_SMOKE_VERIFICATION_MODE,
  );
  const cloudflareResourcePreflight = parseCloudflareResourcePreflight(
    args.cloudflareResourcePreflight ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_RESOURCE_PREFLIGHT,
  );
  if (
    cloudflareConnectionMode === "none" &&
    verificationMode === "cloudflare-worker"
  ) {
    throw new Error(
      "--cloudflare-connection-mode none requires --verification-mode opentofu",
    );
  }
  const cloudflareInputsRequired =
    cloudflareConnectionMode !== "none" ||
    verificationMode === "cloudflare-worker" ||
    cloudflareResourcePreflight !== "none";
  const providerlessOpenTofuSmoke =
    cloudflareConnectionMode === "none" &&
    verificationMode === "opentofu" &&
    providerConnectionId === undefined &&
    providerBindings.length === 0;
  const cloudflareAccountId = cloudflareInputsRequired
    ? await readNonSecretInput({
        file: args.cloudflareAccountIdFile ?? env.CLOUDFLARE_ACCOUNT_ID_FILE,
        value: args.cloudflareAccountId,
        envValue: env.CLOUDFLARE_ACCOUNT_ID,
        envName: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare account id",
        dryRun: args.dryRun === true,
        hint: "pass --cloudflare-account-id-file, --cloudflare-account-id, or set CLOUDFLARE_ACCOUNT_ID",
      })
    : ({ value: "", source: "not_required" } as const);
  const cloudflareWorkersSubdomain = cloudflareInputsRequired
    ? await readNonSecretInput({
        file:
          args.cloudflareWorkersSubdomainFile ??
          env.CLOUDFLARE_WORKERS_SUBDOMAIN_FILE,
        value: args.cloudflareWorkersSubdomain,
        envValue: env.CLOUDFLARE_WORKERS_SUBDOMAIN,
        envName: "CLOUDFLARE_WORKERS_SUBDOMAIN",
        label: "Cloudflare Workers subdomain",
        dryRun: args.dryRun === true,
        hint: "pass --cloudflare-workers-subdomain-file, --cloudflare-workers-subdomain, or set CLOUDFLARE_WORKERS_SUBDOMAIN",
      })
    : ({ value: "", source: "not_required" } as const);
  const patTokenFile = args.patTokenFile ?? env.TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE;
  const patTokenValue = env.TAKOSUMI_ACCOUNT_PAT_TOKEN;
  const accountAuthTokenKind = parseAuthTokenKind(
    args.authTokenKind ??
      env.TAKOSUMI_ACCOUNT_AUTH_TOKEN_KIND ??
      (patTokenFile || patTokenValue ? "pat" : "session"),
  );
  const accountSessionToken = await readSecret({
    file:
      patTokenFile ??
      args.sessionTokenFile ??
      env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE,
    envValue: patTokenValue ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN,
    envName: "TAKOSUMI_ACCOUNT_PAT_TOKEN or TAKOSUMI_ACCOUNT_SESSION_TOKEN",
    label:
      accountAuthTokenKind === "pat"
        ? "account personal access token"
        : "account session token",
    dryRun: args.dryRun === true,
  });
  const cloudflareApiToken = cloudflareInputsRequired
    ? await readSecret({
        file: args.cloudflareApiTokenFile ?? env.CLOUDFLARE_API_TOKEN_FILE,
        envValue: env.CLOUDFLARE_API_TOKEN,
        envName: "CLOUDFLARE_API_TOKEN",
        label: "Cloudflare API token",
        dryRun: args.dryRun === true,
      })
    : ({ value: "", source: "not_required" } as const);
  const rawSourceGitUrl =
    args.sourceGitUrl ??
    env.TAKOSUMI_SMOKE_SOURCE_GIT_URL ??
    (args.dryRun === true
      ? "https://git.example.test/example/smoke-fixture.git"
      : undefined);
  if (!rawSourceGitUrl) {
    throw new Error(
      "--source-git-url is required. Platform smoke uses Git URL Source/Capsule; public upload deploy is retired.",
    );
  }
  const sourceGitUrl =
    rawSourceGitUrl !== undefined
      ? normalizeSmokeSourceGitUrl(rawSourceGitUrl)
      : undefined;
  const sourceRef = args.sourceRef ?? env.TAKOSUMI_SMOKE_SOURCE_REF;
  const sourcePath = args.sourcePath ?? env.TAKOSUMI_SMOKE_SOURCE_PATH ?? ".";
  const modulePath = args.modulePath ?? env.TAKOSUMI_SMOKE_MODULE_PATH;
  const installConfigId =
    args.installConfigId ?? env.TAKOSUMI_SMOKE_INSTALL_CONFIG_ID;
  const storeMetadata = await readJsonRecordInput({
    inline: args.storeMetadataJson ?? env.TAKOSUMI_SMOKE_STORE_METADATA_JSON,
    file:
      args.storeMetadataJsonFile ?? env.TAKOSUMI_SMOKE_STORE_METADATA_JSON_FILE,
    label: "store metadata",
    fallback: {},
  });
  const sourceName =
    args.sourceName ?? env.TAKOSUMI_SMOKE_SOURCE_NAME ?? undefined;
  const sourceMode = "git" as const;
  const capsuleDir = resolve(
    args.capsuleDir ??
      (providerlessOpenTofuSmoke
        ? DEFAULT_PROVIDERLESS_CAPSULE_DIR
        : DEFAULT_CAPSULE_DIR),
  );
  const resolvedAppName = args.appName ?? defaultCapsuleName();
  const explicitVars = await readJsonRecordInput({
    inline: args.varsJson ?? env.TAKOSUMI_SMOKE_VARS_JSON,
    file: args.varsJsonFile ?? env.TAKOSUMI_SMOKE_VARS_JSON_FILE,
    label: "vars",
    fallback: {},
  });
  const defaultVars = (() => {
    if (args.noDefaultVars === true) return {};
    if (providerlessOpenTofuSmoke) {
      return Object.keys(explicitVars).length > 0
        ? {}
        : defaultSmokeVars({
            accountId: "",
            appName: resolvedAppName,
            workersSubdomain: "",
            providerless: true,
          });
    }
    if (cloudflareConnectionMode === "none") return {};
    return defaultSmokeVars({
      accountId: cloudflareAccountId.value,
      appName: resolvedAppName,
      workersSubdomain: cloudflareWorkersSubdomain.value,
    });
  })();
  const vars = mergeJsonRecords(defaultVars, explicitVars);
  const outputAllowlist = parseOutputAllowlist(
    await readJsonRecordInput({
      inline:
        args.outputAllowlistJson ?? env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON,
      file:
        args.outputAllowlistJsonFile ??
        env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON_FILE,
      label: "output allowlist",
      fallback: defaultSmokeOutputAllowlist(providerlessOpenTofuSmoke),
    }),
  );
  const noInterfaceProof =
    args.noInterfaceProof === true ||
    env.TAKOSUMI_SMOKE_NO_INTERFACE_PROOF === "1";
  const interfaceBlueprintsInline =
    args.interfaceBlueprintsJson ??
    env.TAKOSUMI_SMOKE_INTERFACE_BLUEPRINTS_JSON;
  const interfaceBlueprintsFile =
    args.interfaceBlueprintsJsonFile ??
    env.TAKOSUMI_SMOKE_INTERFACE_BLUEPRINTS_JSON_FILE;
  if (
    interfaceBlueprintsInline !== undefined &&
    interfaceBlueprintsFile !== undefined
  ) {
    throw new Error(
      "--interface-blueprints-json cannot be combined with --interface-blueprints-json-file",
    );
  }
  const customInterfaceBlueprints = parseSmokeInterfaceBlueprints(
    await readJsonValueInput({
      inline: interfaceBlueprintsInline,
      file: interfaceBlueprintsFile,
      label: "interface blueprints",
      fallback: [],
    }),
  );
  const builtInInterfaceBlueprints =
    verificationMode === "cloudflare-worker" && !noInterfaceProof
      ? [
          defaultHelloWorkerInterfaceBlueprint(
            resolvedAppName,
            (() => {
              const configured =
                args.runtimePublicUrlOutput ??
                env.TAKOSUMI_SMOKE_RUNTIME_PUBLIC_URL_OUTPUT;
              if (
                configured &&
                outputAllowlist[configured]?.type === "url"
              ) {
                return configured;
              }
              return (
                Object.entries(outputAllowlist).find(
                  ([, projection]) => projection.type === "url",
                )?.[0] ?? "url"
              );
            })(),
          ),
        ]
      : [];
  const interfaceBlueprints = mergeSmokeInterfaceBlueprints(
    builtInInterfaceBlueprints,
    customInterfaceBlueprints,
  );
  if (
    verificationMode === "cloudflare-worker" &&
    !noInterfaceProof &&
    !Object.values(outputAllowlist).some(
      (projection) => projection.type === "url",
    )
  ) {
    throw new Error(
      "Cloudflare hello-worker Interface proof requires a public URL output in the output allowlist",
    );
  }
  const interfaceRuntimeTokenFile =
    args.interfaceRuntimeTokenFile ??
    env.TAKOSUMI_SMOKE_INTERFACE_RUNTIME_TOKEN_FILE;
  const hasOAuthInterfaceBinding = interfaceBlueprints.some((blueprint) =>
    (blueprint.bindings ?? []).some(
      (proposal) => proposal.delivery.type === "oauth2",
    ),
  );
  const interfaceTokenProofRequested =
    args.interfaceTokenProof === true || interfaceRuntimeTokenFile !== undefined;
  if (interfaceTokenProofRequested && !hasOAuthInterfaceBinding) {
    throw new Error(
      "--interface-token-proof or --interface-runtime-token-file requires an OAuth Interface blueprint binding",
    );
  }
  if (interfaceTokenProofRequested && !interfaceRuntimeTokenFile) {
    throw new Error(
      "Interface token proof was requested but --interface-runtime-token-file is missing",
    );
  }
  const interfaceRuntimeToken = interfaceRuntimeTokenFile
      ? await readSecret({
        file: interfaceRuntimeTokenFile,
        envValue: undefined,
        envName: "TAKOSUMI_SMOKE_INTERFACE_RUNTIME_TOKEN_FILE",
        label: "Interface runtime token",
        dryRun: args.dryRun === true,
        maxBytes: MAX_SMOKE_INTERFACE_TOKEN_BYTES,
      })
    : undefined;
  const publicUrlChecks = parsePublicUrlChecks(
    await readJsonValueInput({
      inline:
        args.publicUrlChecksJson ?? env.TAKOSUMI_SMOKE_PUBLIC_URL_CHECKS_JSON,
      file:
        args.publicUrlChecksJsonFile ??
        env.TAKOSUMI_SMOKE_PUBLIC_URL_CHECKS_JSON_FILE,
      label: "public URL checks",
      fallback: [],
    }),
    outputAllowlist,
  );
  const cloudflareWorkerNameOutput = parseExplicitProjectedOutputName({
    raw:
      args.cloudflareWorkerNameOutput ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_WORKER_NAME_OUTPUT,
    label: "--cloudflare-worker-name-output",
    outputAllowlist,
    acceptedTypes: ["string"],
  });
  const runtimePublicUrlOutput = parseExplicitProjectedOutputName({
    raw:
      args.runtimePublicUrlOutput ??
      env.TAKOSUMI_SMOKE_RUNTIME_PUBLIC_URL_OUTPUT,
    label: "--runtime-public-url-output",
    outputAllowlist,
    acceptedTypes: ["url"],
  });
  const functionalProbeScriptInput =
    args.functionalProbeScript ?? env.TAKOSUMI_SMOKE_FUNCTIONAL_PROBE_SCRIPT;
  const functionalProbeScript = functionalProbeScriptInput
    ? resolve(functionalProbeScriptInput)
    : undefined;
  const functionalProbeScriptDigest = functionalProbeScript
    ? sha256(await readFile(functionalProbeScript, "utf8"))
    : undefined;
  const functionalProbeEnvNames = parseFunctionalProbeEnvNames(
    args.functionalProbeEnv ?? env.TAKOSUMI_SMOKE_FUNCTIONAL_PROBE_ENV,
  );
  if (functionalProbeEnvNames.length > 0 && !functionalProbeScript) {
    throw new Error(
      "--functional-probe-env requires --functional-probe-script",
    );
  }
  if (!args.dryRun) {
    for (const name of functionalProbeEnvNames) {
      if (!env[name]) {
        throw new Error(
          `functional probe environment variable ${name} is not set`,
        );
      }
    }
  }
  const appName = resolvedAppName;
  const explicitRunnerProfileId =
    args.runnerProfileId ?? env.TAKOSUMI_SMOKE_RUNNER_PROFILE_ID;
  const runnerProfileId =
    explicitRunnerProfileId ??
    (providerlessOpenTofuSmoke
      ? DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID
      : undefined);
  const requireReleaseActivation = parseReleaseActivationRequirement(
    args.requireReleaseActivation ??
      env.TAKOSUMI_SMOKE_REQUIRE_RELEASE_ACTIVATION,
  );
  return {
    url,
    accountSessionToken: accountSessionToken.value,
    accountSessionTokenSource: accountSessionToken.source,
    accountAuthTokenKind,
    cloudflareApiToken: cloudflareApiToken.value,
    cloudflareApiTokenSource: cloudflareApiToken.source,
    cloudflareAccountId: cloudflareAccountId.value,
    cloudflareAccountIdSource: cloudflareAccountId.source,
    cloudflareWorkersSubdomain: cloudflareWorkersSubdomain.value,
    cloudflareWorkersSubdomainSource: cloudflareWorkersSubdomain.source,
    cloudflareConnectionMode,
    ...(providerConnectionId ? { providerConnectionId } : {}),
    providerBindings,
    providerBindingsExplicit,
    cloudflareResourcePreflight,
    ...(runnerProfileId ? { runnerProfileId } : {}),
    workspace,
    appName,
    environment: args.environment?.trim() || "smoke",
    sourceMode,
    capsuleDir,
    verificationMode,
    vars,
    outputAllowlist,
    publicUrlChecks,
    ...(cloudflareWorkerNameOutput ? { cloudflareWorkerNameOutput } : {}),
    ...(runtimePublicUrlOutput ? { runtimePublicUrlOutput } : {}),
    ...(functionalProbeScript ? { functionalProbeScript } : {}),
    ...(functionalProbeScriptDigest ? { functionalProbeScriptDigest } : {}),
    functionalProbeEnvNames,
    ...(sourceGitUrl ? { sourceGitUrl } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(sourceGitUrl ? { sourcePath } : {}),
    ...(modulePath ? { modulePath } : {}),
    ...(installConfigId ? { installConfigId } : {}),
    interfaceBlueprints,
    interfaceBlueprintsExplicit:
      interfaceBlueprintsInline !== undefined ||
      interfaceBlueprintsFile !== undefined ||
      noInterfaceProof,
    noInterfaceProof,
    interfaceTokenProofRequested,
    ...(interfaceRuntimeToken
      ? {
          interfaceRuntimeToken: interfaceRuntimeToken.value,
          interfaceRuntimeTokenSource: interfaceRuntimeToken.source,
        }
      : {}),
    ...(Object.keys(storeMetadata).length > 0 ? { storeMetadata } : {}),
    ...(sourceGitUrl && sourceName ? { sourceName } : {}),
    timeoutSeconds: parsePositiveInteger(
      args.timeoutSeconds,
      "--timeout-seconds",
      600,
    ),
    deployTimeoutSeconds: parsePositiveInteger(
      args.deployTimeoutSeconds,
      "--deploy-timeout-seconds",
      DEFAULT_DEPLOY_TIMEOUT_SECONDS,
    ),
    pollIntervalMs: parsePositiveInteger(
      args.pollIntervalMs,
      "--poll-interval-ms",
      2_000,
    ),
    dryRun: args.dryRun === true,
    noDefaultVars: args.noDefaultVars === true,
    json: args.json === true,
    ...(outFile ? { outFile } : {}),
    ...(requireReleaseActivation ? { requireReleaseActivation } : {}),
    keepConnection: args.keepConnection === true,
    ensureWorkspace: args.ensureWorkspace === true,
    backupRestoreRehearsal: args.backupRestoreRehearsal === true,
    ...(args.workspaceDisplayName
      ? { workspaceDisplayName: args.workspaceDisplayName }
      : {}),
    ...(expectedServiceIdentity ? { expectedServiceIdentity } : {}),
  };
}

export function dryRunResult(
  options: PlatformControlPlaneSmokeOptions,
): PlatformControlPlaneSmokeResult {
  assertBackupRestoreRehearsalUnavailable(options);
  for (const check of options.publicUrlChecks) {
    assertPublicUrlLifecycleContract(check);
  }
  const generatedAt = new Date().toISOString();
  const steps = requiredSteps(options);
  const dryRunInterfaces = dryRunInterfaceEvidence(options);
  const dryRunRunEvents = dryRunInterfaces
    ? dryRunCanonicalRunEventSequence()
    : undefined;
  const publicUrlDestroyChecks: readonly PublicUrlDestroyCheckResult[] =
    options.publicUrlChecks.map((check) => ({
      name: check.name,
      output: check.output,
      url: dryRunPublicUrl(check),
      expectation: check.destroyExpectation,
      applyStatus: "planned" as const,
      status:
        check.destroyExpectation.kind === "http-404"
          ? "planned" as const
          : "not_claimed" as const,
    }));
  return {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "dry_run",
    generatedAt,
    startedAt: generatedAt,
    finishedAt: generatedAt,
    durationMs: 0,
    serviceUrl: options.url,
    scratchWorkspaceId: options.workspace,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath: providerCredentialPath(options),
    providerConnectionMode: options.cloudflareConnectionMode,
    ...(options.expectedServiceIdentity
      ? {
          serviceIdentity: serviceIdentityEvidence(
            options.expectedServiceIdentity,
            0,
            "planned",
          ),
        }
      : {}),
    ...(options.providerConnectionId
      ? { providerConnectionId: options.providerConnectionId }
      : {}),
    sourceMode: options.sourceMode,
    steps,
    completedSteps: steps,
    stepTimings: steps.map((step) => ({
      step,
      startedAt: generatedAt,
      finishedAt: generatedAt,
      durationMs: 0,
    })),
    runTimings: dryRunRunTimings(generatedAt),
    appName: options.appName,
    environment: options.environment,
    capsuleGateStatus: "passed",
    policyStatus: "passed",
    workerUrl: shouldVerifyCloudflareWorker(options)
      ? publicWorkerUrl(options)
      : "",
    opentofuApplyVerified: options.verificationMode === "opentofu",
    runtimeVerified: shouldVerifyCloudflareWorker(options),
    publicUrlVerified:
      options.verificationMode === "cloudflare-worker" ||
      options.publicUrlChecks.length > 0,
    stateVersionLedgerVerified: true,
    destroyVerified: publicUrlDestroyChecks.every(
      (check) => check.status === "planned",
    ),
    ...(options.cloudflareResourcePreflight !== "none"
      ? {
          cloudflareResourcePreflight: {
            mode: options.cloudflareResourcePreflight,
            status: "passed",
            checks: cloudflareResourcePreflightChecks(
              options.cloudflareResourcePreflight,
            ),
          },
        }
      : {}),
    connectionRevoked:
      options.keepConnection || !temporaryProviderConnection(options)
        ? undefined
        : true,
    stateVersionLedger: {
      capsuleStatus: "active",
      stateVersionId: "state_dry_run",
      generation: 1,
      applyRunId: "apply_dry_run",
      outputId: "output_dry_run",
      outputDigest: `sha256:${"0".repeat(64)}`,
      publicOutputNames: Object.keys(options.outputAllowlist).sort(),
      publicOutputDigest: `sha256:${"0".repeat(64)}`,
    },
    ...(dryRunInterfaces
      ? {
          interfaceMaterializations: dryRunInterfaces,
          interfaceMaterialization: dryRunInterfaces[0],
        }
      : {}),
    ...(dryRunRunEvents ? { runEventSequence: dryRunRunEvents } : {}),
    ...(options.publicUrlChecks.length > 0
      ? {
          publicUrlChecks: options.publicUrlChecks.map((check) => ({
            name: check.name,
            output: check.output,
            url: dryRunPublicUrl(check),
            status: check.expectedStatus,
            ok: true as const,
            bodyIncludes: check.bodyIncludes,
            bodyDigest: `sha256:${"0".repeat(64)}`,
            destroyExpectation: check.destroyExpectation,
          })),
          publicUrlDestroyChecks,
        }
      : {}),
    ...(options.functionalProbeScript
      ? {
          functionalProbe: {
            product: options.appName,
            checkNames: ["dry-run"],
            cleanupVerified: true,
            cleanupMode: "probe" as const,
            resultDigest: `sha256:${"0".repeat(64)}`,
            scriptDigest:
              options.functionalProbeScriptDigest ?? `sha256:${"0".repeat(64)}`,
            durationMs: 0,
          },
        }
      : {}),
    ...(options.requireReleaseActivation
      ? {
          releaseActivation: {
            eventId: "evt_dry_run",
            action: `release_activation.${dryRunReleaseActivationStatus(
              options.requireReleaseActivation,
            )}`,
            status: dryRunReleaseActivationStatus(
              options.requireReleaseActivation,
            ),
            targetId: "dep_dry_run",
            runId: "apply_dry_run",
            activationKind: "takosumi.release-commands@v1",
            commandCount: 1,
            outputCount: Object.keys(options.outputAllowlist).length,
            metadataKeys: ["activationKind", "commandCount", "outputCount"],
          },
        }
      : {}),
    inputs: publicInputSummary(options),
  };
}

function providerCredentialPath(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    "cloudflareConnectionMode" | "providerConnectionId" | "providerBindings"
  >,
): "workspace_scoped_provider_connection" | "none" {
  return options.providerConnectionId !== undefined ||
    options.providerBindings.length > 0 ||
    options.cloudflareConnectionMode !== "none"
    ? "workspace_scoped_provider_connection"
    : "none";
}

function temporaryProviderConnection(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    "cloudflareConnectionMode" | "providerConnectionId" | "providerBindings"
  >,
): boolean {
  return (
    options.providerConnectionId === undefined &&
    options.providerBindings.length === 0 &&
    options.cloudflareConnectionMode !== "none"
  );
}

function dryRunRunTimings(timestamp: string): readonly SmokeRunTiming[] {
  return ["plan", "apply", "destroy_plan", "destroy_apply"].map((name) => ({
    name,
    runId: `${name}_dry_run`,
    type: name,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    queueMs: 0,
    executionMs: 0,
    totalMs: 0,
  }));
}

function dryRunInterfaceEvidence(
  options: PlatformControlPlaneSmokeOptions,
): readonly InterfaceMaterializationVerificationResult[] | undefined {
  const blueprints = options.interfaceBlueprints ?? [];
  if (blueprints.length === 0) return undefined;
  const outputDigest = `sha256:${"0".repeat(64)}`;
  return blueprints.map((blueprint, index) => {
    const proposal = blueprint.bindings?.[0];
    return {
      interfaceId: `interface_dry_run_${index + 1}`,
      interfaceName: blueprint.name,
      interfaceKey: blueprint.key,
      interfaceType: blueprint.spec.type,
      interfaceVersion: blueprint.spec.version,
      interfacePhase: "Resolved",
      interfaceGeneration: 1,
      resolvedRevision: 1,
      stateVersionId: "state_dry_run",
      stateGeneration: 1,
      outputId: "output_dry_run",
      outputGeneration: 1,
      outputDigest,
      ...(proposal
        ? {
            bindingId: `interface_binding_dry_run_${index + 1}`,
            bindingPhase: "Ready",
            bindingGeneration: 1,
            bindingPermission: proposal.permissions[0],
            bindingDelivery: proposal.delivery.type,
          }
        : {}),
      endpointUse: "skipped",
      ...(options.interfaceTokenProofRequested
        ? {
            tokenProof: {
              status: "skipped" as const,
              ...(proposal?.permissions[0]
                ? { permission: proposal.permissions[0] }
                : {}),
            },
          }
        : {}),
      retiredPhase: "Retired",
      ...(proposal ? { revokedBindingPhase: "Revoked" } : {}),
    };
  });
}

function dryRunCanonicalRunEventSequence(): CanonicalRunEventSequenceVerificationResult {
  const metadataKeys = ["capsuleId", "operation"] as const;
  return {
    plan: {
      id: "event_plan_dry_run",
      action: "run.plan_created",
      outcome: "planned",
      runId: "plan_dry_run",
      targetId: "plan_dry_run",
      operation: "plan",
      metadataKeys,
    },
    apply: {
      id: "event_apply_dry_run",
      action: "run.applied",
      outcome: "applied",
      runId: "apply_dry_run",
      targetId: "apply_dry_run",
      metadataKeys: ["capsuleId"],
    },
    destroyPlan: {
      id: "event_destroy_plan_dry_run",
      action: "run.plan_created",
      outcome: "planned",
      runId: "destroy_plan_dry_run",
      targetId: "destroy_plan_dry_run",
      operation: "destroy",
      metadataKeys,
    },
    destroyApply: {
      id: "event_destroy_apply_dry_run",
      action: "run.destroyed",
      outcome: "destroyed",
      runId: "destroy_apply_dry_run",
      targetId: "destroy_apply_dry_run",
      metadataKeys: ["capsuleId"],
    },
  };
}

function smokeRunTiming(name: string, run: RunRecord): SmokeRunTiming {
  const createdAtMs =
    typeof run.createdAt === "string" ? Date.parse(run.createdAt) : undefined;
  const startedAtMs =
    typeof run.startedAt === "string" ? Date.parse(run.startedAt) : undefined;
  const finishedAtMs =
    typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : undefined;
  return {
    name,
    runId: run.id,
    type: run.type,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(typeof createdAtMs === "number" &&
    Number.isFinite(createdAtMs) &&
    typeof startedAtMs === "number" &&
    Number.isFinite(startedAtMs)
      ? { queueMs: Math.max(0, startedAtMs - createdAtMs) }
      : {}),
    ...(typeof startedAtMs === "number" &&
    Number.isFinite(startedAtMs) &&
    typeof finishedAtMs === "number" &&
    Number.isFinite(finishedAtMs)
      ? { executionMs: Math.max(0, finishedAtMs - startedAtMs) }
      : {}),
    ...(typeof createdAtMs === "number" &&
    Number.isFinite(createdAtMs) &&
    typeof finishedAtMs === "number" &&
    Number.isFinite(finishedAtMs)
      ? { totalMs: Math.max(0, finishedAtMs - createdAtMs) }
      : {}),
  };
}

export async function runPlatformControlPlaneSmoke(
  options: PlatformControlPlaneSmokeOptions,
  dependencies: PublicUrlFetchDependencies = {},
): Promise<PlatformControlPlaneSmokeResult> {
  return await controlPlaneTransportContext.run(
    controlPlaneDependencies(dependencies),
    async () => await runPlatformControlPlaneSmokeInternal(options),
  );
}

async function runPlatformControlPlaneSmokeInternal(
  options: PlatformControlPlaneSmokeOptions,
): Promise<PlatformControlPlaneSmokeResult> {
  assertBackupRestoreRehearsalUnavailable(options);
  for (const check of options.publicUrlChecks) {
    assertPublicUrlLifecycleContract(check);
  }
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let workspaceId = options.workspace;
  let serviceIdentitySampleCount = 0;
  const completedSteps: string[] = [];
  const stepTimings: SmokeStepTiming[] = [];
  const runTimings: SmokeRunTiming[] = [];
  const stepStartedAtMs = new Map<string, number>();
  const stepStartedAt = new Map<string, string>();
  const beginStep = (step: string): void => {
    if (stepStartedAtMs.has(step)) return;
    const nowMs = Date.now();
    stepStartedAtMs.set(step, nowMs);
    stepStartedAt.set(step, new Date(nowMs).toISOString());
  };
  const completeStep = (step: string): void => {
    if (!completedSteps.includes(step)) completedSteps.push(step);
    if (stepTimings.some((timing) => timing.step === step)) return;
    const finishedAtMs = Date.now();
    const startedAtMsForStep = stepStartedAtMs.get(step) ?? finishedAtMs;
    stepTimings.push({
      step,
      startedAt:
        stepStartedAt.get(step) ?? new Date(startedAtMsForStep).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMsForStep),
    });
  };
  let connectionId: string | undefined;
  let providerConnectionId: string | undefined = options.providerConnectionId;
  let providerBindings: readonly SmokeProviderBindingInput[] = [];
  let connectionRevoked = false;
  let sourceId: string | undefined;
  let sourceSyncRunId: string | undefined;
  let sourceSnapshotId: string | undefined;
  let sourceSnapshotTransport: SourceSnapshotTransportEvidence | undefined;
  let installConfigId: string | undefined;
  let compatibilityReportId: string | undefined;
  let capsuleId: string | undefined;
  let planRunId: string | undefined;
  let applyRunId: string | undefined;
  let applyStartAttempted = false;
  let applyTerminalOwnershipEstablished = false;
  let destroyAttempted = false;
  let destroyProgress: DestroySmokeCapsuleProgress | undefined;
  let destroyPlanRunId: string | undefined;
  let destroyApplyRunId: string | undefined;
  let stateVersionLedger: StateVersionLedgerVerificationResult | undefined;
  let interfaceMaterialization:
    | InterfaceMaterializationVerificationResult
    | undefined;
  let interfaceMaterializations:
    | readonly InterfaceMaterializationVerificationResult[]
    | undefined;
  let interfaceMaterializationContext:
    | InterfaceMaterializationContext
    | undefined;
  let runEventSequence:
    | CanonicalRunEventSequenceVerificationResult
    | undefined;
  let releaseActivation: ReleaseActivationVerificationResult | undefined;
  let publicUrlChecks: readonly PublicUrlCheckResult[] | undefined;
  let publicUrlLifecycleChecks:
    | readonly RegisteredPublicUrlCheck[]
    | undefined = options.publicUrlChecks.length > 0
      ? registerConfiguredPublicUrls(options.publicUrlChecks, undefined)
      : undefined;
  let publicUrlDestroyChecks:
    | readonly PublicUrlDestroyCheckResult[]
    | undefined;
  let functionalProbe: CapsuleFunctionalProbeEvidence | undefined;
  let capsuleGateStatus: SmokeCheckStatus = "not_reached";
  let policyStatus: SmokeCheckStatus = "not_reached";
  let timedOutRunId: string | undefined;
  let runCancellationStatus:
    "cancelled" | "already_terminal" | "failed" | undefined;
  let runCancellationError: string | undefined;
  let connectionRevokeSkippedReason: string | undefined;
  let failureCleanup: FailureCleanupResult | undefined;
  let failure: unknown;
  let cloudflareResourcePreflight:
    CloudflareResourcePreflightResult | undefined;
  const recordDestroyProgress = (
    progress: DestroySmokeCapsuleProgress | undefined,
  ): void => {
    if (!progress) return;
    const destroyPlanRun = progress.destroyPlanRun;
    if (destroyPlanRun) {
      destroyPlanRunId ??= destroyPlanRun.id;
      if (
        !runTimings.some(
          (timing) =>
            timing.name === "destroy_plan" && timing.runId === destroyPlanRun.id,
        )
      ) {
        runTimings.push(smokeRunTiming("destroy_plan", destroyPlanRun));
      }
    }
    const destroyApplyRun = progress.destroyApplyRun;
    if (destroyApplyRun) {
      destroyApplyRunId ??= destroyApplyRun.id;
      policyStatus = publicPolicyStatus(destroyApplyRun);
      if (
        !runTimings.some(
          (timing) =>
            timing.name === "destroy_apply" && timing.runId === destroyApplyRun.id,
        )
      ) {
        runTimings.push(smokeRunTiming("destroy_apply", destroyApplyRun));
      }
    }
  };
  const recordReconciledRun = (
    runId: string,
    terminalRun: RunRecord,
  ): void => {
    let timingName: string | undefined;
    if (destroyProgress?.destroyPlanRun?.id === runId) {
      destroyProgress.destroyPlanRun = terminalRun;
      timingName = "destroy_plan";
    } else if (destroyProgress?.destroyApplyRun?.id === runId) {
      destroyProgress.destroyApplyRun = terminalRun;
      timingName = "destroy_apply";
    } else if (planRunId === runId) {
      timingName = "plan";
    } else if (applyRunId === runId) {
      timingName = "apply";
    }
    policyStatus = publicPolicyStatus(terminalRun);
    if (
      timingName &&
      !runTimings.some(
        (timing) => timing.name === timingName && timing.runId === runId,
      )
    ) {
      runTimings.push(smokeRunTiming(timingName, terminalRun));
    }
  };

  try {
    if (options.expectedServiceIdentity) {
      await probeServiceIdentity(options);
      serviceIdentitySampleCount += 1;
    }
    workspaceId = await resolveWorkspaceId(options);
    if (options.providerBindings.length > 0) {
      beginStep("existingProviderConnectionsSelected");
      providerBindings = await Promise.all(
        options.providerBindings.map(async (binding, index) => {
          const actualProvider = await lookupExistingProviderConnectionSource(
            options,
            workspaceId,
            binding.connectionId,
          );
          if (canonicalProviderSource(actualProvider) !== binding.provider) {
            throw new Error(
              `ProviderBinding[${index}] connection source ${actualProvider} does not match binding provider ${binding.provider}`,
            );
          }
          return binding;
        }),
      );
      completeStep("existingProviderConnectionsSelected");
    } else if (options.providerConnectionId !== undefined) {
      beginStep("existingProviderConnectionSelected");
      const providerConnectionSource =
        await lookupExistingProviderConnectionSource(
          options,
          workspaceId,
          options.providerConnectionId,
        );
      providerBindings = [
        {
          provider: canonicalProviderSource(providerConnectionSource),
          connectionId: options.providerConnectionId,
        },
      ];
      completeStep("existingProviderConnectionSelected");
    } else if (options.cloudflareConnectionMode !== "none") {
      beginStep("workspaceScopedProviderConnection");
      beginStep("connectionVerified");
      const connection = await createWorkspaceCloudflareConnection(
        options,
        workspaceId,
      );
      connectionId = connection.rawConnectionId;
      providerConnectionId = connection.providerConnectionId;
      providerBindings = [
        {
          provider: CLOUDFLARE_PROVIDER_SOURCE,
          connectionId: connection.providerConnectionId,
        },
      ];
      completeStep("workspaceScopedProviderConnection");
      if (options.cloudflareConnectionMode === "generic-env") {
        beginStep("genericEnvProviderConnection");
        completeStep("genericEnvProviderConnection");
      }
      completeStep("connectionVerified");
    } else {
      beginStep("providerConnectionNotRequired");
      completeStep("providerConnectionNotRequired");
    }
    if (options.cloudflareResourcePreflight !== "none") {
      beginStep("cloudflareResourcePreflight");
      cloudflareResourcePreflight =
        await assertCloudflareResourcePreflight(options);
      completeStep("cloudflareResourcePreflight");
    }
    beginStep("sourceRegistered");
    beginStep("sourceSynced");
    beginStep("scratchInstall");
    beginStep("compatibilityChecked");
    beginStep("plan");
    const deploy = await deployGitSourceCapsule(options, {
      workspaceId,
      providerBindings,
    });
    sourceId = deploy.sourceId;
    sourceSyncRunId = deploy.sourceSyncRunId;
    sourceSnapshotId = deploy.sourceSnapshotId;
    sourceSnapshotTransport = deploy.sourceSnapshotTransport;
    installConfigId = deploy.installConfigId;
    compatibilityReportId = deploy.compatibilityReportId;
    capsuleId = deploy.capsule.id;
    planRunId = deploy.planRun?.id ?? deploy.run.id;
    completeStep("sourceRegistered");
    completeStep("sourceSynced");
    completeStep("scratchInstall");
    completeStep("compatibilityChecked");
    capsuleGateStatus = "passed";
    const completedPlan = await ensurePlanReadyForApply(options, planRunId);
    policyStatus = publicPolicyStatus(completedPlan);
    assertRunSucceeded(completedPlan, "plan");
    runTimings.push(smokeRunTiming("plan", completedPlan));
    completeStep("plan");
    beginStep("apply");
    let applyRun: RunRecord;
    if (deploy.applyRun) {
      applyRun = deploy.applyRun;
    } else {
      // Record mutation intent before crossing the POST boundary. If its
      // acknowledgement is lost, the exact Plan-linked ApplyRun must be
      // recovered before any cleanup or credential revocation decision.
      applyStartAttempted = true;
      applyRun = await startApplyRunWithReconciliation(options, {
        workspaceId,
        capsuleId,
        planRunId,
      });
    }
    applyRunId = applyRun.id;
    const completedApply = await pollRun(options, applyRunId);
    applyTerminalOwnershipEstablished = true;
    policyStatus = publicPolicyStatus(completedApply);
    assertRunSucceeded(completedApply, "apply");
    runTimings.push(smokeRunTiming("apply", completedApply));
    completeStep("apply");
    beginStep("stateVersionLedgerVerified");
    if (options.verificationMode === "opentofu") {
      beginStep("opentofuApplyVerified");
    }
    stateVersionLedger = await assertStateVersionLedger(options, {
      workspaceId,
      capsuleId,
      applyRunId,
    });
    if (options.publicUrlChecks.length > 0) {
      publicUrlLifecycleChecks = registerConfiguredPublicUrls(
        options.publicUrlChecks,
        stateVersionLedger.publicOutputs,
      );
    }
    if (options.verificationMode === "opentofu") {
      completeStep("opentofuApplyVerified");
    }
    completeStep("stateVersionLedgerVerified");
    if (options.requireReleaseActivation) {
      beginStep("releaseActivationVerified");
      releaseActivation = await assertReleaseActivation(options, {
        workspaceId,
        applyRunId,
        stateVersionId: stateVersionLedger.stateVersionId,
      });
      completeStep("releaseActivationVerified");
    }
    if (shouldVerifyCloudflareWorker(options)) {
      beginStep("runtimeVerified");
      await assertCloudflareWorkerExists(
        options,
        stateVersionLedger.publicOutputs,
      );
      completeStep("runtimeVerified");
    }
    if (options.verificationMode === "cloudflare-worker") {
      beginStep("publicUrlVerified");
      if (options.publicUrlChecks.length > 0) {
        publicUrlChecks = await assertConfiguredPublicUrls(
          options,
          stateVersionLedger.publicOutputs,
        );
        publicUrlLifecycleChecks = configuredPublicUrlRegistrations(
          publicUrlChecks,
        );
      } else {
        await assertPublicWorkerUrl(options, stateVersionLedger.publicOutputs);
      }
      completeStep("publicUrlVerified");
    }
    if (
      options.verificationMode === "opentofu" &&
      options.publicUrlChecks.length > 0
    ) {
      beginStep("publicUrlVerified");
      publicUrlChecks = await assertConfiguredPublicUrls(
        options,
        stateVersionLedger.publicOutputs,
      );
      publicUrlLifecycleChecks = configuredPublicUrlRegistrations(
        publicUrlChecks,
      );
      completeStep("publicUrlVerified");
    }
    if (options.functionalProbeScript) {
      beginStep("functionalProbe");
      functionalProbe = await runCapsuleFunctionalProbe(
        options,
        stateVersionLedger.publicOutputs ?? {},
      );
      completeStep("functionalProbe");
    }
    if ((options.interfaceBlueprints ?? []).length > 0) {
      beginStep("interfaceMaterializationVerified");
      interfaceMaterializationContext = await assertInterfaceMaterialization(
        options,
        {
          workspaceId,
          capsuleId,
          stateVersionLedger,
        },
      );
      interfaceMaterializations = interfaceMaterializationContext.records.map(
        interfaceMaterializationEvidence,
      );
      interfaceMaterialization = interfaceMaterializations[0];
      completeStep("interfaceMaterializationVerified");
      if (options.interfaceTokenProofRequested) {
        beginStep("interfaceTokenProofVerified");
        completeStep("interfaceTokenProofVerified");
      }
    }
    beginStep("destroy");
    destroyAttempted = true;
    destroyProgress = { destroyApplyAttempted: false };
    const destroyResult = await destroySmokeCapsule(options, {
      capsuleId,
      reason: "Layer-2 platform-control-plane smoke cleanup",
      verifyCloudflareWorkerGone: shouldVerifyCloudflareWorker(options),
      publicOutputs: stateVersionLedger.publicOutputs,
      publicUrlLifecycleChecks,
    }, destroyProgress);
    recordDestroyProgress(destroyProgress);
    publicUrlDestroyChecks =
      destroyResult.destroyVerification?.publicUrlDestroyChecks;
    functionalProbe = finalizeFunctionalProbeCleanup(functionalProbe);
    if (destroyResult.destroyVerification?.status === "inconclusive") {
      failureCleanup = destroyFailureCleanupResult(destroyResult);
      throw new Error(
        `destroy completed but external public-resource verification was inconclusive: ${destroyResult.destroyVerification.error ?? "unknown verification error"}`,
      );
    }
    completeStep("destroy");

    if (interfaceMaterializationContext) {
      beginStep("interfaceRetiredVerified");
      interfaceMaterializationContext = await assertInterfacesRetired(
        options,
        interfaceMaterializationContext,
      );
      interfaceMaterializations = interfaceMaterializationContext.records.map(
        interfaceMaterializationEvidence,
      );
      interfaceMaterialization = interfaceMaterializations[0];
      completeStep("interfaceRetiredVerified");
    }
    if (interfaceMaterializationContext) {
      beginStep("runEventSequenceVerified");
      runEventSequence = await assertCanonicalRunEventSequence(options, {
        workspaceId,
        capsuleId,
        planRunId,
        applyRunId,
        destroyPlanRunId,
        destroyApplyRunId,
      });
      completeStep("runEventSequenceVerified");
    }

    if (connectionId && !options.keepConnection) {
      beginStep("connectionRevoked");
      connectionRevoked = await revokeConnection(options, connectionId);
      if (!connectionRevoked) {
        throw new Error(
          "temporary ProviderConnection revoke did not confirm success",
        );
      }
      completeStep("connectionRevoked");
    }
    if (options.expectedServiceIdentity) {
      await probeServiceIdentity(options);
      serviceIdentitySampleCount += 1;
    }
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    return {
      kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
      status: "passed",
      generatedAt: finishedAt,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      serviceUrl: options.url,
      scratchWorkspaceId: workspaceId,
      capsuleModule: capsuleLabel(options),
      verificationMode: options.verificationMode,
      credentialPath: providerCredentialPath(options),
      providerConnectionMode: options.cloudflareConnectionMode,
      ...(options.expectedServiceIdentity
        ? {
            serviceIdentity: serviceIdentityEvidence(
              options.expectedServiceIdentity,
              serviceIdentitySampleCount,
              serviceIdentitySampleCount === 2 ? "passed" : "failed",
            ),
          }
        : {}),
      sourceMode: options.sourceMode,
      steps: requiredSteps(options),
      completedSteps,
      stepTimings,
      runTimings,
      appName: options.appName,
      environment: options.environment,
      connectionId,
      providerConnectionId,
      sourceId,
      sourceSyncRunId,
      sourceSnapshotId,
      sourceSnapshotTransport,
      installConfigId,
      compatibilityReportId,
      capsuleId,
      planRunId,
      applyRunId,
      destroyPlanRunId,
      destroyApplyRunId,
      stateVersionLedger,
      interfaceMaterialization,
      interfaceMaterializations,
      runEventSequence,
      releaseActivation,
      cloudflareResourcePreflight,
      publicUrlChecks,
      publicUrlDestroyChecks,
      functionalProbe,
      capsuleGateStatus: "passed",
      policyStatus: policyStatus === "denied" ? failPolicy() : "passed",
      workerUrl: shouldVerifyCloudflareWorker(options)
        ? publicRuntimeUrl(options, stateVersionLedger.publicOutputs)
        : "",
      opentofuApplyVerified: options.verificationMode === "opentofu",
      runtimeVerified: shouldVerifyCloudflareWorker(options),
      publicUrlVerified:
        options.verificationMode === "cloudflare-worker" ||
        options.publicUrlChecks.length > 0,
      publicUrlChecks,
      stateVersionLedgerVerified: true,
      destroyVerified: true,
      ...(connectionId ? { connectionRevoked } : {}),
      inputs: publicInputSummary(options),
    };
  } catch (error) {
    if (isWeakMapKey(error)) {
      const progress = publicUrlCheckProgress.get(error);
      if (progress) {
        publicUrlLifecycleChecks = progress.registrations;
        if (progress.results.length > 0) {
          publicUrlChecks = progress.results;
        }
      }
    }
    if (error instanceof RunPollTimeoutError) {
      timedOutRunId = error.runId;
      const cancellation = await cancelRunAfterPollTimeout(
        options,
        error.runId,
      );
      runCancellationStatus = cancellation.status;
      runCancellationError = cancellation.error;
      if (cancellation.run) {
        recordReconciledRun(error.runId, cancellation.run);
        if (
          error.runId === applyRunId &&
          TERMINAL_RUN_STATUSES.has(cancellation.run.status)
        ) {
          applyTerminalOwnershipEstablished = true;
        }
      }
      if (cancellation.status === "failed") {
        connectionRevokeSkippedReason =
          "run did not reach a terminal state and cancel did not confirm terminal ownership";
      }
    }
    if (applyStartAttempted && !applyRunId) {
      connectionRevokeSkippedReason =
        "Apply POST acknowledgement was lost without an exact ApplyRun; retaining the ProviderConnection for operator recovery and preserving the Capsule authority";
    }
    recordDestroyProgress(destroyProgress);
    const retainedApplyCleanupReason = applyStartAttempted && !applyRunId
      ? "Apply POST acknowledgement was lost without an exact ApplyRun; Destroy was not started because mutation ownership is indeterminate"
      : applyRunId && !applyTerminalOwnershipEstablished
        ? `Apply run ${applyRunId} did not establish terminal ownership; Destroy was not started and recovery authority was retained`
        : undefined;
    if (retainedApplyCleanupReason) {
      connectionRevokeSkippedReason ??= retainedApplyCleanupReason;
      failureCleanup = retainedFailureCleanupResult(
        publicUrlLifecycleChecks,
        retainedApplyCleanupReason,
      );
      publicUrlDestroyChecks =
        failureCleanup.destroyVerification?.publicUrlDestroyChecks;
    } else if (capsuleId && applyRunId && !destroyAttempted) {
      beginStep("destroy");
      destroyAttempted = true;
      const verifyCloudflareWorkerGone = shouldVerifyCloudflareWorker(options);
      destroyProgress = { destroyApplyAttempted: false };
      try {
        const destroyResult = await destroySmokeCapsule(options, {
          capsuleId,
          reason:
            "Layer-2 platform-control-plane smoke cleanup after verification failure",
          verifyCloudflareWorkerGone,
          publicOutputs: stateVersionLedger?.publicOutputs,
          publicUrlLifecycleChecks,
        }, destroyProgress);
        recordDestroyProgress(destroyProgress);
        publicUrlDestroyChecks =
          destroyResult.destroyVerification?.publicUrlDestroyChecks;
        functionalProbe = finalizeFunctionalProbeCleanup(functionalProbe);
        if (destroyResult.destroyVerification?.status !== "inconclusive") {
          completeStep("destroy");
        }
        failureCleanup = destroyFailureCleanupResult(destroyResult);
      } catch (destroyError) {
        recordDestroyProgress(destroyProgress);
        connectionRevokeSkippedReason =
          "post-apply cleanup destroy failed; keeping ProviderConnection so the Capsule can be destroyed after the blocker is fixed";
        failureCleanup = failedDestroyCleanupResult(
          destroyProgress,
          destroyError,
          publicUrlLifecycleChecks,
        );
        publicUrlDestroyChecks =
          failureCleanup.destroyVerification?.publicUrlDestroyChecks;
      }
    } else if (!applyRunId && !destroyAttempted && !applyStartAttempted) {
      await markPendingSmokeCapsuleError(options, {
        workspaceId,
        capsuleId,
      }).catch(() => undefined);
    } else if (
      destroyAttempted &&
      !failureCleanup &&
      destroyProgress?.destroyPlanRun &&
      destroyProgress.destroyApplyRun?.status === "succeeded" &&
      destroyProgress.destroyApplyRun.policyStatus !== "deny"
    ) {
      let destroyVerification: SmokeDestroyVerification | undefined;
      try {
        destroyVerification = await verifyDestroyedSmokeCapsule(options, {
          verifyCloudflareWorkerGone: shouldVerifyCloudflareWorker(options),
          publicOutputs: stateVersionLedger?.publicOutputs,
          publicUrlLifecycleChecks,
        });
      } catch (verificationError) {
        destroyVerification = inconclusiveDestroyVerification(
          publicUrlLifecycleChecks,
          verificationError,
        );
      }
      const destroyResult: DestroySmokeCapsuleResult = {
        destroyPlanRun: destroyProgress.destroyPlanRun,
        destroyApplyRun: destroyProgress.destroyApplyRun,
        ...(destroyVerification ? { destroyVerification } : {}),
      };
      publicUrlDestroyChecks =
        destroyVerification?.publicUrlDestroyChecks;
      functionalProbe = finalizeFunctionalProbeCleanup(functionalProbe);
      failureCleanup = destroyFailureCleanupResult(destroyResult);
      if (destroyVerification?.status !== "inconclusive") {
        completeStep("destroy");
      }
    } else if (
      destroyAttempted &&
      !failureCleanup &&
      (destroyProgress?.destroyApplyRun?.status !== "succeeded" ||
        destroyProgress?.destroyApplyRun?.policyStatus === "deny")
    ) {
      connectionRevokeSkippedReason =
        "post-apply cleanup destroy failed; keeping ProviderConnection so the Capsule can be destroyed after the blocker is fixed";
      failureCleanup = failedDestroyCleanupResult(
        destroyProgress,
        error,
        publicUrlLifecycleChecks,
      );
      publicUrlDestroyChecks =
        failureCleanup.destroyVerification?.publicUrlDestroyChecks;
    }
    failure = error;
  } finally {
    if (
      connectionId &&
      !options.keepConnection &&
      !connectionRevoked &&
      !connectionRevokeSkippedReason
    ) {
      beginStep("connectionRevoked");
      connectionRevoked = await revokeConnection(options, connectionId);
      if (connectionRevoked) completeStep("connectionRevoked");
    }
  }
  return failedResult(options, {
    startedAt,
    startedAtMs,
    workspaceId,
    completedSteps,
    stepTimings,
    runTimings,
    connectionId,
    providerConnectionId,
    capsuleId,
    sourceId,
    sourceSyncRunId,
    sourceSnapshotId,
    sourceSnapshotTransport,
    installConfigId,
    compatibilityReportId,
    planRunId,
    applyRunId,
    destroyPlanRunId,
    destroyApplyRunId,
    stateVersionLedger,
    interfaceMaterialization,
    interfaceMaterializations,
    runEventSequence,
    releaseActivation,
    cloudflareResourcePreflight,
    publicUrlChecks,
    publicUrlDestroyChecks,
    functionalProbe,
    capsuleGateStatus,
    policyStatus,
    connectionRevoked,
    timedOutRunId,
    runCancellationStatus,
    runCancellationError,
    connectionRevokeSkippedReason,
    failureCleanup,
    serviceIdentitySampleCount,
    redactedValues:
      interfaceMaterializationContext?.records.flatMap((record) =>
        record.issuedToken ? [record.issuedToken.token] : [],
      ) ?? [],
    error: failure,
  });
}

async function startApplyRunWithReconciliation(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly planRunId: string;
  },
): Promise<RunRecord> {
  try {
    const response = await requestJson<{ readonly run?: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/runs/${encodeURIComponent(input.planRunId)}/apply`,
      body: {},
    });
    if (isExactApplyRun(response.run, input)) {
      return response.run;
    }
    // A malformed or truncated success response is also a lost
    // acknowledgement: the server may already own a live mutation.
  } catch {
    // Reconcile below through the public Workspace Run authority. Never retry
    // this mutation POST because a concurrent queued Apply may already exist.
  }

  let response: { readonly runs?: readonly unknown[] };
  try {
    response = await requestJson<{ readonly runs?: readonly unknown[] }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/workspaces/${encodeURIComponent(
        input.workspaceId,
      )}/runs?limit=500`,
    });
  } catch {
    throw new ApplyStartIndeterminateError(
      input.planRunId,
      "run_authority_unavailable",
    );
  }
  if (!Array.isArray(response.runs)) {
    throw new ApplyStartIndeterminateError(
      input.planRunId,
      "run_authority_unavailable",
    );
  }
  const matches = response.runs.filter(
    (candidate): candidate is RunRecord => isExactApplyRun(candidate, input),
  );
  if (matches.length === 0) {
    throw new ApplyStartIndeterminateError(input.planRunId, "no_exact_run");
  }
  if (matches.length !== 1) {
    throw new ApplyStartIndeterminateError(
      input.planRunId,
      "ambiguous_exact_runs",
    );
  }
  return matches[0]!;
}

function isExactApplyRun(
  candidate: unknown,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly planRunId: string;
  },
): candidate is RunRecord {
  return isRecord(candidate) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.status === "string" &&
    candidate.workspaceId === input.workspaceId &&
    candidate.capsuleId === input.capsuleId &&
    candidate.planRunId === input.planRunId &&
    candidate.type === "apply";
}

export function failedResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly startedAt: string;
    readonly startedAtMs: number;
    readonly workspaceId: string;
    readonly completedSteps: readonly string[];
    readonly stepTimings: readonly SmokeStepTiming[];
    readonly runTimings: readonly SmokeRunTiming[];
    readonly connectionId?: string;
    readonly providerConnectionId?: string;
    readonly sourceId?: string;
    readonly sourceSyncRunId?: string;
    readonly sourceSnapshotId?: string;
    readonly sourceSnapshotTransport?: SourceSnapshotTransportEvidence;
    readonly installConfigId?: string;
    readonly compatibilityReportId?: string;
    readonly capsuleId?: string;
    readonly planRunId?: string;
    readonly applyRunId?: string;
    readonly destroyPlanRunId?: string;
    readonly destroyApplyRunId?: string;
    readonly stateVersionLedger?: StateVersionLedgerVerificationResult;
    readonly interfaceMaterialization?: InterfaceMaterializationVerificationResult;
    readonly interfaceMaterializations?: readonly InterfaceMaterializationVerificationResult[];
    readonly runEventSequence?: CanonicalRunEventSequenceVerificationResult;
    readonly releaseActivation?: ReleaseActivationVerificationResult;
    readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
    readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
    readonly publicUrlDestroyChecks?: readonly PublicUrlDestroyCheckResult[];
    readonly functionalProbe?: CapsuleFunctionalProbeEvidence;
    readonly capsuleGateStatus: SmokeCheckStatus;
    readonly policyStatus: SmokeCheckStatus;
    readonly connectionRevoked?: boolean;
    readonly timedOutRunId?: string;
    readonly runCancellationStatus?:
      "cancelled" | "already_terminal" | "failed";
    readonly runCancellationError?: string;
    readonly connectionRevokeSkippedReason?: string;
    readonly failureCleanup?: FailureCleanupResult;
    readonly serviceIdentitySampleCount: number;
    readonly redactedValues?: readonly string[];
    readonly error: unknown;
  },
): PlatformControlPlaneSmokeResult {
  const finishedAtMs = Date.now();
  const finishedAt = new Date(finishedAtMs).toISOString();
  const redactedValues = smokeRedactedValues(
    options,
    input.redactedValues,
  );
  const result: PlatformControlPlaneSmokeResult = {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "failed",
    generatedAt: finishedAt,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAtMs - input.startedAtMs),
    serviceUrl: options.url,
    scratchWorkspaceId: input.workspaceId,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath: providerCredentialPath(options),
    providerConnectionMode: options.cloudflareConnectionMode,
    ...(options.expectedServiceIdentity
      ? {
          serviceIdentity: serviceIdentityEvidence(
            options.expectedServiceIdentity,
            input.serviceIdentitySampleCount,
            "failed",
          ),
        }
      : {}),
    sourceMode: options.sourceMode,
    steps: requiredSteps(options),
    completedSteps: input.completedSteps,
    stepTimings: input.stepTimings,
    runTimings: input.runTimings,
    appName: options.appName,
    environment: options.environment,
    connectionId: input.connectionId,
    providerConnectionId: input.providerConnectionId,
    sourceId: input.sourceId,
    sourceSyncRunId: input.sourceSyncRunId,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceSnapshotTransport: input.sourceSnapshotTransport,
    installConfigId: input.installConfigId,
    compatibilityReportId: input.compatibilityReportId,
    capsuleId: input.capsuleId,
    planRunId: input.planRunId,
    applyRunId: input.applyRunId,
    destroyPlanRunId: input.destroyPlanRunId,
    destroyApplyRunId: input.destroyApplyRunId,
    stateVersionLedger: input.stateVersionLedger,
    interfaceMaterialization: input.interfaceMaterialization,
    interfaceMaterializations: input.interfaceMaterializations,
    runEventSequence: input.runEventSequence,
    releaseActivation: input.releaseActivation,
    cloudflareResourcePreflight: input.cloudflareResourcePreflight,
    publicUrlChecks: input.publicUrlChecks,
    publicUrlDestroyChecks: input.publicUrlDestroyChecks,
    functionalProbe: input.functionalProbe,
    capsuleGateStatus: input.capsuleGateStatus,
    policyStatus: input.policyStatus,
    workerUrl: failedResultWorkerUrl(
      options,
      input.stateVersionLedger?.publicOutputs,
    ),
    opentofuApplyVerified: input.completedSteps.includes(
      "opentofuApplyVerified",
    ),
    runtimeVerified: input.completedSteps.includes("runtimeVerified"),
    publicUrlVerified: input.completedSteps.includes("publicUrlVerified"),
    stateVersionLedgerVerified: input.completedSteps.includes(
      "stateVersionLedgerVerified",
    ),
    destroyVerified: input.completedSteps.includes("destroy"),
    ...(input.connectionId
      ? { connectionRevoked: input.connectionRevoked }
      : {}),
    timedOutRunId: input.timedOutRunId,
    runCancellationStatus: input.runCancellationStatus,
    runCancellationError:
      input.runCancellationError === undefined
        ? undefined
        : publicErrorMessage(
            input.runCancellationError,
            redactedValues,
          ),
    connectionRevokeSkippedReason: input.connectionRevokeSkippedReason,
    failureCleanup: redactFailureCleanup(
      input.failureCleanup,
      redactedValues,
    ),
    error: publicErrorMessage(input.error, redactedValues),
    nextAction: failedNextAction(input),
    inputs: publicInputSummary(options),
  };
  assertSmokeSerializationSafe(result, options, input.redactedValues);
  return result;
}

function smokeRedactedValues(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    | "providerBindings"
    | "accountSessionToken"
    | "cloudflareApiToken"
    | "interfaceRuntimeToken"
  >,
  additionalValues: readonly string[] = [],
): readonly string[] {
  return [
    ...options.providerBindings.map((binding) => binding.connectionId),
    options.accountSessionToken,
    options.cloudflareApiToken,
    options.interfaceRuntimeToken,
    ...additionalValues,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && value !== "<redacted>",
  );
}

function failedNextAction(input: {
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly connectionRevokeSkippedReason?: string;
  readonly error: unknown;
}): string {
  if (input.error instanceof CloudflareResourcePreflightError) {
    return "Update the operator Cloudflare API token so it can read and create the Cloudflare account resources required by the Capsule, or use a non-resource-creating Capsule smoke before rerunning this apply.";
  }
  if (input.error instanceof ApplyStartIndeterminateError) {
    return `The Apply POST for plan ${input.error.planRunId} became indeterminate. Keep the recorded Capsule and ProviderConnection, reconcile the exact Plan-linked ApplyRun from the Workspace Run ledger, then cancel or destroy it before revoking recovery credentials.`;
  }
  if (
    input.error instanceof RequestTimeoutError &&
    input.error.method === "POST" &&
    /\/workspaces\/[^/]+\/install-plans$/u.test(input.error.path)
  ) {
    return "The install coordinator request timed out before returning a plan run id. Check the scratch Workspace for the idempotent smoke install, verify the temporary Provider Connection is retained until recovery is complete, then reconcile the exact install plan.";
  }
  if (input.connectionRevokeSkippedReason !== undefined) {
    return "Inspect the failed cleanup run, destroy the recorded Capsule after fixing the blocker, then revoke the retained ProviderConnection and rerun the smoke.";
  }
  return "Inspect the recorded Run and Capsule ids, confirm any temporary Cloudflare resources are destroyed, then rerun the smoke after the blocking Run reaches a terminal state.";
}

function failPolicy(): never {
  throw new Error("policyStatus denied during platform-control-plane smoke");
}

function publicPolicyStatus(run: RunRecord): SmokeCheckStatus {
  return run.policyStatus === "deny" ? "denied" : "passed";
}

async function resolveWorkspaceId(
  options: PlatformControlPlaneSmokeOptions,
): Promise<string> {
  const normalized = options.workspace.replace(/^@/, "");
  if (/^ws_[0-9a-zA-Z]{3,64}$/u.test(normalized)) {
    if (options.ensureWorkspace) {
      await requestJson({
        baseUrl: options.url,
        token: options.accountSessionToken,
        path: `${API_PREFIX}/workspaces/${encodeURIComponent(normalized)}`,
      });
    }
    return normalized;
  }
  const match = await findWorkspaceByHandle(options, normalized);
  if (match?.id) {
    if (typeof match.archivedAt === "string" && match.archivedAt.length > 0) {
      await requestJson({
        baseUrl: options.url,
        token: options.accountSessionToken,
        method: "PATCH",
        path: `${API_PREFIX}/workspaces/${encodeURIComponent(match.id)}`,
        body: { archived: false },
      });
    }
    return match.id;
  }
  if (!match) {
    if (options.ensureWorkspace) {
      const created = await requestJson<{
        readonly workspace?: { readonly id?: string };
      }>({
        baseUrl: options.url,
        token: options.accountSessionToken,
        method: "POST",
        path: `${API_PREFIX}/workspaces`,
        body: {
          handle: normalized,
          displayName: options.workspaceDisplayName ?? normalized,
          type: "personal",
        },
      });
      const createdId = created.workspace?.id;
      if (!createdId) {
        throw new Error(
          "Workspace create response did not include workspace.id",
        );
      }
      return createdId;
    }
    throw new Error(
      `workspace @${normalized} was not found; pass --ensure-workspace or create the scratch Workspace first`,
    );
  }
}

async function findWorkspaceByHandle(
  options: PlatformControlPlaneSmokeOptions,
  handle: string,
): Promise<
  | {
      readonly id: string;
      readonly handle: string;
      readonly archivedAt?: string;
    }
  | undefined
> {
  let cursor: string | undefined;
  for (let page = 0; page < 1_000; page += 1) {
    const response = await requestJson<{
      readonly workspaces?: readonly {
        readonly id: string;
        readonly handle: string;
        readonly archivedAt?: string;
      }[];
      readonly nextCursor?: string;
    }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path:
        `${API_PREFIX}/workspaces?includeArchived=true&limit=100&order=updated_desc` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    });
    const match = (response.workspaces ?? []).find(
      (workspace) => workspace.handle === handle,
    );
    if (match) return match;
    if (!response.nextCursor) return undefined;
    cursor = response.nextCursor;
  }
  throw new Error("Workspace pagination exceeded the smoke safety ceiling");
}

async function createWorkspaceCloudflareConnection(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<{
  readonly rawConnectionId: string;
  readonly providerConnectionId: string;
}> {
  const displayName = `Layer-2 smoke ${options.appName}`;
  const response = await requestJson<{
    readonly connection?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/connections`,
    body: smokeWorkspaceCloudflareConnectionBody(
      options,
      workspaceId,
      displayName,
    ),
  });
  const id = response.connection?.id;
  if (!id) {
    throw new Error("connection create response did not include connection.id");
  }
  await verifyConnection(options, id);
  const providerConnectionId = await lookupPublicProviderConnectionId(
    options,
    workspaceId,
    displayName,
  );
  return { rawConnectionId: id, providerConnectionId };
}

export function smokeWorkspaceCloudflareConnectionBody(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    | "cloudflareConnectionMode"
    | "cloudflareApiToken"
    | "cloudflareAccountId"
    | "cloudflareWorkersSubdomain"
  >,
  workspaceId: string,
  displayName: string,
): Readonly<Record<string, unknown>> {
  const genericEnv = options.cloudflareConnectionMode === "generic-env";
  return {
    workspaceId,
    provider: CLOUDFLARE_PROVIDER_SOURCE,
    credentialRecipe: genericEnv
      ? {
          id: "generic-env",
          authMode: "env",
          secretPartition: "provider-credentials",
        }
      : {
          id: "cloudflare",
          authMode: "api_token",
          secretPartition: "provider-credentials",
        },
    displayName,
    scopeHints: {
      providerSettings: {
        accountId: options.cloudflareAccountId,
        workersSubdomain: options.cloudflareWorkersSubdomain,
      },
      moduleInputDefaults: {
        cloudflare_account_id: options.cloudflareAccountId,
        cloudflare_workers_subdomain: options.cloudflareWorkersSubdomain,
      },
    },
    values: {
      CLOUDFLARE_API_TOKEN: options.cloudflareApiToken,
      ...(genericEnv
        ? { CLOUDFLARE_ACCOUNT_ID: options.cloudflareAccountId }
        : {}),
    },
  };
}

async function verifyConnection(
  options: PlatformControlPlaneSmokeOptions,
  connectionId: string,
): Promise<void> {
  const tested = await requestJson<{ readonly status?: string }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/connections/${encodeURIComponent(connectionId)}/test`,
  });
  if (tested.status !== "verified") {
    throw new Error(
      `connection ${connectionId} test ended as ${tested.status ?? "unknown"}`,
    );
  }
}

export async function fetchBoundedCloudflareApi(
  path: string,
  token: string,
  dependencies: {
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
    readonly readBody?: boolean;
  } = {},
): Promise<{ readonly response: Response; readonly body: string }> {
  if (
    !path.startsWith("/client/v4/") ||
    path.startsWith("//") ||
    /[#\0\r\n]/u.test(path)
  ) {
    throw new Error("Cloudflare API path is invalid");
  }
  if (
    !token ||
    new TextEncoder().encode(token).byteLength > PRIVATE_INPUT_MAX_BYTES ||
    /[\0\r\n]/u.test(token)
  ) {
    throw new Error("Cloudflare API token is invalid");
  }
  const timeoutMs = dependencies.timeoutMs ?? PUBLIC_URL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Cloudflare API request timeout must be a positive integer");
  }
  const deadline = createAbsoluteRequestDeadline(
    timeoutMs,
    "Cloudflare API request",
  );
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  const request = Promise.resolve().then(() =>
    (dependencies.fetcher ?? fetch)(`https://api.cloudflare.com${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: controller.signal,
    }),
  );
  request.catch(() => undefined);
  const guardedRequest = new Promise<Response>((resolveResponse, rejectResponse) => {
    request.then(
      (candidate) => {
        if (timedOut || remainingDeadlineMs(deadline) <= 0) {
          timedOut = true;
          controller.abort();
          void cancelPublicResponseBody(candidate).catch(() => undefined);
          return;
        }
        resolveResponse(candidate);
      },
      rejectResponse,
    );
  });
  guardedRequest.catch(() => undefined);
  const markTimedOut = (): void => {
    timedOut = true;
    controller.abort();
  };
  try {
    response = await waitWithinDeadline(
      guardedRequest,
      deadline,
      () => new CloudflareApiTimeoutError(),
      markTimedOut,
    );
    if (response.status >= 300 && response.status < 400) {
      await cancelPublicResponseBody(response, deadline);
      throw new CloudflareApiRedirectError();
    }
    if (dependencies.readBody === false) {
      void cancelPublicResponseBody(response, deadline).catch(() => undefined);
      return { response, body: "" };
    }
    const bodyRead = readBoundedPublicResponse(
      response,
      {
        name: "Cloudflare API",
        output: "cloudflare-api",
        path,
        expectedStatus: 200,
        bodyIncludes: [],
        destroyExpectation: { kind: "not-verifiable", reason: "Cloudflare API request" },
      },
      controller.signal,
      deadline,
    );
    bodyRead.catch(() => undefined);
    return {
      response,
      body: await waitWithinDeadline(
        bodyRead,
        deadline,
        () => new CloudflareApiTimeoutError(),
        markTimedOut,
      ),
    };
  } catch (error) {
    await cancelPublicResponseBody(response, deadline);
    if (timedOut || error instanceof CloudflareApiTimeoutError) {
      throw new CloudflareApiTimeoutError();
    }
    if (error instanceof PublicUrlResponseTooLargeError) {
      throw new CloudflareApiResponseTooLargeError();
    }
    if (error instanceof CloudflareApiRedirectError) throw error;
    throw new CloudflareApiRequestError();
  }
}

async function assertCloudflareResourcePreflight(
  options: PlatformControlPlaneSmokeOptions,
): Promise<CloudflareResourcePreflightResult> {
  if (options.cloudflareResourcePreflight === "none") {
    throw new Error("cloudflare resource preflight called with mode none");
  }
  const checks = cloudflareResourcePreflightDefinitions(
    options.cloudflareResourcePreflight,
  );
  for (const check of checks) {
    const path = check.path(options.cloudflareAccountId);
    const request = await fetchBoundedCloudflareApi(
      path,
      options.cloudflareApiToken,
    ).catch((error) => {
      throw new CloudflareResourcePreflightError(
        "request_failed",
        `cloudflare resource preflight request failed: ${check.label}: ${errorMessage(error)}`,
      );
    });
    const { response, body: bodyText } = request;
    const body = parseResponseBody(
      bodyText,
      `cloudflare resource preflight ${check.id}`,
    );
    if (!response.ok || !cloudflareApiSuccess(body)) {
      throw new CloudflareResourcePreflightError(
        "capability_denied",
        `cloudflare resource preflight failed: ${check.id} returned http ${
          response.status
        }: ${cloudflareApiErrorCode(body)}. The Cloudflare token is active but cannot read ${check.label} for the configured account; update CLOUDFLARE_API_TOKEN permissions or CLOUDFLARE_ACCOUNT_ID before applying resource-creating Capsules.`,
      );
    }
  }
  return {
    mode: options.cloudflareResourcePreflight,
    status: "passed",
    checks: checks.map((check) => check.id),
  };
}

function cloudflareResourcePreflightDefinitions(
  mode: Exclude<CloudflareResourcePreflightMode, "none">,
): readonly (typeof CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS)[number][] {
  if (mode === "workers") {
    return [CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS[0]!];
  }
  if (mode === "d1") {
    return [CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS[1]!];
  }
  if (mode === "account-resources") {
    return CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS;
  }
  return assertNever(mode);
}

function cloudflareResourcePreflightChecks(
  mode: CloudflareResourcePreflightMode,
): readonly string[] {
  if (mode === "none") return [];
  return cloudflareResourcePreflightDefinitions(mode).map((check) => check.id);
}

async function lookupPublicProviderConnectionId(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
  displayName: string,
): Promise<string> {
  const match = (await listSmokeProviderConnections(options, workspaceId)).find(
    (connection) =>
      isSmokeProviderConnectionMatch(
        connection,
        smokeCloudflareProviderConnectionMatch(displayName),
      ),
  );
  if (!match?.id) {
    throw new Error(
      "created connection did not appear in provider-connections",
    );
  }
  return match.id;
}

async function listSmokeProviderConnections(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<readonly SmokeProviderConnectionListEntry[]> {
  const response = await requestJson<{
    readonly providerConnections?: readonly SmokeProviderConnectionListEntry[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/provider-connections?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
  return response.providerConnections ?? [];
}

async function lookupExistingProviderConnectionSource(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
  providerConnectionId: string,
): Promise<string> {
  const match = (await listSmokeProviderConnections(options, workspaceId)).find(
    (connection) => connection.id === providerConnectionId,
  );
  if (!match) {
    throw new Error(
      `provider connection ${providerConnectionId} was not available to the scratch Workspace`,
    );
  }
  if (typeof match.providerSource !== "string" || !match.providerSource) {
    throw new Error(
      `provider connection ${providerConnectionId} did not expose providerSource`,
    );
  }
  return canonicalProviderSource(match.providerSource);
}

export function smokeCloudflareProviderConnectionMatch(displayName: string): {
  readonly provider: string;
  readonly displayName: string;
} {
  return { provider: CLOUDFLARE_PROVIDER_SOURCE, displayName };
}

export function isSmokeProviderConnectionMatch(
  connection: SmokeProviderConnectionListEntry,
  expected: { readonly provider: string; readonly displayName: string },
): boolean {
  return (
    typeof connection.id === "string" &&
    connection.displayName === expected.displayName &&
    connection.providerSource !== undefined &&
    canonicalProviderSource(connection.providerSource) ===
      canonicalProviderSource(expected.provider)
  );
}

async function deployGitSourceCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly providerBindings: readonly SmokeProviderBindingInput[];
  },
): Promise<
  DeployResponse & {
    readonly sourceId: string;
    readonly sourceSyncRunId: string;
    readonly sourceSnapshotId: string;
    readonly sourceSnapshotTransport: SourceSnapshotTransportEvidence;
    readonly installConfigId: string;
  }
> {
  if (!options.sourceGitUrl) {
    throw new Error("sourceGitUrl is required for git source smoke");
  }
  const source = await createSmokeSource(options, input.workspaceId);
  const sourceSyncRun = await syncSmokeSource(options, source.id);
  const sourceSnapshotId = sourceSyncRun.sourceSnapshotId;
  if (!sourceSnapshotId) {
    throw new Error(
      `source sync run ${sourceSyncRun.id} succeeded without sourceSnapshotId`,
    );
  }
  const sourceSnapshotTransport = await readSourceSnapshotTransport(
    options,
    source.id,
    sourceSnapshotId,
    sourceSyncRun.id,
  );
  const installConfigId = await findSmokeCapsuleInstallConfigId(
    options,
    input.workspaceId,
  );
  const compatibility = await createSmokeSourceCompatibilityCheck(options, {
    sourceId: source.id,
    sourceSnapshotId,
    capsuleName: options.appName,
    installConfigId,
    compileInstallUx: options.installConfigId === undefined,
  });
  if (
    compatibility.report.level !== "ready" ||
    compatibility.run?.type !== "compatibility_check" ||
    compatibility.run.status !== "succeeded" ||
    compatibility.run.compatibilityReportId !== compatibility.report.id
  ) {
    throw new Error(
      "source compatibility check did not return one exact successful declaration",
    );
  }
  const resolvedProviderBindings =
    resolveSmokeProviderBindingsFromCompatibility(
      input.providerBindings,
      compatibility.report.rootProviderRequirements,
    );
  const reviewedInstallConfigId =
    compatibility.repositoryInstallUx?.status === "accepted"
      ? compatibility.repositoryInstallUx.installConfigId
      : installConfigId;
  const coordinated = await createReviewableSmokeInstallPlan(options, {
    workspaceId: input.workspaceId,
    sourceId: source.id,
    sourceSnapshotId,
    compatibilityCheckRunId: compatibility.run.id,
    compatibilityReportId: compatibility.report.id,
    installConfigId: reviewedInstallConfigId,
    providerBindings: resolvedProviderBindings,
  });
  return {
    capsule: { id: coordinated.capsuleId, name: options.appName },
    run: coordinated.run,
    planRun: coordinated.run,
    created: true,
    sourceId: source.id,
    sourceSyncRunId: sourceSyncRun.id,
    sourceSnapshotId,
    sourceSnapshotTransport,
    installConfigId: coordinated.installConfigId,
    compatibilityReportId: compatibility.report.id,
  };
}

async function readSourceSnapshotTransport(
  options: PlatformControlPlaneSmokeOptions,
  sourceId: string,
  sourceSnapshotId: string,
  sourceSyncRunId: string,
): Promise<SourceSnapshotTransportEvidence> {
  const response = await requestJson<{
    readonly snapshots?: readonly unknown[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/sources/${encodeURIComponent(sourceId)}/snapshots?limit=100`,
  });
  const snapshot = (response.snapshots ?? []).find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && value.id === sourceSnapshotId,
  );
  if (
    !snapshot ||
    Object.hasOwn(snapshot, "archiveObjectKey") ||
    typeof snapshot.resolvedCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(snapshot.resolvedCommit) ||
    typeof snapshot.archiveRef !== "string" ||
    snapshot.archiveRef.length === 0 ||
    typeof snapshot.archiveDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(snapshot.archiveDigest) ||
    !Number.isInteger(snapshot.archiveSizeBytes) ||
    Number(snapshot.archiveSizeBytes) <= 0 ||
    snapshot.fetchedByRunId !== sourceSyncRunId
  ) {
    throw new Error(
      "SourceSnapshot did not prove the current archiveRef persistence contract",
    );
  }
  return {
    sourceSnapshotId,
    resolvedCommit: snapshot.resolvedCommit,
    archiveRef: snapshot.archiveRef,
    archiveDigest: snapshot.archiveDigest,
    archiveSizeBytes: Number(snapshot.archiveSizeBytes),
    fetchedByRunId: sourceSyncRunId,
  };
}

async function createSmokeSourceCompatibilityCheck(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly sourceId: string;
    readonly sourceSnapshotId: string;
    readonly capsuleName: string;
    readonly installConfigId: string;
    readonly compileInstallUx: boolean;
  },
): Promise<{
  readonly report: {
    readonly id: string;
    readonly level?: string;
    readonly rootProviderRequirements: readonly SmokeCompatibilityRootProviderRequirement[];
  };
  readonly run?: RunRecord;
  readonly repositoryInstallUx?: {
    readonly status: "accepted" | "absent" | "invalid";
    readonly installConfigId?: string;
  };
}> {
  const response = await requestJson<{
    readonly report?: {
      readonly id?: string;
      readonly level?: string;
      readonly rootProviderRequirements?: unknown;
    };
    readonly run?: RunRecord;
    readonly repositoryInstallUx?: {
      readonly status?: string;
      readonly installConfigId?: string;
    };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources/${encodeURIComponent(
      input.sourceId,
    )}/compatibility-check`,
    body: smokeSourceCompatibilityCheckBody({
      sourceSnapshotId: input.sourceSnapshotId,
      capsuleName: input.capsuleName,
      installConfigId: input.installConfigId,
      compileInstallUx: input.compileInstallUx,
      modulePath: options.modulePath,
    }),
  });
  const reportId = response.report?.id;
  if (!reportId) {
    throw new Error(
      "source compatibility check response did not include report.id",
    );
  }
  const rootProviderRequirements =
    parseSmokeCompatibilityRootProviderRequirements(
      response.report?.rootProviderRequirements,
    );
  return {
    report: {
      id: reportId,
      ...(response.report?.level ? { level: response.report.level } : {}),
      rootProviderRequirements,
    },
    ...(response.run ? { run: response.run } : {}),
    ...(response.repositoryInstallUx?.status === "accepted" &&
    response.repositoryInstallUx.installConfigId
      ? {
          repositoryInstallUx: {
            status: "accepted" as const,
            installConfigId: response.repositoryInstallUx.installConfigId,
          },
        }
      : response.repositoryInstallUx?.status === "absent" ||
          response.repositoryInstallUx?.status === "invalid"
        ? {
            repositoryInstallUx: {
              status: response.repositoryInstallUx.status,
            },
          }
        : {}),
  };
}

export function smokeSourceCompatibilityCheckBody(input: {
  readonly sourceSnapshotId: string;
  readonly capsuleName: string;
  readonly installConfigId: string;
  readonly compileInstallUx: boolean;
  readonly modulePath?: string;
}): Readonly<Record<string, unknown>> {
  return {
    sourceSnapshotId: input.sourceSnapshotId,
    ...(input.compileInstallUx
      ? { compileInstallUx: true, capsuleName: input.capsuleName }
      : { installConfigId: input.installConfigId }),
    ...(input.modulePath ? { modulePath: input.modulePath } : {}),
  };
}

async function createSmokeSource(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<{ readonly id: string }> {
  const response = await requestJson<{
    readonly source?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources`,
    body: {
      workspaceId,
      name: options.sourceName ?? `${options.appName}-source`,
      url: options.sourceGitUrl,
      ...(options.sourceRef ? { defaultRef: options.sourceRef } : {}),
      defaultPath: options.sourcePath,
    },
  });
  const id = response.source?.id;
  if (!id) throw new Error("source create response did not include source.id");
  return { id };
}

async function syncSmokeSource(
  options: PlatformControlPlaneSmokeOptions,
  sourceId: string,
): Promise<RunRecord & { readonly sourceSnapshotId: string }> {
  const created = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources/${encodeURIComponent(sourceId)}/sync`,
    body: {},
  });
  const completed = await pollRun(options, created.run.id);
  assertRunSucceeded(completed, "source sync");
  if (!completed.sourceSnapshotId) {
    throw new Error(
      `source sync run ${completed.id} did not expose sourceSnapshotId`,
    );
  }
  return completed as RunRecord & { readonly sourceSnapshotId: string };
}

async function findSmokeCapsuleInstallConfigId(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<string> {
  const response = await requestJson<{
    readonly installConfigs?: readonly InstallConfigRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsule-configs?workspaceId=${encodeURIComponent(
      workspaceId,
    )}`,
  });
  const configs = response.installConfigs ?? [];
  return selectSmokeInstallConfigId(configs, options.installConfigId);
}

export function selectSmokeInstallConfigId(
  configs: readonly InstallConfigRecord[],
  requestedId?: string,
): string {
  const selectable = configs.filter(isSelectableCapsuleInstallConfig);
  if (requestedId) {
    const match = selectable.find((config) => config.id === requestedId);
    if (!match) {
      throw new Error(
        `install config ${requestedId} was not available to the scratch Workspace`,
      );
    }
    return match.id;
  }
  if (selectable.length === 0) {
    throw new Error(
      "selectable Capsule install config was not available to the scratch Workspace",
    );
  }
  if (selectable.length > 1) {
    throw new Error(
      "multiple selectable Capsule install configs are available; set --install-config-id explicitly",
    );
  }
  return selectable[0]!.id;
}

export function isSelectableCapsuleInstallConfig(
  config: InstallConfigRecord,
): config is InstallConfigRecord & { readonly id: string } {
  if (typeof config.id !== "string") return false;
  if (config.internal?.reason === "per_install_overrides") return false;
  return true;
}

export function smokeGitInstallPlanBody(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    | "appName"
    | "environment"
    | "modulePath"
    | "runnerProfileId"
    | "outputAllowlist"
    | "vars"
    | "interfaceBlueprints"
    | "storeMetadata"
  >,
  input: {
    readonly sourceName: string;
    readonly sourceId: string;
    readonly sourceSnapshotId: string;
    readonly compatibilityCheckRunId: string;
    readonly compatibilityReportId: string;
    readonly installConfigId: string;
    readonly providerBindings: readonly SmokeProviderBindingInput[];
  },
): Readonly<Record<string, unknown>> {
  return {
    source: {
      name: input.sourceName,
      url: options.sourceGitUrl,
      ref: options.sourceRef ?? "HEAD",
      path: options.sourcePath ?? ".",
    },
    capsule: {
      name: options.appName,
      environment: options.environment,
    },
    options: {
      modulePath: options.modulePath ?? ".",
      providerBindings: smokeGitInstallPlanProviderBindings(
        input.providerBindings,
      ),
    },
    preflight: {
      sourceId: input.sourceId,
      sourceSnapshotId: input.sourceSnapshotId,
      compatibilityCheckRunId: input.compatibilityCheckRunId,
      compatibilityReportId: input.compatibilityReportId,
      installConfigId: input.installConfigId,
    },
    variables: options.vars,
    initialConfiguration: {
      ...(options.runnerProfileId
        ? { runnerProfileId: options.runnerProfileId }
        : {}),
      outputAllowlist: options.outputAllowlist,
      ...(options.interfaceBlueprints !== undefined
        ? { interfaceBlueprints: options.interfaceBlueprints }
        : {}),
      ...(options.storeMetadata ? { store: options.storeMetadata } : {}),
    },
  };
}

export function capsuleFromLedgerResponse(
  response: CapsuleLedgerResponse,
): CapsuleLedgerRecord {
  const capsule = response.capsule;
  if (!capsule) {
    throw new Error("capsule ledger response did not include capsule");
  }
  return capsule;
}

function capsuleWorkspaceId(capsule: CapsuleLedgerRecord): string | undefined {
  return capsule.workspaceId;
}

function capsuleCurrentStateVersionId(
  capsule: CapsuleLedgerRecord,
): string | undefined {
  return capsule.currentStateVersionId;
}

interface SmokeInstallPlanResponse {
  readonly installPlan: {
    readonly id: string;
    readonly phase: string;
    readonly capsuleId?: string;
    readonly installConfigId?: string;
    readonly planRunId?: string;
    readonly diagnostic?: { readonly code?: string; readonly message?: string };
  };
  readonly nextAction: "reconcile" | "review_run" | "none";
}

async function createReviewableSmokeInstallPlan(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly sourceSnapshotId: string;
    readonly compatibilityCheckRunId: string;
    readonly compatibilityReportId: string;
    readonly installConfigId: string;
    readonly providerBindings: readonly SmokeProviderBindingInput[];
  },
): Promise<{
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly run: RunRecord;
}> {
  const sourceName = options.sourceName ?? `${options.appName}-source`;
  const requestBody = smokeGitInstallPlanBody(options, {
    ...input,
    sourceName,
  });
  const idempotencyKey = `smoke-install-${digestJson({
    workspaceId: input.workspaceId,
    sourceSnapshotId: input.sourceSnapshotId,
    capsuleName: options.appName,
    requestBody,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  let response = await requestJson<SmokeInstallPlanResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/workspaces/${encodeURIComponent(
      input.workspaceId,
    )}/install-plans`,
    body: requestBody,
    idempotencyKey,
    timeoutMs: options.deployTimeoutSeconds * 1000,
  });
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  while (response.nextAction === "reconcile") {
    if (Date.now() >= deadline) {
      throw new Error("install coordinator did not return a reviewable Plan in time");
    }
    response = await requestJson<SmokeInstallPlanResponse>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/install-plans/${encodeURIComponent(
        response.installPlan.id,
      )}/reconcile`,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
  }
  const plan = response.installPlan;
  if (
    response.nextAction !== "review_run" ||
    plan.phase !== "reviewable" ||
    !plan.capsuleId ||
    !plan.installConfigId ||
    !plan.planRunId
  ) {
    throw new Error(
      `install coordinator ended without a reviewable Plan (${plan.diagnostic?.code ?? plan.phase})`,
    );
  }
  const run = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/runs/${encodeURIComponent(plan.planRunId)}`,
  });
  return {
    capsuleId: plan.capsuleId,
    installConfigId: plan.installConfigId,
    run: run.run,
  };
}

function parseSmokeCompatibilityRootProviderRequirements(
  value: unknown,
): readonly SmokeCompatibilityRootProviderRequirement[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "source compatibility check response did not include report.rootProviderRequirements",
    );
  }
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(
        `compatibility rootProviderRequirements[${index}] must be an object`,
      );
    }
    const source = requiredTrimmedString(
      candidate.source,
      `compatibility rootProviderRequirements[${index}].source`,
    );
    const canonicalSource = canonicalProviderSource(source);
    if (!EXACT_PROVIDER_SOURCE_PATTERN.test(canonicalSource)) {
      throw new Error(
        `compatibility rootProviderRequirements[${index}].source must be a canonical provider source`,
      );
    }
    const moduleLocalName = requiredTrimmedString(
      candidate.moduleLocalName,
      `compatibility rootProviderRequirements[${index}].moduleLocalName`,
    );
    if (!isOpenTofuIdentifier(moduleLocalName)) {
      throw new Error(
        `compatibility rootProviderRequirements[${index}].moduleLocalName must be a valid OpenTofu identifier`,
      );
    }
    const childAlias = optionalOpenTofuIdentifier(
      candidate.childAlias,
      `compatibility rootProviderRequirements[${index}].childAlias`,
    );
    return {
      source: canonicalSource,
      moduleLocalName,
      ...(childAlias ? { childAlias } : {}),
    };
  });
}

/**
 * The public ProviderBinding API requires the module-local identity scanned
 * from required_providers. A guided ProviderConnection starts with only its
 * source, so fill only a uniquely discovered local name after compatibility.
 * Never guess from the provider source suffix or silently reuse one Connection
 * across multiple aliases.
 */
export function resolveSmokeProviderBindingsFromCompatibility(
  bindings: readonly SmokeProviderBindingInput[],
  rootProviderRequirements: readonly SmokeCompatibilityRootProviderRequirement[],
): readonly SmokeProviderBindingInput[] {
  const requirements = parseSmokeCompatibilityRootProviderRequirements(
    rootProviderRequirements,
  );
  return bindings.map((binding) => {
    const source = canonicalProviderSource(binding.provider);
    const sourceMatches = requirements.filter(
      (requirement) => requirement.source === source,
    );
    if (binding.moduleLocalName !== undefined) {
      const declared = sourceMatches.some(
        (requirement) =>
          requirement.moduleLocalName === binding.moduleLocalName &&
          requirement.childAlias === binding.childAlias,
      );
      if (!declared) {
        throw new Error(
          `explicit provider identity ${source} (${binding.moduleLocalName}${binding.childAlias ? `.${binding.childAlias}` : " default"}) is not declared by the compatibility report`,
        );
      }
      return binding;
    }
    if (sourceMatches.length === 0) {
      throw new Error(
        `ProviderBinding ${source} omitted moduleLocalName and the compatibility report has no matching root provider requirement; pass --provider-bindings-json with explicit moduleLocalName and childAlias`,
      );
    }
    if (sourceMatches.length > 1) {
      throw new Error(
        `ProviderBinding ${source} omitted moduleLocalName and the compatibility report has ${sourceMatches.length} matching root provider requirements; pass --provider-bindings-json with explicit moduleLocalName and childAlias`,
      );
    }
    const requirement = sourceMatches[0]!;
    if (requirement.childAlias !== binding.childAlias) {
      throw new Error(
        `ProviderBinding ${source} omitted an exact aliased provider identity; pass --provider-bindings-json with explicit moduleLocalName and childAlias`,
      );
    }
    return { ...binding, moduleLocalName: requirement.moduleLocalName };
  });
}

export function smokeGitInstallPlanProviderBindings(
  bindings: readonly SmokeProviderBindingInput[],
): readonly Readonly<Record<string, string>>[] {
  return [...bindings].sort(compareSmokeProviderBindings).map((binding) => ({
    provider: binding.provider,
    ...(binding.moduleLocalName
      ? { moduleLocalName: binding.moduleLocalName }
      : {}),
    ...(binding.childAlias ? { childAlias: binding.childAlias } : {}),
    ...(binding.rootAlias ? { rootAlias: binding.rootAlias } : {}),
    connectionId: binding.connectionId,
  }));
}

async function ensurePlanReadyForApply(
  options: PlatformControlPlaneSmokeOptions,
  planRunId: string,
): Promise<RunRecord> {
  const plan = await pollRun(options, planRunId);
  if (plan.status !== "waiting_approval") return plan;
  const approved = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(planRunId)}/approve`,
    body: { reason: "Layer-2 platform-control-plane smoke apply" },
  });
  if (TERMINAL_RUN_STATUSES.has(approved.run.status)) return approved.run;
  return await pollRun(options, planRunId);
}

async function destroySmokeCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly capsuleId: string;
    readonly reason: string;
    readonly verifyCloudflareWorkerGone: boolean;
    readonly publicOutputs?: Readonly<Record<string, unknown>>;
    readonly publicUrlLifecycleChecks?: readonly RegisteredPublicUrlCheck[];
  },
  progress: DestroySmokeCapsuleProgress,
): Promise<DestroySmokeCapsuleResult> {
  const destroyPlan = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      input.capsuleId,
    )}/destroy-plan`,
    body: {
      ...(options.runnerProfileId
        ? { runnerProfileId: options.runnerProfileId }
        : {}),
    },
  });
  progress.destroyPlanRun = destroyPlan.run;
  const reviewedDestroyPlan = await pollRun(options, destroyPlan.run.id);
  progress.destroyPlanRun = reviewedDestroyPlan;
  if (reviewedDestroyPlan.status !== "waiting_approval") {
    throw new Error(
      `destroy plan ${destroyPlan.run.id} ended as ${reviewedDestroyPlan.status}; expected waiting_approval`,
    );
  }
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlan.run.id)}/approve`,
    body: { reason: input.reason },
  });
  progress.destroyApplyAttempted = true;
  const destroyApply = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlan.run.id)}/apply`,
    body: { confirmDestructive: true },
  });
  progress.destroyApplyRun = destroyApply.run;
  const completedDestroy = await pollRun(options, destroyApply.run.id);
  progress.destroyApplyRun = completedDestroy;
  assertRunSucceeded(completedDestroy, "destroy apply");
  const destroyVerification = await verifyDestroyedSmokeCapsule(
    options,
    input,
  );
  return {
    destroyPlanRun: reviewedDestroyPlan,
    destroyApplyRun: completedDestroy,
    ...(destroyVerification ? { destroyVerification } : {}),
  };
}

async function verifyDestroyedSmokeCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly verifyCloudflareWorkerGone: boolean;
    readonly publicOutputs?: Readonly<Record<string, unknown>>;
    readonly publicUrlLifecycleChecks?: readonly RegisteredPublicUrlCheck[];
  },
): Promise<SmokeDestroyVerification | undefined> {
  let destroyVerification: SmokeDestroyVerification | undefined;
  if (
    input.verifyCloudflareWorkerGone ||
    (input.publicUrlLifecycleChecks?.length ?? 0) > 0
  ) {
    let cloudflareWorkerGone = false;
    const verificationErrors: string[] = [];
    if (input.verifyCloudflareWorkerGone) {
      try {
        await assertCloudflareWorkerGone(options, input.publicOutputs);
        cloudflareWorkerGone = true;
      } catch (error) {
        verificationErrors.push(errorMessage(error));
      }
      try {
        await verifyPublicWorkerUrlGone(options, input.publicOutputs);
      } catch (error) {
        verificationErrors.push(errorMessage(error));
      }
    }
    let publicUrlDestroyChecks: readonly PublicUrlDestroyCheckResult[] | undefined;
    if (input.publicUrlLifecycleChecks?.length) {
      try {
        publicUrlDestroyChecks = await verifyRegisteredPublicUrlsDestroyed(
          input.publicUrlLifecycleChecks,
        );
      } catch (error) {
        publicUrlDestroyChecks = materializeInconclusivePublicUrlDestroyChecks(
          input.publicUrlLifecycleChecks,
          error,
        );
      }
      for (const check of publicUrlDestroyChecks) {
        if (check.status === "passed") continue;
        verificationErrors.push(
          check.status === "not_claimed"
            ? `public URL check ${check.name} has no valid absence contract: ${check.expectation.kind === "not-verifiable" ? check.expectation.reason : "not claimed"}`
            : check.error ??
              `public URL check ${check.name} absence is inconclusive`,
        );
      }
    }
    destroyVerification = verificationErrors.length > 0
      ? {
          status: "inconclusive",
          cloudflareWorkerGone,
          ...(publicUrlDestroyChecks ? { publicUrlDestroyChecks } : {}),
          error: verificationErrors.join("; "),
        }
      : {
          status: "passed",
          cloudflareWorkerGone,
          ...(publicUrlDestroyChecks ? { publicUrlDestroyChecks } : {}),
        };
  }
  return destroyVerification;
}

function destroyFailureCleanupResult(
  destroyResult: DestroySmokeCapsuleResult,
): FailureCleanupResult {
  const verification = destroyResult.destroyVerification;
  return {
    attempted: true,
    cloudflareWorkerGone: verification?.cloudflareWorkerGone ?? false,
    capsuleMarkedError: false,
    destroyAttempted: true,
    destroyApplyAttempted: true,
    destroyPlanRunId: destroyResult.destroyPlanRun.id,
    destroyApplyRunId: destroyResult.destroyApplyRun.id,
    destroySucceeded: true,
    ...(verification ? { destroyVerification: verification } : {}),
    ...(verification?.error ? { error: verification.error } : {}),
  };
}

function failedDestroyCleanupResult(
  progress: DestroySmokeCapsuleProgress | undefined,
  error: unknown,
  publicUrlLifecycleChecks?: readonly RegisteredPublicUrlCheck[],
): FailureCleanupResult {
  const destroyVerification = inconclusiveDestroyVerification(
    publicUrlLifecycleChecks,
    error,
  );
  return {
    attempted: true,
    cloudflareWorkerGone: false,
    capsuleMarkedError: false,
    destroyAttempted: true,
    ...(progress?.destroyApplyAttempted === undefined
      ? {}
      : { destroyApplyAttempted: progress.destroyApplyAttempted }),
    ...(progress?.destroyPlanRun
      ? { destroyPlanRunId: progress.destroyPlanRun.id }
      : {}),
    ...(progress?.destroyApplyRun
      ? { destroyApplyRunId: progress.destroyApplyRun.id }
      : {}),
    destroySucceeded: false,
    destroyError: errorMessage(error),
    destroyVerification,
    error: destroyVerification.error,
  };
}

function retainedFailureCleanupResult(
  publicUrlLifecycleChecks: readonly RegisteredPublicUrlCheck[] | undefined,
  reason: string,
): FailureCleanupResult {
  const destroyVerification = inconclusiveDestroyVerification(
    publicUrlLifecycleChecks,
    reason,
  );
  return {
    attempted: true,
    cloudflareWorkerGone: false,
    capsuleMarkedError: false,
    destroyAttempted: false,
    retainedForOperatorRecovery: true,
    destroyVerification,
    error: destroyVerification.error,
  };
}

function inconclusiveDestroyVerification(
  publicUrlLifecycleChecks: readonly RegisteredPublicUrlCheck[] | undefined,
  error: unknown,
): SmokeDestroyVerification {
  const publicUrlDestroyChecks = publicUrlLifecycleChecks?.length
    ? materializeInconclusivePublicUrlDestroyChecks(
        publicUrlLifecycleChecks,
        error,
      )
    : undefined;
  return {
    status: "inconclusive",
    cloudflareWorkerGone: false,
    ...(publicUrlDestroyChecks ? { publicUrlDestroyChecks } : {}),
    error: errorMessage(error),
  };
}

function materializeInconclusivePublicUrlDestroyChecks(
  registrations: readonly RegisteredPublicUrlCheck[],
  error: unknown,
): readonly PublicUrlDestroyCheckResult[] {
  const reason = `Destroy absence verification was not completed: ${errorMessage(error)}`;
  return registrations.map(({ check, url, applyResult, applyError }) => ({
    name: check.name,
    output: check.output,
    ...(url ? { url } : {}),
    expectation: check.destroyExpectation,
    applyStatus: applyResult ? "passed" as const : "unverified" as const,
    status: check.destroyExpectation.kind === "not-verifiable"
      ? "not_claimed" as const
      : "inconclusive" as const,
    error: !applyResult && applyError
      ? `${reason}; Apply existence proof was not established: ${applyError}`
      : reason,
  }));
}

export function shouldMarkPendingSmokeCapsuleError(
  capsule: CapsuleLedgerRecord,
  appName: string,
): capsule is CapsuleLedgerRecord & { readonly id: string } {
  return (
    typeof capsule.id === "string" &&
    capsule.name === appName &&
    capsule.status === "pending" &&
    (capsule.currentStateGeneration ?? 0) === 0
  );
}

async function markPendingSmokeCapsuleError(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId?: string;
  },
): Promise<boolean> {
  const candidates = input.capsuleId
    ? [
        (
          await requestJson<{ readonly capsule?: CapsuleLedgerRecord }>({
            baseUrl: options.url,
            token: options.accountSessionToken,
            path: `${API_PREFIX}/capsules/${encodeURIComponent(
              input.capsuleId,
            )}`,
          })
        ).capsule,
      ]
    : ((
        await requestJson<{ readonly capsules?: CapsuleLedgerRecord[] }>({
          baseUrl: options.url,
          token: options.accountSessionToken,
          path: `${API_PREFIX}/workspaces/${encodeURIComponent(
            input.workspaceId,
          )}/capsules`,
        })
      ).capsules ?? []);

  const target = candidates
    .filter((item): item is CapsuleLedgerRecord => item !== undefined)
    .find((item) => shouldMarkPendingSmokeCapsuleError(item, options.appName));
  if (!target?.id) return false;
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "PATCH",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(target.id)}`,
    body: { status: "error" },
  });
  return true;
}

async function pollRun(
  options: PlatformControlPlaneSmokeOptions,
  runId: string,
): Promise<RunRecord> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus = "";
  while (Date.now() <= deadline) {
    const response = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}`,
    });
    if (response.run.id !== runId) {
      throw new Error(
        `run ${runId} poll returned mismatched run id ${response.run.id}`,
      );
    }
    if (response.run.status !== lastStatus && !options.json) {
      console.log(`run ${runId} ${response.run.status}`);
      lastStatus = response.run.status;
    }
    if (TERMINAL_RUN_STATUSES.has(response.run.status)) {
      return response.run;
    }
    await sleep(options.pollIntervalMs);
  }
  throw new RunPollTimeoutError(runId);
}

async function cancelRunAfterPollTimeout(
  options: PlatformControlPlaneSmokeOptions,
  runId: string,
): Promise<{
  readonly status: "cancelled" | "already_terminal" | "failed";
  readonly run?: RunRecord;
  readonly error?: string;
}> {
  try {
    const current = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}`,
    });
    if (current.run.id !== runId) {
      throw new Error(
        `run ${runId} cancel reconciliation returned mismatched run id ${current.run.id}`,
      );
    }
    if (TERMINAL_RUN_STATUSES.has(current.run.status)) {
      return { status: "already_terminal", run: current.run };
    }
    const cancelled = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}/cancel`,
      body: {},
    });
    if (cancelled.run.id !== runId) {
      throw new Error(
        `run ${runId} cancel response returned mismatched run id ${cancelled.run.id}`,
      );
    }
    if (TERMINAL_RUN_STATUSES.has(cancelled.run.status)) {
      return { status: "cancelled", run: cancelled.run };
    }
    return {
      status: "failed",
      error: `cancel returned non-terminal status ${cancelled.run.status}`,
    };
  } catch (error) {
    return { status: "failed", error: publicErrorMessage(error) };
  }
}

function assertRunSucceeded(run: RunRecord, phase: string): void {
  if (run.status !== "succeeded") {
    throw new Error(`${phase} run ${run.id} ended as ${run.status}`);
  }
  if (run.policyStatus === "deny") {
    throw new Error(`${phase} run ${run.id} was denied by policy`);
  }
}

async function assertCloudflareWorkerExists(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const workerName = cloudflareWorkerName(options, publicOutputs);
  const deadline = createAbsoluteRequestDeadline(
    60_000,
    "Cloudflare Worker existence check",
  );
  let lastStatus = 0;
  while (remainingDeadlineMs(deadline) > 0) {
    const response = await cloudflareScriptRequest(
      options,
      workerName,
      Math.min(
        PUBLIC_URL_REQUEST_TIMEOUT_MS,
        Math.max(1, remainingDeadlineMs(deadline)),
      ),
    );
    lastStatus = response.status;
    if (response.status === 200) return;
    try {
      await waitWithinDeadline(
        sleep(Math.min(2_000, remainingDeadlineMs(deadline))),
        deadline,
        () => new CloudflareApiTimeoutError(),
      );
    } catch {
      break;
    }
  }
  throw new Error(
    `Cloudflare Worker ${workerName} was not readable after apply (last HTTP ${lastStatus})`,
  );
}

function publicWorkerUrl(options: PlatformControlPlaneSmokeOptions): string {
  return publicWorkerUrlForName(options, options.appName);
}

function publicRuntimeUrl(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): string {
  if (options.runtimePublicUrlOutput) {
    return requiredProjectedStringOutput(
      publicOutputs,
      options.runtimePublicUrlOutput,
      "runtime public URL",
    );
  }
  return publicWorkerUrlForName(
    options,
    cloudflareWorkerName(options, publicOutputs),
  );
}

function failedResultWorkerUrl(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): string {
  if (options.verificationMode !== "cloudflare-worker") return "";
  if (options.runtimePublicUrlOutput) {
    const value = publicOutputs?.[options.runtimePublicUrlOutput];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }
  if (options.cloudflareWorkerNameOutput) {
    const value = publicOutputs?.[options.cloudflareWorkerNameOutput];
    return typeof value === "string" && value.trim()
      ? publicWorkerUrlForName(options, value.trim())
      : "";
  }
  return publicWorkerUrl(options);
}

function publicWorkerUrlForName(
  options: PlatformControlPlaneSmokeOptions,
  workerName: string,
): string {
  return `https://${workerName}.${options.cloudflareWorkersSubdomain}.workers.dev`;
}

function cloudflareWorkerName(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): string {
  if (options.cloudflareWorkerNameOutput) {
    return requiredProjectedStringOutput(
      publicOutputs,
      options.cloudflareWorkerNameOutput,
      "Cloudflare Worker name",
    );
  }
  return options.appName;
}

function requiredProjectedStringOutput(
  publicOutputs: Readonly<Record<string, unknown>> | undefined,
  outputName: string,
  purpose: string,
): string {
  const value = publicOutputs?.[outputName];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${purpose} output ${JSON.stringify(outputName)} is missing or is not a non-empty string`,
    );
  }
  return value.trim();
}

function isCurrentTakosumiHelloPage(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    normalized.includes("hello from takosumi") &&
    normalized.includes("<h1>it works</h1>") &&
    normalized.includes("takosumi")
  );
}

async function assertPublicWorkerUrl(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
  dependencies: Pick<PublicUrlFetchDependencies, "resolver" | "connector"> = {},
): Promise<void> {
  const url = strictPublicUrl(
    publicRuntimeUrl(options, publicOutputs),
    "Cloudflare Worker public URL",
  );
  const transport = publicTransportDependencies(dependencies);
  const resolver = transport.resolver ?? resolveAllDnsAddresses;
  const connector = transport.connector ?? connectPinnedHttps;
  const sleepForRetry = transport.sleep ?? sleep;
  let target: ResolvedDnsAddress | undefined;
  const check = publicWorkerProbeCheck(url);
  // The Cloudflare script API may become readable before the workers.dev edge
  // hostname has converged. Keep the probe fail-closed, but allow the public
  // data plane a bounded propagation window observed in real release drills.
  const deadline = createAbsoluteRequestDeadline(
    CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS,
    "Cloudflare Worker public URL",
  );
  let lastStatus = 0;
  let lastBody = "";
  while (remainingDeadlineMs(deadline) > 0) {
    try {
      target ??= await resolvePinnedPublicTarget(
        url.hostname,
        resolver,
        "Cloudflare Worker public URL",
        CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS,
        deadline,
      );
      const { response, body } = await fetchPublicCheckAttempt(
        url,
        check,
        target,
        connector,
        CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS,
        undefined,
        "GET",
        undefined,
        deadline,
      );
      lastStatus = response.status;
      lastBody = body;
      if (response.ok && isCurrentTakosumiHelloPage(lastBody)) {
        return;
      }
    } catch (error) {
      if (
        error instanceof PublicUrlNonPublicAddressError ||
        error instanceof PublicUrlDnsResolutionError
      ) {
        throw error;
      }
      lastBody = error instanceof PublicUrlDnsResolutionError
        ? error.message
        : "public URL request failed";
    }
    const retrySleep = Promise.resolve().then(() => sleepForRetry(2_000));
    retrySleep.catch(() => undefined);
    try {
      await waitWithinDeadline(
        retrySleep,
        deadline,
        () => new PublicUrlCheckTimeoutError(check.name),
      );
    } catch {
      break;
    }
  }
  throw new Error(
    `Cloudflare Worker public URL did not return the expected Takosumi page (last HTTP ${lastStatus}, body ${JSON.stringify(
      redactResponseSnippet(lastBody),
    )})`,
  );
}

function publicWorkerProbeCheck(url: URL): PublicUrlCheck {
  return {
    name: "cloudflare-worker-runtime",
    output: "runtime_url",
    path: url.pathname,
    expectedStatus: 200,
    bodyIncludes: [],
    destroyExpectation: { kind: "http-404" },
  };
}

function dryRunPublicUrl(check: PublicUrlCheck): string {
  const path = check.path === "/" ? "" : check.path;
  return `https://example.invalid${path}`;
}

type ResolvedDnsAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

type PinnedHttpsRequest = {
  readonly address: string;
  readonly family: 4 | 6;
  readonly servername: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
};

interface ControlPlaneTransportDependencies {
  readonly resolver?: (hostname: string) => Promise<readonly ResolvedDnsAddress[]>;
  readonly connector?: (request: PinnedHttpsRequest) => Promise<Response>;
  /** Unit-test seam for bounded control-plane request recovery. */
  readonly requestTimeoutMs?: number;
  readonly authorityScope?: PinnedAuthorityScope;
  readonly publicResolver?: PublicUrlFetchDependencies["resolver"];
  readonly publicConnector?: PublicUrlFetchDependencies["connector"];
  readonly publicSleep?: PublicUrlFetchDependencies["sleep"];
  readonly publicMaxAttempts?: PublicUrlFetchDependencies["maxAttempts"];
  readonly publicRequestTimeoutMs?: PublicUrlFetchDependencies["requestTimeoutMs"];
}

interface PublicUrlFetchDependencies {
  readonly resolver?: (hostname: string) => Promise<readonly ResolvedDnsAddress[]>;
  readonly connector?: (request: PinnedHttpsRequest) => Promise<Response>;
  /** Explicit unit-test seam for the dynamic Takosumi control-plane authority. */
  readonly controlPlaneResolver?: ControlPlaneTransportDependencies["resolver"];
  /** Explicit unit-test seam; the CLI production path never supplies this. */
  readonly controlPlaneConnector?: ControlPlaneTransportDependencies["connector"];
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly authorityScope?: PinnedAuthorityScope;
}

interface PinnedAuthorityScope {
  readonly targets: Map<string, Promise<ResolvedDnsAddress>>;
}

type AbsoluteRequestDeadline = {
  readonly expiresAt: number;
  readonly timeoutMs: number;
};

function createAbsoluteRequestDeadline(
  timeoutMs: number,
  label: string,
): AbsoluteRequestDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${label} timeout must be a positive integer`);
  }
  return {
    expiresAt: Date.now() + timeoutMs,
    timeoutMs,
  };
}

function remainingDeadlineMs(deadline: AbsoluteRequestDeadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

async function waitWithinDeadline<T>(
  operation: Promise<T>,
  deadline: AbsoluteRequestDeadline,
  timeoutError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  const remaining = remainingDeadlineMs(deadline);
  if (remaining <= 0) {
    onTimeout?.();
    throw timeoutError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerExpired = false;
  try {
    let value: T;
    try {
      value = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timerExpired = true;
            onTimeout?.();
            reject(timeoutError());
          }, remaining);
        }),
      ]);
    } catch (error) {
      if (!timerExpired && Date.now() > deadline.expiresAt) {
        onTimeout?.();
        throw timeoutError();
      }
      throw error;
    }
    if (Date.now() > deadline.expiresAt) {
      onTimeout?.();
      throw timeoutError();
    }
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type SmokeHttpsDependencies = Pick<
  PublicUrlFetchDependencies,
  | "resolver"
  | "connector"
  | "controlPlaneResolver"
  | "controlPlaneConnector"
  | "sleep"
  | "maxAttempts"
  | "requestTimeoutMs"
  | "authorityScope"
>;

function controlPlaneDependencies(
  dependencies: PublicUrlFetchDependencies = {},
): ControlPlaneTransportDependencies {
  const inherited = controlPlaneTransportContext.getStore();
  return {
    resolver:
      dependencies.controlPlaneResolver ??
      inherited?.resolver,
    connector:
      dependencies.controlPlaneConnector ??
      inherited?.connector,
    requestTimeoutMs:
      dependencies.requestTimeoutMs ??
      inherited?.requestTimeoutMs,
    authorityScope:
      dependencies.authorityScope ??
      inherited?.authorityScope ??
      { targets: new Map() },
    publicResolver:
      dependencies.resolver ??
      inherited?.publicResolver,
    publicConnector:
      dependencies.connector ??
      inherited?.publicConnector,
    publicSleep:
      dependencies.sleep ??
      inherited?.publicSleep,
    publicMaxAttempts:
      dependencies.maxAttempts ??
      inherited?.publicMaxAttempts,
    publicRequestTimeoutMs:
      dependencies.requestTimeoutMs ??
      inherited?.publicRequestTimeoutMs,
  };
}

function publicTransportDependencies(
  dependencies: PublicUrlFetchDependencies = {},
): PublicUrlFetchDependencies {
  const inherited = controlPlaneTransportContext.getStore();
  return {
    resolver: dependencies.resolver ?? inherited?.publicResolver,
    connector: dependencies.connector ?? inherited?.publicConnector,
    sleep: dependencies.sleep ?? inherited?.publicSleep,
    maxAttempts:
      dependencies.maxAttempts ?? inherited?.publicMaxAttempts,
    requestTimeoutMs:
      dependencies.requestTimeoutMs ?? inherited?.publicRequestTimeoutMs,
    authorityScope:
      dependencies.authorityScope ?? inherited?.authorityScope,
  };
}

export async function assertConfiguredPublicUrls(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs: Readonly<Record<string, unknown>> | undefined,
  dependencies: PublicUrlFetchDependencies = {},
): Promise<readonly PublicUrlCheckResult[]> {
  const transport = controlPlaneDependencies(dependencies);
  const results: PublicUrlCheckResult[] = [];
  const registrations = registerConfiguredPublicUrls(
    options.publicUrlChecks,
    publicOutputs,
  );
  Object.defineProperty(results, publicUrlTransportScope, {
    configurable: false,
    enumerable: false,
    value: transport.authorityScope,
    writable: false,
  });
  Object.defineProperty(results, publicUrlLifecycleScope, {
    configurable: false,
    enumerable: false,
    value: registrations,
    writable: false,
  });
  Object.defineProperty(registrations, publicUrlTransportScope, {
    configurable: false,
    enumerable: false,
    value: transport.authorityScope,
    writable: false,
  });
  try {
    const invalid = registrations.find((registration) => !registration.url);
    if (invalid) {
      for (const registration of registrations) {
        registration.applyError ??=
          "URL checks were not started because at least one configured applied URL was invalid";
      }
      throw new Error(
        invalid.applyError ??
          `public URL check ${invalid.check.name} applied URL is invalid`,
      );
    }
    await controlPlaneTransportContext.run(
      transport,
      async () =>
        await assertConfiguredPublicUrlsInternal(
          registrations,
          dependencies,
          results,
        ),
    );
    return results;
  } catch (error) {
    // Preserve the complete configured lifecycle set, including URLs whose
    // Apply proof failed or could not be resolved. Cleanup must never infer
    // that an omitted check is safe to claim as destroyed.
    if (isWeakMapKey(error)) {
      publicUrlCheckProgress.set(error, { registrations, results });
    }
    throw error;
  }
}

function registerConfiguredPublicUrls(
  checks: readonly PublicUrlCheck[],
  publicOutputs: Readonly<Record<string, unknown>> | undefined,
): RegisteredPublicUrlCheck[] {
  return checks.map((check) => {
    try {
      assertPublicUrlLifecycleContract(check);
      if (!publicOutputs) {
        throw new Error(
          "Output ledger did not expose publicOutputs for URL checks",
        );
      }
      const rawUrl = publicOutputs[check.output];
      if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        throw new Error(
          `public URL check ${check.name} expected string output ${check.output}`,
        );
      }
      return { check, url: publicCheckUrl(rawUrl, check) };
    } catch (error) {
      return { check, applyError: publicErrorMessage(error) };
    }
  });
}

async function assertConfiguredPublicUrlsInternal(
  registrations: readonly RegisteredPublicUrlCheck[],
  dependencies: PublicUrlFetchDependencies,
  results: PublicUrlCheckResult[],
): Promise<void> {
  const transport = publicTransportDependencies(dependencies);
  for (let index = 0; index < registrations.length; index += 1) {
    const registration = registrations[index]!;
    const { check, url } = registration;
    if (!url) {
      throw new Error(
        registration.applyError ??
          `public URL check ${check.name} applied URL is invalid`,
      );
    }
    try {
      const { response, body } = await fetchPublicUrlCheckWithRetry(
        url,
        check,
        transport,
      );
      const result: PublicUrlCheckResult = {
        name: check.name,
        output: check.output,
        url,
        status: response.status,
        ok: true,
        bodyIncludes: check.bodyIncludes,
        bodyDigest: sha256(body),
        destroyExpectation: check.destroyExpectation,
      };
      registration.applyResult = result;
      results.push(result);
    } catch (error) {
      registration.applyError = publicErrorMessage(error);
      for (const unattempted of registrations.slice(index + 1)) {
        unattempted.applyError ??=
          "Apply existence proof was not attempted because an earlier configured URL check failed";
      }
      throw error;
    }
  }
}

export async function verifyConfiguredPublicUrlsDestroyed(
  appliedChecks: readonly PublicUrlCheckResult[],
  dependencies: Pick<
    PublicUrlFetchDependencies,
    | "resolver"
    | "connector"
    | "sleep"
    | "maxAttempts"
    | "requestTimeoutMs"
    | "authorityScope"
  > = {},
): Promise<readonly PublicUrlDestroyCheckResult[]> {
  const registrations = configuredPublicUrlRegistrations(appliedChecks);
  const retainedAuthorityScope = (
    appliedChecks as readonly PublicUrlCheckResult[] & {
      readonly [publicUrlTransportScope]?: PinnedAuthorityScope;
    }
  )[publicUrlTransportScope];
  if (!(publicUrlTransportScope in registrations)) {
    Object.defineProperty(registrations, publicUrlTransportScope, {
      configurable: false,
      enumerable: false,
      value: retainedAuthorityScope ?? dependencies.authorityScope,
      writable: false,
    });
  }
  return await verifyRegisteredPublicUrlsDestroyed(
    registrations,
    {
      ...dependencies,
      authorityScope:
        retainedAuthorityScope ?? dependencies.authorityScope,
    },
  );
}

function configuredPublicUrlRegistrations(
  appliedChecks: readonly PublicUrlCheckResult[],
): RegisteredPublicUrlCheck[] {
  const retained = (
    appliedChecks as readonly PublicUrlCheckResult[] & {
      readonly [publicUrlLifecycleScope]?: readonly RegisteredPublicUrlCheck[];
    }
  )[publicUrlLifecycleScope];
  if (retained) return retained as RegisteredPublicUrlCheck[];
  return appliedChecks.map((applyResult) => ({
    check: {
      name: applyResult.name,
      output: applyResult.output,
      path: new URL(applyResult.url).pathname,
      expectedStatus: applyResult.status,
      bodyIncludes: applyResult.bodyIncludes,
      destroyExpectation: applyResult.destroyExpectation,
    },
    url: applyResult.url,
    applyResult,
  }));
}

async function verifyRegisteredPublicUrlsDestroyed(
  registrations: readonly RegisteredPublicUrlCheck[],
  dependencies: Pick<
    PublicUrlFetchDependencies,
    | "resolver"
    | "connector"
    | "sleep"
    | "maxAttempts"
    | "requestTimeoutMs"
    | "authorityScope"
  > = {},
): Promise<readonly PublicUrlDestroyCheckResult[]> {
  const retainedAuthorityScope = (
    registrations as readonly RegisteredPublicUrlCheck[] & {
      readonly [publicUrlTransportScope]?: PinnedAuthorityScope;
    }
  )[publicUrlTransportScope];
  const transport = controlPlaneDependencies({
    ...dependencies,
    authorityScope:
      retainedAuthorityScope ?? dependencies.authorityScope,
  });
  return await controlPlaneTransportContext.run(
    transport,
    async () => {
      // An Apply proof owns its authority pin. A caller may tune the retry
      // transport for Destroy, but cannot replace that retained DNS decision.
      const publicDependencies = publicTransportDependencies({
        ...dependencies,
        authorityScope: transport.authorityScope,
      });
      const results: PublicUrlDestroyCheckResult[] = [];
      for (const registration of registrations) {
        const { check, url: appliedUrl, applyResult, applyError } = registration;
        const applyStatus = applyResult ? "passed" as const : "unverified" as const;
        const shared = {
          name: check.name,
          output: check.output,
          ...(appliedUrl ? { url: appliedUrl } : {}),
          expectation: check.destroyExpectation,
          applyStatus,
        };
        if (check.destroyExpectation.kind === "not-verifiable") {
          results.push({
            ...shared,
            status: "not_claimed",
            ...(applyError ? { error: applyError } : {}),
          });
          continue;
        }
        if (!appliedUrl) {
          results.push({
            ...shared,
            status: "inconclusive",
            error:
              applyError ??
              `public URL check ${check.name} applied URL was unresolved`,
          });
          continue;
        }
        try {
          const url = strictPublicUrl(
            appliedUrl,
            `public URL check ${check.name} applied URL`,
          );
          const observedStatus = await verifyPinnedPublicRetirement(
            url,
            check,
            `public URL check ${check.name}`,
            publicDependencies,
            { maxAttempts: 16, deadlineMs: 120_000 },
          );
          results.push({
            ...shared,
            status: applyResult ? "passed" : "inconclusive",
            observedStatus,
            ...(!applyResult
              ? {
                  error:
                    `Apply existence proof was not established: ${
                      applyError ?? "the configured URL check was not completed"
                    }`,
                }
              : {}),
          });
        } catch (error) {
          results.push({
            ...shared,
            status: "inconclusive",
            error: publicErrorMessage(error),
          });
        }
      }
      return results;
    },
  );
}

export async function fetchPublicUrlCheckWithRetry(
  url: string,
  check: PublicUrlCheck,
  dependencies: PublicUrlFetchDependencies = {},
): Promise<{ readonly response: Response; readonly body: string }> {
  const requestUrl = validatePublicCheckRequestUrl(url, check);
  const resolver = dependencies.resolver ?? resolveAllDnsAddresses;
  const connector = dependencies.connector ?? connectPinnedHttps;
  const sleepForRetry = dependencies.sleep ?? sleep;
  const maxAttempts = dependencies.maxAttempts ?? 16;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? PUBLIC_URL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("public URL check max attempts must be a positive integer");
  }
  const deadline = createAbsoluteRequestDeadline(
    requestTimeoutMs,
    `public URL check ${check.name}`,
  );
  const parsedRequestUrl = new URL(requestUrl);
  let target: ResolvedDnsAddress | undefined;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      target ??= await resolvePinnedPublicTarget(
        parsedRequestUrl.hostname,
        resolver,
        `public URL check ${check.name}`,
        requestTimeoutMs,
        deadline,
      );
      const { response, body } = await fetchPublicCheckAttempt(
        parsedRequestUrl,
        check,
        target,
        connector,
        requestTimeoutMs,
        undefined,
        "GET",
        undefined,
        deadline,
      );
      if (response.status >= 300 && response.status < 400) {
        lastError = new Error(
          `public URL check ${check.name} rejected a redirect response`,
        );
      } else if (response.status === check.expectedStatus) {
        const missing = check.bodyIncludes.find(
          (marker) => !body.includes(marker),
        );
        if (!missing) return { response, body };
        lastError = new Error(
          `public URL check ${check.name} response did not include marker ${JSON.stringify(
            missing,
          )}`,
        );
      } else {
        lastError = new Error(
          `public URL check ${check.name} returned HTTP ${response.status}; expected ${check.expectedStatus}`,
        );
      }
    } catch (error) {
      if (
        error instanceof PublicUrlNonPublicAddressError ||
        error instanceof PublicUrlDnsResolutionError
      ) {
        throw error;
      }
      lastError =
        error instanceof PublicUrlDnsResolutionError
          ? error
          : error instanceof PublicUrlCheckTimeoutError
          ? error
          : error instanceof PublicUrlResponseTooLargeError
            ? error
            : new Error(`public URL check ${check.name} request failed`);
      if (error instanceof PublicUrlResponseTooLargeError) throw error;
    }
    if (attempt + 1 < maxAttempts) {
      const retrySleep = Promise.resolve().then(() =>
        sleepForRetry(Math.min(5_000, 500 + attempt * 500)),
      );
      retrySleep.catch(() => undefined);
      await waitWithinDeadline(
        retrySleep,
        deadline,
        () => new PublicUrlCheckTimeoutError(check.name),
      );
    }
  }
  throw lastError ?? new Error(`public URL check ${check.name} failed`);
}

async function fetchPublicCheckAttempt(
  url: URL,
  check: PublicUrlCheck,
  target: ResolvedDnsAddress,
  connector: (request: PinnedHttpsRequest) => Promise<Response>,
  requestTimeoutMs: number,
  requestHeaders: Readonly<Record<string, string>> = {
    accept: "text/html,*/*",
  },
  method = "GET",
  requestBody?: Uint8Array,
  deadline = createAbsoluteRequestDeadline(
    requestTimeoutMs,
    "public URL request",
  ),
): Promise<{ readonly response: Response; readonly body: string }> {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("public URL request timeout must be a positive integer");
  }
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  const request = Promise.resolve().then(() =>
    connector({
      ...target,
      servername: url.hostname,
      headers: {
        ...requestHeaders,
        host: url.hostname,
      },
      method,
      path: `${url.pathname}${url.search}`,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: controller.signal,
    }),
  );
  request.catch(() => undefined);
  const guardedRequest = new Promise<Response>((resolveResponse, rejectResponse) => {
    request.then(
      (candidate) => {
        if (timedOut || remainingDeadlineMs(deadline) <= 0) {
          timedOut = true;
          controller.abort();
          void cancelPublicResponseBody(candidate).catch(() => undefined);
          return;
        }
        resolveResponse(candidate);
      },
      rejectResponse,
    );
  });
  guardedRequest.catch(() => undefined);
  const markTimedOut = (): void => {
    timedOut = true;
    controller.abort();
  };
  try {
    response = await waitWithinDeadline(
      guardedRequest,
      deadline,
      () => new PublicUrlCheckTimeoutError(check.name),
      markTimedOut,
    );
    const bodyRead = readBoundedPublicResponse(
      response,
      check,
      controller.signal,
      deadline,
    );
    bodyRead.catch(() => undefined);
    const body = await waitWithinDeadline(
      bodyRead,
      deadline,
      () => new PublicUrlCheckTimeoutError(check.name),
      markTimedOut,
    );
    return { response, body };
  } catch (error) {
    await cancelPublicResponseBody(response, deadline);
    if (timedOut || error instanceof PublicUrlCheckTimeoutError) {
      throw new PublicUrlCheckTimeoutError(check.name);
    }
    throw error;
  }
}

export async function fetchPinnedInterfaceBearerResource(
  urlValue: string,
  bearer: string,
  dependencies: Pick<PublicUrlFetchDependencies, "resolver" | "connector"> = {},
): Promise<{ readonly response: Response; readonly body: string }> {
  if (
    !bearer ||
    new TextEncoder().encode(bearer).byteLength > MAX_SMOKE_INTERFACE_TOKEN_BYTES ||
    /[\0\r\n]/u.test(bearer)
  ) {
    throw new Error("Interface bearer is invalid");
  }
  const url = strictPublicUrl(urlValue, "Interface bearer resource");
  const transport = publicTransportDependencies(dependencies);
  const deadline = createAbsoluteRequestDeadline(
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    "Interface bearer resource",
  );
  const target = await resolvePinnedPublicTarget(
    url.hostname,
    transport.resolver ?? resolveAllDnsAddresses,
    "Interface bearer resource",
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    deadline,
  );
  try {
    const result = await fetchPublicCheckAttempt(
      url,
      interfacePublicEndpointCheck(url),
      target,
      transport.connector ?? connectPinnedHttps,
      PUBLIC_URL_REQUEST_TIMEOUT_MS,
      {
        accept: "application/json",
        "cache-control": "no-store",
        authorization: `Bearer ${bearer}`,
      },
      "GET",
      undefined,
      deadline,
    );
    if (result.response.status >= 300 && result.response.status < 400) {
      throw new InterfaceBearerRedirectError();
    }
    return result;
  } catch (error) {
    if (
      error instanceof PublicUrlNonPublicAddressError ||
      error instanceof PublicUrlDnsResolutionError ||
      error instanceof PublicUrlCheckTimeoutError ||
      error instanceof PublicUrlResponseTooLargeError ||
      error instanceof InterfaceBearerRedirectError
    ) {
      throw error;
    }
    throw new Error("Interface bearer resource request failed");
  }
}

async function resolveAllDnsAddresses(
  hostname: string,
): Promise<readonly ResolvedDnsAddress[]> {
  const answers = await lookupDns(hostname, { all: true, verbatim: true });
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new Error("DNS returned an unsupported address family");
    }
    return { address: answer.address, family: answer.family };
  });
}

async function resolvePinnedPublicTarget(
  hostname: string,
  resolver: (hostname: string) => Promise<readonly ResolvedDnsAddress[]>,
  label: string,
  timeoutMs = PUBLIC_URL_REQUEST_TIMEOUT_MS,
  deadline = createAbsoluteRequestDeadline(timeoutMs, `${label} DNS`),
): Promise<ResolvedDnsAddress> {
  const authorityScope =
    controlPlaneTransportContext.getStore()?.authorityScope;
  const authorityKey = `https://${hostname.toLowerCase().replace(/\.$/u, "")}`;
  let target = authorityScope?.targets.get(authorityKey);
  if (!target) {
    target = resolvePinnedPublicTargetUncached(hostname, resolver, label);
    target.catch(() => undefined);
    authorityScope?.targets.set(authorityKey, target);
  }
  return await waitWithinDeadline(
    target,
    deadline,
    () => new PublicUrlDnsResolutionError(label),
  );
}

async function resolvePinnedPublicTargetUncached(
  hostname: string,
  resolver: (hostname: string) => Promise<readonly ResolvedDnsAddress[]>,
  label: string,
): Promise<ResolvedDnsAddress> {
  let answers: readonly ResolvedDnsAddress[];
  const resolution = Promise.resolve().then(() => resolver(hostname));
  resolution.catch(() => undefined);
  try {
    answers = await resolution;
  } catch (error) {
    if (error instanceof PublicUrlNonPublicAddressError) throw error;
    throw new PublicUrlDnsResolutionError(label);
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new PublicUrlDnsResolutionError(label);
  }
  const unique = new Map<string, ResolvedDnsAddress>();
  for (const answer of answers) {
    if (
      !answer ||
      typeof answer.address !== "string" ||
      (answer.family !== 4 && answer.family !== 6) ||
      isIP(answer.address) !== answer.family ||
      !isGloballyRoutableIp(answer.address)
    ) {
      throw new PublicUrlNonPublicAddressError(label);
    }
    const bytes = ipAddressBytes(answer.address);
    if (!bytes) {
      throw new PublicUrlNonPublicAddressError(label);
    }
    const key = `${answer.family}:${bytesToHex(bytes)}`;
    if (!unique.has(key)) {
      unique.set(key, {
        address: answer.address.toLowerCase(),
        family: answer.family,
      });
    }
  }
  // Fail closed if any answer is unsafe, then select one target: the
  // bytewise-lowest IPv4 answer (or IPv6 when no IPv4 answer exists). Retries
  // reuse that target; there is no address failover or second DNS lookup for
  // this authority anywhere in the owning smoke lifecycle.
  return [...unique.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0]![1];
}

function isGloballyRoutableIp(address: string): boolean {
  const bytes = ipAddressBytes(address);
  if (!bytes) return false;
  if (bytes.length === 4) return isGloballyRoutableIpv4(bytes);
  return isGloballyRoutableIpv6(bytes);
}

function isGloballyRoutableIpv4(bytes: Uint8Array): boolean {
  const [first, second, third, fourth] = bytes;
  if (first === 0 || first === 10 || first === 127) return false;
  if (first === 100 && second! >= 64 && second! <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second! >= 16 && second! <= 31) return false;
  if (first === 192 && second === 0 && third === 0) {
    return fourth === 9 || fourth === 10;
  }
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return first! < 224;
}

function isGloballyRoutableIpv6(bytes: Uint8Array): boolean {
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return false;
  }
  const first = (bytes[0]! << 8) | bytes[1]!;
  const second = (bytes[2]! << 8) | bytes[3]!;
  if (first === 0x2001) {
    return (
      (second >= 0x0200 && second <= 0x0fff && second !== 0x0db8) ||
      (second >= 0x1200 && second <= 0x3fff) ||
      (second >= 0x4000 && second <= 0x4dff) ||
      (second >= 0x5000 && second <= 0x5fff) ||
      (second >= 0x8000 && second <= 0xbfff)
    );
  }
  if (first === 0x2003) return (second & 0xc000) === 0;
  if ((first & 0xfff0) === 0x2400) return true;
  if ((first & 0xfff0) === 0x2600) return true;
  if (first === 0x2610) return (second & 0xfe00) === 0;
  if (first === 0x2620) return (second & 0xfe00) === 0;
  if ((first & 0xfff0) === 0x2630) return true;
  if ((first & 0xfff0) === 0x2800) return true;
  if ((first & 0xffe0) === 0x2a00) return true;
  return (first & 0xfff0) === 0x2c00;
}

function ipAddressBytes(address: string): Uint8Array | undefined {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    return parts.length === 4 ? Uint8Array.from(parts) : undefined;
  }
  if (family !== 6 || address.includes("%")) return undefined;
  let value = address.toLowerCase();
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail) {
    const ipv4 = ipAddressBytes(ipv4Tail);
    if (!ipv4 || ipv4.length !== 4) return undefined;
    value = `${value.slice(0, -ipv4Tail.length)}${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined;
  }
  const bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function connectPinnedHttps(request: PinnedHttpsRequest): Promise<Response> {
  return await new Promise<Response>((resolveResponse, rejectResponse) => {
    try {
      const clientRequest = requestHttps(
        {
          protocol: "https:",
          hostname: request.address,
          family: request.family,
          port: 443,
          method: request.method,
          path: request.path,
          servername: request.servername,
          rejectUnauthorized: true,
          agent: false,
          headers: request.headers,
          signal: request.signal,
        },
        (incoming) => {
          const status = incoming.statusCode;
          if (!status || status < 200 || status > 599) {
            incoming.destroy();
            rejectResponse(new Error("pinned HTTPS response status was invalid"));
            return;
          }
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          const body = status === 204 || status === 205 || status === 304
            ? null
            : Readable.toWeb(incoming) as unknown as BodyInit;
          if (body === null) incoming.destroy();
          resolveResponse(new Response(body, {
            status,
            statusText: incoming.statusMessage,
            headers,
          }));
        },
      );
      clientRequest.once("error", rejectResponse);
      clientRequest.end(request.body);
    } catch (error) {
      rejectResponse(error);
    }
  });
}

async function readBoundedPublicResponse(
  response: Response,
  check: PublicUrlCheck,
  signal?: AbortSignal,
  deadline?: AbsoluteRequestDeadline,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > MAX_PUBLIC_URL_RESPONSE_BYTES) {
      await cancelPublicResponseBody(response, deadline);
      throw new PublicUrlResponseTooLargeError(check.name);
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PUBLIC_URL_RESPONSE_BYTES) {
      throw new PublicUrlResponseTooLargeError(check.name);
    }
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelOnAbort = (): void => {
    void cancelPublicReader(reader, deadline).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array
        ? next.value
        : new Uint8Array(next.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_PUBLIC_URL_RESPONSE_BYTES) {
        await cancelPublicReader(reader, deadline);
        throw new PublicUrlResponseTooLargeError(check.name);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await cancelPublicReader(reader, deadline);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may retain its lock until its best-effort cancel settles.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function cancelPublicReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline?: AbsoluteRequestDeadline,
): Promise<void> {
  let cancellation: Promise<unknown>;
  try {
    cancellation = Promise.resolve().then(() => reader.cancel());
  } catch {
    return;
  }
  cancellation.catch(() => undefined);
  await waitForBoundedCancellation(cancellation, deadline);
}

async function cancelPublicResponseBody(
  response: Response | undefined,
  deadline?: AbsoluteRequestDeadline,
): Promise<void> {
  if (!response?.body) return;
  let cancellation: Promise<unknown>;
  try {
    cancellation = Promise.resolve().then(() => response.body!.cancel());
  } catch {
    return;
  }
  cancellation.catch(() => undefined);
  await waitForBoundedCancellation(cancellation, deadline);
}

async function waitForBoundedCancellation(
  cancellation: Promise<unknown>,
  deadline?: AbsoluteRequestDeadline,
): Promise<void> {
  const available = deadline
    ? remainingDeadlineMs(deadline)
    : RESPONSE_BODY_CANCEL_TIMEOUT_MS;
  const waitMs = Math.min(RESPONSE_BODY_CANCEL_TIMEOUT_MS, available);
  if (waitMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function publicCheckUrl(rawUrl: string, check: PublicUrlCheck): string {
  const url = strictPublicUrl(rawUrl, `public URL check ${check.name} URL output`);
  if (url.pathname !== "/") {
    throw new Error(
      `public URL check ${check.name} URL output must be an HTTPS origin without a path`,
    );
  }
  url.pathname = publicCheckPath(check);
  return url.toString();
}

function validatePublicCheckRequestUrl(urlValue: string, check: PublicUrlCheck): string {
  const url = strictPublicUrl(urlValue, `public URL check ${check.name} request`);
  if (url.pathname !== publicCheckPath(check)) {
    throw new Error(`public URL check ${check.name} request path is invalid`);
  }
  return url.toString();
}

function strictPublicUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    hasExplicitUrlPort(value) ||
    /[?#]/u.test(value) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be an absolute HTTPS URL without credentials, port, query, or fragment`,
    );
  }
  assertPublicHostname(url.hostname, label);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return url;
}

function publicCheckPath(check: PublicUrlCheck): string {
  if (
    !check.path.startsWith("/") ||
    check.path.startsWith("//") ||
    /[?#\0\r\n]/u.test(check.path)
  ) {
    throw new Error(`public URL check ${check.name} path is invalid`);
  }
  return check.path;
}

function hasExplicitUrlPort(value: string): boolean {
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#\\]*)/u)?.[1];
  if (!authority) return false;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) return hostPort.includes("]:");
  return hostPort.includes(":");
}

function assertPublicHostname(hostname: string, label: string): void {
  const host = hostname
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
  const reservedSuffixes = [
    "alt",
    "corp",
    "example",
    "home",
    "home.arpa",
    "internal",
    "invalid",
    "lan",
    "local",
    "localhost",
    "onion",
    "test",
  ];
  const reservedDomains = ["example.com", "example.net", "example.org"];
  const labels = host.split(".");
  if (
    !host ||
    host.length > 253 ||
    labels.length < 2 ||
    labels.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) ||
    isIP(host) !== 0 ||
    reservedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
    reservedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  ) {
    throw new Error(`${label} must identify a public non-reserved HTTPS hostname`);
  }
}

async function assertStateVersionLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly applyRunId: string;
  },
): Promise<StateVersionLedgerVerificationResult> {
  const result = await readStateVersionAndOutputLedger(options, input);
  const missingRequiredOutputs = Object.entries(options.outputAllowlist)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .filter((name) => !result.publicOutputNames.includes(name));
  if (missingRequiredOutputs.length > 0) {
    throw new Error(
      `Output publicOutputs did not include required output(s): ${missingRequiredOutputs.join(
        ", ",
      )}`,
    );
  }
  return result;
}

async function readStateVersionAndOutputLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly applyRunId: string;
  },
): Promise<StateVersionLedgerVerificationResult> {
  const capsuleResponse = await requestJson<CapsuleLedgerResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(input.capsuleId)}`,
  });
  const capsule = capsuleFromLedgerResponse(capsuleResponse);
  if (capsule.id !== input.capsuleId) {
    throw new Error("capsule ledger returned an unexpected capsule id");
  }
  if (capsuleWorkspaceId(capsule) !== input.workspaceId) {
    throw new Error("capsule ledger returned an unexpected Workspace id");
  }
  if (capsule.status !== "active") {
    throw new Error(
      `capsule ledger status was ${capsule.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(capsule.currentStateGeneration) ||
    Number(capsule.currentStateGeneration) < 1
  ) {
    throw new Error("capsule ledger did not advance state generation");
  }
  const currentStateVersionId = capsuleCurrentStateVersionId(capsule);
  if (!currentStateVersionId) {
    throw new Error("capsule ledger did not expose currentStateVersionId");
  }
  const currentStateGeneration = Number(capsule.currentStateGeneration);

  const stateVersionsResponse = await requestJson<{
    readonly stateVersions?: readonly StateVersionRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      input.capsuleId,
    )}/state-versions`,
  });
  const stateVersion = (stateVersionsResponse.stateVersions ?? []).find(
    (item) => item.id === currentStateVersionId,
  );
  if (!stateVersion) {
    throw new Error(
      "StateVersion ledger did not include currentStateVersionId",
    );
  }
  if (stateVersion.workspaceId !== input.workspaceId) {
    throw new Error("StateVersion ledger returned an unexpected Workspace id");
  }
  if (stateVersion.capsuleId !== input.capsuleId) {
    throw new Error("StateVersion ledger returned an unexpected Capsule id");
  }
  if (stateVersion.environment !== options.environment) {
    throw new Error(
      `StateVersion environment was ${stateVersion.environment}; expected ${options.environment}`,
    );
  }
  if (stateVersion.createdByRunId !== input.applyRunId) {
    throw new Error(
      "StateVersion ledger returned an unexpected createdByRunId",
    );
  }
  if (
    !Number.isInteger(stateVersion.generation) ||
    stateVersion.generation !== currentStateGeneration
  ) {
    throw new Error("StateVersion generation did not match Capsule");
  }

  const outputResponse = await requestJson<{
    readonly output?: OutputRecord | null;
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(input.capsuleId)}/outputs`,
  });
  const output = outputResponse.output;
  if (!output) {
    throw new Error("Output ledger did not expose the Capsule current Output");
  }
  if (output.workspaceId !== input.workspaceId) {
    throw new Error("Output ledger returned an unexpected Workspace id");
  }
  if (output.capsuleId !== input.capsuleId) {
    throw new Error("Output ledger returned an unexpected Capsule id");
  }
  if (
    typeof output.id !== "string" ||
    output.id.trim() === "" ||
    typeof output.outputDigest !== "string" ||
    output.outputDigest.trim() === ""
  ) {
    throw new Error("Output ledger did not expose a stable id and digest");
  }
  if (output.stateGeneration !== stateVersion.generation) {
    throw new Error(
      "Output stateGeneration did not match StateVersion generation",
    );
  }
  if (!isRecord(output.publicOutputs)) {
    throw new Error("Output ledger did not expose publicOutputs");
  }
  const publicOutputs = output.publicOutputs;
  const publicOutputNames = Object.keys(publicOutputs).sort();
  return {
    capsuleStatus: capsule.status,
    stateVersionId: stateVersion.id,
    generation: stateVersion.generation,
    applyRunId: input.applyRunId,
    outputId: output.id,
    outputDigest: output.outputDigest,
    publicOutputNames,
    publicOutputDigest: digestJson(publicOutputs),
    publicOutputs,
  };
}

export interface InterfaceMaterializationRecord {
  readonly blueprint: CapsuleInterfaceBlueprint;
  readonly interface: Interface;
  readonly bindings: readonly InterfaceBinding[];
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly outputId?: string;
  readonly outputGeneration: number;
  readonly outputDigest: string;
  readonly endpointUrl?: string;
  readonly endpointUse?: "passed" | "skipped";
  readonly issuedToken?: {
    readonly token: string;
    readonly resource: string;
    readonly permission: string;
    readonly expiresIn: number;
  };
  readonly retiredPhase?: string;
  readonly revokedBindingPhase?: string;
  readonly tokenRevoked?: boolean;
  readonly tokenUseDenied?: boolean;
  readonly endpointRetired?: boolean;
}

export interface InterfaceMaterializationContext {
  readonly records: readonly InterfaceMaterializationRecord[];
}

/**
 * Reads the public Interface API until every Plan-pinned blueprint is
 * materialized.  Only ids, generations, digests, and contract metadata are
 * retained in the returned evidence; resolved output values and credentials
 * never leave this function.
 */
export async function assertInterfaceMaterialization(
  options: PlatformControlPlaneSmokeOptions,
  input: Parameters<typeof assertInterfaceMaterializationInternal>[1],
  publicProbeDependencies: SmokeHttpsDependencies = {},
): Promise<InterfaceMaterializationContext> {
  const transport = controlPlaneDependencies(publicProbeDependencies);
  const result = await controlPlaneTransportContext.run(
    transport,
    async () =>
      await assertInterfaceMaterializationInternal(
        options,
        input,
        publicProbeDependencies,
      ),
  );
  Object.defineProperty(result, interfaceTransportScope, {
    configurable: false,
    enumerable: false,
    value: transport.authorityScope,
    writable: false,
  });
  return result;
}

async function assertInterfaceMaterializationInternal(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly stateVersionLedger: StateVersionLedgerVerificationResult;
  },
  publicProbeDependencies: SmokeHttpsDependencies,
): Promise<InterfaceMaterializationContext> {
  const blueprints = options.interfaceBlueprints ?? [];
  if (blueprints.length === 0) {
    throw new Error("Interface materialization proof requested without blueprints");
  }
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  let lastMissing = blueprints.map((blueprint) => blueprint.key);
  while (Date.now() <= deadline) {
    const listed = await listCapsuleInterfaces(options, input);
    const records: InterfaceMaterializationRecord[] = [];
    const missing: string[] = [];
    for (const blueprint of blueprints) {
      const listedInterface = listed.find((candidate) =>
        interfaceMatchesBlueprint(candidate, blueprint, input.capsuleId),
      );
      if (!listedInterface) {
        missing.push(blueprint.key);
        continue;
      }
      const iface = await readInterface(options, listedInterface.metadata.id);
      if (!interfaceMatchesBlueprint(iface, blueprint, input.capsuleId)) {
        throw new Error(
          `Interface ${listedInterface.metadata.id} did not retain the Plan-pinned ${blueprint.key} declaration`,
        );
      }
      if (iface.metadata.workspaceId !== input.workspaceId) {
        throw new Error(
          `Interface ${iface.metadata.id} was returned from an unexpected Workspace`,
        );
      }
      if (iface.status.phase !== "Resolved") {
        missing.push(blueprint.key);
        continue;
      }
      assertInterfaceGeneration(
        iface,
        blueprint,
        input.stateVersionLedger,
      );
      assertInterfaceInputs(iface, blueprint, input.stateVersionLedger);
      const bindings = await listInterfaceBindings(options, iface.metadata.id);
      assertInterfaceBindings(iface, blueprint, bindings);
      const endpointUrl = interfaceEndpointUrl(iface);
      records.push({
        blueprint,
        interface: iface,
        bindings,
        stateVersionId: input.stateVersionLedger.stateVersionId,
        stateGeneration: input.stateVersionLedger.generation,
        ...(input.stateVersionLedger.outputId
          ? { outputId: input.stateVersionLedger.outputId }
          : {}),
        outputGeneration: input.stateVersionLedger.generation,
        outputDigest:
          input.stateVersionLedger.outputDigest ??
          input.stateVersionLedger.publicOutputDigest,
        ...(endpointUrl ? { endpointUrl } : {}),
      });
    }
    if (missing.length === 0 && records.length === blueprints.length) {
      const verifiedRecords: InterfaceMaterializationRecord[] = [];
      for (const record of records) {
        const noneBinding = record.bindings.find(
          (binding) =>
            binding.spec.delivery.type === "none" &&
            binding.status.phase !== "Revoked",
        );
        const endpointUse = noneBinding && record.endpointUrl
          ? await assertInterfaceEndpointUse(
              record.endpointUrl,
              publicProbeDependencies,
            )
          : "skipped" as const;
        const issuedToken =
          options.interfaceTokenProofRequested === true
            ? await issueInterfaceTokenProof(
                options,
                record.interface,
                record.bindings,
                publicProbeDependencies,
              )
            : undefined;
        verifiedRecords.push({
          ...record,
          ...(endpointUse ? { endpointUse } : {}),
          ...(issuedToken ? { issuedToken } : {}),
        });
      }
      return { records: verifiedRecords };
    }
    lastMissing = missing;
    await sleep(options.pollIntervalMs);
  }
  throw new Error(
    `Capsule ${input.capsuleId} did not materialize Interface blueprint(s): ${lastMissing.join(", ")}`,
  );
}

async function listCapsuleInterfaces(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly includeRetired?: boolean;
  },
): Promise<readonly Interface[]> {
  const response = await requestJson<{ readonly interfaces?: readonly Interface[] }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path:
      `${API_PREFIX}/interfaces?workspaceId=${encodeURIComponent(input.workspaceId)}` +
      `&ownerKind=Capsule&ownerId=${encodeURIComponent(input.capsuleId)}` +
      `&includeRetired=${input.includeRetired === true ? "true" : "false"}`,
  });
  return (response.interfaces ?? []).filter((candidate) =>
    candidate?.metadata?.ownerRef?.id === input.capsuleId,
  );
}

async function readInterface(
  options: PlatformControlPlaneSmokeOptions,
  interfaceId: string,
): Promise<Interface> {
  return await requestJson<Interface>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/interfaces/${encodeURIComponent(interfaceId)}`,
  });
}

async function listInterfaceBindings(
  options: PlatformControlPlaneSmokeOptions,
  interfaceId: string,
): Promise<readonly InterfaceBinding[]> {
  const response = await requestJson<{
    readonly bindings?: readonly InterfaceBinding[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/interfaces/${encodeURIComponent(interfaceId)}/bindings`,
  });
  return response.bindings ?? [];
}

function interfaceMatchesBlueprint(
  iface: Interface,
  blueprint: CapsuleInterfaceBlueprint,
  capsuleId: string,
): boolean {
  const metadata = iface?.metadata;
  const source = metadata?.materializedFrom;
  return (
    metadata?.ownerRef?.kind === "Capsule" &&
    metadata.ownerRef.id === capsuleId &&
    metadata.name === blueprint.name &&
    source?.source === "capsule_blueprint" &&
    source.key === blueprint.key &&
    iface.spec.type === blueprint.spec.type &&
    iface.spec.version === blueprint.spec.version
  );
}

function assertInterfaceGeneration(
  iface: Interface,
  blueprint: CapsuleInterfaceBlueprint,
  ledger: StateVersionLedgerVerificationResult,
): void {
  if (!Number.isSafeInteger(iface.metadata.generation) || iface.metadata.generation < 1) {
    throw new Error(`Interface ${iface.metadata.id} has an invalid generation`);
  }
  if (iface.status.observedGeneration !== iface.metadata.generation) {
    throw new Error(`Interface ${iface.metadata.id} observedGeneration is stale`);
  }
  if (!Number.isSafeInteger(iface.status.resolvedRevision) || iface.status.resolvedRevision < 1) {
    throw new Error(`Interface ${iface.metadata.id} has no resolved revision`);
  }
  const provenance = Object.values(iface.status.provenance ?? {});
  const expectedCapsuleOutputInputs = Object.entries(
    blueprint.spec.inputs ?? {},
  ).filter(([, input]) => input.source === "capsule_output");
  if (
    expectedCapsuleOutputInputs.length > 0 &&
    provenance.filter((entry) => entry.source === "capsule_output").length === 0
  ) {
    throw new Error(
      `Interface ${iface.metadata.id} did not expose capsule-output provenance for the Plan-pinned Output`,
    );
  }
  for (const entry of provenance) {
    if (entry.source !== "capsule_output") continue;
    if (
      entry.stateVersionId !== ledger.stateVersionId ||
      entry.outputId !== ledger.outputId ||
      entry.outputDigest !== ledger.outputDigest ||
      entry.runId !== ledger.applyRunId
    ) {
      throw new Error(`Interface ${iface.metadata.id} provenance is not pinned to the current StateVersion`);
    }
  }
  for (const [name, input] of expectedCapsuleOutputInputs) {
    const entry = iface.status.provenance?.[name];
    if (!entry || entry.source !== "capsule_output") {
      throw new Error(
        `Interface ${iface.metadata.id} input ${name} did not retain capsule-output provenance`,
      );
    }
  }
}

function assertInterfaceInputs(
  iface: Interface,
  blueprint: CapsuleInterfaceBlueprint,
  ledger: StateVersionLedgerVerificationResult,
): void {
  for (const [name, declaration] of Object.entries(blueprint.spec.inputs ?? {})) {
    if (declaration.source === "literal") {
      if (stableJson(iface.status.resolvedInputs?.[name]) !== stableJson(declaration.value)) {
        throw new Error(`Interface ${iface.metadata.id} literal input ${name} was not retained`);
      }
      continue;
    }
    const rawOutput = ledger.publicOutputs?.[declaration.outputName];
    if (
      ledger.publicOutputs === undefined ||
      !Object.prototype.hasOwnProperty.call(
        ledger.publicOutputs,
        declaration.outputName,
      )
    ) {
      throw new Error(
        `Interface ${iface.metadata.id} input ${name} referenced missing Output ${declaration.outputName}`,
      );
    }
    const expected = declaration.pointer
      ? resolveSmokeJsonPointer(rawOutput, declaration.pointer)
      : rawOutput;
    if (stableJson(iface.status.resolvedInputs?.[name]) !== stableJson(expected)) {
      throw new Error(`Interface ${iface.metadata.id} input ${name} did not resolve from the current Output`);
    }
    const provenance = iface.status.provenance?.[name];
    if (!provenance || provenance.source !== "capsule_output") {
      throw new Error(`Interface ${iface.metadata.id} input ${name} has no capsule-output provenance`);
    }
    if (provenance.outputName !== declaration.outputName) {
      throw new Error(`Interface ${iface.metadata.id} input ${name} provenance output mismatch`);
    }
    if (provenance.pointer !== declaration.pointer) {
      throw new Error(
        `Interface ${iface.metadata.id} input ${name} provenance pointer mismatch`,
      );
    }
  }
  const resourceInput = iface.spec.access.resourceUriInput;
  if (resourceInput !== undefined) {
    const expectedResource = iface.status.resolvedInputs?.[resourceInput];
    const canonicalExpected =
      typeof expectedResource === "string"
        ? new URL(expectedResource).href
        : undefined;
    if (iface.status.resourceUri !== canonicalExpected) {
      throw new Error(`Interface ${iface.metadata.id} resourceUri did not match its resolved endpoint input`);
    }
  }
}

function resolveSmokeJsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    throw new Error(`Interface capsule-output pointer ${pointer} must start with /`);
  }
  let current: unknown = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^\d+$/u.test(key)) {
      current = current[Number(key)];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function assertInterfaceBindings(
  iface: Interface,
  blueprint: CapsuleInterfaceBlueprint,
  bindings: readonly InterfaceBinding[],
): void {
  for (const proposal of blueprint.bindings ?? []) {
    const binding = bindings.find(
      (candidate) =>
        candidate.metadata.materializedFrom?.source === "capsule_blueprint" &&
        candidate.metadata.materializedFrom.interfaceKey === blueprint.key &&
        candidate.metadata.materializedFrom.key === proposal.key,
    );
    if (!binding) {
      throw new Error(`Interface ${iface.metadata.id} did not materialize binding ${proposal.key}`);
    }
    if (binding.spec.interfaceId !== iface.metadata.id) {
      throw new Error(`InterfaceBinding ${binding.metadata.id} points at a different Interface`);
    }
    if (binding.metadata.workspaceId !== iface.metadata.workspaceId) {
      throw new Error(
        `InterfaceBinding ${binding.metadata.id} belongs to a different Workspace`,
      );
    }
    if (binding.status.phase !== "Ready") {
      throw new Error(
        `InterfaceBinding ${binding.metadata.id} was not Ready before destroy`,
      );
    }
    if (
      binding.status.observedInterfaceRevision !==
      iface.status.resolvedRevision
    ) {
      throw new Error(
        `InterfaceBinding ${binding.metadata.id} observed a stale Interface revision`,
      );
    }
    if (binding.spec.permissions.slice().sort().join(" ") !== proposal.permissions.slice().sort().join(" ")) {
      throw new Error(`InterfaceBinding ${binding.metadata.id} permissions did not match the blueprint`);
    }
    if (binding.spec.delivery.type !== proposal.delivery.type) {
      throw new Error(`InterfaceBinding ${binding.metadata.id} delivery did not match the blueprint`);
    }
    if (binding.spec.subjectRef.kind !== "Principal" || !binding.spec.subjectRef.id) {
      throw new Error(`InterfaceBinding ${binding.metadata.id} did not resolve an exact Principal subject`);
    }
  }
}

function interfaceEndpointUrl(iface: Interface): string | undefined {
  const resource = iface.status.resourceUri;
  if (typeof resource !== "string" || resource.trim() === "") return undefined;
  try {
    const parsed = new URL(resource);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

async function assertInterfaceEndpointUse(
  urlValue: string,
  dependencies: Pick<PublicUrlFetchDependencies, "resolver" | "connector">,
): Promise<"passed"> {
  const url = strictPublicUrl(urlValue, "Interface public endpoint");
  const transport = publicTransportDependencies(dependencies);
  const check = interfacePublicEndpointCheck(url);
  const deadline = createAbsoluteRequestDeadline(
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    "Interface public endpoint",
  );
  const target = await resolvePinnedPublicTarget(
    url.hostname,
    transport.resolver ?? resolveAllDnsAddresses,
    "Interface public endpoint",
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    deadline,
  );
  let response: Response;
  let body: string;
  try {
    ({ response, body } = await fetchPublicCheckAttempt(
      url,
      check,
      target,
      transport.connector ?? connectPinnedHttps,
      PUBLIC_URL_REQUEST_TIMEOUT_MS,
      undefined,
      "GET",
      undefined,
      deadline,
    ));
  } catch (error) {
    if (
      error instanceof PublicUrlNonPublicAddressError ||
      error instanceof PublicUrlDnsResolutionError ||
      error instanceof PublicUrlCheckTimeoutError ||
      error instanceof PublicUrlResponseTooLargeError
    ) {
      throw error;
    }
    throw new Error("Interface public endpoint request failed");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Interface public endpoint rejected a redirect response");
  }
  if (!response.ok) {
    throw new Error(`Interface public endpoint returned HTTP ${response.status}: ${redactResponseSnippet(body)}`);
  }
  return "passed";
}

function interfacePublicEndpointCheck(url: URL): PublicUrlCheck {
  return {
    name: "interface-public-endpoint",
    output: "interface_resource",
    path: `${url.pathname}${url.search}`,
    expectedStatus: 200,
    bodyIncludes: [],
    destroyExpectation: { kind: "http-404" },
  };
}

async function issueInterfaceTokenProof(
  options: PlatformControlPlaneSmokeOptions,
  iface: Interface,
  bindings: readonly InterfaceBinding[],
  publicProbeDependencies: Pick<
    PublicUrlFetchDependencies,
    "resolver" | "connector"
  >,
): Promise<NonNullable<InterfaceMaterializationRecord["issuedToken"]>> {
  const runtimeToken = options.interfaceRuntimeToken;
  if (!runtimeToken) {
    throw new Error("Interface token proof was requested but no runtime token was loaded");
  }
  const binding = bindings.find(
    (candidate) =>
      candidate.spec.delivery.type === "oauth2" &&
      candidate.status.phase !== "Revoked",
  );
  if (!binding) {
    throw new Error(`Interface ${iface.metadata.id} has no usable oauth2 binding for token proof`);
  }
  const permission = binding.spec.permissions[0];
  if (!permission) throw new Error(`InterfaceBinding ${binding.metadata.id} has no permission`);
  // `options.url` is the operator-selected Takosumi control-plane authority.
  // Keep that authenticated transport distinct from the output-derived
  // Interface resource, which must pass DNS validation and address pinning.
  const issued = await requestJson<{
    readonly access_token?: unknown;
    readonly token_type?: unknown;
    readonly expires_in?: unknown;
    readonly resource?: unknown;
  }>({
    baseUrl: options.url,
    token: runtimeToken,
    method: "POST",
    path: `${API_PREFIX}/interfaces/${encodeURIComponent(iface.metadata.id)}/token`,
    body: { permission },
  });
  if (
    typeof issued.access_token !== "string" ||
    issued.access_token.length === 0 ||
    new TextEncoder().encode(issued.access_token).byteLength >
      MAX_SMOKE_INTERFACE_TOKEN_BYTES ||
    /[\0\r\n]/u.test(issued.access_token) ||
    issued.access_token === runtimeToken ||
    issued.token_type !== "Bearer" ||
    typeof issued.expires_in !== "number" ||
    !Number.isSafeInteger(issued.expires_in) ||
    issued.expires_in < 1 ||
    issued.expires_in > 60 ||
    typeof issued.resource !== "string" ||
    issued.resource.length === 0
  ) {
    throw new Error("Interface token endpoint returned an invalid short-lived grant");
  }
  const resource = safeInterfaceResource(issued.resource);
  const canonicalResource = interfaceEndpointUrl(iface);
  if (!canonicalResource || resource !== canonicalResource) {
    throw new Error(
      `Interface token endpoint resource did not match the canonical Interface resource for ${iface.metadata.id}`,
    );
  }
  const { response, body: responseBody } =
    await fetchPinnedInterfaceBearerResource(
      resource,
      issued.access_token,
      publicProbeDependencies,
    );
  if (!response.ok) {
    throw new Error(`Interface token could not use ${resource} (HTTP ${response.status}): ${redactResponseSnippet(responseBody, [issued.access_token])}`);
  }
  return {
    token: issued.access_token,
    resource,
    permission,
    expiresIn: issued.expires_in,
  };
}

export function interfaceMaterializationEvidence(
  record: InterfaceMaterializationRecord,
): InterfaceMaterializationVerificationResult {
  const binding = record.bindings.find(
    (candidate) =>
      candidate.metadata.materializedFrom?.source === "capsule_blueprint" &&
      candidate.metadata.materializedFrom.interfaceKey === record.blueprint.key,
  );
  const tokenProof = record.issuedToken
    ? {
        status: "passed" as const,
        permission: record.issuedToken.permission,
        resourceDigest: sha256(record.issuedToken.resource),
        tokenDigest: sha256(record.issuedToken.token),
        expiresIn: record.issuedToken.expiresIn,
        ...(record.tokenRevoked !== undefined
          ? { postDestroyTokenDenied: record.tokenRevoked }
          : {}),
        ...(record.tokenUseDenied !== undefined
          ? { postDestroyUseDenied: record.tokenUseDenied }
          : {}),
      }
    : undefined;
  return {
    interfaceId: record.interface.metadata.id,
    interfaceName: record.interface.metadata.name,
    interfaceKey: record.blueprint.key,
    interfaceType: record.interface.spec.type,
    interfaceVersion: record.interface.spec.version,
    interfacePhase: record.interface.status.phase,
    interfaceGeneration: record.interface.metadata.generation,
    resolvedRevision: record.interface.status.resolvedRevision,
    stateVersionId: record.stateVersionId,
    stateGeneration: record.stateGeneration,
    ...(record.outputId ? { outputId: record.outputId } : {}),
    outputGeneration: record.outputGeneration,
    outputDigest: record.outputDigest,
    ...(binding
      ? {
          bindingId: binding.metadata.id,
          bindingPhase: binding.status.phase,
          bindingGeneration: binding.metadata.generation,
          bindingPermission: binding.spec.permissions[0],
          bindingDelivery: binding.spec.delivery.type,
        }
      : {}),
    ...(record.endpointUse ? { endpointUse: record.endpointUse } : {}),
    ...(tokenProof ? { tokenProof } : {}),
    ...(record.retiredPhase ? { retiredPhase: record.retiredPhase } : {}),
    ...(record.revokedBindingPhase
      ? { revokedBindingPhase: record.revokedBindingPhase }
      : {}),
    ...(record.tokenRevoked !== undefined
      ? { tokenRevoked: record.tokenRevoked }
      : {}),
    ...(record.endpointRetired !== undefined
      ? { endpointRetired: record.endpointRetired }
      : {}),
  };
}

export async function assertInterfacesRetired(
  options: PlatformControlPlaneSmokeOptions,
  context: InterfaceMaterializationContext,
  publicProbeDependencies: SmokeHttpsDependencies = {},
): Promise<InterfaceMaterializationContext> {
  const retainedAuthorityScope = (
    context as InterfaceMaterializationContext & {
      readonly [interfaceTransportScope]?: PinnedAuthorityScope;
    }
  )[interfaceTransportScope];
  const transport = controlPlaneDependencies({
    ...publicProbeDependencies,
    authorityScope:
      retainedAuthorityScope ?? publicProbeDependencies.authorityScope,
  });
  return await controlPlaneTransportContext.run(
    transport,
    async () =>
      await assertInterfacesRetiredInternal(
        options,
        context,
        {
          ...publicProbeDependencies,
          // The materialization proof owns the public/control authority pins.
          // Retirement may not replace them with a fresh DNS scope.
          authorityScope: transport.authorityScope,
        },
      ),
  );
}

async function assertInterfacesRetiredInternal(
  options: PlatformControlPlaneSmokeOptions,
  context: InterfaceMaterializationContext,
  publicProbeDependencies: SmokeHttpsDependencies,
): Promise<InterfaceMaterializationContext> {
  const records: InterfaceMaterializationRecord[] = [];
  for (const record of context.records) {
    const retirementDeadline =
      Date.now() + options.deployTimeoutSeconds * 1000;
    let iface: Interface | undefined;
    let bindings: readonly InterfaceBinding[] | undefined;
    let lastPhase = "missing";
    while (Date.now() <= retirementDeadline) {
      const listedRetired = await listCapsuleInterfaces(options, {
        workspaceId: record.interface.metadata.workspaceId,
        capsuleId: record.interface.metadata.ownerRef.id,
        includeRetired: true,
      });
      if (
        !listedRetired.some(
          (candidate) =>
            candidate.metadata.id === record.interface.metadata.id,
        )
      ) {
        lastPhase = "missing-from-list";
        await sleep(options.pollIntervalMs);
        continue;
      }
      const candidate = await readInterface(
        options,
        record.interface.metadata.id,
      );
      if (
        candidate.metadata.workspaceId !==
          record.interface.metadata.workspaceId ||
        candidate.metadata.ownerRef.kind !== "Capsule" ||
        candidate.metadata.ownerRef.id !== record.interface.metadata.ownerRef.id
      ) {
        throw new Error(
          `Interface ${candidate.metadata.id} changed Workspace or Capsule ownership after destroy`,
        );
      }
      lastPhase = candidate.status.phase;
      if (candidate.status.phase !== "Retired") {
        await sleep(options.pollIntervalMs);
        continue;
      }
      const candidateBindings = await listInterfaceBindings(
        options,
        candidate.metadata.id,
      );
      const bindingsReady = (record.blueprint.bindings ?? []).every((proposal) =>
        candidateBindings.some(
          (binding) =>
            binding.metadata.materializedFrom?.source ===
              "capsule_blueprint" &&
            binding.metadata.materializedFrom.interfaceKey ===
              record.blueprint.key &&
            binding.metadata.materializedFrom.key === proposal.key &&
            binding.status.phase === "Revoked",
        ),
      );
      if (!bindingsReady) {
        lastPhase = "Retired/BindingsPending";
        await sleep(options.pollIntervalMs);
        continue;
      }
      iface = candidate;
      bindings = candidateBindings;
      break;
    }
    if (!iface || !bindings) {
      throw new Error(
        `Interface ${record.interface.metadata.id} did not prove Retired/Revoked after destroy (last phase ${lastPhase})`,
      );
    }
    for (const proposal of record.blueprint.bindings ?? []) {
      const binding = bindings.find(
        (candidate) =>
          candidate.metadata.materializedFrom?.source === "capsule_blueprint" &&
          candidate.metadata.materializedFrom.interfaceKey === record.blueprint.key &&
          candidate.metadata.materializedFrom.key === proposal.key,
      );
      if (!binding) {
        throw new Error(
          `Interface ${iface.metadata.id} did not retain binding ${proposal.key} after destroy`,
        );
      }
      if (binding.metadata.workspaceId !== iface.metadata.workspaceId) {
        throw new Error(
          `InterfaceBinding ${binding.metadata.id} changed Workspace ownership after destroy`,
        );
      }
      if (binding.status.phase !== "Revoked") {
        throw new Error(
          `InterfaceBinding ${binding.metadata.id} remained ${binding.status.phase} after destroy`,
        );
      }
      const fetched = await requestJson<InterfaceBinding>({
        baseUrl: options.url,
        token: options.accountSessionToken,
        path: `${API_PREFIX}/interfaces/${encodeURIComponent(
          iface.metadata.id,
        )}/bindings/${encodeURIComponent(binding.metadata.id)}`,
      });
      if (
        fetched.metadata.id !== binding.metadata.id ||
        fetched.metadata.workspaceId !== iface.metadata.workspaceId ||
        fetched.spec.interfaceId !== iface.metadata.id
      ) {
        throw new Error(
          `InterfaceBinding ${binding.metadata.id} GET changed its Interface or Workspace owner`,
        );
      }
      if (fetched.status.phase !== "Revoked") {
        throw new Error(
          `InterfaceBinding ${binding.metadata.id} GET did not prove Revoked`,
        );
      }
    }
    let endpointRetired: boolean | undefined;
    if (record.endpointUrl) {
      endpointRetired = await verifyInterfaceEndpointRetired(
        record.endpointUrl,
        publicProbeDependencies,
      );
    }
    let tokenRevoked: boolean | undefined;
    let tokenUseDenied: boolean | undefined;
    const tokenProof = record.issuedToken;
    if (tokenProof) {
      const runtimeToken = options.interfaceRuntimeToken;
      if (!runtimeToken) {
        throw new Error("Interface token was issued but runtime token is unavailable for revocation proof");
      }
      tokenRevoked = await assertInterfaceTokenDenied(options, iface.metadata.id, runtimeToken, tokenProof.permission);
      tokenUseDenied = await assertInterfaceUseDenied(
        tokenProof.resource,
        tokenProof.token,
        publicProbeDependencies,
      );
    }
    records.push({
      ...record,
      interface: iface,
      bindings,
      retiredPhase: iface.status.phase,
      ...(bindings.find((binding) => binding.status.phase === "Revoked")
        ? {
            revokedBindingPhase: "Revoked",
          }
        : {}),
      ...(endpointRetired !== undefined ? { endpointRetired } : {}),
      ...(tokenRevoked !== undefined ? { tokenRevoked } : {}),
      ...(tokenUseDenied !== undefined ? { tokenUseDenied } : {}),
      ...(tokenProof
        ? {
            issuedToken: tokenProof,
          }
        : {}),
    });
  }
  return { records };
}

export async function verifyInterfaceEndpointRetired(
  urlValue: string,
  dependencies: Pick<
    PublicUrlFetchDependencies,
    "resolver" | "connector" | "sleep" | "maxAttempts" | "requestTimeoutMs"
  >,
): Promise<boolean> {
  const url = strictPublicUrl(urlValue, "Interface public endpoint");
  await verifyPinnedPublicRetirement(
    url,
    interfacePublicEndpointCheck(url),
    "Interface public endpoint",
    dependencies,
    { maxAttempts: 4, deadlineMs: 120_000 },
  );
  return true;
}

async function verifyPinnedPublicRetirement(
  url: URL,
  check: PublicUrlCheck,
  label: string,
  dependencies: Pick<
    PublicUrlFetchDependencies,
    "resolver" | "connector" | "sleep" | "maxAttempts" | "requestTimeoutMs"
  >,
  defaults: {
    readonly maxAttempts: number;
    readonly deadlineMs: number;
  },
): Promise<404> {
  const transport = publicTransportDependencies(dependencies);
  const resolver = transport.resolver ?? resolveAllDnsAddresses;
  const connector = transport.connector ?? connectPinnedHttps;
  const sleepForRetry = transport.sleep ?? sleep;
  const maxAttempts = transport.maxAttempts ?? defaults.maxAttempts;
  const requestTimeoutMs = transport.requestTimeoutMs ?? defaults.deadlineMs;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${label} retirement max attempts must be a positive integer`);
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error(`${label} retirement timeout must be a positive integer`);
  }
  const deadline = createAbsoluteRequestDeadline(
    requestTimeoutMs,
    `${label} retirement`,
  );
  let target: ResolvedDnsAddress | undefined;
  let lastStatus: number | undefined;
  let lastFailure: "http" | "transport" = "transport";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      target ??= await resolvePinnedPublicTarget(
        url.hostname,
        resolver,
        label,
        requestTimeoutMs,
        deadline,
      );
      const { response } = await fetchPublicCheckAttempt(
        url,
        check,
        target,
        connector,
        requestTimeoutMs,
        undefined,
        "GET",
        undefined,
        deadline,
      );
      lastStatus = response.status;
      lastFailure = "http";
      if (response.status === 404) return 404;
    } catch (error) {
      if (error instanceof PublicUrlNonPublicAddressError) throw error;
      lastFailure = "transport";
      if (error instanceof PublicUrlDnsResolutionError) break;
    }
    if (attempt + 1 >= maxAttempts || remainingDeadlineMs(deadline) <= 0) break;
    const retrySleep = Promise.resolve().then(() =>
      sleepForRetry(Math.min(2_000, remainingDeadlineMs(deadline))),
    );
    retrySleep.catch(() => undefined);
    try {
      await waitWithinDeadline(
        retrySleep,
        deadline,
        () => new PublicUrlCheckTimeoutError(check.name),
      );
    } catch {
      lastFailure = "transport";
      break;
    }
  }
  if (lastFailure === "http" && lastStatus !== undefined) {
    throw new Error(
      `${label} did not return contract 404 after bounded retry (last HTTP ${lastStatus})`,
    );
  }
  throw new Error(`${label} retirement is inconclusive after bounded retry`);
}

async function assertInterfaceTokenDenied(
  options: PlatformControlPlaneSmokeOptions,
  interfaceId: string,
  runtimeToken: string,
  permission: string,
): Promise<boolean> {
  const { response } = await fetchPinnedControlPlaneRequest({
    baseUrl: options.url,
    token: runtimeToken,
    method: "POST",
    path: `${API_PREFIX}/interfaces/${encodeURIComponent(interfaceId)}/token`,
    body: { permission },
  });
  if (![401, 403, 404].includes(response.status)) {
    throw new Error(
      `retired Interface ${interfaceId} token endpoint returned HTTP ${response.status}`,
    );
  }
  return true;
}

async function assertInterfaceUseDenied(
  resource: string,
  token: string,
  publicProbeDependencies: Pick<
    PublicUrlFetchDependencies,
    "resolver" | "connector"
  >,
): Promise<boolean> {
  const { response } = await fetchPinnedInterfaceBearerResource(
    resource,
    token,
    publicProbeDependencies,
  );
  if (![401, 403, 404].includes(response.status)) {
    throw new InterfaceTokenUseStillAuthorizedError(resource, response.status);
  }
  return true;
}

async function assertCanonicalRunEventSequence(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly planRunId: string;
    readonly applyRunId: string;
    readonly destroyPlanRunId: string;
    readonly destroyApplyRunId: string;
  },
): Promise<CanonicalRunEventSequenceVerificationResult> {
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  let latest: readonly ActivityEventRecord[] = [];
  while (Date.now() <= deadline) {
    const response = await requestJson<{
      readonly events?: readonly ActivityEventRecord[];
    }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/workspaces/${encodeURIComponent(input.workspaceId)}/activity?limit=500`,
    });
    latest = response.events ?? [];
    const result = canonicalRunEventSequenceFromActivity(latest, input);
    if (result) return result;
    await sleep(options.pollIntervalMs);
  }
  throw new Error(
    `Workspace activity did not expose canonical plan/apply/destroy events for Runs ${input.planRunId}, ${input.applyRunId}, ${input.destroyPlanRunId}, ${input.destroyApplyRunId}; observed ${latest.length} events`,
  );
}

export function canonicalRunEventSequenceFromActivity(
  events: readonly ActivityEventRecord[],
  input: {
    readonly capsuleId: string;
    readonly planRunId: string;
    readonly applyRunId: string;
    readonly destroyPlanRunId: string;
    readonly destroyApplyRunId: string;
  },
): CanonicalRunEventSequenceVerificationResult | undefined {
  const plan = findCanonicalRunEvent(events, {
    action: "run.plan_created",
    runId: input.planRunId,
    operation: "plan",
    capsuleId: input.capsuleId,
  });
  const apply = findCanonicalRunEvent(events, {
    action: "run.applied",
    runId: input.applyRunId,
    capsuleId: input.capsuleId,
  });
  const destroyPlan = findCanonicalRunEvent(events, {
    action: "run.plan_created",
    runId: input.destroyPlanRunId,
    operation: "destroy",
    capsuleId: input.capsuleId,
  });
  const destroyApply = findCanonicalRunEvent(events, {
    action: "run.destroyed",
    runId: input.destroyApplyRunId,
    capsuleId: input.capsuleId,
  });
  if (!plan || !apply || !destroyPlan || !destroyApply) return undefined;
  return { plan, apply, destroyPlan, destroyApply };
}

function findCanonicalRunEvent(
  events: readonly ActivityEventRecord[],
  input: {
    readonly action: string;
    readonly runId: string;
    readonly capsuleId: string;
    readonly operation?: string;
  },
): CanonicalRunEventEvidence | undefined {
  const event = events.find(
    (candidate) =>
      candidate.action === input.action &&
      candidate.runId === input.runId &&
      candidate.targetType === "run" &&
      candidate.targetId === input.runId &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      isRecord(candidate.metadata) &&
      candidate.metadata.capsuleId === input.capsuleId &&
      (input.operation === undefined ||
        candidate.metadata.operation === input.operation),
  );
  if (!event) return undefined;
  const metadata = event.metadata ?? {};
  return {
    id: event.id!,
    action: event.action ?? input.action,
    outcome:
      input.action === "run.plan_created"
        ? "planned"
        : input.action === "run.approved"
          ? "approved"
          : input.action === "run.applied"
            ? "applied"
            : "destroyed",
    runId: event.runId ?? input.runId,
    targetId: event.targetId ?? input.runId,
    ...(typeof metadata.operation === "string"
      ? { operation: metadata.operation }
      : {}),
    metadataKeys: safeActivityMetadataKeys(metadata),
  };
}

function safeActivityMetadataKeys(
  metadata: Record<string, unknown>,
): readonly string[] {
  return Object.keys(metadata)
    .filter(
      (key) =>
        !/(?:authorization|bearer|token|secret|credential|password|cookie)/iu.test(
          key,
        ),
    )
    .sort();
}

function safeInterfaceResource(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("unsafe resource");
    }
    return url.href;
  } catch {
    throw new Error("Interface token response contained an unsafe resource URI");
  }
}

async function assertReleaseActivation(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
): Promise<ReleaseActivationVerificationResult> {
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  let lastObservedStatus: ReleaseActivationStatus | undefined;
  while (Date.now() <= deadline) {
    const response = await requestJson<{
      readonly events?: readonly ActivityEventRecord[];
    }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/workspaces/${encodeURIComponent(input.workspaceId)}/activity?limit=50`,
    });
    const events = (response.events ?? []).filter((candidate) =>
      isReleaseActivationEvent(candidate, input),
    );
    for (const event of events) {
      lastObservedStatus = releaseActivationStatusFromAction(event.action);
      if (
        options.requireReleaseActivation === "any" ||
        lastObservedStatus === options.requireReleaseActivation
      ) {
        return releaseActivationVerificationResult(options, input, event);
      }
    }
    const terminalMismatch = events.find(
      (event) => releaseActivationStatusFromAction(event.action) !== "pending",
    );
    if (terminalMismatch) {
      return releaseActivationVerificationResult(
        options,
        input,
        terminalMismatch,
      );
    }
    await sleep(options.pollIntervalMs);
  }
  if (lastObservedStatus) {
    throw new Error(
      `release activation for apply run ${input.applyRunId} remained ${lastObservedStatus}; expected ${options.requireReleaseActivation}`,
    );
  }
  throw new Error(
    `apply Run ${input.applyRunId} did not emit release_activation Activity for StateVersion ${input.stateVersionId}`,
  );
}

function isReleaseActivationEvent(
  candidate: ActivityEventRecord,
  input: {
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
): candidate is ActivityEventRecord & {
  readonly action: string;
  readonly runId: string;
  readonly targetId: string;
  readonly targetType: "state_version";
} {
  if (!candidate.action?.startsWith("release_activation.")) return false;
  if (candidate.runId !== input.applyRunId) return false;
  if (candidate.targetId !== input.stateVersionId) return false;
  return candidate.targetType === "state_version";
}

function releaseActivationVerificationResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
  event: ActivityEventRecord & {
    readonly action: string;
    readonly runId: string;
    readonly targetId: string;
    readonly targetType: "state_version";
  },
): ReleaseActivationVerificationResult {
  const status = releaseActivationStatusFromAction(event.action);
  if (
    options.requireReleaseActivation !== "any" &&
    status !== options.requireReleaseActivation
  ) {
    throw new Error(
      `release activation for apply run ${input.applyRunId} was ${status}; expected ${options.requireReleaseActivation}`,
    );
  }
  const metadata = event.metadata ?? {};
  return {
    eventId: event.id ?? "",
    action: event.action,
    status,
    targetId: event.targetId,
    runId: event.runId,
    ...(typeof metadata.activationKind === "string"
      ? { activationKind: metadata.activationKind }
      : {}),
    ...(typeof metadata.commandCount === "number"
      ? { commandCount: metadata.commandCount }
      : {}),
    ...(typeof metadata.outputCount === "number"
      ? { outputCount: metadata.outputCount }
      : {}),
    metadataKeys: safeActivityMetadataKeys(metadata),
  };
}

function releaseActivationStatusFromAction(
  action: string,
): Exclude<ReleaseActivationStatus, "skipped"> {
  const status = action.replace(/^release_activation\./u, "");
  if (status === "pending" || status === "succeeded" || status === "failed") {
    return status;
  }
  throw new Error(`release activation action ${action} has invalid status`);
}

async function assertCloudflareWorkerGone(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const workerName = cloudflareWorkerName(options, publicOutputs);
  const deadline = createAbsoluteRequestDeadline(
    60_000,
    "Cloudflare Worker absence check",
  );
  let lastStatus = 0;
  while (remainingDeadlineMs(deadline) > 0) {
    const response = await cloudflareScriptRequest(
      options,
      workerName,
      Math.min(
        PUBLIC_URL_REQUEST_TIMEOUT_MS,
        Math.max(1, remainingDeadlineMs(deadline)),
      ),
    );
    lastStatus = response.status;
    if (response.status === 404) return;
    try {
      await waitWithinDeadline(
        sleep(Math.min(2_000, remainingDeadlineMs(deadline))),
        deadline,
        () => new CloudflareApiTimeoutError(),
      );
    } catch {
      break;
    }
  }
  throw new Error(
    `Cloudflare Worker ${workerName} still existed after destroy (last HTTP ${lastStatus})`,
  );
}

export async function verifyPublicWorkerUrlGone(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
  dependencies: Pick<
    PublicUrlFetchDependencies,
    "resolver" | "connector" | "sleep" | "maxAttempts" | "requestTimeoutMs"
  > = {},
): Promise<void> {
  const url = strictPublicUrl(
    publicRuntimeUrl(options, publicOutputs),
    "Cloudflare Worker public URL",
  );
  const check = publicWorkerProbeCheck(url);
  await verifyPinnedPublicRetirement(
    url,
    check,
    "Cloudflare Worker public URL",
    dependencies,
    { maxAttempts: 60, deadlineMs: 120_000 },
  );
}

async function cloudflareScriptRequest(
  options: PlatformControlPlaneSmokeOptions,
  workerName = options.appName,
  timeoutMs = PUBLIC_URL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const { response } = await fetchBoundedCloudflareApi(
    `/client/v4/accounts/${encodeURIComponent(
      options.cloudflareAccountId,
    )}/workers/scripts/${encodeURIComponent(workerName)}`,
    options.cloudflareApiToken,
    { readBody: false, timeoutMs },
  );
  return response;
}

async function revokeConnection(
  options: PlatformControlPlaneSmokeOptions,
  connectionId: string,
): Promise<boolean> {
  try {
    await requestJson({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/connections/${encodeURIComponent(
        connectionId,
      )}/revoke`,
      body: {},
      allowEmpty: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function requestJson<T = unknown>(options: RequestOptions): Promise<T> {
  const method = options.method ?? "GET";
  const { response, body: text } =
    await fetchPinnedControlPlaneRequest(options);
  if (!response.ok) {
    throw new Error(`${method} ${options.path} failed (${response.status})`);
  }
  const body = parseResponseBody(
    text,
    `${method} ${options.path}`,
  );
  if (body === undefined) {
    if (options.allowEmpty) return {} as T;
    throw new Error(`${method} ${options.path} returned empty response`);
  }
  return body as T;
}

export async function fetchPinnedControlPlaneRequest(
  options: RequestOptions,
  dependencies: ControlPlaneTransportDependencies =
    controlPlaneTransportContext.getStore() ?? {},
): Promise<{ readonly response: Response; readonly body: string }> {
  const method = options.method ?? "GET";
  if (!/^[A-Z]+$/u.test(method)) {
    throw new Error("Takosumi control-plane request method is invalid");
  }
  if (
    !options.token ||
    new TextEncoder().encode(options.token).byteLength > PRIVATE_INPUT_MAX_BYTES ||
    /[\0\r\n]/u.test(options.token)
  ) {
    throw new Error("Takosumi control-plane bearer is invalid");
  }
  if (options.binary !== undefined && options.body !== undefined) {
    throw new Error("Takosumi control-plane request body is ambiguous");
  }
  const timeoutMs =
    options.timeoutMs ?? dependencies.requestTimeoutMs ??
      PUBLIC_URL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Takosumi control-plane request timeout must be a positive integer");
  }
  const deadline = createAbsoluteRequestDeadline(
    timeoutMs,
    "Takosumi control-plane request",
  );
  const url = controlPlaneRequestUrl(options.baseUrl, options.path);
  const target = await resolvePinnedPublicTarget(
    url.hostname,
    dependencies.resolver ?? resolveAllDnsAddresses,
    "Takosumi control-plane origin",
    timeoutMs,
    deadline,
  );
  let requestBody: Uint8Array | undefined;
  let contentType: string | undefined;
  if (options.binary !== undefined) {
    requestBody = options.binary;
    contentType = "application/zstd";
  } else if (options.body !== undefined) {
    const serialized = JSON.stringify(options.body);
    if (serialized === undefined) {
      throw new Error("Takosumi control-plane JSON body is invalid");
    }
    requestBody = new TextEncoder().encode(serialized);
    contentType = "application/json";
  }
  if (
    requestBody !== undefined &&
    requestBody.byteLength > CONTROL_PLANE_REQUEST_MAX_BYTES
  ) {
    throw new Error("Takosumi control-plane request body is oversized");
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
    ...(contentType === undefined ? {} : { "content-type": contentType }),
    ...(requestBody === undefined
      ? {}
      : { "content-length": String(requestBody.byteLength) }),
  };
  if (options.idempotencyKey !== undefined) {
    if (
      !options.idempotencyKey ||
      new TextEncoder().encode(options.idempotencyKey).byteLength > 256 ||
      /[\0\r\n]/u.test(options.idempotencyKey)
    ) {
      throw new Error("Takosumi control-plane Idempotency-Key is invalid");
    }
    headers["idempotency-key"] = options.idempotencyKey;
  }
  let result: { readonly response: Response; readonly body: string };
  try {
    result = await fetchPublicCheckAttempt(
      url,
      {
        name: "Takosumi control-plane",
        output: "control-plane",
        path: `${url.pathname}${url.search}`,
        expectedStatus: 200,
        bodyIncludes: [],
        destroyExpectation: { kind: "not-verifiable", reason: "control-plane request" },
      },
      target,
      dependencies.connector ?? connectPinnedHttps,
      timeoutMs,
      headers,
      method,
      requestBody,
      deadline,
    );
  } catch (error) {
    if (
      error instanceof PublicUrlDnsResolutionError ||
      error instanceof PublicUrlNonPublicAddressError
    ) {
      throw error;
    }
    if (error instanceof PublicUrlCheckTimeoutError) {
      throw new RequestTimeoutError(
        method,
        options.path,
        timeoutMs,
      );
    }
    if (error instanceof PublicUrlResponseTooLargeError) {
      throw new RequestResponseTooLargeError(method, options.path);
    }
    throw new RequestTransportError(method, options.path);
  }
  if (result.response.status >= 300 && result.response.status < 400) {
    throw new RequestRedirectError(method, options.path);
  }
  return result;
}

function controlPlaneRequestUrl(baseUrl: string, path: string): URL {
  try {
    const base = strictPublicUrl(baseUrl, "Takosumi control-plane base URL");
    if (base.pathname !== "/") throw new Error("base URL has a path");
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[#\0\r\n]/u.test(path)
    ) {
      throw new Error("request path is invalid");
    }
    const url = new URL(path, `${base.origin}/`);
    if (url.origin !== base.origin) throw new Error("request origin changed");
    return url;
  } catch {
    throw new Error(
      "Takosumi control-plane request requires one canonical public HTTPS origin and a relative API path",
    );
  }
}

function isFetchTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function parseResponseBody(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  }
  return {
    message: `${label} returned non-JSON response`,
  };
}

function redactResponseSnippet(
  value: string,
  redactedValues: readonly string[] = [],
): string {
  return publicErrorMessage(
    value.replace(/\s+/g, " ").slice(0, 240),
    redactedValues,
  );
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string") return errorRecord.message;
    if (typeof errorRecord.code === "string") return errorRecord.code;
  }
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  return fallback;
}

function cloudflareApiSuccess(body: unknown): boolean {
  return isRecord(body) && body.success === true;
}

function cloudflareApiErrorCode(body: unknown): string {
  if (!isRecord(body)) return "unknown_error";
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "unknown_error";
  const first = errors[0];
  if (!isRecord(first)) return "unknown_error";
  const code = typeof first.code === "number" ? String(first.code) : undefined;
  const message = typeof first.message === "string" ? first.message : undefined;
  return [code, message].filter(Boolean).join(": ") || "unknown_error";
}

function publicErrorMessage(
  error: unknown,
  redactedValues: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  let redacted = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(
      /authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;}]+/giu,
      "<redacted-header>",
    )
    .replace(
      /\b((?:token|secret|authorization|cookie)=)[^\s&]+/giu,
      "$1<redacted>",
    )
    .replace(
      /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/)[^\s"'(){};,]*(?:token|secret|credential|password|api[_-]?key)[^\s"'(){};,]*/giu,
      "$1<private-file>",
    )
    .replace(/(takosumi_session=)[^;\s]+/giu, "$1<redacted>");
  for (const value of [...new Set(redactedValues)].filter(Boolean)) {
    redacted = redacted.replaceAll(value, "<provider-connection>");
  }
  return redacted;
}

function redactFailureCleanup(
  cleanup: FailureCleanupResult | undefined,
  redactedValues: readonly string[],
): FailureCleanupResult | undefined {
  if (cleanup === undefined) return undefined;
  return {
    ...cleanup,
    ...(cleanup.destroyVerification === undefined
      ? {}
      : {
          destroyVerification: {
            ...cleanup.destroyVerification,
            ...(cleanup.destroyVerification.error === undefined
              ? {}
              : {
                  error: publicErrorMessage(
                    cleanup.destroyVerification.error,
                    redactedValues,
                  ),
                }),
          },
        }),
    ...(cleanup.destroyError === undefined
      ? {}
      : {
          destroyError: publicErrorMessage(
            cleanup.destroyError,
            redactedValues,
          ),
        }),
    ...(cleanup.error === undefined
      ? {}
      : { error: publicErrorMessage(cleanup.error, redactedValues) }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

function assertBackupRestoreRehearsalUnavailable(
  options: Pick<PlatformControlPlaneSmokeOptions, "backupRestoreRehearsal">,
): void {
  if (!options.backupRestoreRehearsal) return;
  throw new Error(
    "--backup-restore-rehearsal is unavailable: the control export has no manifest-bound restore importer",
  );
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = camel(rawKey);
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args as CliArgs;
}

function camel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

async function readSecret(input: {
  readonly file?: string;
  readonly envValue?: string;
  readonly envName: string;
  readonly label: string;
  readonly dryRun: boolean;
  readonly maxBytes?: number;
}): Promise<{ readonly value: string; readonly source: "env" | "file" }> {
  if (input.file) {
    if (input.dryRun) return { value: "<redacted>", source: "file" };
    const value = (
      await readOwnerPrivateTextFile(input.file, {
        sourceRoots: [TAKOSUMI_ROOT],
        maxBytes: input.maxBytes ?? PRIVATE_INPUT_MAX_BYTES,
        label: input.label,
      })
    ).trim();
    if (!value) throw new Error(`${input.label} file is empty`);
    return { value, source: "file" };
  }
  if (input.envValue) {
    return {
      value: input.dryRun ? "<redacted>" : input.envValue,
      source: "env",
    };
  }
  throw new Error(
    `${input.label} is required: pass the matching --*-file option or set ${input.envName}`,
  );
}

function parseExpectedServiceIdentity(
  rawHeaderName: string | undefined,
  rawValue: string | undefined,
): { readonly headerName: string; readonly value: string } | undefined {
  if (rawHeaderName === undefined && rawValue === undefined) return undefined;
  if (rawHeaderName === undefined || rawValue === undefined) {
    throw new Error(
      "--expected-service-identity-header and --expected-service-identity must be provided together",
    );
  }
  const headerName = rawHeaderName.trim().toLowerCase();
  const value = rawValue.trim();
  if (!headerName || !HTTP_HEADER_NAME.test(headerName)) {
    throw new Error(
      "expected service identity header must be a valid HTTP header name",
    );
  }
  if (
    !value ||
    Buffer.byteLength(value) > SERVICE_IDENTITY_MAX_BYTES ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error(
      "expected service identity must be one bounded header value",
    );
  }
  return { headerName, value };
}

export async function probeServiceIdentity(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    "url" | "expectedServiceIdentity"
  >,
  dependencies: ControlPlaneTransportDependencies =
    controlPlaneTransportContext.getStore() ?? {},
): Promise<void> {
  const expectation = options.expectedServiceIdentity;
  if (!expectation) return;
  const url = strictPublicUrl(options.url, "Takosumi service identity origin");
  if (url.pathname !== "/") {
    throw new Error("Takosumi service identity origin must not include a path");
  }
  const deadline = createAbsoluteRequestDeadline(
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    "Takosumi service identity origin",
  );
  const target = await resolvePinnedPublicTarget(
    url.hostname,
    dependencies.resolver ?? resolveAllDnsAddresses,
    "Takosumi service identity origin",
    PUBLIC_URL_REQUEST_TIMEOUT_MS,
    deadline,
  );
  let response: Response;
  try {
    ({ response } = await fetchPublicCheckAttempt(
      url,
      {
        name: "Takosumi service identity",
        output: "control-plane",
        path: "/",
        expectedStatus: 200,
        bodyIncludes: [],
        destroyExpectation: { kind: "not-verifiable", reason: "service identity request" },
      },
      target,
      dependencies.connector ?? connectPinnedHttps,
      PUBLIC_URL_REQUEST_TIMEOUT_MS,
      { accept: "text/html,application/json" },
      "GET",
      undefined,
      deadline,
    ));
  } catch (error) {
    if (
      error instanceof PublicUrlDnsResolutionError ||
      error instanceof PublicUrlNonPublicAddressError ||
      error instanceof PublicUrlCheckTimeoutError ||
      error instanceof PublicUrlResponseTooLargeError
    ) {
      throw error;
    }
    throw new Error("Takosumi service identity request failed");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Takosumi service identity request rejected a redirect response");
  }
  assertServiceIdentityResponse(response.headers, expectation);
}

export function assertServiceIdentityResponse(
  headers: Headers,
  expectation: { readonly headerName: string; readonly value: string },
): void {
  if (headers.get(expectation.headerName) !== expectation.value) {
    throw new Error(
      "service identity response header did not match expectation",
    );
  }
}

function serviceIdentityEvidence(
  expectation: { readonly headerName: string; readonly value: string },
  sampleCount: number,
  result: "planned" | "passed" | "failed",
): NonNullable<PlatformControlPlaneSmokeResult["serviceIdentity"]> {
  return {
    headerName: expectation.headerName,
    identityDigest: sha256(expectation.value) as `sha256:${string}`,
    sampleCount,
    result,
  };
}

async function readNonSecretInput(input: {
  readonly file?: string;
  readonly value?: string;
  readonly envValue?: string;
  readonly envName: string;
  readonly label: string;
  readonly dryRun: boolean;
  readonly hint: string;
}): Promise<{
  readonly value: string;
  readonly source: "env" | "file" | "arg";
}> {
  if (input.file) {
    if (input.dryRun) return { value: "<redacted>", source: "file" };
    const value = (await readFile(input.file, "utf8")).trim();
    if (!value) throw new Error(`${input.label} file is empty`);
    return { value, source: "file" };
  }
  if (input.value) {
    return {
      value: input.dryRun ? "<redacted>" : input.value,
      source: "arg",
    };
  }
  if (input.envValue) {
    return {
      value: input.dryRun ? "<redacted>" : input.envValue,
      source: "env",
    };
  }
  throw new Error(`${input.label} is required: ${input.hint}`);
}

function parsePositiveInteger(
  raw: string | undefined,
  label: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(raw);
}

function parseFunctionalProbeEnvNames(
  raw: string | undefined,
): readonly string[] {
  if (!raw?.trim()) return [];
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(
        "--functional-probe-env must be a comma-separated list of uppercase environment variable names",
      );
    }
  }
  return names.sort();
}

function normalizeBaseUrl(value: string): string {
  try {
    if (
      value !== value.trim() ||
      /[\u0000-\u0020\u007f]/u.test(value) ||
      !/^https:\/\/[^/?#\\]+\/?$/iu.test(value)
    ) {
      throw new Error("non-authority URL syntax");
    }
    const url = strictPublicUrl(value, "--url");
    if (url.pathname !== "/") throw new Error("non-origin path");
    return url.origin;
  } catch {
    throw new Error(
      "--url must be an absolute HTTPS origin with a public hostname and without credentials, port, path, query, or fragment",
    );
  }
}

function parseCloudflareConnectionMode(
  value: string | undefined,
): SmokeProviderConnectionMode {
  if (value === undefined || value.trim() === "" || value === "none")
    return "none";
  if (value === "guided") return "guided";
  if (value === "generic-env") return "generic-env";
  if (value === "none") return "none";
  throw new Error(
    "--cloudflare-connection-mode must be guided, generic-env, or none",
  );
}

function optionalProviderConnectionId(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("--provider-connection-id must be a non-empty string");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function parseSmokeProviderBindings(
  value: JsonSmokeValue,
): readonly SmokeProviderBindingInput[] {
  if (!Array.isArray(value)) {
    throw new Error("provider bindings must be a JSON array");
  }
  if (value.length > MAX_SMOKE_PROVIDER_BINDINGS) {
    throw new Error(
      `provider bindings must contain at most ${MAX_SMOKE_PROVIDER_BINDINGS} entries`,
    );
  }
  const bindings = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`provider bindings[${index}] must be an object`);
    }
    const allowed = new Set([
      "provider",
      "moduleLocalName",
      "childAlias",
      "rootAlias",
      "connectionId",
    ]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `provider bindings[${index}] has unknown fields: ${unknown.sort().join(", ")}`,
      );
    }
    const provider = requiredTrimmedString(
      entry.provider,
      `provider bindings[${index}].provider`,
    );
    if (
      !EXACT_PROVIDER_SOURCE_PATTERN.test(provider) ||
      canonicalProviderSource(provider) !== provider
    ) {
      throw new Error(
        `provider bindings[${index}].provider must be an exact canonical provider source`,
      );
    }
    const connectionId = requiredTrimmedString(
      entry.connectionId,
      `provider bindings[${index}].connectionId`,
    );
    const moduleLocalName = optionalOpenTofuIdentifier(
      entry.moduleLocalName,
      `provider bindings[${index}].moduleLocalName`,
    );
    const childAlias = optionalOpenTofuIdentifier(
      entry.childAlias,
      `provider bindings[${index}].childAlias`,
    );
    const rootAlias = optionalOpenTofuIdentifier(
      entry.rootAlias,
      `provider bindings[${index}].rootAlias`,
    );
    return {
      provider,
      ...(moduleLocalName ? { moduleLocalName } : {}),
      ...(childAlias ? { childAlias } : {}),
      ...(rootAlias ? { rootAlias } : {}),
      connectionId,
    } satisfies SmokeProviderBindingInput;
  });
  const addresses = new Set<string>();
  const rootTargets = new Set<string>();
  const rootSources = new Map<string, string>();
  for (const binding of bindings) {
    const address = stableJson([
      binding.provider,
      binding.moduleLocalName ?? null,
      binding.childAlias ?? null,
    ]);
    if (addresses.has(address)) {
      throw new Error(
        `duplicate ProviderBinding address for ${binding.provider}`,
      );
    }
    addresses.add(address);
    const localProvider =
      binding.moduleLocalName ?? binding.provider.split("/").at(-1)!;
    const existingSource = rootSources.get(localProvider);
    if (existingSource !== undefined && existingSource !== binding.provider) {
      throw new Error(
        `root provider local name ${localProvider} maps to multiple provider sources`,
      );
    }
    rootSources.set(localProvider, binding.provider);
    const rootTarget = stableJson([localProvider, binding.rootAlias ?? null]);
    if (rootTargets.has(rootTarget)) {
      throw new Error(
        `duplicate root provider target for ${localProvider}${binding.rootAlias ? `.${binding.rootAlias}` : " (default)"}`,
      );
    }
    rootTargets.add(rootTarget);
  }
  return bindings.sort(compareSmokeProviderBindings);
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalOpenTofuIdentifier(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredTrimmedString(value, label);
  if (!isOpenTofuIdentifier(normalized)) {
    throw new Error(`${label} must be a valid OpenTofu identifier`);
  }
  return normalized;
}

function compareSmokeProviderBindings(
  left: SmokeProviderBindingInput,
  right: SmokeProviderBindingInput,
): number {
  const leftKey = stableJson([
    left.provider,
    left.moduleLocalName ?? null,
    left.childAlias ?? null,
    left.rootAlias ?? null,
    left.connectionId,
  ]);
  const rightKey = stableJson([
    right.provider,
    right.moduleLocalName ?? null,
    right.childAlias ?? null,
    right.rootAlias ?? null,
    right.connectionId,
  ]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function parseAuthTokenKind(value: string | undefined): SmokeAuthTokenKind {
  if (value === undefined || value.trim() === "" || value === "session") {
    return "session";
  }
  if (value === "pat") return "pat";
  throw new Error("--auth-token-kind must be session or pat");
}

function parseVerificationMode(
  value: string | undefined,
): SmokeVerificationMode {
  if (value === undefined || value.trim() === "" || value === "opentofu")
    return "opentofu";
  if (value === "cloudflare-worker") return "cloudflare-worker";
  throw new Error("--verification-mode must be cloudflare-worker or opentofu");
}

function parseCloudflareResourcePreflight(
  value: string | undefined,
): CloudflareResourcePreflightMode {
  if (value === undefined || value.trim() === "" || value === "none") {
    return "none";
  }
  if (value === "d1") return "d1";
  if (value === "workers") return "workers";
  if (value === "account-resources") return "account-resources";
  throw new Error(
    "--cloudflare-resource-preflight must be workers, account-resources, d1, or none",
  );
}

function parseReleaseActivationRequirement(
  value: string | undefined,
): ReleaseActivationRequirement | undefined {
  if (value === undefined || value.trim() === "" || value === "none") {
    return undefined;
  }
  if (
    value === "any" ||
    value === "pending" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(
    "--require-release-activation must be any, pending, succeeded, failed, or none",
  );
}

function dryRunReleaseActivationStatus(
  requirement: ReleaseActivationRequirement,
): Exclude<ReleaseActivationStatus, "skipped"> {
  return requirement === "any" ? "succeeded" : requirement;
}

function defaultSmokeVars(input: {
  readonly accountId: string;
  readonly appName: string;
  readonly workersSubdomain: string;
  readonly providerless?: boolean;
}): Readonly<Record<string, JsonSmokeValue>> {
  if (input.providerless) {
    return {
      name: input.appName,
      base_url: `https://${input.appName}.example.invalid`,
    };
  }
  // The control-plane smoke installs the cloudflare-hello-worker module,
  // whose declared variables are camelCase; the generated root projects only
  // declared variables, so these defaults must match the module contract.
  return {
    accountId: input.accountId,
    appName: input.appName,
    workersSubdomain: input.workersSubdomain,
  };
}

function mergeJsonRecords(
  base: Readonly<Record<string, JsonSmokeValue>>,
  override: Readonly<Record<string, JsonSmokeValue>>,
): Readonly<Record<string, JsonSmokeValue>> {
  const merged: Record<string, JsonSmokeValue> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainJsonObject(baseValue) && isPlainJsonObject(value)) {
      merged[key] = mergeJsonRecords(baseValue, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainJsonObject(
  value: JsonSmokeValue | undefined,
): value is Readonly<Record<string, JsonSmokeValue>> {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function defaultSmokeOutputAllowlist(
  providerless: boolean,
): SmokeOutputAllowlist {
  if (providerless) {
    return {
      example_label: {
        from: "example_label",
        type: "string",
        required: true,
      },
      example_endpoint: {
        from: "example_endpoint",
        type: "url",
        required: true,
      },
    };
  }
  return {
    worker_name: { from: "worker_name", type: "string", required: true },
    url: { from: "url", type: "url", required: true },
  };
}

/**
 * The Cloudflare hello-worker smoke has one deterministic, credential-free
 * Interface declaration.  Its name/key are derived from the Capsule name so
 * repeated smoke runs cannot accidentally compare a previous Capsule's
 * Interface.  The binding uses `none`: the public Worker Output is the
 * invocation surface, while the binding still proves the installer grant.
 */
export function defaultHelloWorkerInterfaceBlueprint(
  appName: string,
  endpointOutputName = "url",
): CapsuleInterfaceBlueprint {
  const identity = smokeInterfaceIdentity(appName);
  const key = `${identity}.hello-worker`;
  return {
    key,
    name: `${identity}.hello-worker`,
    labels: { component: "platform-control-plane-smoke" },
    spec: {
      type: HELLO_WORKER_INTERFACE_TYPE,
      version: HELLO_WORKER_INTERFACE_VERSION,
      document: {
        transport: "streamable-http",
        display: { title: `${identity} public Worker` },
      },
      inputs: {
        endpoint: {
          source: "capsule_output",
          outputName: endpointOutputName,
        },
      },
      access: { visibility: "public", resourceUriInput: "endpoint" },
    },
    bindings: [
      {
        key: `${key}.installer`,
        subject: { source: "installing_principal" },
        permissions: [HELLO_WORKER_INTERFACE_PERMISSION],
        delivery: { type: "none" },
      },
    ],
  };
}

function smokeInterfaceIdentity(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^[^A-Za-z]+/u, "");
  const bounded = normalized.slice(0, 96).replace(/[-_.]+$/u, "");
  return bounded || "takosumi-smoke";
}

export function parseSmokeInterfaceBlueprints(
  value: JsonSmokeValue,
): readonly CapsuleInterfaceBlueprint[] {
  if (!Array.isArray(value)) {
    throw new Error("interface blueprints must be a JSON array");
  }
  if (value.length > MAX_SMOKE_INTERFACE_BLUEPRINTS) {
    throw new Error(
      `interface blueprints must contain at most ${MAX_SMOKE_INTERFACE_BLUEPRINTS} entries`,
    );
  }
  const seenKeys = new Set<string>();
  const blueprints = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`interface blueprints[${index}] must be an object`);
    }
    const key = requiredTrimmedString(
      entry.key,
      `interface blueprints[${index}].key`,
    );
    const name = requiredTrimmedString(
      entry.name,
      `interface blueprints[${index}].name`,
    );
    if (seenKeys.has(key)) {
      throw new Error(`interface blueprints contains duplicate key ${key}`);
    }
    seenKeys.add(key);
    const spec = parseSmokeInterfaceSpec(
      entry.spec,
      `interface blueprints[${index}].spec`,
    );
    const labels = entry.labels === undefined
      ? undefined
      : parseSmokeInterfaceLabels(
          entry.labels,
          `interface blueprints[${index}].labels`,
        );
    const bindings = entry.bindings === undefined
      ? undefined
      : parseSmokeInterfaceBindings(
          entry.bindings,
          `interface blueprints[${index}].bindings`,
        );
    return {
      key,
      name,
      ...(labels ? { labels } : {}),
      spec,
      ...(bindings ? { bindings } : {}),
    } satisfies CapsuleInterfaceBlueprint;
  });
  return blueprints;
}

function mergeSmokeInterfaceBlueprints(
  base: readonly CapsuleInterfaceBlueprint[],
  overrides: readonly CapsuleInterfaceBlueprint[],
): readonly CapsuleInterfaceBlueprint[] {
  const merged = new Map(base.map((blueprint) => [blueprint.key, blueprint]));
  for (const blueprint of overrides) merged.set(blueprint.key, blueprint);
  return [...merged.values()];
}

function parseSmokeInterfaceSpec(
  value: unknown,
  label: string,
): CapsuleInterfaceBlueprint["spec"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const type = requiredTrimmedString(value.type, `${label}.type`);
  const version = requiredTrimmedString(value.version, `${label}.version`);
  if (!isJsonSmokeValue(value.document)) {
    throw new Error(`${label}.document must be JSON-compatible`);
  }
  if (!isRecord(value.access)) throw new Error(`${label}.access must be an object`);
  const visibility = value.access.visibility;
  if (
    visibility !== "private" &&
    visibility !== "workspace" &&
    visibility !== "public"
  ) {
    throw new Error(`${label}.access.visibility must be private, workspace, or public`);
  }
  const resourceUriInput = value.access.resourceUriInput;
  if (
    resourceUriInput !== undefined &&
    (typeof resourceUriInput !== "string" || resourceUriInput.trim() === "")
  ) {
    throw new Error(`${label}.access.resourceUriInput must be a non-empty string`);
  }
  const inputs = value.inputs === undefined
    ? undefined
    : parseSmokeInterfaceInputs(value.inputs, `${label}.inputs`);
  return {
    type,
    version,
    document: value.document as unknown as JsonValue,
    ...(inputs ? { inputs } : {}),
    access: {
      visibility,
      ...(typeof resourceUriInput === "string"
        ? { resourceUriInput: resourceUriInput.trim() }
        : {}),
    },
  };
}

function parseSmokeInterfaceInputs(
  value: unknown,
  label: string,
): NonNullable<CapsuleInterfaceBlueprint["spec"]["inputs"]> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const inputs: Record<string, CapsuleInterfaceBlueprintInput> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
      throw new Error(`${label}.${name} is not a valid input name`);
    }
    if (!isRecord(raw)) throw new Error(`${label}.${name} must be an object`);
    const source = raw.source;
    if (source === "literal") {
      if (!isJsonSmokeValue(raw.value)) {
        throw new Error(`${label}.${name}.value must be JSON-compatible`);
      }
      inputs[name] = {
        source,
        value: raw.value as unknown as JsonValue,
      };
      continue;
    }
    if (source !== "capsule_output") {
      throw new Error(`${label}.${name}.source must be literal or capsule_output`);
    }
    const outputName = requiredTrimmedString(
      raw.outputName,
      `${label}.${name}.outputName`,
    );
    const pointer = raw.pointer;
    if (
      pointer !== undefined &&
      (typeof pointer !== "string" || pointer.trim() === "")
    ) {
      throw new Error(`${label}.${name}.pointer must be a non-empty string`);
    }
    inputs[name] = {
      source,
      outputName,
      ...(typeof pointer === "string" ? { pointer: pointer.trim() } : {}),
    };
  }
  return inputs;
}

function parseSmokeInterfaceLabels(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key)) {
      throw new Error(`${label}.${key} is not a valid label name`);
    }
    labels[key] = requiredTrimmedString(raw, `${label}.${key}`);
  }
  return labels;
}

function parseSmokeInterfaceBindings(
  value: unknown,
  label: string,
): readonly CapsuleInterfaceBindingProposal[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seenKeys = new Set<string>();
  return value.map<CapsuleInterfaceBindingProposal>((raw, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(raw)) throw new Error(`${itemLabel} must be an object`);
    const key = requiredTrimmedString(raw.key, `${itemLabel}.key`);
    if (seenKeys.has(key)) throw new Error(`${label} contains duplicate key ${key}`);
    seenKeys.add(key);
    if (!Array.isArray(raw.permissions) || raw.permissions.length === 0) {
      throw new Error(`${itemLabel}.permissions must be a non-empty string array`);
    }
    const permissions = raw.permissions.map((permission, permissionIndex) =>
      requiredTrimmedString(
        permission,
        `${itemLabel}.permissions[${permissionIndex}]`,
      ),
    );
    if (!isRecord(raw.delivery)) throw new Error(`${itemLabel}.delivery must be an object`);
    const deliveryType = requiredTrimmedString(
      raw.delivery.type,
      `${itemLabel}.delivery.type`,
    );
    const delivery = {
      type: deliveryType,
      ...(raw.delivery.credentialRef !== undefined
        ? {
            credentialRef: requiredTrimmedString(
              raw.delivery.credentialRef,
              `${itemLabel}.delivery.credentialRef`,
            ),
          }
        : {}),
      ...(raw.delivery.options !== undefined
        ? {
              options: isRecord(raw.delivery.options)
              ? (raw.delivery.options as unknown as JsonObject)
              : (() => {
                  throw new Error(`${itemLabel}.delivery.options must be an object`);
                })(),
          }
        : {}),
    };
    if (raw.subject !== undefined) {
      if (!isRecord(raw.subject) || raw.subject.source !== "installing_principal") {
        throw new Error(`${itemLabel}.subject must be installing_principal`);
      }
      const proposal = {
        key,
        permissions,
        delivery,
        subject: { source: "installing_principal" },
      } as CapsuleInterfaceBindingProposal;
      return proposal;
    }
    if (!isRecord(raw.subjectRef)) {
      throw new Error(`${itemLabel} must include subject or subjectRef`);
    }
    const subjectKind = raw.subjectRef.kind;
    if (subjectKind !== "Principal" && subjectKind !== "ServiceAccount" && subjectKind !== "Capsule") {
      throw new Error(`${itemLabel}.subjectRef.kind is invalid`);
    }
    const subjectId = requiredTrimmedString(raw.subjectRef.id, `${itemLabel}.subjectRef.id`);
    const proposal = {
      key,
      permissions,
      delivery,
      subjectRef: { kind: subjectKind, id: subjectId },
    } as CapsuleInterfaceBindingProposal;
    return proposal;
  });
}

async function readJsonRecordInput(input: {
  readonly inline?: string;
  readonly file?: string;
  readonly label: string;
  readonly fallback: Readonly<Record<string, JsonSmokeValue>>;
}): Promise<Readonly<Record<string, JsonSmokeValue>>> {
  if (input.inline !== undefined) {
    return parseJsonRecord(input.inline, input.label);
  }
  if (input.file !== undefined) {
    return parseJsonRecord(await readFile(input.file, "utf8"), input.label);
  }
  return input.fallback;
}

async function readJsonValueInput(input: {
  readonly inline?: string;
  readonly file?: string;
  readonly label: string;
  readonly fallback: JsonSmokeValue;
}): Promise<JsonSmokeValue> {
  if (input.inline !== undefined) {
    return parseJsonValue(input.inline, input.label);
  }
  if (input.file !== undefined) {
    return parseJsonValue(await readFile(input.file, "utf8"), input.label);
  }
  return input.fallback;
}

function parseJsonRecord(
  raw: string,
  label: string,
): Readonly<Record<string, JsonSmokeValue>> {
  const parsed = parseJsonValue(raw, label);
  if (!isJsonRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonValue(raw: string, label: string): JsonSmokeValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isJsonSmokeValue(parsed)) {
    throw new Error(`${label} must be JSON-compatible`);
  }
  return parsed;
}

function parseOutputAllowlist(
  value: Readonly<Record<string, JsonSmokeValue>>,
): SmokeOutputAllowlist {
  const out: Record<
    string,
    {
      from: string;
      type: SmokeOutputAllowlistType;
      required?: boolean;
    }
  > = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `output allowlist key ${JSON.stringify(name)} must be an OpenTofu identifier`,
      );
    }
    if (!isRecord(spec) || typeof spec.from !== "string" || !spec.from) {
      throw new Error(
        `output allowlist ${name} must include a non-empty string "from" field`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.from)) {
      throw new Error(
        `output allowlist ${name}.from must be an OpenTofu output identifier`,
      );
    }
    if (!isOutputAllowlistType(spec.type)) {
      throw new Error(
        `output allowlist ${name}.type must be one of string, url, hostname, number, boolean, json`,
      );
    }
    out[name] = {
      from: spec.from,
      type: spec.type,
      ...(typeof spec.required === "boolean"
        ? { required: spec.required }
        : {}),
    };
  }
  return out;
}

function parseExplicitProjectedOutputName(input: {
  readonly raw?: string;
  readonly label: string;
  readonly outputAllowlist: SmokeOutputAllowlist;
  readonly acceptedTypes: readonly SmokeOutputAllowlistType[];
}): string | undefined {
  const name = input.raw?.trim();
  if (!name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`${input.label} must be an OpenTofu output identifier`);
  }
  const projection = input.outputAllowlist[name];
  if (!projection) {
    throw new Error(`${input.label} must also be in the output allowlist`);
  }
  if (!input.acceptedTypes.includes(projection.type)) {
    throw new Error(
      `${input.label} must reference an output projected as ${input.acceptedTypes.join(" or ")}`,
    );
  }
  return name;
}

function isOutputAllowlistType(
  value: unknown,
): value is SmokeOutputAllowlistType {
  return (
    value === "string" ||
    value === "url" ||
    value === "hostname" ||
    value === "number" ||
    value === "boolean" ||
    value === "json"
  );
}

function parsePublicUrlChecks(
  value: JsonSmokeValue,
  outputAllowlist: SmokeOutputAllowlist,
): readonly PublicUrlCheck[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parsePublicUrlCheck(entry, index, outputAllowlist),
    );
  }
  if (isRecord(value) && Object.keys(value).length === 0) return [];
  throw new Error("public URL checks must be a JSON array");
}

function parsePublicUrlCheck(
  value: JsonSmokeValue,
  index: number,
  outputAllowlist: SmokeOutputAllowlist,
): PublicUrlCheck {
  if (!isRecord(value)) {
    throw new Error(`public URL checks[${index}] must be an object`);
  }
  const output = stringField(value, "output");
  if (!output || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(output)) {
    throw new Error(
      `public URL checks[${index}].output must be an output name`,
    );
  }
  if (!(output in outputAllowlist)) {
    throw new Error(
      `public URL checks[${index}].output must also be in the output allowlist`,
    );
  }
  const name = stringField(value, "name") ?? output;
  if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(name)) {
    throw new Error(`public URL checks[${index}].name is invalid`);
  }
  const path = stringField(value, "path") ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\0\r\n]/u.test(path)) {
    throw new Error(`public URL checks[${index}].path must start with /`);
  }
  const expectedStatus = numberField(value, "expectedStatus") ?? 200;
  if (
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 100 ||
    expectedStatus > 599
  ) {
    throw new Error(
      `public URL checks[${index}].expectedStatus must be an HTTP status`,
    );
  }
  const bodyIncludes = stringArrayField(value, "bodyIncludes");
  const destroyExpectation = parsePublicUrlDestroyExpectation(value, index);
  const check = {
    name,
    output,
    path,
    expectedStatus,
    bodyIncludes,
    destroyExpectation,
  };
  assertPublicUrlLifecycleContract(
    check,
    `public URL checks[${index}]`,
  );
  return check;
}

function assertPublicUrlLifecycleContract(
  check: PublicUrlCheck,
  label = `public URL check ${check.name}`,
): void {
  if (
    check.destroyExpectation.kind === "http-404" &&
    (check.expectedStatus === 404 || check.expectedStatus === 410)
  ) {
    throw new Error(
      `${label}.expectedStatus must prove presence and cannot be 404 or 410 when destroyExpectation is http-404`,
    );
  }
}

function parsePublicUrlDestroyExpectation(
  value: Readonly<Record<string, unknown>>,
  index: number,
): PublicUrlDestroyExpectation {
  const expectation = value.destroyExpectation;
  if (!isRecord(expectation)) {
    throw new Error(
      `public URL checks[${index}].destroyExpectation must explicitly select http-404 or not-verifiable`,
    );
  }
  if (expectation.kind === "http-404") {
    return { kind: "http-404" };
  }
  if (expectation.kind === "not-verifiable") {
    const reason = stringField(expectation, "reason");
    if (
      !reason ||
      new TextEncoder().encode(reason).byteLength > 240 ||
      /[\0\r\n]/u.test(reason)
    ) {
      throw new Error(
        `public URL checks[${index}] not-verifiable destroyExpectation requires a bounded reason`,
      );
    }
    return { kind: "not-verifiable", reason };
  }
  throw new Error(
    `public URL checks[${index}].destroyExpectation must explicitly select http-404 or not-verifiable`,
  );
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return value;
  }
  throw new Error(`${key} must be a string array`);
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonSmokeValue>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonSmokeValue);
}

function isJsonSmokeValue(value: unknown): value is JsonSmokeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) return value.every(isJsonSmokeValue);
  return isJsonRecord(value);
}

function normalizeSmokeSourceGitUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error(
      "--source-git-url must not include embedded credentials; use a public fixture repo or a Source Git Connection",
    );
  }
  url.hash = "";
  return url.toString();
}

function defaultCapsuleName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `takosumi-smoke-${suffix}`;
}

function capsuleLabel(options: PlatformControlPlaneSmokeOptions): string {
  void options;
  return "git-opentofu-capsule";
}

function publicInputSummary(options: PlatformControlPlaneSmokeOptions): {
  readonly accountSessionTokenSource: "env" | "file";
  readonly accountAuthTokenKind: SmokeAuthTokenKind;
  readonly cloudflareApiTokenSource: SecretInputSource;
  readonly cloudflareAccountIdSource: NonSecretInputSource;
  readonly cloudflareAccountIdDigest: string;
  readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
  readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
  readonly providerConnectionId?: string;
  readonly providerBindingCount: number;
  readonly providerBindingsExplicit: boolean;
  readonly providerBindingsDigest?: string;
  readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
  readonly runnerProfileId?: string;
  readonly sourceMode: "git";
  readonly verificationMode: SmokeVerificationMode;
  readonly varsDigest: string;
  readonly outputAllowlistNames: readonly string[];
  readonly publicUrlCheckNames: readonly string[];
  readonly publicUrlDestroyExpectations: readonly {
    readonly name: string;
    readonly expectation: PublicUrlDestroyExpectation;
  }[];
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScriptDigest?: string;
  readonly functionalProbeEnvNames: readonly string[];
  readonly capsuleDir?: string;
  readonly sourceGitUrlDigest?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly interfaceBlueprintCount: number;
  readonly interfaceBlueprintsExplicit: boolean;
  readonly interfaceProof: "required" | "disabled" | "not_requested";
  readonly interfaceTokenProofRequested: boolean;
  readonly interfaceRuntimeTokenSource?: SecretInputSource;
  readonly storeMetadataDigest?: string;
} {
  const interfaceBlueprints = options.interfaceBlueprints ?? [];
  const interfaceProof =
    options.noInterfaceProof === true
      ? "disabled"
      : interfaceBlueprints.length > 0
        ? "required"
        : "not_requested";
  return {
    accountSessionTokenSource: options.accountSessionTokenSource,
    accountAuthTokenKind: options.accountAuthTokenKind,
    cloudflareApiTokenSource: options.cloudflareApiTokenSource,
    cloudflareAccountIdSource: options.cloudflareAccountIdSource,
    cloudflareAccountIdDigest:
      options.cloudflareAccountIdSource === "not_required"
        ? "not_required"
        : sha256(options.cloudflareAccountId),
    cloudflareWorkersSubdomainSource: options.cloudflareWorkersSubdomainSource,
    cloudflareConnectionMode: options.cloudflareConnectionMode,
    ...(options.providerConnectionId
      ? { providerConnectionId: options.providerConnectionId }
      : {}),
    providerBindingCount: options.providerBindings.length,
    providerBindingsExplicit: options.providerBindingsExplicit,
    ...(options.providerBindingsExplicit || options.providerBindings.length > 0
      ? {
          providerBindingsDigest: digestJson(options.providerBindings),
        }
      : {}),
    cloudflareResourcePreflight: options.cloudflareResourcePreflight,
    ...(options.runnerProfileId
      ? { runnerProfileId: options.runnerProfileId }
      : {}),
    sourceMode: options.sourceMode,
    verificationMode: options.verificationMode,
    varsDigest: digestJson(options.vars),
    outputAllowlistNames: Object.keys(options.outputAllowlist).sort(),
    publicUrlCheckNames: options.publicUrlChecks.map((check) => check.name),
    publicUrlDestroyExpectations: options.publicUrlChecks.map((check) => ({
      name: check.name,
      expectation: check.destroyExpectation,
    })),
    ...(options.cloudflareWorkerNameOutput
      ? { cloudflareWorkerNameOutput: options.cloudflareWorkerNameOutput }
      : {}),
    ...(options.runtimePublicUrlOutput
      ? { runtimePublicUrlOutput: options.runtimePublicUrlOutput }
      : {}),
    ...(options.functionalProbeScriptDigest
      ? { functionalProbeScriptDigest: options.functionalProbeScriptDigest }
      : {}),
    functionalProbeEnvNames: options.functionalProbeEnvNames,
    ...(options.sourceGitUrl
      ? {
          sourceGitUrlDigest: sha256(options.sourceGitUrl),
          ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
          sourcePath: options.sourcePath ?? ".",
          ...(options.modulePath ? { modulePath: options.modulePath } : {}),
          ...(options.installConfigId
            ? { installConfigId: options.installConfigId }
            : {}),
          ...(options.storeMetadata
            ? { storeMetadataDigest: digestJson(options.storeMetadata) }
            : {}),
        }
      : {}),
    interfaceBlueprintCount: interfaceBlueprints.length,
    interfaceBlueprintsExplicit: options.interfaceBlueprintsExplicit === true,
    interfaceProof,
    interfaceTokenProofRequested:
      options.interfaceTokenProofRequested === true,
    ...(options.interfaceRuntimeTokenSource
      ? { interfaceRuntimeTokenSource: options.interfaceRuntimeTokenSource }
      : {}),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runCapsuleFunctionalProbe(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs: Readonly<Record<string, unknown>>,
): Promise<CapsuleFunctionalProbeEvidence> {
  const script = options.functionalProbeScript;
  if (!script) throw new Error("functional probe script is not configured");
  const startedAtMs = Date.now();
  const tempDir = await mkdtemp(resolve(tmpdir(), "takosumi-capsule-probe-"));
  const outputsFile = resolve(tempDir, "outputs.json");
  await writeFile(outputsFile, `${JSON.stringify(publicOutputs)}\n`, {
    mode: 0o600,
  });
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tempDir,
    TMPDIR: tempDir,
    TAKOSUMI_CAPSULE_OUTPUTS_FILE: outputsFile,
    TAKOSUMI_CAPSULE_APP_NAME: options.appName,
    TAKOSUMI_CAPSULE_WORKSPACE_ID: options.workspace,
  };
  for (const name of options.functionalProbeEnvNames) {
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `functional probe environment variable ${name} is not set`,
      );
    }
    childEnv[name] = value;
  }

  try {
    const child = spawn(process.execPath, [script], {
      cwd: dirname(script),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let spawnError: Error | undefined;
    let timedOut = false;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.deployTimeoutSeconds * 1000);
    const exitCode = await new Promise<number>((resolveExit) => {
      child.on("close", (code) => resolveExit(code ?? 1));
    });
    clearTimeout(timeout);
    if (spawnError) throw spawnError;
    if (timedOut) {
      throw new Error(
        `functional probe did not finish within ${options.deployTimeoutSeconds}s`,
      );
    }
    if (outputBytes > 1024 * 1024) {
      throw new Error("functional probe output exceeded 1 MiB");
    }
    if (exitCode !== 0) {
      const detail = publicErrorMessage(
        Buffer.concat(stderr).toString("utf8").trim(),
      ).slice(0, 2_000);
      throw new Error(
        `functional probe exited with ${exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }
    const raw = Buffer.concat(stdout).toString("utf8").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("functional probe stdout must be one JSON object");
    }
    const result = assertCapsuleFunctionalProbeResult(parsed);
    return {
      product: result.product,
      checkNames: result.checks.map((check) => check.name),
      cleanupVerified: result.cleanupVerified === true,
      cleanupMode:
        result.cleanupVerified === true ? "probe" : "opentofu-destroy",
      resultDigest: digestJson(result),
      scriptDigest:
        options.functionalProbeScriptDigest ??
        sha256(await readFile(script, "utf8")),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertCapsuleFunctionalProbeResult(
  value: unknown,
): CapsuleFunctionalProbeResult {
  if (!isRecord(value))
    throw new Error("functional probe result must be an object");
  if (value.kind !== "takosumi.capsule-functional-probe@v1") {
    throw new Error("functional probe result kind is invalid");
  }
  if (value.status !== "passed") {
    throw new Error("functional probe result did not pass");
  }
  if (typeof value.product !== "string" || !value.product.trim()) {
    throw new Error("functional probe result product is required");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new Error("functional probe result requires at least one check");
  }
  const checks = value.checks.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      entry.status !== "passed"
    ) {
      throw new Error(
        "functional probe checks must have a name and passed status",
      );
    }
    return { name: entry.name.trim(), status: "passed" as const };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error("functional probe check names must be unique");
  }
  if (
    value.cleanupVerified !== true &&
    value.cleanupDelegatedToDestroy !== true
  ) {
    throw new Error(
      "functional probe must verify cleanup or delegate it to OpenTofu destroy",
    );
  }
  if (
    value.cleanupVerified === true &&
    value.cleanupDelegatedToDestroy === true
  ) {
    throw new Error(
      "functional probe cleanup cannot be both verified and delegated",
    );
  }
  return {
    kind: "takosumi.capsule-functional-probe@v1",
    status: "passed",
    product: value.product.trim(),
    checks,
    ...(value.cleanupVerified === true
      ? { cleanupVerified: true }
      : { cleanupDelegatedToDestroy: true }),
  };
}

function finalizeFunctionalProbeCleanup(
  evidence: CapsuleFunctionalProbeEvidence | undefined,
): CapsuleFunctionalProbeEvidence | undefined {
  if (!evidence || evidence.cleanupMode !== "opentofu-destroy") return evidence;
  return { ...evidence, cleanupVerified: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWeakMapKey(value: unknown): value is object {
  return value !== null &&
    (typeof value === "object" || typeof value === "function");
}

function requiredSteps(
  options?: Pick<
    PlatformControlPlaneSmokeOptions,
    | "keepConnection"
    | "sourceMode"
    | "cloudflareConnectionMode"
    | "providerConnectionId"
    | "providerBindings"
    | "cloudflareResourcePreflight"
    | "verificationMode"
    | "requireReleaseActivation"
    | "publicUrlChecks"
    | "outputAllowlist"
    | "functionalProbeScript"
    | "interfaceBlueprints"
    | "interfaceTokenProofRequested"
  >,
): readonly string[] {
  const steps = [
    ...(options?.providerBindings && options.providerBindings.length > 0
      ? ["existingProviderConnectionsSelected"]
      : options?.providerConnectionId
        ? ["existingProviderConnectionSelected"]
        : options?.cloudflareConnectionMode === "none"
          ? ["providerConnectionNotRequired"]
          : ["workspaceScopedProviderConnection"]),
    ...(options?.cloudflareConnectionMode === "generic-env"
      ? ["genericEnvProviderConnection"]
      : []),
    ...(options?.cloudflareConnectionMode === "none"
      ? []
      : ["connectionVerified"]),
    ...(options?.cloudflareResourcePreflight &&
    options.cloudflareResourcePreflight !== "none"
      ? ["cloudflareResourcePreflight"]
      : []),
    ...(options?.sourceMode === "git" ? ["sourceRegistered"] : []),
    ...(options?.sourceMode === "git" ? ["sourceSynced"] : []),
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    ...(options?.verificationMode === "opentofu"
      ? [
          "opentofuApplyVerified",
          ...(shouldVerifyCloudflareWorker(options) ? ["runtimeVerified"] : []),
        ]
      : ["runtimeVerified", "publicUrlVerified"]),
    "stateVersionLedgerVerified",
  ];
  if (options?.requireReleaseActivation) {
    steps.push("releaseActivationVerified");
  }
  if (
    options?.verificationMode === "opentofu" &&
    options.publicUrlChecks.length > 0
  ) {
    steps.push("publicUrlVerified");
  }
  if (options?.functionalProbeScript) {
    steps.push("functionalProbe");
  }
  if (options?.interfaceBlueprints && options.interfaceBlueprints.length > 0) {
    steps.push("interfaceMaterializationVerified");
    if (options.interfaceTokenProofRequested) {
      steps.push("interfaceTokenProofVerified");
    }
  }
  steps.push("destroy");
  if (options?.interfaceBlueprints && options.interfaceBlueprints.length > 0) {
    steps.push("runEventSequenceVerified");
    steps.push("interfaceRetiredVerified");
  }
  if (
    options &&
    !options.keepConnection &&
    temporaryProviderConnection(options)
  ) {
    steps.push("connectionRevoked");
  }
  return steps;
}

function shouldVerifyCloudflareWorker(
  options?: Pick<PlatformControlPlaneSmokeOptions, "verificationMode">,
): boolean {
  return options?.verificationMode === "cloudflare-worker";
}

async function writeResult(
  result: PlatformControlPlaneSmokeResult,
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  assertSmokeSerializationSafe(result, options);
  if (options.outFile) {
    await writeResultFile(options.outFile, result);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label =
    result.status === "passed"
      ? "PASS"
      : result.status === "failed"
        ? "FAIL"
        : "DRY RUN";
  console.log(`${label} ${result.kind}`);
  console.log(`service: ${result.serviceUrl}`);
  console.log(`workspace: ${result.scratchWorkspaceId}`);
  console.log(`provider connection: ${result.providerConnectionMode}`);
  console.log(`source mode: ${result.sourceMode}`);
  console.log(`verification mode: ${result.verificationMode}`);
  console.log(`capsule: ${result.capsuleModule}`);
  console.log(`app: ${result.appName}`);
  if (result.verificationMode === "cloudflare-worker") {
    console.log(`worker URL: ${result.workerUrl}`);
  }
  console.log(
    `public URL verified: ${result.publicUrlVerified ? "yes" : "no"}`,
  );
  if (result.releaseActivation) {
    console.log(`release activation: ${result.releaseActivation.status}`);
  }
  if (result.capsuleId) console.log(`capsule id: ${result.capsuleId}`);
  if (result.sourceSyncRunId)
    console.log(`source sync run: ${result.sourceSyncRunId}`);
  if (result.applyRunId) console.log(`apply run: ${result.applyRunId}`);
  if (result.destroyApplyRunId) {
    console.log(`destroy apply run: ${result.destroyApplyRunId}`);
  }
  if (result.interfaceMaterializations?.length) {
    console.log(
      `interfaces verified: ${result.interfaceMaterializations.length}`,
    );
  }
  if (result.runEventSequence) {
    console.log("run events verified: plan/apply/destroy");
  }
  if (result.connectionRevoked !== undefined) {
    console.log(
      `connection revoked: ${result.connectionRevoked ? "yes" : "no"}`,
    );
  }
  if (result.error) console.log(`error: ${result.error}`);
  if (result.nextAction) console.log(`next: ${result.nextAction}`);
}

async function writeResultFile(
  outFile: string,
  result: PlatformControlPlaneSmokeResult,
): Promise<void> {
  assertSmokeSerializationSafe(result);
  await writeNewPrivateEvidenceJson(outFile, result);
}

/** Fail closed if an evidence/result object ever acquires credential material. */
export function assertSmokeSerializationSafe(
  result: unknown,
  options?: Pick<
    PlatformControlPlaneSmokeOptions,
    "accountSessionToken" | "cloudflareApiToken" | "interfaceRuntimeToken"
  >,
  additionalForbiddenValues: readonly string[] = [],
): void {
  const serialized = JSON.stringify(result);
  const forbiddenValues = [
    options?.accountSessionToken,
    options?.cloudflareApiToken,
    options?.interfaceRuntimeToken,
    ...additionalForbiddenValues,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && value !== "<redacted>",
  );
  for (const value of forbiddenValues) {
    if (serialized.includes(value)) {
      throw new Error("smoke serialization contained a credential value");
    }
  }
  if (/(?:^|[\s"'])authorization\s*[:=]/iu.test(serialized)) {
    throw new Error("smoke serialization contained an Authorization header");
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu.test(serialized)) {
    throw new Error("smoke serialization contained a bearer credential");
  }
}

function expectSafeSerializationSelfTest(): void {
  try {
    assertSmokeSerializationSafe({
      authorization: "Bearer interface-secret-selftest",
    });
  } catch {
    return;
  }
  throw new Error("self-test serialization guard accepted Authorization");
}

async function runSelfTest(): Promise<void> {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      cloudflareConnectionMode: "guided",
      cloudflareResourcePreflight: "workers",
      verificationMode: "cloudflare-worker",
    },
    {},
  );
  const result = dryRunResult(options);
  const serialized = JSON.stringify(result);
  const tempRoot = await mkdtemp(resolve(tmpdir(), "takosumi-platform-smoke-"));
  try {
    const evidenceDirectory = resolve(tempRoot, "nested");
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const outFile = resolve(evidenceDirectory, "smoke.json");
    await writeResultFile(outFile, result);
    const saved = JSON.parse(await readFile(outFile, "utf8"));
    if (saved.kind !== PLATFORM_CONTROL_PLANE_SMOKE_KIND) {
      throw new Error("self-test did not write out-file JSON result");
    }
    if (JSON.stringify(saved).includes("account-session-token")) {
      throw new Error(
        "self-test out-file leaked account session token file name",
      );
    }
    const probeScript = resolve(tempRoot, "probe.ts");
    await writeFile(
      probeScript,
      `console.log(JSON.stringify({kind:"takosumi.capsule-functional-probe@v1",status:"passed",product:"self-test",checks:[{name:"round-trip",status:"passed"}],cleanupVerified:true}));\n`,
    );
    const probeEvidence = await runCapsuleFunctionalProbe(
      {
        ...options,
        functionalProbeScript: probeScript,
        functionalProbeScriptDigest: sha256(
          await readFile(probeScript, "utf8"),
        ),
        functionalProbeEnvNames: [],
      },
      { url: "https://example.test" },
    );
    if (
      probeEvidence.product !== "self-test" ||
      probeEvidence.checkNames.join(",") !== "round-trip" ||
      probeEvidence.cleanupVerified !== true ||
      probeEvidence.cleanupMode !== "probe"
    ) {
      throw new Error("self-test functional probe evidence is invalid");
    }
    const delegatedProbeScript = resolve(tempRoot, "delegated-probe.ts");
    await writeFile(
      delegatedProbeScript,
      `console.log(JSON.stringify({kind:"takosumi.capsule-functional-probe@v1",status:"passed",product:"delegated-self-test",checks:[{name:"leave-data",status:"passed"}],cleanupDelegatedToDestroy:true}));\n`,
    );
    const delegatedProbe = await runCapsuleFunctionalProbe(
      {
        ...options,
        functionalProbeScript: delegatedProbeScript,
        functionalProbeScriptDigest: sha256(
          await readFile(delegatedProbeScript, "utf8"),
        ),
        functionalProbeEnvNames: [],
      },
      { url: "https://example.test" },
    );
    const finalizedProbe = finalizeFunctionalProbeCleanup(delegatedProbe);
    if (
      delegatedProbe.cleanupVerified !== false ||
      delegatedProbe.cleanupMode !== "opentofu-destroy" ||
      finalizedProbe?.cleanupVerified !== true
    ) {
      throw new Error("self-test delegated cleanup evidence is invalid");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (options.deployTimeoutSeconds !== DEFAULT_DEPLOY_TIMEOUT_SECONDS) {
    throw new Error("self-test default deploy timeout is wrong");
  }
  if (serialized.includes("account-session-token")) {
    throw new Error("self-test leaked account session token file name");
  }
  if (serialized.includes("cloudflare-token")) {
    throw new Error("self-test leaked Cloudflare token file name");
  }
  if (serialized.includes("cloudflare-account-id")) {
    throw new Error("self-test leaked Cloudflare account id file name");
  }
  if (serialized.includes("cloudflare-workers-subdomain")) {
    throw new Error("self-test leaked Cloudflare Workers subdomain file name");
  }
  if (serialized.includes("acc_selftest")) {
    throw new Error("self-test leaked Cloudflare account id");
  }
  if (result.sourceMode !== "git") {
    throw new Error("self-test default source mode is not git");
  }
  if (result.providerConnectionMode !== "guided") {
    throw new Error("self-test default Provider Connection mode is not guided");
  }
  if (
    result.cloudflareResourcePreflight?.mode !== "workers" ||
    result.cloudflareResourcePreflight.checks.join(",") !==
      "cloudflare.workers.script.list"
  ) {
    throw new Error("self-test Stable Worker preflight scope is wrong");
  }
  if (!result.steps.includes("destroy")) {
    throw new Error("self-test result is missing destroy step");
  }
  if (
    options.interfaceBlueprints?.length !== 1 ||
    result.inputs.interfaceProof !== "required" ||
    !result.steps.includes("interfaceMaterializationVerified") ||
    !result.steps.includes("interfaceRetiredVerified") ||
    result.interfaceMaterializations?.length !== 1 ||
    result.interfaceMaterialization?.bindingPhase !== "Ready" ||
    result.interfaceMaterialization?.retiredPhase !== "Retired" ||
    result.interfaceMaterialization?.revokedBindingPhase !== "Revoked" ||
    result.runEventSequence?.plan.runId !== "plan_dry_run" ||
    result.runEventSequence?.apply.runId !== "apply_dry_run" ||
    result.runEventSequence?.destroyApply.runId !== "destroy_apply_dry_run"
  ) {
    throw new Error("self-test did not require the built-in Interface proof");
  }
  const builtInBlueprint = options.interfaceBlueprints[0]!;
  if (
    builtInBlueprint.spec.inputs?.endpoint?.source !== "capsule_output" ||
    builtInBlueprint.spec.inputs.endpoint.outputName !== "url" ||
    builtInBlueprint.bindings?.[0]?.delivery.type !== "none"
  ) {
    throw new Error("self-test built-in Interface blueprint is not credential-free");
  }
  const installPlanBody = smokeGitInstallPlanBody(options, {
    sourceName: "selftest-source",
    sourceId: "src_selftest",
    sourceSnapshotId: "snap_selftest",
    compatibilityCheckRunId: "ccr_selftest",
    compatibilityReportId: "caprep_selftest",
    installConfigId: "cfg_selftest",
    providerBindings: [],
  });
  if (
    !isRecord(installPlanBody.initialConfiguration) ||
    !Array.isArray(installPlanBody.initialConfiguration.interfaceBlueprints) ||
    installPlanBody.initialConfiguration.interfaceBlueprints.length !== 1
  ) {
    throw new Error("self-test install coordinator omitted Interface blueprints");
  }
  assertSmokeSerializationSafe(result, options);
  expectSafeSerializationSelfTest();
  const eventFixture = canonicalRunEventSequenceFromActivity(
    [
      { id: "evt_destroyed", action: "run.destroyed", targetType: "run", targetId: "run_destroy_apply", runId: "run_destroy_apply", metadata: { capsuleId: "cap_selftest" } },
      { id: "evt_destroy_plan", action: "run.plan_created", targetType: "run", targetId: "run_destroy_plan", runId: "run_destroy_plan", metadata: { capsuleId: "cap_selftest", operation: "destroy" } },
      { id: "evt_applied", action: "run.applied", targetType: "run", targetId: "run_apply", runId: "run_apply", metadata: { capsuleId: "cap_selftest", stateGeneration: 1 } },
      { id: "evt_plan", action: "run.plan_created", targetType: "run", targetId: "run_plan", runId: "run_plan", metadata: { capsuleId: "cap_selftest", operation: "plan" } },
    ],
    {
      capsuleId: "cap_selftest",
      planRunId: "run_plan",
      applyRunId: "run_apply",
      destroyPlanRunId: "run_destroy_plan",
      destroyApplyRunId: "run_destroy_apply",
    },
  );
  if (
    !eventFixture ||
    eventFixture.plan.runId !== "run_plan" ||
    eventFixture.apply.outcome !== "applied" ||
    eventFixture.destroyApply.outcome !== "destroyed"
  ) {
    throw new Error("self-test canonical Run event fixture did not tie exact ids");
  }
  const genericEnvOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      cloudflareConnectionMode: "generic-env",
    },
    {},
  );
  const genericEnvResult = dryRunResult(genericEnvOptions);
  const serializedGenericEnv = JSON.stringify(genericEnvResult);
  if (genericEnvResult.providerConnectionMode !== "generic-env") {
    throw new Error("self-test did not enable generic-env connection mode");
  }
  if (!genericEnvResult.steps.includes("genericEnvProviderConnection")) {
    throw new Error("generic-env self-test result is missing connection step");
  }
  if (
    serializedGenericEnv.includes("cloudflare-token") ||
    serializedGenericEnv.includes("cloudflare-account-id")
  ) {
    throw new Error("generic-env self-test leaked secret file names");
  }
  const opentofuOnlyOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      capsuleDir: "/private/custom-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      verificationMode: "opentofu",
      varsJson:
        '{"target":"cloudflare","project_name":"takosumi-smoke-selftest","environment":"selftest","cloudflare":{"account_id":"acc_selftest"}}',
      outputAllowlistJson:
        '{"target":{"from":"target","type":"string","required":true}}',
    },
    {},
  );
  const opentofuOnlyResult = dryRunResult(opentofuOnlyOptions);
  const serializedOpenTofuOnly = JSON.stringify(opentofuOnlyResult);
  if (opentofuOnlyResult.verificationMode !== "opentofu") {
    throw new Error("self-test did not enable OpenTofu-only verification");
  }
  if (!opentofuOnlyResult.steps.includes("opentofuApplyVerified")) {
    throw new Error("OpenTofu-only self-test result is missing apply proof");
  }
  if (opentofuOnlyResult.steps.includes("publicUrlVerified")) {
    throw new Error("OpenTofu-only self-test should not require public URL");
  }
  if (opentofuOnlyResult.publicUrlVerified !== false) {
    throw new Error("OpenTofu-only self-test should not report public URL");
  }
  if (serializedOpenTofuOnly.includes("acc_selftest")) {
    throw new Error("OpenTofu-only self-test leaked vars content");
  }
  const providerlessOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      capsuleDir: "/private/keyless-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      varsJson:
        '{"name":"takosumi-keyless-selftest","base_url":"https://example.invalid/keyless"}',
      outputAllowlistJson:
        '{"url":{"from":"url","type":"url","required":true},"worker_name":{"from":"worker_name","type":"string","required":true}}',
    },
    {},
  );
  const providerlessResult = dryRunResult(providerlessOptions);
  const serializedProviderless = JSON.stringify(providerlessResult);
  if (providerlessResult.providerConnectionMode !== "none") {
    throw new Error("providerless self-test did not enable none mode");
  }
  if (providerlessResult.credentialPath !== "none") {
    throw new Error("providerless self-test should not report credentials");
  }
  if (!providerlessResult.steps.includes("providerConnectionNotRequired")) {
    throw new Error("providerless self-test is missing no-connection step");
  }
  if (
    providerlessResult.steps.includes("workspaceScopedProviderConnection") ||
    providerlessResult.steps.includes("connectionVerified") ||
    providerlessResult.steps.includes("connectionRevoked")
  ) {
    throw new Error("providerless self-test should not require connections");
  }
  if (providerlessResult.connectionRevoked !== undefined) {
    throw new Error("providerless self-test should not report revocation");
  }
  if (
    providerlessResult.inputs.interfaceProof !== "not_requested" ||
    providerlessResult.steps.some((step) => step.startsWith("interface"))
  ) {
    throw new Error("providerless self-test unexpectedly enabled Interface proof");
  }
  if (serializedProviderless.includes("keyless-selftest")) {
    throw new Error("providerless self-test leaked vars content");
  }
  const noInterfaceProofOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-no-interface-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      noInterfaceProof: true,
    },
    {},
  );
  const noInterfaceProofResult = dryRunResult(noInterfaceProofOptions);
  if (
    noInterfaceProofOptions.noInterfaceProof !== true ||
    noInterfaceProofResult.inputs.interfaceProof !== "disabled" ||
    noInterfaceProofResult.inputs.interfaceBlueprintCount !== 0 ||
    noInterfaceProofResult.steps.some((step) => step.startsWith("interface"))
  ) {
    throw new Error(
      "self-test --no-interface-proof did not produce an explicit non-GA result",
    );
  }
  const managedCloudflareOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      capsuleDir: "/private/takos-opentofu-module",
      appName: "takos-managed-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      varsJson:
        '{"target":"cloudflare","project_name":"takos-managed-selftest","environment":"selftest","cloudflare":{"account_id":"acc_selftest","workers_subdomain":"app.takos.jp"}}',
      outputAllowlistJson:
        '{"published_endpoint":{"from":"url","type":"url","required":true},"runtime_resource":{"from":"worker_name","type":"string","required":true}}',
      cloudflareWorkerNameOutput: "runtime_resource",
      runtimePublicUrlOutput: "published_endpoint",
    },
    {},
  );
  if (
    "name" in managedCloudflareOptions.vars ||
    "base_url" in managedCloudflareOptions.vars
  ) {
    throw new Error(
      "managed Cloudflare self-test should not inherit providerless default vars",
    );
  }
  const currentHelloHtml =
    '<!doctype html><meta charset="utf-8"><title>Hello from Takosumi</title>' +
    "<h1>It works</h1><p>This Worker was provisioned by a Takosumi Capsule.</p>";
  if (!isCurrentTakosumiHelloPage(currentHelloHtml)) {
    throw new Error(
      "self-test did not recognize the current hello Worker page",
    );
  }
  if (
    isCurrentTakosumiHelloPage(
      "<!doctype html><title>It works</title><h1>It works</h1>",
    )
  ) {
    throw new Error("self-test accepted a non-Takosumi hello page");
  }
  if (
    cloudflareWorkerName(managedCloudflareOptions, {
      runtime_resource: "portable-storage-runtime",
    }) !== "portable-storage-runtime"
  ) {
    throw new Error(
      "self-test did not resolve the explicitly mapped Worker name output",
    );
  }
  const {
    cloudflareWorkerNameOutput: _explicitWorkerNameOutput,
    ...configuredWorkerOptions
  } = managedCloudflareOptions;
  if (
    cloudflareWorkerName(configuredWorkerOptions) !== "takos-managed-selftest"
  ) {
    throw new Error("self-test did not use the explicit app name fallback");
  }
  if (
    publicRuntimeUrl(managedCloudflareOptions, {
      published_endpoint: "https://storage.example.test",
    }) !== "https://storage.example.test"
  ) {
    throw new Error(
      "self-test did not resolve the explicitly mapped runtime URL output",
    );
  }
  const defaultProviderlessOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      appName: "takosumi-keyless-default-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {},
  );
  const defaultProviderlessResult = dryRunResult(defaultProviderlessOptions);
  if (
    defaultProviderlessResult.capsuleModule !== "git-opentofu-capsule" ||
    defaultProviderlessResult.sourceMode !== "git" ||
    !defaultProviderlessResult.steps.includes("compatibilityChecked")
  ) {
    throw new Error(
      "providerless self-test did not default to Git OpenTofu Capsule flow",
    );
  }
  if (
    defaultProviderlessResult.inputs.runnerProfileId !==
      DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID ||
    defaultProviderlessOptions.runnerProfileId !==
      DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID
  ) {
    throw new Error("providerless self-test did not default to generic runner");
  }
  if (
    defaultProviderlessResult.inputs.cloudflareApiTokenSource !== "not_required"
  ) {
    throw new Error(
      "providerless self-test should not require a Cloudflare token",
    );
  }
  if (
    defaultProviderlessOptions.vars.name !==
      "takosumi-keyless-default-selftest" ||
    defaultProviderlessOptions.vars.base_url !==
      "https://takosumi-keyless-default-selftest.example.invalid"
  ) {
    throw new Error("providerless self-test did not default keyless vars");
  }
  const customModuleOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "custom-module-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://github.com/example/custom.git",
      sourcePath: ".",
      varsJson:
        '{"enable_cloudflare_resources":true,"cloudflare_account_id":"acc_selftest","project_name":"custom-module-selftest"}',
      noDefaultVars: true,
      verificationMode: "opentofu",
    },
    {},
  );
  if (
    "target" in customModuleOptions.vars ||
    "cloudflare" in customModuleOptions.vars
  ) {
    throw new Error("no-default-vars self-test leaked smoke defaults");
  }
  if (
    customModuleOptions.vars.project_name !== "custom-module-selftest" ||
    customModuleOptions.vars.enable_cloudflare_resources !== true
  ) {
    throw new Error("no-default-vars self-test lost explicit vars");
  }
  const gitOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://git.example.test/example/takosumi-fixture.git",
      sourceRef: "main",
      sourcePath: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    },
    {},
  );
  const gitResult = dryRunResult(gitOptions);
  const serializedGit = JSON.stringify(gitResult);
  if (gitResult.sourceMode !== "git") {
    throw new Error("self-test did not enable git source mode");
  }
  if (
    !gitResult.steps.includes("sourceRegistered") ||
    !gitResult.steps.includes("sourceSynced")
  ) {
    throw new Error("git self-test result is missing source steps");
  }
  if (
    serializedGit.includes("git.example.test") ||
    serializedGit.includes("takosumi-fixture.git")
  ) {
    throw new Error("git self-test leaked source Git URL");
  }
  const releaseOptions = await resolveOptions(
    {
      dryRun: true,
      requireReleaseActivation: "succeeded",
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      appName: "takosumi-release-selftest",
      sessionTokenFile: "/private/account-session-token",
    },
    {},
  );
  const releaseResult = dryRunResult(releaseOptions);
  if (
    !releaseResult.steps.includes("releaseActivationVerified") ||
    releaseResult.releaseActivation?.status !== "succeeded"
  ) {
    throw new Error("self-test result is missing release activation evidence");
  }
  const failedStartedAtMs = Date.now();
  const failedStartedAt = new Date(failedStartedAtMs).toISOString();
  const failed = failedResult(options, {
    startedAt: failedStartedAt,
    startedAtMs: failedStartedAtMs,
    workspaceId: "ws_selftest",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    connectionId: "conn_selftest",
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: true,
    timedOutRunId: "run_selftest",
    runCancellationStatus: "cancelled",
    error: new Error(
      "GET /api/v1/workspaces failed with Bearer secret-token token=secret cookie=session",
    ),
  });
  const serializedFailed = JSON.stringify(failed);
  if (failed.status !== "failed" || failed.destroyVerified !== false) {
    throw new Error("self-test failed result shape is wrong");
  }
  if (
    serializedFailed.includes("secret-token") ||
    serializedFailed.includes("token=secret") ||
    serializedFailed.includes("cookie=session")
  ) {
    throw new Error("self-test leaked secret-looking failure details");
  }
  const deployTimeout = failedResult(options, {
    startedAt: failedStartedAt,
    startedAtMs: failedStartedAtMs,
    workspaceId: "ws_selftest",
    completedSteps: ["workspaceScopedProviderConnection", "connectionVerified"],
    stepTimings: [
      {
        step: "workspaceScopedProviderConnection",
        startedAt: failedStartedAt,
        finishedAt: failedStartedAt,
        durationMs: 0,
      },
      {
        step: "connectionVerified",
        startedAt: failedStartedAt,
        finishedAt: failedStartedAt,
        durationMs: 0,
      },
    ],
    runTimings: [],
    connectionId: "conn_selftest",
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: true,
    error: new RequestTimeoutError(
      "POST",
      `${API_PREFIX}/workspaces/ws_selftest/install-plans`,
      1,
    ),
  });
  if (
    deployTimeout.status !== "failed" ||
    deployTimeout.capsuleId !== undefined ||
    deployTimeout.planRunId !== undefined ||
    !deployTimeout.nextAction?.includes("install coordinator request timed out")
  ) {
    throw new Error("self-test deploy timeout failed result shape is wrong");
  }
  const originalFetch = globalThis.fetch;
  const selfTestControlPlaneTransport: ControlPlaneTransportDependencies = {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    connector: async (request) => {
      const body = request.body === undefined
        ? undefined
        : request.headers["content-type"] === "application/json"
          ? new TextDecoder().decode(request.body)
          : request.body as unknown as BodyInit;
      return await globalThis.fetch(
        `https://${request.servername}${request.path}`,
        {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          signal: request.signal,
          redirect: "error",
        },
      );
    },
  };
  const workspaceResolveCalls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    workspaceResolveCalls.push(
      `${init?.method ?? "GET"} ${new URL(url).pathname}`,
    );
    if (
      url ===
      "https://app-staging.takosumi.com/api/v1/workspaces?includeArchived=true&limit=100&order=updated_desc"
    ) {
      return new Response(
        JSON.stringify({
          workspaces: [{ id: "ws_other", handle: "other-workspace" }],
          nextCursor: "cursor_next",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url ===
      "https://app-staging.takosumi.com/api/v1/workspaces?includeArchived=true&limit=100&order=updated_desc&cursor=cursor_next"
    ) {
      return new Response(
        JSON.stringify({
          workspaces: [{ id: "ws_existing", handle: "existing-workspace" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected self-test workspace request: ${url}`);
  }) as typeof fetch;
  try {
    const resolved = await controlPlaneTransportContext.run(
      selfTestControlPlaneTransport,
      async () => await resolveWorkspaceId({
        ...options,
        workspace: "@existing-workspace",
        ensureWorkspace: true,
      }),
    );
    if (resolved !== "ws_existing") {
      throw new Error("self-test did not resolve existing Workspace id");
    }
    if (workspaceResolveCalls.some((call) => call.startsWith("POST "))) {
      throw new Error("self-test posted a duplicate Workspace");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (
      url ===
      "https://app-staging.takosumi.com/api/v1/workspaces?includeArchived=true&limit=100&order=updated_desc"
    ) {
      return new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://app-staging.takosumi.com/api/v1/workspaces") {
      return new Response(JSON.stringify({ workspace: { id: "ws_created" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected self-test workspace create request: ${url}`);
  }) as typeof fetch;
  try {
    const created = await controlPlaneTransportContext.run(
      selfTestControlPlaneTransport,
      async () => await resolveWorkspaceId({
        ...options,
        workspace: "@created-workspace",
        ensureWorkspace: true,
      }),
    );
    if (created !== "ws_created") {
      throw new Error("self-test did not accept workspace create response");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const timeoutOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      deployTimeoutSeconds: "7",
    },
    {},
  );
  if (timeoutOptions.deployTimeoutSeconds !== 7) {
    throw new Error("self-test did not parse --deploy-timeout-seconds");
  }
  globalThis.fetch = ((_, init) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  try {
    await controlPlaneTransportContext.run(
      selfTestControlPlaneTransport,
      async () => await requestJson({
        baseUrl: "https://app-staging.takosumi.com",
        token: "redacted",
        method: "POST",
        path: `${API_PREFIX}/workspaces/ws_selftest/install-plans`,
        timeoutMs: 1,
        body: {},
      }),
    );
    throw new Error("self-test requestJson timeout did not fire");
  } catch (error) {
    if (!(error instanceof RequestTimeoutError)) {
      throw error;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("platform control-plane smoke self-test passed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printHelp(): void {
  console.log(`Usage:
  bun run smoke:platform-control-plane -- --url <origin> --workspace <ws_...|@handle> --session-token-file <path> --source-git-url <url>

Required inputs:
  --url <origin>                                  or TAKOSUMI_PLATFORM_URL
  --workspace <ws_...|@handle>                    or TAKOSUMI_SMOKE_WORKSPACE
  --session-token-file <path>                     or TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE / TAKOSUMI_ACCOUNT_SESSION_TOKEN
  --pat-token-file <path>                         or TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE / TAKOSUMI_ACCOUNT_PAT_TOKEN

Cloudflare reference contribution inputs (only when explicitly enabled):
  --cloudflare-api-token-file <path>              or CLOUDFLARE_API_TOKEN_FILE / CLOUDFLARE_API_TOKEN; not required with --cloudflare-connection-mode none
  --cloudflare-account-id-file <path>             or CLOUDFLARE_ACCOUNT_ID_FILE; not required with --cloudflare-connection-mode none
  --cloudflare-account-id <id>                    or CLOUDFLARE_ACCOUNT_ID; not required with --cloudflare-connection-mode none
  --cloudflare-workers-subdomain-file <path>      or CLOUDFLARE_WORKERS_SUBDOMAIN_FILE; only required for cloudflare-worker verification
  --cloudflare-workers-subdomain <name>           or CLOUDFLARE_WORKERS_SUBDOMAIN; only required for cloudflare-worker verification

Options:
  --app-name <name>                               default takosumi-smoke-<random>
  --environment <name>                            explicit evidence label, default smoke
  --ensure-workspace                              create @handle scratch Workspace when missing; validates existing workspace ids
  --workspace-display-name <name>                 display name used with --ensure-workspace
  --cloudflare-connection-mode <guided|generic-env|none> default none; guided/generic-env explicitly enable the Cloudflare reference contribution
  --provider-connection-id <id>                   bind an existing Workspace ProviderConnection; also TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID; mutually exclusive with guided/generic-env and never revoked
  --provider-bindings-json <json>                 explicit array of 0..N {provider,moduleLocalName?,childAlias?,rootAlias?,connectionId}; mutually exclusive with the singular shorthand and guided/generic-env
  --provider-bindings-json-file <path>            read the same non-secret binding array from JSON; or TAKOSUMI_SMOKE_PROVIDER_BINDINGS_JSON_FILE
  --cloudflare-resource-preflight <workers|account-resources|d1|none>
                                                   verify only the capabilities needed by the selected smoke before apply; workers is the Stable EdgeWorker gate, account-resources is the explicit Preview suite
  --runner-profile-id <id>                         request an enabled runner profile for Capsule plans; or TAKOSUMI_SMOKE_RUNNER_PROFILE_ID; providerless OpenTofu defaults to ${DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID}
  --auth-token-kind <session|pat>                 evidence/source label; inferred from --pat-token-file when omitted and never inferred from token prefixes
  --source-git-url <url>                          Git Source URL to sync; required outside dry-run (or TAKOSUMI_SMOKE_SOURCE_GIT_URL)
  --source-ref <ref>                              optional Git ref for --source-git-url; omitted delegates HEAD resolution to Git
  --source-path <path>                            Source archive path inside the Git repo, default .
  --module-path <path>                            OpenTofu Capsule module path inside the SourceSnapshot archive
  --install-config-id <id>                        install config to use for the Capsule, default selectable generic Capsule
  --interface-blueprints-json <json>              optional Interface blueprint array; merged over the built-in Cloudflare hello-worker blueprint
  --interface-blueprints-json-file <path>         read Interface blueprints from one non-secret JSON file; or TAKOSUMI_SMOKE_INTERFACE_BLUEPRINTS_JSON_FILE
  --no-interface-proof                             explicitly disable the built-in Cloudflare Interface lifecycle proof (non-GA/providerless use)
  --interface-token-proof                         opt into OAuth Interface token/use proof; requires --interface-runtime-token-file
  --interface-runtime-token-file <path>           private runtime OAuth token file for the explicit token proof; or TAKOSUMI_SMOKE_INTERFACE_RUNTIME_TOKEN_FILE
  --store-metadata-json <json>                    repository/store presentation metadata copied into Capsule creation
  --store-metadata-json-file <path>               read repository/store presentation metadata from JSON
  --source-name <name>                            Source display name, default <app-name>-source
  --verification-mode <cloudflare-worker|opentofu> default opentofu; cloudflare-worker explicitly enables Cloudflare script/public checks
  --vars-json <json>                              OpenTofu variable object passed to the generated root
  --vars-json-file <path>                         read OpenTofu variable object from a JSON file
  --no-default-vars                               do not merge smoke default variables into --vars-json
  --output-allowlist-json <json>                  explicit output projection object; defaults only to the selected bundled smoke fixture's exact ordinary Output names
  --output-allowlist-json-file <path>             read output projection object from a JSON file
  --public-url-checks-json <json>                 optional array of {output,path,expectedStatus,bodyIncludes[],destroyExpectation:{kind:"http-404"}|{kind:"not-verifiable",reason}} checks against allowlisted public URL outputs
  --public-url-checks-json-file <path>            read public URL checks from a JSON file
  --cloudflare-worker-name-output <name>          optional explicit projected Output name for Cloudflare script verification; otherwise --app-name is authoritative
  --runtime-public-url-output <name>              optional explicit projected URL Output name; otherwise the Cloudflare reference URL is derived from --app-name
  --functional-probe-script <path>                run a local Bun probe after apply/public checks and before destroy; ordinary projected Outputs are available through TAKOSUMI_CAPSULE_OUTPUTS_FILE and stdout must be takosumi.capsule-functional-probe@v1 JSON
  --functional-probe-env <NAME,...>               explicitly forward only these environment variables to the functional probe
  --require-release-activation <any|pending|succeeded|failed|none>
                                                   require a release_activation Activity event for the apply Run; default none
  --expected-service-identity-header <name>        optional provider-neutral immutable service identity header; requires --expected-service-identity
  --expected-service-identity <value>              expected opaque header value; recorded only as SHA-256 digest
  --timeout-seconds <n>                           default 600
  --deploy-timeout-seconds <n>                    default ${DEFAULT_DEPLOY_TIMEOUT_SECONDS}
  --poll-interval-ms <n>                          default 2000
  --out-file <path>                               write once to a new owner-private evidence file outside this source checkout
  --keep-connection                               keep the temporary Workspace ProviderConnection
  --dry-run                                       validate shape and print redacted plan
  --json                                          print JSON only
  --self-test                                     run offline redaction/shape self-test
`);
}
