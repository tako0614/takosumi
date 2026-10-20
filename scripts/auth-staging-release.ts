import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sameGitRemote } from "./lib/platform-release-source.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_COMPATIBILITY_DATE, AUTH_STAGING_CONTROL_SECRETS, AUTH_STAGING_HOST, AUTH_STAGING_ISSUER, AUTH_STAGING_RETRY_CRON, AUTH_STAGING_WORKER, assertAuthStagingVariables, assertAuthStagingUpstreams } from "../deploy/accounts-cloudflare/src/staging-target.ts";
import { CloudflareD1RestTransport } from "../deploy/cloudflare/d1-rest-transport.ts";
import { ensureAccountsD1WorkerSchema } from "../deploy/accounts-cloudflare/src/d1-schema-gate.ts";
import { verifyD1OpenTofuLedgerSchemaPredeployed } from "../worker/src/d1_opentofu_store.ts";
import { assertControlD1MaintenanceInactive } from "../worker/src/d1_schema_maintenance.ts";
import { upstreamOAuthOptionsFromEnvironment } from "../accounts/service/src/upstream-config.ts";
import { OWNER_OPERATION_ENTRYPOINT } from "../accounts/service/src/owner-operation-contract.ts";
import { authStagingOwnerTargetBindingDigest, createAuthStagingOwnerGraphReader, parseAuthStagingOwnerGraphExpectation } from "./auth-staging-owner-graph.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHA = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ID = /^[a-f0-9]{32}$/u;
const BASE_SECRETS = ["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", ...AUTH_STAGING_CLIENTS.map((client) => client.clientSecretEnv), ...AUTH_STAGING_CONTROL_SECRETS];

export type AuthStagingTarget = Readonly<{
  kind: "takosumi.auth-staging-target@v1";
  environment: "staging";
  worker: typeof AUTH_STAGING_WORKER;
  issuer: typeof AUTH_STAGING_ISSUER;
  accountId: string;
  zoneId: string;
  repository: string;
  sourceCommit: string;
  canonicalStageConfigSha256: string;
  canonicalStageVersionId: string;
  jwksSha256: string;
  secretsSha256: string;
  requiredSecrets: readonly string[];
  vars: Readonly<Record<string, string>>;
}>;

type NativeBinding = Readonly<Record<string, unknown> & { name: string; type: string }>;
export type AuthStagingPlan = Readonly<{
  kind: "takosumi.auth-staging-plan@v1";
  sourceCommit: string;
  targetDigest: string;
  configDigest: string;
  artifactDigest: string;
  authorityDigest: string;
  confirmation: string;
  bindings: readonly NativeBinding[];
  requiredSecrets: readonly string[];
}>;

export function parseAuthStagingTarget(value: unknown): AuthStagingTarget {
  if (!record(value) || Object.keys(value).sort().join(",") !== "accountId,canonicalStageConfigSha256,canonicalStageVersionId,environment,issuer,jwksSha256,kind,repository,requiredSecrets,secretsSha256,sourceCommit,vars,worker,zoneId" ||
      value.kind !== "takosumi.auth-staging-target@v1" || value.environment !== "staging" ||
      value.worker !== AUTH_STAGING_WORKER || value.issuer !== AUTH_STAGING_ISSUER ||
      typeof value.accountId !== "string" || !ID.test(value.accountId) ||
      typeof value.zoneId !== "string" || !ID.test(value.zoneId) ||
      typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(value.sourceCommit) ||
      typeof value.repository !== "string" || !sameGitRemote(value.repository, "https://github.com/tako0614/takosumi") ||
      typeof value.canonicalStageVersionId !== "string" || !UUID.test(value.canonicalStageVersionId) ||
      typeof value.canonicalStageConfigSha256 !== "string" || !SHA.test(value.canonicalStageConfigSha256) ||
      typeof value.secretsSha256 !== "string" || !SHA.test(value.secretsSha256) ||
      typeof value.jwksSha256 !== "string" || !SHA.test(value.jwksSha256) ||
      !record(value.vars) || !Array.isArray(value.requiredSecrets)) throw new Error("auth_staging_target_invalid");
  const vars: Record<string, string> = {};
  for (const [name, text] of Object.entries(value.vars)) {
    if (typeof text !== "string" || text.length > 32_768 ||
        !/^(?:TAKOSUMI_ACCOUNTS_[A-Z0-9_]+|TAKOSUMI_ENVIRONMENT|TAKOSUMI_AUTH_WORKER_NAME|TAKOSUMI_CONTROL_D1_SCHEMA_MODE)$/u.test(name) ||
        /(?:SECRET|PRIVATE_JWK|TOKEN)$/u.test(name)) throw new Error("auth_staging_vars_invalid");
    vars[name] = text;
    if (text.startsWith("[") || text.startsWith("{")) {
      try { rejectInlineSecrets(JSON.parse(text)); }
      catch { throw new Error("auth_staging_vars_invalid"); }
    }
  }
  assertAuthStagingVariables(vars);
  const requiredSecrets = value.requiredSecrets;
  const descriptorSecrets = [...BASE_SECRETS, ...assertAuthStagingUpstreams(vars.TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS)];
  if (requiredSecrets.some((name) => typeof name !== "string" || !descriptorSecrets.includes(name)) ||
      new Set(requiredSecrets).size !== requiredSecrets.length ||
      descriptorSecrets.some((name) => !requiredSecrets.includes(name))) throw new Error("auth_staging_secrets_invalid");
  return {
    kind: "takosumi.auth-staging-target@v1", environment: "staging", worker: AUTH_STAGING_WORKER, issuer: AUTH_STAGING_ISSUER,
    accountId: value.accountId, zoneId: value.zoneId, repository: value.repository, sourceCommit: value.sourceCommit,
    canonicalStageConfigSha256: value.canonicalStageConfigSha256, canonicalStageVersionId: value.canonicalStageVersionId,
    secretsSha256: value.secretsSha256, jwksSha256: value.jwksSha256,
    vars, requiredSecrets: requiredSecrets.map((name: unknown) => { if (typeof name !== "string") throw new Error("auth_staging_secrets_invalid"); return name; }),
  };
}

