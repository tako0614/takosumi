import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderCompatibilityProofArtifact } from "./provider-release-compatibility.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVICE_FORM_REMOVAL_POLICY_PATH = join(
  REPO_ROOT,
  "provider/release/compatibility/service-form-removal-policy.json",
);
export const SERVICE_FORM_MIGRATION_FIXTURE_AUTHORITY_PATH = join(
  REPO_ROOT,
  "provider/release/compatibility/service-form-migration-fixture-authority.json",
);

const POLICY_KIND = "takosumi.service-form-compatibility-removal-policy@v1";
const FIXTURE_AUTHORITY_KIND =
  "takosumi.service-form-migration-fixture-authority@v1";
const INVENTORY_KIND = "takosumi.service-form-compatibility-inventory@v1";
const REMOVAL_EVIDENCE_KIND =
  "takosumi.service-form-compatibility-removal-evidence@v1";
const ROLLBACK_KIND =
  "takosumi.service-form-compatibility-rollback-artifacts@v1";
const PROVIDER_PROOF_KIND = "takosumi.provider-compatibility-proof-evidence@v1";
const TAKOFORM_MIGRATION_KIND = "takoform.provider-migration-evidence@v1";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const EVIDENCE_REF = /^(?:evidence|vault):\/\/[A-Za-z0-9._~:/-]+$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

const LEGACY_FORM_RESOURCE_TYPES = [
  "takosumi_container_service",
  "takosumi_durable_workflow",
  "takosumi_edge_worker",
  "takosumi_kv_store",
  "takosumi_object_bucket",
  "takosumi_queue",
  "takosumi_schedule",
  "takosumi_sql_database",
  "takosumi_stateful_actor_namespace",
  "takosumi_vector_index",
];
const LEGACY_MIGRATION_RESOURCE_TYPES = [
  "takosumi_container_service",
  "takosumi_edge_worker",
  "takosumi_kv_store",
  "takosumi_object_bucket",
  "takosumi_queue",
  "takosumi_sql_database",
];
const TAKOSUMI_PROVIDER_PROOF_RESOURCE_TYPES = [
  "takosumi_container_service",
  "takosumi_edge_worker",
  "takosumi_kv_store",
  "takosumi_object_bucket",
  "takosumi_queue",
  "takosumi_sql_database",
  "takosumi_target_pool",
];
const MIGRATION_PHASES = [
  "state-backup",
  "old-refresh-no-op",
  "approved-remove-import",
  "new-refresh-no-op",
  "old-artifact-lock-rollback",
];
const POLICY_REQUIREMENTS = [
  "authorized-external-state-inventory",
  "public-support-window-notice-and-elapsed-window",
  "external-legacy-usage-observation",
  "retained-takosumi-provider-no-op-and-rollback-proof",
  "takoform-remove-import-no-op-migration-proof",
  "operator-retained-rollback-artifacts-and-restore-drill",
];
const INVENTORY_MISSING_EVIDENCE = [
  "external_usage_observation_window",
  "announced_minimum_support_window",
  "no_op_state_migration_fixtures",
  "rollback_artifacts",
];

const PINNED_TAKOFORM = {
  repository: "https://github.com/tako0614/terraform-provider-takoform",
  tag: "v0.1.0-rc.3",
  commit: "47698a158fb330b36e92450852a66ffa510e734e",
  artifacts: {
    "mapping.json":
      "sha256:c94f59e5b5c783fa36434e3fe87d567c29ffd05b80860ffcb9a057a43f638ae0",
    "legacy-state.json":
      "sha256:d9e5c5e9d368bde2ed4a7c18b4fa2e46e1ff3a5f71ff6a9ad7199083c66339a1",
    "golden-state.json":
      "sha256:ca333579961032f94f04a143801fa11e6ff95c646dea20624dbeb29849c25a1d",
    "evidence.json":
      "sha256:647be39bc9e4ee6142afcd7b92e27dcef7bbfc4e589758a3f850e1a7611740d2",
    "migration-from-takosumi-provider.md":
      "sha256:cbef5e3859d6ffff64da058c764dec27c127b4a04fbd882c18dcf0b76df4873f",
  },
};

export async function loadServiceFormRemovalAuthorities() {
  const [policyBytes, policySidecar, fixtureBytes, fixtureSidecar] =
    await Promise.all([
      readFile(SERVICE_FORM_REMOVAL_POLICY_PATH),
      readFile(`${SERVICE_FORM_REMOVAL_POLICY_PATH}.sha256`, "utf8"),
      readFile(SERVICE_FORM_MIGRATION_FIXTURE_AUTHORITY_PATH),
      readFile(
        `${SERVICE_FORM_MIGRATION_FIXTURE_AUTHORITY_PATH}.sha256`,
        "utf8",
      ),
    ]);
  verifySidecar(policyBytes, policySidecar, "service-form-removal-policy.json");
  verifySidecar(
    fixtureBytes,
    fixtureSidecar,
    "service-form-migration-fixture-authority.json",
  );
  const policy = parseJson(policyBytes, "Service Form removal policy");
  const fixtureAuthority = parseJson(
    fixtureBytes,
    "Service Form migration fixture authority",
  );
  validateServiceFormRemovalPolicy(policy);
  validateServiceFormMigrationFixtureAuthority(fixtureAuthority);
  return {
    policy,
    fixtureAuthority,
    policySha256: digest(policyBytes),
    fixtureAuthoritySha256: digest(fixtureBytes),
  };
}

export function validateServiceFormRemovalPolicy(policy) {
  exactKeys(
    policy,
    [
      "schemaVersion",
      "kind",
      "policyId",
      "scope",
      "supportWindow",
      "usageObservation",
      "requiredEvidence",
      "status",
    ],
    "removal policy",
  );
  if (
    policy.schemaVersion !== 1 ||
    policy.kind !== POLICY_KIND ||
    policy.policyId !== "resource-shape-compatibility-aliases-v1" ||
    policy.status !== "announced-policy-window-not-started"
  ) {
    throw new Error("Service Form removal policy identity is invalid");
  }
  exactKeys(
    policy.scope,
    [
      "apiGroup",
      "resourceApiPrefix",
      "providerAddresses",
      "legacyFormResourceTypes",
    ],
    "removal policy scope",
  );
  if (
    policy.scope.apiGroup !== "takosumi.dev/v1alpha1" ||
    policy.scope.resourceApiPrefix !== "/v1/resources" ||
    !sameStrings(policy.scope.providerAddresses, [
      "registry.opentofu.org/takosjp/takosumi",
      "registry.terraform.io/takosjp/takosumi",
    ]) ||
    !sameStrings(
      policy.scope.legacyFormResourceTypes,
      LEGACY_FORM_RESOURCE_TYPES,
    )
  ) {
    throw new Error("Service Form removal policy alias scope drifted");
  }
  exactKeys(
    policy.supportWindow,
    ["minimumDays", "startRule", "startedAt", "minimumRemovalMajor"],
    "support window policy",
  );
  if (
    policy.supportWindow.minimumDays !== 365 ||
    policy.supportWindow.startRule !==
      "later-of-public-notice-and-stable-migration-availability" ||
    policy.supportWindow.startedAt !== null ||
    policy.supportWindow.minimumRemovalMajor !== 2
  ) {
    throw new Error("Service Form support window policy drifted");
  }
  exactKeys(
    policy.usageObservation,
    [
      "minimumDays",
      "maximumLagDays",
      "requiredLegacyControlRequests",
      "requiredLegacyStateInstances",
    ],
    "usage observation policy",
  );
  if (
    policy.usageObservation.minimumDays !== 90 ||
    policy.usageObservation.maximumLagDays !== 7 ||
    policy.usageObservation.requiredLegacyControlRequests !== "0" ||
    policy.usageObservation.requiredLegacyStateInstances !== "0" ||
    !sameStrings(policy.requiredEvidence, POLICY_REQUIREMENTS)
  ) {
    throw new Error("Service Form removal evidence policy drifted");
  }
  return policy;
}