/** Derive resources from the already-qualified platform config, never caller substitutions. */
export function authStagingResourceBindings(canonicalConfig: string, target: AuthStagingTarget): readonly NativeBinding[] {
  if (digest(canonicalConfig) !== target.canonicalStageConfigSha256) throw new Error("auth_staging_canonical_config_digest_mismatch");
  let config: unknown;
  try { config = Bun.TOML.parse(canonicalConfig); }
  catch { throw new Error("auth_staging_canonical_config_invalid"); }
  if (!record(config) || config.name !== "takosumi-staging" || !record(config.vars) ||
      config.vars.TAKOSUMI_ENVIRONMENT !== "staging" ||
      config.vars.TAKOSUMI_ACCOUNTS_ISSUER !== "https://app-staging.takosumi.com" ||
      config.vars.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE !== "predeployed" ||
      config.vars.TAKOSUMI_CONTROL_D1_SCHEMA_MODE !== "predeployed") throw new Error("auth_staging_canonical_config_invalid");
  const bindings: NativeBinding[] = [];
  for (const name of ["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"]) {
    const resource = exactNamed(config.d1_databases, "binding", name);
    if (typeof resource.database_id !== "string" || !UUID.test(resource.database_id)) throw new Error("auth_staging_database_invalid");
    bindings.push({ name, type: "d1", id: resource.database_id });
  }
  if (bindings[0]?.id === bindings[1]?.id) throw new Error("auth_staging_database_alias_invalid");
  for (const name of ["R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS"]) {
    const resource = exactNamed(config.r2_buckets, "binding", name);
    if (typeof resource.bucket_name !== "string" || !resource.bucket_name.includes("staging")) throw new Error("auth_staging_bucket_invalid");
    bindings.push({ name, type: "r2_bucket", bucket_name: resource.bucket_name });
  }
  if (!record(config.durable_objects)) throw new Error("auth_staging_durable_objects_invalid");
  for (const [name, className] of [["COORDINATION", "CoordinationObject"], ["RUN_OWNER", "OpenTofuRunOwnerObject"], ["RUNNER", "OpenTofuRunnerObject"]]) {
    const resource = exactNamed(config.durable_objects.bindings, "name", name!);
    if (resource.class_name !== className || resource.script_name !== undefined) throw new Error("auth_staging_durable_objects_invalid");
    bindings.push({ name: name!, type: "durable_object_namespace", class_name: className, script_name: "takosumi-staging" });
  }
  return bindings;
}