export function validateServiceFormMigrationFixtureAuthority(authority) {
  exactKeys(
    authority,
    [
      "schemaVersion",
      "kind",
      "takoformSource",
      "migration",
      "takosumiProviderProof",
      "status",
    ],
    "migration fixture authority",
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== FIXTURE_AUTHORITY_KIND ||
    authority.status !== "repo-fixtures-pinned-live-phases-required"
  ) {
    throw new Error("Service Form migration fixture authority is invalid");
  }
  exactKeys(
    authority.takoformSource,
    ["repository", "tag", "commit", "artifacts"],
    "Takoform fixture source",
  );
  exactKeys(
    authority.takoformSource.artifacts,
    Object.keys(PINNED_TAKOFORM.artifacts),
    "Takoform fixture artifacts",
  );
  if (
    authority.takoformSource.repository !== PINNED_TAKOFORM.repository ||
    authority.takoformSource.tag !== PINNED_TAKOFORM.tag ||
    authority.takoformSource.commit !== PINNED_TAKOFORM.commit ||
    JSON.stringify(authority.takoformSource.artifacts) !==
      JSON.stringify(PINNED_TAKOFORM.artifacts)
  ) {
    throw new Error("Takoform migration fixture source or digest drifted");
  }
  exactKeys(
    authority.migration,
    [
      "format",
      "approvedPath",
      "legacyResourceCount",
      "targetResourceCount",
      "legacyResourceTypes",
      "requiredPhases",
    ],
    "migration fixture contract",
  );
  if (
    authority.migration.format !== TAKOFORM_MIGRATION_KIND ||
    authority.migration.approvedPath !==
      "backup-remove-import-refresh-or-restore-backup" ||
    authority.migration.legacyResourceCount !== 6 ||
    authority.migration.targetResourceCount !== 10 ||
    !sameStrings(
      authority.migration.legacyResourceTypes,
      LEGACY_MIGRATION_RESOURCE_TYPES,
    ) ||
    !sameStrings(authority.migration.requiredPhases, MIGRATION_PHASES)
  ) {
    throw new Error("Takoform migration fixture contract drifted");
  }
  exactKeys(
    authority.takosumiProviderProof,
    ["command", "evidenceKind", "coveredResourceTypes"],
    "Takosumi provider proof authority",
  );
  if (
    authority.takosumiProviderProof.command !==
      "bun run provider:custody:state-proof" ||
    authority.takosumiProviderProof.evidenceKind !== PROVIDER_PROOF_KIND ||
    !sameStrings(
      authority.takosumiProviderProof.coveredResourceTypes,
      TAKOSUMI_PROVIDER_PROOF_RESOURCE_TYPES,
    )
  ) {
    throw new Error("Takosumi provider compatibility proof authority drifted");
  }
  return authority;
}