export function createAuthStagingPlan(target: AuthStagingTarget, canonicalConfig: string, artifact: Uint8Array): AuthStagingPlan {
  const bindings = authStagingResourceBindings(canonicalConfig, target);
  const configDigest = digest(JSON.stringify({ bindings, vars: target.vars, requiredSecrets: target.requiredSecrets.slice().sort(), jwksSha256: target.jwksSha256, compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"], handlers: ["fetch", "scheduled"], retryCron: AUTH_STAGING_RETRY_CRON }));
  const authorityDigest = digest(JSON.stringify({ kind: "takosumi.auth-staging-authority@v1", configDigest, secretsSha256: target.secretsSha256 }));
  const body = { kind: "takosumi.auth-staging-plan@v1" as const, sourceCommit: target.sourceCommit, targetDigest: digest(JSON.stringify(target)), configDigest, artifactDigest: digest(artifact), authorityDigest, bindings, requiredSecrets: target.requiredSecrets };
  return { ...body, confirmation: digest(JSON.stringify(body)) };
}

export type AuthStagingProvider = Readonly<{
  request(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: BodyInit): Promise<unknown>;
}>;
export type AuthStagingReleaseRuntime = Readonly<{
  provider: AuthStagingProvider;
  verifySchema(target: AuthStagingTarget, bindings: readonly NativeBinding[]): Promise<void>;
  publicReadback(version: string, plan: AuthStagingPlan): Promise<void>;
  bootstrap(target: AuthStagingTarget): Promise<void>;
}>;

/** Read-only topology/metadata and actual schema checks after versions exist.
 * Owning release source/build/upload custody remains a separate, unavailable
 * prerequisite. This does not activate a binding or supply owner readiness. */
export async function inspectAuthStagingOwnerReleaseTopology(input: {
  readonly target: AuthStagingTarget;
  readonly plan: AuthStagingPlan;
  readonly expectation: unknown;
}, runtime: AuthStagingReleaseRuntime) {
  const target = parseAuthStagingTarget(input.target), expected = parseAuthStagingOwnerGraphExpectation(input.expectation);
  assertPlanClosure(input.plan, target);
  const targetBindingDigest = authStagingOwnerTargetBindingDigest(expected);
  if (expected.issuer.worker !== target.worker || expected.issuer.sourceCommit !== target.sourceCommit ||
    expected.issuer.sourceCommitBinding !== "TAKOSUMI_AUTH_SOURCE_COMMIT" ||
    target.vars.TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID !== expected.ownerClientId ||
    target.vars.TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST !== targetBindingDigest ||
    !input.plan.bindings.some((binding) => binding.type === "d1" && binding.name === "TAKOSUMI_ACCOUNTS_DB" && binding.id === expected.issuer.accountsDatabaseId) ||
    !input.plan.bindings.some((binding) => binding.type === "d1" && binding.name === "TAKOSUMI_CONTROL_DB" && binding.id === expected.issuer.controlDatabaseId)) {
    throw new Error("auth_staging_owner_release_target_mismatch");
  }
  assertAuthStagingVersion(await runtime.provider.request("GET", `/workers/scripts/${target.worker}/versions/${expected.issuer.versionId}`), input.plan, target);
  await assertTopology(runtime.provider, target, true);
  const qualification = await createAuthStagingOwnerGraphReader(runtime.provider).qualify(expected);
  await runtime.verifySchema(target, input.plan.bindings);
  return qualification;
}

/** The exact handler surface the provider reports for `entry-worker.ts`: the
 * default export's members and each named WorkerEntrypoint's methods. Any
 * additional or missing entrypoint or method is a different artifact. */
export const AUTH_STAGING_DEFAULT_HANDLERS = ["fetch", "scheduled"] as const;
export const AUTH_STAGING_NAMED_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  AccountsFinancialProof: ["fetch", "loadFinancialIdentityProof", "prove", "verifyCurrentFinancialIdentityProof"],
  [OWNER_OPERATION_ENTRYPOINT]: ["readOwnerOperation"],
};

function sameNames(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every((name) => typeof name === "string") &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function exactHandlerSurface(script: Record<string, unknown>): boolean {
  const named = script.named_handlers;
  if (!sameNames(script.handlers, AUTH_STAGING_DEFAULT_HANDLERS) || !Array.isArray(named) ||
      named.length !== Object.keys(AUTH_STAGING_NAMED_HANDLERS).length) return false;
  return Object.entries(AUTH_STAGING_NAMED_HANDLERS).every(([name, handlers]) => {
    const matches = named.filter((entry) => record(entry) && entry.name === name);
    return matches.length === 1 && sameNames(matches[0]!.handlers, handlers);
  });
}

/** Metadata-only readback. Never accept extra authority or a second physical store. */
export function assertAuthStagingVersion(value: unknown, plan: AuthStagingPlan, target: AuthStagingTarget): void {
  if (!record(value) || !record(value.resources) || !Array.isArray(value.resources.bindings) || !record(value.resources.script) ||
      !record(value.resources.script_runtime) || value.resources.script_runtime.compatibility_date !== AUTH_STAGING_COMPATIBILITY_DATE ||
      JSON.stringify(value.resources.script_runtime.compatibility_flags) !== JSON.stringify(["nodejs_compat"])) throw new Error("auth_staging_version_invalid");
  if (!exactHandlerSurface(value.resources.script)) throw new Error("auth_staging_entrypoint_invalid");
  if (target.vars.TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST !== undefined &&
      (!record(value.resources.script_runtime.exports) ||
       !record(value.resources.script_runtime.exports[OWNER_OPERATION_ENTRYPOINT]) ||
       value.resources.script_runtime.exports[OWNER_OPERATION_ENTRYPOINT].type !== "worker")) throw new Error("auth_staging_owner_entrypoint_invalid");
  const actual = value.resources.bindings;
  const expected = [...plan.bindings, ...Object.entries(target.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "TAKOSUMI_AUTH_ARTIFACT_DIGEST", type: "plain_text", text: plan.artifactDigest },
    { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: plan.authorityDigest },
    { name: "TAKOSUMI_AUTH_SOURCE_COMMIT", type: "plain_text", text: target.sourceCommit },
    { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
    ...target.requiredSecrets.map((name) => ({ name, type: "secret_text" }))];
  if (actual.length !== expected.length) throw new Error("auth_staging_binding_set_invalid");
  for (const binding of expected) {
    const current = exactNamed(actual, "name", binding.name);
    if (current.type !== binding.type || Object.entries(binding).some(([name, field]) => current[name] !== field)) throw new Error("auth_staging_binding_identity_mismatch");
  }
}

export async function executeAuthStagingRelease(input: {
  action: "bootstrap" | "authority" | "code" | "topology";
  target: AuthStagingTarget;
  plan: AuthStagingPlan;
  artifact: Uint8Array;
  secrets: Readonly<Record<string, string>>;
  confirmation: string;
  reviewer?: string;
}, runtime: AuthStagingReleaseRuntime): Promise<Readonly<Record<string, unknown>>> {
  const { target, plan, action } = input;
  // Revalidate the closed target and bytes before any provider request.
  parseAuthStagingTarget(target);
  assertPlanClosure(plan, target);
  if (digest(input.artifact) !== plan.artifactDigest || input.confirmation !== plan.confirmation ||
      plan.targetDigest !== digest(JSON.stringify(target))) throw new Error("auth_staging_confirmation_mismatch");
  if (action !== "code" && (!input.reviewer || !/^[^\r\n]{3,128}$/u.test(input.reviewer))) throw new Error("auth_staging_independent_review_required");
  if (action === "code" || action === "authority") {
    validateSecrets(input.secrets, target);
    await validateSigningSecrets(input.secrets, target);
    try { upstreamOAuthOptionsFromEnvironment({ ...target.vars, ...input.secrets }); }
    catch { throw new Error("auth_staging_upstream_configuration_invalid"); }
  }
  const script = `/workers/scripts/${AUTH_STAGING_WORKER}`;
  const settings = await runtime.provider.request("GET", `${script}/script-settings`);
  let touched = false;
  const releaseTag = `auth-stage-${randomUUID()}`;
  let uploadedVersion: string | undefined;
  let predecessor: string | undefined;
  try {
    if (action === "bootstrap") {
      if (settings !== null) throw new Error("auth_staging_bootstrap_existing_worker");
      touched = true;
      await runtime.bootstrap(target);
      await assertTopology(runtime.provider, target, false);
      return { status: "inert-slot-created", worker: AUTH_STAGING_WORKER, issuerActive: false };
    }
    if (settings === null) throw new Error("auth_staging_bootstrap_required");
    const canonicalNamespaces = await assertCanonicalBindings(runtime.provider, target, plan);
    await runtime.verifySchema(target, plan.bindings);
    predecessor = servingVersion(await runtime.provider.request("GET", `${script}/deployments`));
    if (action === "topology") {
      const version = await runtime.provider.request("GET", `${script}/versions/${predecessor}`);
      assertAuthStagingVersion(version, plan, target);
      assertCanonicalNamespaces(version, canonicalNamespaces);
      const retryPrepared = await assertTopology(runtime.provider, target, false, true);
      touched = true;
      if (!retryPrepared) {
        await runtime.provider.request("PUT", `${script}/schedules`, JSON.stringify([{cron:AUTH_STAGING_RETRY_CRON}]));
        if (!await assertTopology(runtime.provider, target, false, true)) throw new Error("auth_staging_schedule_readback_mismatch");
      }
      await runtime.provider.request("PUT", "/workers/domains", JSON.stringify({ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: target.zoneId, enabled: true, previews_enabled: false }));
      await assertTopology(runtime.provider, target, true);
      await runtime.publicReadback(predecessor, plan);
      return { status: "ready", sourceCommit: target.sourceCommit, version: predecessor, artifactDigest: plan.artifactDigest, authorityDigest: plan.authorityDigest };
    }
    // A reviewed authority change may also replace the authority of an issuer
    // that is already served; its domain and retry schedule stay attached and
    // the new Version is read back publicly before the change is reported.
    const active = action === "code" || (action === "authority" && await topologyActive(runtime.provider));
    await assertTopology(runtime.provider, target, active);
    validateSecrets(input.secrets, target);
    if (action === "code") {
      const before = await runtime.provider.request("GET", `${script}/versions/${predecessor}`);
      // Source/artifact may differ; all authority, stores, registrations and private
      // secret custody must be the same as the reviewed predecessor.
      assertCodeAuthority(before, plan, target);
    }
    const metadata = uploadMetadata(target, plan, input.secrets, releaseTag);
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("auth.mjs", new Blob([new Uint8Array(input.artifact)], { type: "application/javascript+module" }), "auth.mjs");
    touched = true;
    const upload = await runtime.provider.request("POST", `${script}/versions`, form);
    if (!record(upload) || typeof upload.id !== "string" || !UUID.test(upload.id)) throw new Error("auth_staging_upload_identity_invalid");
    uploadedVersion = upload.id;
    const version = await runtime.provider.request("GET", `${script}/versions/${uploadedVersion}`);
    assertAuthStagingVersion(version, plan, target);
    assertCanonicalNamespaces(version, canonicalNamespaces);
    // Lost upload/activation acknowledgements are never retried. Current serving
    // predecessor is rechecked before the one explicit activation.
    if (servingVersion(await runtime.provider.request("GET", `${script}/deployments`)) !== predecessor) throw new Error("auth_staging_concurrent_deployment");
    await runtime.provider.request("POST", `${script}/deployments`, JSON.stringify({ strategy: "percentage", versions: [{ version_id: uploadedVersion, percentage: 100 }] }));
    if (servingVersion(await runtime.provider.request("GET", `${script}/deployments`)) !== uploadedVersion) throw new Error("auth_staging_activation_readback_mismatch");
    await assertTopology(runtime.provider, target, active);
    if (active) await runtime.publicReadback(uploadedVersion, plan);
    return { status: action === "code" ? "ready" : active ? "authority-ready-served" : "authority-ready-route-disabled", sourceCommit: target.sourceCommit, artifactDigest: plan.artifactDigest, authorityDigest: plan.authorityDigest, releaseTag, predecessor, version: uploadedVersion, reversal: "explicit owner code restore to recorded predecessor while schema compatible; no database rollback" };
  } catch (error) {
    if (!touched) throw error;
    const reason = error instanceof Error && /^auth_staging_[a-z0-9_]+$/u.test(error.message) ? error.message : "dependency_failed";
    throw new AuthStagingIncompleteError({ action, predecessor, uploadedVersion, releaseTag, reason });
  }
}

export class AuthStagingIncompleteError extends Error {
  constructor(readonly recovery: { action: string; predecessor?: string; uploadedVersion?: string; releaseTag?: string; reason?: string }) {
    super("auth_staging_mutation_incomplete_read_provider_history_no_retry");
  }
}

function uploadMetadata(target: AuthStagingTarget, plan: AuthStagingPlan, secrets: Readonly<Record<string, string>>, releaseTag: string) {
  return {
    main_module: "auth.mjs", compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"],
    annotations: { "workers/commit_sha": target.sourceCommit, "workers/tag": releaseTag },
    bindings: [...plan.bindings, ...Object.entries(target.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      { name: "TAKOSUMI_AUTH_ARTIFACT_DIGEST", type: "plain_text", text: plan.artifactDigest },
      { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: plan.authorityDigest },
      { name: "TAKOSUMI_AUTH_SOURCE_COMMIT", type: "plain_text", text: target.sourceCommit },
      { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
      ...Object.entries(secrets).map(([name, text]) => ({ name, type: "secret_text", text }))],
    observability: { enabled: true, head_sampling_rate: 1 },
  };
}

function assertPlanClosure(plan: AuthStagingPlan, target: AuthStagingTarget): void {
  const configDigest = digest(JSON.stringify({ bindings: plan.bindings, vars: target.vars, requiredSecrets: target.requiredSecrets.slice().sort(), jwksSha256: target.jwksSha256, compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"], handlers: ["fetch", "scheduled"], retryCron: AUTH_STAGING_RETRY_CRON }));
  const authorityDigest = digest(JSON.stringify({ kind: "takosumi.auth-staging-authority@v1", configDigest, secretsSha256: target.secretsSha256 }));
  const body = { kind: "takosumi.auth-staging-plan@v1", sourceCommit: target.sourceCommit, targetDigest: digest(JSON.stringify(target)), configDigest, artifactDigest: plan.artifactDigest, authorityDigest, bindings: plan.bindings, requiredSecrets: target.requiredSecrets };
  if (plan.kind !== body.kind || plan.sourceCommit !== target.sourceCommit ||
      plan.configDigest !== configDigest || plan.authorityDigest !== authorityDigest ||
      plan.targetDigest !== body.targetDigest || !SHA.test(plan.artifactDigest) ||
      JSON.stringify(plan.requiredSecrets) !== JSON.stringify(target.requiredSecrets) ||
      plan.confirmation !== digest(JSON.stringify(body))) throw new Error("auth_staging_plan_closure_invalid");
}

function assertCodeAuthority(value: unknown, plan: AuthStagingPlan, target: AuthStagingTarget): void {
  if (!record(value) || !record(value.resources) || !Array.isArray(value.resources.bindings)) throw new Error("auth_staging_code_authority_invalid");
  const bindings = value.resources.bindings;
  const authority = exactNamed(bindings, "name", "TAKOSUMI_AUTH_AUTHORITY_DIGEST");
  if (authority.type !== "plain_text" || authority.text !== plan.authorityDigest) throw new Error("auth_staging_code_authority_drift");
  const artifact = exactNamed(bindings, "name", "TAKOSUMI_AUTH_ARTIFACT_DIGEST");
  const source = exactNamed(bindings, "name", "TAKOSUMI_AUTH_SOURCE_COMMIT");
  if (typeof artifact.text !== "string" || !SHA.test(artifact.text) || typeof source.text !== "string" || !/^[a-f0-9]{40}$/u.test(source.text)) throw new Error("auth_staging_code_predecessor_invalid");
  assertAuthStagingVersion(value, { ...plan, artifactDigest: artifact.text }, { ...target, sourceCommit: source.text });
}

async function assertCanonicalBindings(provider: AuthStagingProvider, target: AuthStagingTarget, plan: Pick<AuthStagingPlan, "bindings">): Promise<Readonly<Record<string, string>>> {
  const value = await provider.request("GET", `/workers/scripts/takosumi-staging/versions/${target.canonicalStageVersionId}`);
  if (servingVersion(await provider.request("GET", "/workers/scripts/takosumi-staging/deployments")) !== target.canonicalStageVersionId) throw new Error("auth_staging_canonical_version_not_current");
  // The Workers versions API returns `resources.bindings` as the binding array itself.
  if (!record(value) || !record(value.resources) || !Array.isArray(value.resources.bindings)) throw new Error("auth_staging_canonical_version_invalid");
  const namespaces: Record<string, string> = {};
  for (const binding of plan.bindings) {
    const actual = exactNamed(value.resources.bindings, "name", binding.name);
    if (actual.type !== binding.type || (binding.type === "d1" && actual.id !== binding.id) ||
        (binding.type === "r2_bucket" && actual.bucket_name !== binding.bucket_name) ||
        (binding.type === "durable_object_namespace" && (actual.class_name !== binding.class_name || typeof actual.namespace_id !== "string" || actual.namespace_id.length === 0))) throw new Error("auth_staging_canonical_binding_mismatch");
    if (binding.type === "durable_object_namespace") namespaces[binding.name] = String(actual.namespace_id);
  }
  return namespaces;
}

function assertCanonicalNamespaces(value: unknown, namespaces: Readonly<Record<string, string>>): void {
  if (!record(value) || !record(value.resources) || !Array.isArray(value.resources.bindings)) throw new Error("auth_staging_namespace_readback_invalid");
  for (const [name, namespaceId] of Object.entries(namespaces)) {
    if (exactNamed(value.resources.bindings, "name", name).namespace_id !== namespaceId) throw new Error("auth_staging_namespace_readback_mismatch");
  }
}

async function assertTopology(provider: AuthStagingProvider, target: AuthStagingTarget, active: boolean, allowPreparedRetry = false): Promise<boolean> {
  const script = `/workers/scripts/${AUTH_STAGING_WORKER}`;
  const subdomain = await provider.request("GET", `${script}/subdomain`);
  const scheduleResponse = await provider.request("GET", `${script}/schedules`);
  const schedules = record(scheduleResponse) ? scheduleResponse.schedules : undefined;
  const retryPrepared = Array.isArray(schedules) && schedules.length === 1 && record(schedules[0]) && schedules[0].cron === AUTH_STAGING_RETRY_CRON;
  const domains = await provider.request("GET", `/workers/domains?service=${AUTH_STAGING_WORKER}&environment=production`);
  const routes = await provider.request("GET", `/zones/${target.zoneId}/workers/routes`);
  if (!record(subdomain) || subdomain.enabled !== false || subdomain.previews_enabled !== false ||
      !Array.isArray(schedules) || (active ? !retryPrepared : schedules.length !== 0 && !(allowPreparedRetry && retryPrepared)) || !Array.isArray(domains) || !Array.isArray(routes) ||
      routes.some((route) => record(route) && route.script === AUTH_STAGING_WORKER)) throw new Error("auth_staging_topology_invalid");
  if (!active && domains.length !== 0) throw new Error("auth_staging_topology_already_active");
  if (active && (domains.length !== 1 || !record(domains[0]) || domains[0].hostname !== AUTH_STAGING_HOST || domains[0].service !== AUTH_STAGING_WORKER || domains[0].zone_id !== target.zoneId || domains[0].enabled !== true || domains[0].previews_enabled !== false)) throw new Error("auth_staging_domain_readback_mismatch");
  // Refuse reassignment, including an existing domain owned by another Worker.
  if (!active) {
    const owners = await provider.request("GET", `/workers/domains?hostname=${AUTH_STAGING_HOST}`);
    if (!Array.isArray(owners) || owners.length !== 0) throw new Error("auth_staging_domain_already_owned");
  }
  return retryPrepared;
}

async function topologyActive(provider: AuthStagingProvider): Promise<boolean> {
  const domains = await provider.request("GET", `/workers/domains?service=${AUTH_STAGING_WORKER}&environment=production`);
  if (!Array.isArray(domains)) throw new Error("auth_staging_topology_invalid");
  return domains.length !== 0;
}

function servingVersion(value: unknown): string {
  if (!record(value) || !Array.isArray(value.deployments) || !record(value.deployments[0]) || !Array.isArray(value.deployments[0].versions)) throw new Error("auth_staging_deployment_invalid");
  const versions = value.deployments[0].versions;
  if (versions.length !== 1 || !record(versions[0]) || versions[0].percentage !== 100 || typeof versions[0].version_id !== "string" || !UUID.test(versions[0].version_id)) throw new Error("auth_staging_deployment_not_exact");
  return versions[0].version_id;
}

function validateSecrets(secrets: Readonly<Record<string, string>>, target: AuthStagingTarget): void {
  if (JSON.stringify(Object.keys(secrets).sort()) !== JSON.stringify(target.requiredSecrets.slice().sort()) ||
      Object.values(secrets).some((text) => typeof text !== "string" || !text.trim() || text.length > 16_384)) throw new Error("auth_staging_secret_bundle_invalid");
  for (const client of AUTH_STAGING_CLIENTS) {
    const secret = secrets[client.clientSecretEnv]!;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret) || Buffer.from(secret, "base64url").length !== 32 || Buffer.from(secret, "base64url").toString("base64url") !== secret) throw new Error("auth_staging_client_secret_invalid");
  }
  if (secrets[AUTH_STAGING_CLIENTS[0].clientSecretEnv] === secrets[AUTH_STAGING_CLIENTS[1].clientSecretEnv]) throw new Error("auth_staging_client_secrets_not_separate");
  for (const name of AUTH_STAGING_CONTROL_SECRETS) {
    if (Object.entries(secrets).some(([other, value]) => other !== name && value === secrets[name])) throw new Error("auth_staging_control_secrets_not_separate");
  }
}

async function validateSigningSecrets(secrets: Readonly<Record<string, string>>, target: AuthStagingTarget): Promise<void> {
  try {
    const value: unknown = JSON.parse(secrets.TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK!);
    if (!record(value) || value.kty !== "EC" || value.crv !== "P-256" ||
        typeof value.d !== "string" || typeof value.x !== "string" || typeof value.y !== "string") throw new Error();
    const kid = target.vars.TAKOSUMI_ACCOUNTS_ES256_KEY_ID;
    if (!kid || !/^[A-Za-z0-9._-]{3,128}$/u.test(kid)) throw new Error();
    const privateKey = await crypto.subtle.importKey("jwk", value, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const current = { kty: "EC", crv: "P-256", x: value.x, y: value.y, kid, use: "sig", alg: "ES256" };
    const publicKey = await crypto.subtle.importKey("jwk", current, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const challenge = new TextEncoder().encode("takosumi.auth-staging-signing-config@v1");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) throw new Error();
    const prior = target.vars.TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS;
    const parsed: unknown = prior ? JSON.parse(prior) : [];
    const previous = Array.isArray(parsed) ? parsed : record(parsed) ? parsed.keys : undefined;
    if (!Array.isArray(previous)) throw new Error();
    const keys: unknown[] = [current, ...previous];
    const kids = new Set<string>();
    for (const key of keys) {
      if (!record(key) || Object.hasOwn(key, "d") || key.kty !== "EC" || key.crv !== "P-256" ||
          typeof key.kid !== "string" || !key.kid || kids.has(key.kid)) throw new Error();
      await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      kids.add(key.kid);
    }
    if (publicJwksDigest(keys) !== target.jwksSha256) throw new Error();
    for (const name of ["TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", ...AUTH_STAGING_CONTROL_SECRETS]) {
      if (new TextEncoder().encode(secrets[name]).byteLength < 32) throw new Error();
    }
  } catch { throw new Error("auth_staging_signing_configuration_invalid"); }
}

function publicJwksDigest(keys: readonly unknown[]): string {
  const publicKeys = keys.map((key) => {
    if (!record(key) || Object.hasOwn(key, "d")) throw new Error("auth_staging_jwks_invalid");
    return { kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: key.kid, use: "sig", alg: "ES256" };
  }).sort((left, right) => String(left.kid).localeCompare(String(right.kid)));
  return digest(JSON.stringify({ keys: publicKeys }));
}

function exactNamed(value: unknown, field: string, name: string): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error("auth_staging_binding_invalid");
  const matches = value.filter((item) => record(item) && item[field] === name);
  if (matches.length !== 1 || !record(matches[0])) throw new Error("auth_staging_binding_invalid");
  return matches[0];
}

function rejectInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(rejectInlineSecrets);
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:clientSecret|secret|privateKey|privateJwk|accessToken)$/iu.test(key)) throw new Error("auth_staging_inline_secret_forbidden");
    rejectInlineSecrets(child);
  }
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable no-follow custody; no credential-bearing file can live in a Git checkout. */
function privateFile(path: string): Uint8Array {
  if (!isAbsolute(path) || path !== realpathSync(path)) throw new Error("auth_staging_private_file_invalid");
  let ancestor = resolve(path, "..");
  while (ancestor !== resolve(ancestor, "..")) {
    try { lstatSync(join(ancestor, ".git")); throw new Error("auth_staging_private_file_in_repository"); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    ancestor = resolve(ancestor, "..");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.size > 256_000n) throw new Error("auth_staging_private_file_invalid");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("auth_staging_private_file_changed");
    return bytes;
  } finally { closeSync(fd); }
}

export async function runAuthStagingRelease(surface: string, argv: readonly string[]): Promise<void> {
  const action = argv[0];
  const actions: Record<string, string> = { "takosumi-auth-staging-bootstrap": "bootstrap", "takosumi-auth-staging-authority": "authority", "takosumi-auth-staging-code": "code", "takosumi-auth-staging-topology": "topology" };
  if (!actions[surface] || (action !== "plan" && action !== "apply")) throw new Error("auth_staging_action_invalid");
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !["--target", "--canonical-config", "--secrets", "--confirm", "--reviewer"].includes(flag) || value === undefined || options[flag]) throw new Error("auth_staging_arguments_invalid");
    options[flag] = value;
  }
  if (!options["--target"] || !options["--canonical-config"]) throw new Error("auth_staging_arguments_invalid");
  const targetBytes = privateFile(options["--target"]);
  const canonicalBytes = privateFile(options["--canonical-config"]);
  const target = parseAuthStagingTarget(privateJson(targetBytes));
  await assertSelectedSource(target);
  const entry = surface === "takosumi-auth-staging-bootstrap" ? "staging-bootstrap.ts" : "entry-worker.ts";
  const build = await Bun.build({ entrypoints: [join(ROOT, "deploy/accounts-cloudflare/src", entry)], target: "browser", format: "esm", external: ["cloudflare:workers"] });
  if (!build.success || build.outputs.length !== 1) throw new Error("auth_staging_build_failed");
  const artifact = new Uint8Array(await build.outputs[0]!.arrayBuffer());
  await assertSelectedSource(target);
  const plan = createAuthStagingPlan(target, new TextDecoder().decode(canonicalBytes), artifact);
  if (action === "plan") { process.stdout.write(`${JSON.stringify(plan)}\n`); return; }
  if (!options["--confirm"]) throw new Error("auth_staging_confirmation_required");
  let secrets: Record<string, string> = {};
  if (actions[surface] === "authority" || actions[surface] === "code") {
    if (!options["--secrets"]) throw new Error("auth_staging_secrets_required");
    const bytes = privateFile(options["--secrets"]);
    if (digest(bytes) !== target.secretsSha256) throw new Error("auth_staging_secret_custody_mismatch");
    const value = privateJson(bytes);
    if (!record(value) || Object.values(value).some((text) => typeof text !== "string")) throw new Error("auth_staging_secret_bundle_invalid");
    secrets = Object.fromEntries(Object.entries(value).map(([name, text]) => [name, String(text)]));
    validateSecrets(secrets, target);
  }
  const token = await authToken(target.accountId);
  const provider = nativeProvider(target, token);
  const runtime: AuthStagingReleaseRuntime = {
    provider,
    verifySchema: async (_, bindings) => {
      const boundedFetch: typeof fetch = Object.assign((url: RequestInfo | URL, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: "error" }), { preconnect: fetch.preconnect });
      const database = (name: string) => new CloudflareD1RestTransport({ accountId: target.accountId, databaseId: String(exactNamed(bindings, "name", name).id), apiToken: token, fetch: boundedFetch });
      const evidence = await ensureAccountsD1WorkerSchema(database("TAKOSUMI_ACCOUNTS_DB"));
      if (Number(evidence.headVersion) !== 5) throw new Error("auth_staging_accounts_v5_required");
      const control = database("TAKOSUMI_CONTROL_DB");
      await verifyD1OpenTofuLedgerSchemaPredeployed(control);
      await assertControlD1MaintenanceInactive(control);
    },
    bootstrap: async () => {
      const directory = mkdtempSync(join(tmpdir(), "takosumi-auth-staging-bootstrap-"));
      try {
        const config = join(directory, "wrangler.json");
        const sealedEntry = join(directory, "inert.mjs");
        writeFileSync(sealedEntry, artifact, { mode: 0o600 });
        writeFileSync(config, JSON.stringify({ name: AUTH_STAGING_WORKER, account_id: target.accountId, compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, main: sealedEntry, workers_dev: false, preview_urls: false, routes: [] }), { mode: 0o600 });
        command([join(ROOT, "node_modules/.bin/wrangler"), "deploy", "--no-bundle", "--config", config]);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
    publicReadback: (version, currentPlan) => verifyPublicAuthStaging(version, currentPlan, target.jwksSha256),
  };
  try {
    const result = await executeAuthStagingRelease({ action: actions[surface] as "bootstrap" | "authority" | "code" | "topology", target, plan, artifact, secrets, confirmation: options["--confirm"], reviewer: options["--reviewer"] }, runtime);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof AuthStagingIncompleteError) process.stdout.write(`${JSON.stringify({ status: "incomplete", ...error.recovery, next: "Read exact provider version/deployment/domain history; no mutation retried; preserve schema and repair forward." })}\n`);
    throw error;
  }
}

/** One schema writer: guarded delegation to the existing Accounts owner CLI. */
export async function runAuthStagingAccountsSchema(argv: readonly string[]): Promise<number> {
  const mode = argv[0];
  if (!mode || !["plan", "backup-status", "status", "verify", "apply"].includes(mode)) throw new Error("auth_staging_schema_action_invalid");
  const options: Record<string, string> = {};
  const allowed = ["--target", "--canonical-config", "--reviewer", "--rehearsal-digest", "--out", "--backup-evidence-digest", "--confirm-source-digest", "--confirm-catalog-digest", "--confirm-target-digest", "--confirm-configuration-digest"];
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.includes(flag) || !value || options[flag]) throw new Error("auth_staging_schema_arguments_invalid");
    options[flag] = value;
  }
  if (!options["--target"] || !options["--canonical-config"]) throw new Error("auth_staging_schema_arguments_invalid");
  const target = parseAuthStagingTarget(privateJson(privateFile(options["--target"])));
  const bindings = authStagingResourceBindings(new TextDecoder().decode(privateFile(options["--canonical-config"])), target);
  await assertSelectedSource(target);
  const args = [mode, "--environment", "staging", "--account-id", target.accountId, "--database-id", String(exactNamed(bindings, "name", "TAKOSUMI_ACCOUNTS_DB").id), "--source-commit", target.sourceCommit];
  if (mode === "apply" && (!options["--reviewer"] || !/^[^\r\n]{3,128}$/u.test(options["--reviewer"]) || !SHA.test(options["--rehearsal-digest"] ?? ""))) throw new Error("auth_staging_schema_independent_review_required");
  for (const [flag, value] of Object.entries(options)) {
    if (!["--target", "--canonical-config", "--reviewer", "--rehearsal-digest"].includes(flag)) args.push(flag, value);
  }
  const { runAccountsMigrateD1 } = await import("../cli/src/cli-accounts-commands.ts");
  // Planning is local. Every credential-bearing read or mutation first proves
  // the ID belongs to the current qualified staging Worker, not just two
  // mutually consistent caller files.
  let apiToken: string | undefined;
  if (mode !== "plan") {
    apiToken = await authToken(target.accountId);
    const provider = nativeProvider(target, apiToken);
    await verifyAuthStagingSchemaTarget(provider, target, bindings);
  }
  return await runAccountsMigrateD1(args, { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) }, { ...(apiToken ? { apiToken } : {}) });
}