export function validateTakoformMigrationEvidence(evidence, authority) {
  exactKeys(
    evidence,
    [
      "format",
      "mappingSha256",
      "legacyStateSha256",
      "goldenStateSha256",
      "legacyResourceCount",
      "resourceCount",
      "phases",
      "externalBlockers",
    ],
    "Takoform migration evidence",
  );
  const artifacts = authority.takoformSource.artifacts;
  if (
    evidence.format !== TAKOFORM_MIGRATION_KIND ||
    `sha256:${evidence.mappingSha256}` !== artifacts["mapping.json"] ||
    `sha256:${evidence.legacyStateSha256}` !== artifacts["legacy-state.json"] ||
    `sha256:${evidence.goldenStateSha256}` !== artifacts["golden-state.json"] ||
    evidence.legacyResourceCount !== authority.migration.legacyResourceCount ||
    evidence.resourceCount !== authority.migration.targetResourceCount ||
    !Array.isArray(evidence.externalBlockers) ||
    evidence.externalBlockers.length !== 0
  ) {
    throw new Error("Takoform provider migration evidence is incomplete");
  }
  if (
    !Array.isArray(evidence.phases) ||
    evidence.phases.length !== MIGRATION_PHASES.length
  ) {
    throw new Error("Takoform provider migration phases are incomplete");
  }
  for (let index = 0; index < MIGRATION_PHASES.length; index += 1) {
    const phase = evidence.phases[index];
    exactKeys(phase, ["name", "status", "evidence"], "migration phase");
    if (
      phase.name !== MIGRATION_PHASES[index] ||
      phase.status !== "complete" ||
      typeof phase.evidence !== "string" ||
      phase.evidence.trim() === "" ||
      phase.evidence.length > 512 ||
      phase.evidence.includes("\n") ||
      phase.evidence.includes("\r")
    ) {
      throw new Error(
        `Takoform migration phase ${MIGRATION_PHASES[index]} is incomplete`,
      );
    }
  }
  return evidence;
}

export function validateRollbackArtifactManifest(manifest, migrationDigest) {
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "kind",
      "fixtureOnly",
      "artifactSetRef",
      "migrationEvidenceSha256",
      "artifacts",
      "phases",
      "stateValuesEmbedded",
      "credentialValuesEmbedded",
    ],
    "rollback artifact manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== ROLLBACK_KIND ||
    manifest.fixtureOnly !== false ||
    !EVIDENCE_REF.test(manifest.artifactSetRef ?? "") ||
    manifest.migrationEvidenceSha256 !== migrationDigest ||
    manifest.stateValuesEmbedded !== false ||
    manifest.credentialValuesEmbedded !== false
  ) {
    throw new Error("rollback artifact manifest identity is invalid");
  }
  exactKeys(
    manifest.artifacts,
    [
      "stateBackup",
      "oldDependencyLock",
      "oldHclRevision",
      "oldProviderBundle",
      "newProviderBundle",
      "restoreDrillTranscript",
    ],
    "rollback artifact digests",
  );
  for (const [name, value] of Object.entries(manifest.artifacts)) {
    assertSha256(value, `rollback artifact ${name}`);
  }
  exactKeys(
    manifest.phases,
    [
      "oldRefreshNoOp",
      "newRefreshNoOp",
      "rollbackRefreshNoOp",
      "interruptionRestoreDrill",
    ],
    "rollback proof phases",
  );
  if (Object.values(manifest.phases).some((value) => value !== true)) {
    throw new Error("rollback proof phases are incomplete");
  }
  return manifest;
}

export function validateRemovalEvidencePack({
  policy,
  policySha256,
  fixtureAuthority,
  evidence,
  inventories,
  inventoryDigests,
  takosumiProviderProofValidated,
  takosumiProviderProofSha256,
  takoformMigrationEvidence,
  takoformMigrationSha256,
  rollbackArtifactManifest,
  rollbackArtifactManifestSha256,
  now = new Date(),
}) {
  validateServiceFormRemovalPolicy(policy);
  validateServiceFormMigrationFixtureAuthority(fixtureAuthority);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "kind",
      "policySha256",
      "evaluatedAt",
      "removalCandidateVersion",
      "supportWindow",
      "inventoryCoverage",
      "usageObservation",
      "takosumiProviderProofSha256",
      "takoformMigrationEvidenceSha256",
      "rollbackArtifactManifestSha256",
    ],
    "removal evidence",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== REMOVAL_EVIDENCE_KIND ||
    evidence.policySha256 !== policySha256
  ) {
    throw new Error("Service Form removal evidence identity is invalid");
  }
  assertSha256(policySha256, "removal policy");
  const evaluatedAt = timestamp(evidence.evaluatedAt, "evaluatedAt");
  if (evaluatedAt.getTime() > now.getTime()) {
    throw new Error("removal evidence cannot be evaluated in the future");
  }
  if (
    now.getTime() >
    addDays(evaluatedAt, policy.usageObservation.maximumLagDays).getTime()
  ) {
    throw new Error("removal evidence evaluation is stale");
  }
  const candidate = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(
    evidence.removalCandidateVersion ?? "",
  );
  if (
    !candidate ||
    Number(candidate[1]) < policy.supportWindow.minimumRemovalMajor
  ) {
    throw new Error(
      "compatibility aliases may be removed only in an eligible major release",
    );
  }
  const support = validateSupportWindow(
    evidence.supportWindow,
    policy.supportWindow,
    evaluatedAt,
  );
  const inventory = validateInventoryCoverage(
    evidence.inventoryCoverage,
    inventories,
    inventoryDigests,
  );
  validateUsageObservation(
    evidence.usageObservation,
    policy.usageObservation,
    support.startedAt,
    evaluatedAt,
    inventory.legacyStateInstances,
  );
  if (
    takosumiProviderProofValidated !== true ||
    evidence.takosumiProviderProofSha256 !== takosumiProviderProofSha256
  ) {
    throw new Error(
      "Takosumi provider no-op/rollback proof is missing or stale",
    );
  }
  assertSha256(takosumiProviderProofSha256, "Takosumi provider proof");
  if (evidence.takoformMigrationEvidenceSha256 !== takoformMigrationSha256) {
    throw new Error("Takoform migration evidence digest mismatch");
  }
  assertSha256(takoformMigrationSha256, "Takoform migration evidence");
  validateTakoformMigrationEvidence(
    takoformMigrationEvidence,
    fixtureAuthority,
  );
  if (
    evidence.rollbackArtifactManifestSha256 !== rollbackArtifactManifestSha256
  ) {
    throw new Error("rollback artifact manifest digest mismatch");
  }
  assertSha256(rollbackArtifactManifestSha256, "rollback artifact manifest");
  validateRollbackArtifactManifest(
    rollbackArtifactManifest,
    takoformMigrationSha256,
  );
  return {
    kind: "takosumi.service-form-compatibility-removal-check@v1",
    eligible: true,
    policyId: policy.policyId,
    removalCandidateVersion: evidence.removalCandidateVersion,
    inventoryReportCount: inventories.length,
    supportWindowStartedAt: evidence.supportWindow.startedAt,
    supportWindowEndsAt: evidence.supportWindow.endsAt,
    usageObservationStartedAt: evidence.usageObservation.startedAt,
    usageObservationEndedAt: evidence.usageObservation.endedAt,
    stateValuesRecorded: false,
    credentialValuesRecorded: false,
  };
}

export async function loadAndValidateRemovalEvidencePack({
  evidencePath,
  inventoryPaths,
  takosumiProviderProofPath,
  takoformMigrationEvidencePath,
  rollbackArtifactManifestPath,
  now = new Date(),
}) {
  if (!Array.isArray(inventoryPaths) || inventoryPaths.length === 0) {
    throw new Error("at least one compatibility inventory report is required");
  }
  const authorities = await loadServiceFormRemovalAuthorities();
  const [
    evidenceBytes,
    inventoryBytes,
    providerProofBytes,
    migrationBytes,
    rollbackBytes,
  ] = await Promise.all([
    readFile(evidencePath),
    Promise.all(inventoryPaths.map((path) => readFile(path))),
    readFile(takosumiProviderProofPath),
    readFile(takoformMigrationEvidencePath),
    readFile(rollbackArtifactManifestPath),
  ]);
  await loadProviderCompatibilityProofArtifact({
    path: takosumiProviderProofPath,
  });
  return validateRemovalEvidencePack({
    ...authorities,
    evidence: parseJson(evidenceBytes, "removal evidence"),
    inventories: inventoryBytes.map((bytes) =>
      parseJson(bytes, "compatibility inventory"),
    ),
    inventoryDigests: inventoryBytes.map(digest),
    takosumiProviderProofValidated: true,
    takosumiProviderProofSha256: digest(providerProofBytes),
    takoformMigrationEvidence: parseJson(
      migrationBytes,
      "Takoform migration evidence",
    ),
    takoformMigrationSha256: digest(migrationBytes),
    rollbackArtifactManifest: parseJson(
      rollbackBytes,
      "rollback artifact manifest",
    ),
    rollbackArtifactManifestSha256: digest(rollbackBytes),
    now,
  });
}