export async function verifyAuthStagingSchemaTarget(provider: AuthStagingProvider, target: AuthStagingTarget, bindings: readonly NativeBinding[]): Promise<void> {
  parseAuthStagingTarget(target);
  await assertCanonicalBindings(provider, target, { bindings });
}

async function assertSelectedSource(target: AuthStagingTarget): Promise<void> {
  const { inspectAccountsD1SourceCheckout } = await import("../cli/src/cli-accounts-commands.ts");
  const source = await inspectAccountsD1SourceCheckout({ sourceRoot: ROOT });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-C", ROOT, ...args], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
  }).trim();
  if (source.commit !== target.sourceCommit || source.status || !sameGitRemote(git("remote", "get-url", "origin"), target.repository)) throw new Error("auth_staging_source_mismatch");
  try { git("merge-base", "--is-ancestor", target.sourceCommit, "origin/main"); }
  catch { throw new Error("auth_staging_source_not_merged"); }
}

function privateJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("auth_staging_private_json_invalid"); }
}

function command(argv: readonly string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  } catch { throw new Error("auth_staging_owner_command_failed"); }
}

async function authToken(accountId: string): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) throw new Error("auth_staging_account_credential_mismatch");
  try {
    const value: unknown = JSON.parse(command([join(ROOT, "node_modules/.bin/wrangler"), "auth", "token", "--json"]));
    if (!record(value) || (value.type !== "api_token" && value.type !== "oauth") || typeof value.token !== "string" || !value.token || value.token.length > 4096) throw new Error();
    return value.token;
  } catch { throw new Error("auth_staging_provider_credential_unavailable"); }
}

function nativeProvider(target: AuthStagingTarget, token: string): AuthStagingProvider {
  return {
    async request(method, path, body) {
      const zonePath = `/zones/${target.zoneId}/workers/routes`;
      const prefix = path === zonePath ? "" : `/accounts/${target.accountId}`;
      const url = `https://api.cloudflare.com/client/v4${prefix}${path}`;
      try {
        const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body });
        if (response.status === 404 && method === "GET" && path === `/workers/scripts/${AUTH_STAGING_WORKER}/script-settings`) return null;
        const value = await boundedJson(response);
        if (!response.ok || !record(value) || value.success !== true || !Object.hasOwn(value, "result")) throw new Error();
        return value.result;
      } catch { throw new Error("auth_staging_provider_request_failed"); }
    },
  };
}

async function verifyPublicAuthStaging(version: string, plan: AuthStagingPlan, jwksSha256: string): Promise<void> {
  for (const path of ["/healthz", "/readyz", "/.well-known/openid-configuration", "/oauth/jwks"]) {
    const response = await fetch(`${AUTH_STAGING_ISSUER}${path}`, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    const value = await boundedJson(response);
    if (!response.ok || response.headers.get("x-takosumi-worker-version") !== version || !record(value) || response.headers.has("set-cookie")) throw new Error("auth_staging_public_readback_failed");
    if (path === "/readyz" && (value.ok !== true || value.accountsSchemaHead !== 5)) throw new Error("auth_staging_readiness_failed");
    if (path === "/.well-known/openid-configuration" && (value.issuer !== AUTH_STAGING_ISSUER || value.authorization_endpoint !== `${AUTH_STAGING_ISSUER}/oauth/authorize` || value.token_endpoint !== `${AUTH_STAGING_ISSUER}/oauth/token` || value.jwks_uri !== `${AUTH_STAGING_ISSUER}/oauth/jwks`)) throw new Error("auth_staging_discovery_failed");
    if (path === "/oauth/jwks" && (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.some((key) => !record(key) || key.kty !== "EC" || key.crv !== "P-256" || Object.hasOwn(key, "d")))) throw new Error("auth_staging_jwks_failed");
    if (path === "/oauth/jwks" && publicJwksDigest(value.keys as readonly unknown[]) !== jwksSha256) throw new Error("auth_staging_jwks_identity_mismatch");
  }
  // Artifact/config identity is attested by immutable provider metadata above;
  // public discovery is a reachability check, not an authenticated RP E2E.
  if (!SHA.test(plan.artifactDigest)) throw new Error("auth_staging_artifact_invalid");
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("auth_staging_response_empty");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("auth_staging_response_too_large");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("auth_staging_response_invalid"); }
}