export async function serviceFormRemovalRepoStatus() {
  const authorities = await loadServiceFormRemovalAuthorities();
  return {
    kind: "takosumi.service-form-compatibility-removal-repo-status@v1",
    contractComplete: true,
    removalEligible: false,
    policySha256: authorities.policySha256,
    fixtureAuthoritySha256: authorities.fixtureAuthoritySha256,
    supportWindow: {
      minimumDays: authorities.policy.supportWindow.minimumDays,
      startRule: authorities.policy.supportWindow.startRule,
      startedAt: null,
    },
    missingExternalEvidence: [
      "complete-authorized-state-inventory",
      "public-notice-and-stable-migration-availability-window-start",
      "elapsed-365-day-support-window",
      "current-90-day-zero-legacy-usage-observation",
      "live-takoform-remove-import-no-op-proof",
      "operator-rollback-artifact-set-and-restore-drill",
    ],
  };
}

function validateSupportWindow(value, policy, evaluatedAt) {
  exactKeys(
    value,
    ["publicNoticeAt", "migrationAvailableAt", "startedAt", "endsAt"],
    "support window evidence",
  );
  const publicNoticeAt = timestamp(value.publicNoticeAt, "publicNoticeAt");
  const migrationAvailableAt = timestamp(
    value.migrationAvailableAt,
    "migrationAvailableAt",
  );
  const startedAt = timestamp(value.startedAt, "supportWindow.startedAt");
  const endsAt = timestamp(value.endsAt, "supportWindow.endsAt");
  const expectedStart = Math.max(
    publicNoticeAt.getTime(),
    migrationAvailableAt.getTime(),
  );
  if (startedAt.getTime() !== expectedStart) {
    throw new Error(
      "support window start must not predate notice or stable migration availability",
    );
  }
  if (endsAt.getTime() < addDays(startedAt, policy.minimumDays).getTime()) {
    throw new Error("minimum compatibility support window has not elapsed");
  }
  if (evaluatedAt.getTime() < endsAt.getTime()) {
    throw new Error("compatibility support window is still active");
  }
  return { startedAt, endsAt };
}

function validateInventoryCoverage(value, inventories, inventoryDigests) {
  exactKeys(
    value,
    [
      "authorizationScopeRef",
      "authorizationScopeSha256",
      "complete",
      "authorizedTerraformStateCount",
      "authorizedDependencyLockCount",
      "inventorySha256s",
    ],
    "inventory coverage",
  );
  if (
    !EVIDENCE_REF.test(value.authorizationScopeRef ?? "") ||
    value.complete !== true ||
    !DECIMAL.test(value.authorizedTerraformStateCount ?? "") ||
    !DECIMAL.test(value.authorizedDependencyLockCount ?? "")
  ) {
    throw new Error("authorized inventory coverage is incomplete");
  }
  assertSha256(value.authorizationScopeSha256, "authorization scope");
  if (
    !Array.isArray(inventories) ||
    inventories.length === 0 ||
    !Array.isArray(inventoryDigests) ||
    !sameStrings(value.inventorySha256s, inventoryDigests)
  ) {
    throw new Error("inventory report digest closure is incomplete");
  }
  const seenSources = new Set();
  let stateCount = 0;
  let lockCount = 0;
  let legacyStateInstances = 0;
  for (const inventory of inventories) {
    const result = validateInventory(inventory);
    stateCount += result.stateCount;
    lockCount += result.lockCount;
    legacyStateInstances += result.legacyStateInstances;
    for (const source of inventory.sources) {
      const key = `${source.kind}:${source.sha256}`;
      if (seenSources.has(key)) {
        throw new Error(
          "inventory coverage contains a duplicate source digest",
        );
      }
      seenSources.add(key);
    }
  }
  if (
    BigInt(value.authorizedTerraformStateCount) !== BigInt(stateCount) ||
    BigInt(value.authorizedDependencyLockCount) !== BigInt(lockCount)
  ) {
    throw new Error("inventory coverage counts do not match authorized scope");
  }
  if (legacyStateInstances !== 0) {
    throw new Error(
      "authorized state inventory still contains legacy form instances",
    );
  }
  return { legacyStateInstances };
}

function validateInventory(inventory) {
  exactKeys(
    inventory,
    [
      "kind",
      "sources",
      "summary",
      "resources",
      "providerLocks",
      "removalDecision",
    ],
    "compatibility inventory",
  );
  if (
    inventory.kind !== INVENTORY_KIND ||
    !Array.isArray(inventory.sources) ||
    inventory.sources.length === 0 ||
    !isRecord(inventory.summary) ||
    !Array.isArray(inventory.resources) ||
    !Array.isArray(inventory.providerLocks) ||
    !isRecord(inventory.removalDecision) ||
    inventory.removalDecision.eligible !== false ||
    !sameStrings(
      inventory.removalDecision.missingEvidence,
      INVENTORY_MISSING_EVIDENCE,
    )
  ) {
    throw new Error("compatibility inventory report is invalid");
  }
  exactKeys(
    inventory.summary,
    [
      "terraformStateCount",
      "dependencyLockCount",
      "relevantResourceCount",
      "relevantInstanceCount",
      "otherResourceCount",
      "otherProviderLockCount",
    ],
    "compatibility inventory summary",
  );
  exactKeys(
    inventory.removalDecision,
    ["eligible", "missingEvidence"],
    "compatibility inventory removal decision",
  );
  for (const source of inventory.sources) {
    exactKeys(source, ["kind", "sha256"], "inventory source");
    if (
      !["terraform_state", "dependency_lock"].includes(source.kind) ||
      !SHA256.test(source.sha256)
    ) {
      throw new Error("compatibility inventory source is invalid");
    }
  }
  const stateCount = nonNegativeInteger(
    inventory.summary.terraformStateCount,
    "inventory state count",
  );
  const lockCount = nonNegativeInteger(
    inventory.summary.dependencyLockCount,
    "inventory lock count",
  );
  const relevantResourceCount = nonNegativeInteger(
    inventory.summary.relevantResourceCount,
    "inventory relevant resource count",
  );
  const relevantInstanceCount = nonNegativeInteger(
    inventory.summary.relevantInstanceCount,
    "inventory relevant instance count",
  );
  nonNegativeInteger(
    inventory.summary.otherResourceCount,
    "inventory other resource count",
  );
  nonNegativeInteger(
    inventory.summary.otherProviderLockCount,
    "inventory other provider lock count",
  );
  const actualStateSources = inventory.sources.filter(
    (source) => source.kind === "terraform_state",
  ).length;
  const actualLockSources = inventory.sources.filter(
    (source) => source.kind === "dependency_lock",
  ).length;
  if (stateCount !== actualStateSources || lockCount !== actualLockSources) {
    throw new Error("compatibility inventory source counts drifted");
  }
  let legacyStateInstances = 0;
  let actualInstanceCount = 0;
  for (const resource of inventory.resources) {
    exactKeys(
      resource,
      [
        "providerAddress",
        "mode",
        "resourceType",
        "resourceClass",
        "instanceCount",
      ],
      "compatibility inventory resource",
    );
    const instances = nonNegativeInteger(
      resource.instanceCount,
      "inventory resource instance count",
    );
    actualInstanceCount += instances;
    if (
      (resource.providerAddress !== null &&
        (typeof resource.providerAddress !== "string" ||
          resource.providerAddress.trim() === "")) ||
      !["managed", "data"].includes(resource.mode) ||
      typeof resource.resourceType !== "string" ||
      resource.resourceType.trim() === "" ||
      ![
        "legacy_form",
        "portable_form",
        "takosumi_admin",
        "unknown_takosumi",
      ].includes(resource.resourceClass)
    ) {
      throw new Error("compatibility inventory resource is invalid");
    }
    if (
      resource.resourceClass === "legacy_form" ||
      resource.resourceClass === "unknown_takosumi"
    ) {
      legacyStateInstances += instances;
    }
  }
  if (
    relevantResourceCount !== inventory.resources.length ||
    relevantInstanceCount !== actualInstanceCount
  ) {
    throw new Error("compatibility inventory resource counts drifted");
  }
  for (const providerLock of inventory.providerLocks) {
    exactKeys(
      providerLock,
      ["providerAddress", "version", "constraints", "hashes"],
      "compatibility provider lock",
    );
    if (
      typeof providerLock.providerAddress !== "string" ||
      providerLock.providerAddress.trim() === "" ||
      (providerLock.version !== null &&
        typeof providerLock.version !== "string") ||
      (providerLock.constraints !== null &&
        typeof providerLock.constraints !== "string") ||
      !Array.isArray(providerLock.hashes) ||
      providerLock.hashes.some(
        (value) => typeof value !== "string" || value.trim() === "",
      )
    ) {
      throw new Error("compatibility provider lock is invalid");
    }
  }
  return { stateCount, lockCount, legacyStateInstances };
}

function validateUsageObservation(
  value,
  policy,
  supportWindowStartedAt,
  evaluatedAt,
  legacyStateInstances,
) {
  exactKeys(
    value,
    [
      "evidenceRef",
      "evidenceSha256",
      "sourceKind",
      "startedAt",
      "endedAt",
      "legacyControlRequestCount",
      "legacyStateInstanceCount",
    ],
    "usage observation evidence",
  );
  if (
    !EVIDENCE_REF.test(value.evidenceRef ?? "") ||
    value.sourceKind !== "operator-route-and-provider-telemetry" ||
    !DECIMAL.test(value.legacyControlRequestCount ?? "") ||
    !DECIMAL.test(value.legacyStateInstanceCount ?? "")
  ) {
    throw new Error("external compatibility usage observation is invalid");
  }
  assertSha256(value.evidenceSha256, "usage observation");
  const startedAt = timestamp(value.startedAt, "usageObservation.startedAt");
  const endedAt = timestamp(value.endedAt, "usageObservation.endedAt");
  if (
    startedAt.getTime() < supportWindowStartedAt.getTime() ||
    endedAt.getTime() < addDays(startedAt, policy.minimumDays).getTime() ||
    endedAt.getTime() > evaluatedAt.getTime() ||
    evaluatedAt.getTime() > addDays(endedAt, policy.maximumLagDays).getTime()
  ) {
    throw new Error(
      "external compatibility usage observation window is incomplete or stale",
    );
  }
  if (
    value.legacyControlRequestCount !== policy.requiredLegacyControlRequests ||
    value.legacyStateInstanceCount !== policy.requiredLegacyStateInstances ||
    BigInt(value.legacyStateInstanceCount) !== BigInt(legacyStateInstances)
  ) {
    throw new Error("legacy compatibility usage remains in the removal window");
  }
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(`${label} fields are invalid`);
  }
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSha256(value, label) {
  if (!SHA256.test(value ?? "")) {
    throw new Error(`${label} must be a sha256 digest`);
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function addDays(value, days) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function verifySidecar(bytes, sidecar, filename) {
  const match = /^([a-f0-9]{64})  ([^/\n]+)\n?$/u.exec(sidecar);
  if (
    !match ||
    match[2] !== filename ||
    `sha256:${match[1]}` !== digest(bytes)
  ) {
    throw new Error(`${filename} digest sidecar mismatch`);
  }
}

export function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
