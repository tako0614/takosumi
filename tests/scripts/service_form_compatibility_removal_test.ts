import { describe, expect, test } from "bun:test";
import {
  buildServiceFormCompatibilityInventory,
  stableCompatibilityInventoryJson,
} from "../../scripts/lib/service-form-compatibility-inventory.ts";
import {
  digest,
  loadServiceFormRemovalAuthorities,
  serviceFormRemovalRepoStatus,
  validateRemovalEvidencePack,
  validateRollbackArtifactManifest,
  validateServiceFormMigrationFixtureAuthority,
  validateServiceFormRemovalPolicy,
  validateTakoformMigrationEvidence,
} from "../../scripts/lib/service-form-compatibility-removal.mjs";

const DAY = 24 * 60 * 60 * 1000;

describe("Service Form compatibility removal", () => {
  test("pins a non-retroactive support policy and independent fixture authority", async () => {
    const { policy, fixtureAuthority } =
      await loadServiceFormRemovalAuthorities();
    expect(validateServiceFormRemovalPolicy(policy)).toBe(policy);
    expect(validateServiceFormMigrationFixtureAuthority(fixtureAuthority)).toBe(
      fixtureAuthority,
    );
    expect(policy.supportWindow).toEqual({
      minimumDays: 365,
      startRule: "later-of-public-notice-and-stable-migration-availability",
      startedAt: null,
      minimumRemovalMajor: 2,
    });
    expect(fixtureAuthority.takoformSource).toMatchObject({
      tag: "v0.1.0-rc.3",
      commit: "47698a158fb330b36e92450852a66ffa510e734e",
    });
  });

  test("repo status keeps aliases active and names only external blockers", async () => {
    const status = await serviceFormRemovalRepoStatus();
    expect(status.contractComplete).toBe(true);
    expect(status.removalEligible).toBe(false);
    expect(status.supportWindow.startedAt).toBeNull();
    expect(status.missingExternalEvidence).toContain(
      "elapsed-365-day-support-window",
    );
    expect(status.missingExternalEvidence).toContain(
      "current-90-day-zero-legacy-usage-observation",
    );
  });

  test("accepts only the complete digest-bound external evidence closure", async () => {
    const fixture = await completePack();
    expect(validateRemovalEvidencePack(fixture)).toMatchObject({
      eligible: true,
      removalCandidateVersion: "2.0.0",
      stateValuesRecorded: false,
      credentialValuesRecorded: false,
    });
  });

  test("rejects a support window start before stable migration availability", async () => {
    const fixture = await completePack();
    fixture.evidence.supportWindow.startedAt =
      fixture.evidence.supportWindow.publicNoticeAt;
    expect(() => validateRemovalEvidencePack(fixture)).toThrow(
      "must not predate notice or stable migration availability",
    );
  });

  test("rejects an active support window and a non-major removal", async () => {
    const fixture = await completePack();
    fixture.now = new Date("2027-08-31T00:00:00.000Z");
    fixture.evidence.evaluatedAt = fixture.now.toISOString();
    expect(() => validateRemovalEvidencePack(fixture)).toThrow(
      "support window is still active",
    );

    const nonMajor = await completePack();
    nonMajor.evidence.removalCandidateVersion = "1.99.0";
    expect(() => validateRemovalEvidencePack(nonMajor)).toThrow(
      "only in an eligible major release",
    );

    const staleEvaluation = await completePack();
    staleEvaluation.now = new Date(
      new Date(staleEvaluation.evidence.evaluatedAt).getTime() + 8 * DAY,
    );
    expect(() => validateRemovalEvidencePack(staleEvaluation)).toThrow(
      "removal evidence evaluation is stale",
    );
  });

  test("rejects stale, short, or non-zero external usage observation", async () => {
    const short = await completePack();
    short.evidence.usageObservation.startedAt = new Date(
      new Date(short.evidence.usageObservation.endedAt).getTime() - 89 * DAY,
    ).toISOString();
    expect(() => validateRemovalEvidencePack(short)).toThrow(
      "window is incomplete or stale",
    );

    const used = await completePack();
    used.evidence.usageObservation.legacyControlRequestCount = "1";
    expect(() => validateRemovalEvidencePack(used)).toThrow(
      "legacy compatibility usage remains",
    );

    const stale = await completePack();
    stale.now = new Date(
      new Date(stale.evidence.usageObservation.endedAt).getTime() + 8 * DAY,
    );
    stale.evidence.evaluatedAt = stale.now.toISOString();
    expect(() => validateRemovalEvidencePack(stale)).toThrow(
      "window is incomplete or stale",
    );
  });

  test("rejects inventories that retain a legacy form instance", async () => {
    const fixture = await completePack({ legacyState: true });
    expect(() => validateRemovalEvidencePack(fixture)).toThrow(
      "still contains legacy form instances",
    );
  });

  test("rejects inventory fields that could smuggle state values", async () => {
    const fixture = await completePack();
    fixture.inventories[0].resources[0].attributes = {
      token: "must-not-enter-removal-evidence",
    };
    expect(() => validateRemovalEvidencePack(fixture)).toThrow(
      "compatibility inventory resource fields are invalid",
    );
  });

  test("rejects structural fixture claims as live migration or rollback proof", async () => {
    const fixture = await completePack();
    fixture.takoformMigrationEvidence.phases[1].status = "external-required";
    fixture.takoformMigrationEvidence.externalBlockers = ["live host"];
    expect(() =>
      validateTakoformMigrationEvidence(
        fixture.takoformMigrationEvidence,
        fixture.fixtureAuthority,
      ),
    ).toThrow("migration evidence is incomplete");

    const rollback = structuredClone(fixture.rollbackArtifactManifest);
    rollback.fixtureOnly = true;
    expect(() =>
      validateRollbackArtifactManifest(
        rollback,
        fixture.takoformMigrationSha256,
      ),
    ).toThrow("rollback artifact manifest identity is invalid");
  });
});

async function completePack({ legacyState = false } = {}) {
  const { policy, policySha256, fixtureAuthority } =
    await loadServiceFormRemovalAuthorities();
  const state = JSON.stringify({
    version: 4,
    resources: [
      {
        mode: "managed",
        type: legacyState ? "takosumi_edge_worker" : "takoform_edge_worker",
        provider: legacyState
          ? 'provider["registry.terraform.io/takosjp/takosumi"]'
          : 'provider["registry.terraform.io/tako0614/takoform"]',
        instances: [{ attributes: { id: "synthetic-fixture" } }],
      },
      {
        mode: "managed",
        type: "takosumi_target_pool",
        provider: 'provider["registry.terraform.io/takosjp/takosumi"]',
        instances: [{ attributes: { id: "synthetic-admin-fixture" } }],
      },
    ],
  });
  const inventory = buildServiceFormCompatibilityInventory([
    { kind: "terraform_state", bytes: new TextEncoder().encode(state) },
  ]);
  const inventoryBytes = new TextEncoder().encode(
    stableCompatibilityInventoryJson(inventory),
  );
  const inventorySha256 = digest(inventoryBytes);
  const takoformMigrationEvidence = {
    format: "takoform.provider-migration-evidence@v1",
    mappingSha256:
      "c94f59e5b5c783fa36434e3fe87d567c29ffd05b80860ffcb9a057a43f638ae0",
    legacyStateSha256:
      "d9e5c5e9d368bde2ed4a7c18b4fa2e46e1ff3a5f71ff6a9ad7199083c66339a1",
    goldenStateSha256:
      "ca333579961032f94f04a143801fa11e6ff95c646dea20624dbeb29849c25a1d",
    legacyResourceCount: 6,
    resourceCount: 10,
    phases: [
      "state-backup",
      "old-refresh-no-op",
      "approved-remove-import",
      "new-refresh-no-op",
      "old-artifact-lock-rollback",
    ].map((name) => ({ name, status: "complete", evidence: `${name}-proof` })),
    externalBlockers: [],
  };
  const migrationBytes = new TextEncoder().encode(
    JSON.stringify(takoformMigrationEvidence),
  );
  const takoformMigrationSha256 = digest(migrationBytes);
  const rollbackArtifactManifest = {
    schemaVersion: 1,
    kind: "takosumi.service-form-compatibility-rollback-artifacts@v1",
    fixtureOnly: false,
    artifactSetRef: "vault://takosumi/provider-migration/rollback-set",
    migrationEvidenceSha256: takoformMigrationSha256,
    artifacts: {
      stateBackup: sha("1"),
      oldDependencyLock: sha("2"),
      oldHclRevision: sha("3"),
      oldProviderBundle: sha("4"),
      newProviderBundle: sha("5"),
      restoreDrillTranscript: sha("6"),
    },
    phases: {
      oldRefreshNoOp: true,
      newRefreshNoOp: true,
      rollbackRefreshNoOp: true,
      interruptionRestoreDrill: true,
    },
    stateValuesEmbedded: false,
    credentialValuesEmbedded: false,
  };
  const rollbackBytes = new TextEncoder().encode(
    JSON.stringify(rollbackArtifactManifest),
  );
  const rollbackArtifactManifestSha256 = digest(rollbackBytes);
  const supportStartedAt = new Date("2026-09-01T00:00:00.000Z");
  const supportEndsAt = new Date(supportStartedAt.getTime() + 365 * DAY);
  const usageStartedAt = new Date(supportEndsAt.getTime() - 90 * DAY);
  const now = new Date(supportEndsAt);
  const takosumiProviderProofSha256 = sha("a");
  const evidence = {
    schemaVersion: 1,
    kind: "takosumi.service-form-compatibility-removal-evidence@v1",
    policySha256,
    evaluatedAt: now.toISOString(),
    removalCandidateVersion: "2.0.0",
    supportWindow: {
      publicNoticeAt: "2026-08-01T00:00:00.000Z",
      migrationAvailableAt: supportStartedAt.toISOString(),
      startedAt: supportStartedAt.toISOString(),
      endsAt: supportEndsAt.toISOString(),
    },
    inventoryCoverage: {
      authorizationScopeRef: "vault://takosumi/provider-migration/scope",
      authorizationScopeSha256: sha("b"),
      complete: true,
      authorizedTerraformStateCount: "1",
      authorizedDependencyLockCount: "0",
      inventorySha256s: [inventorySha256],
    },
    usageObservation: {
      evidenceRef: "evidence://takosumi/provider-migration/usage-window",
      evidenceSha256: sha("c"),
      sourceKind: "operator-route-and-provider-telemetry",
      startedAt: usageStartedAt.toISOString(),
      endedAt: supportEndsAt.toISOString(),
      legacyControlRequestCount: "0",
      legacyStateInstanceCount: legacyState ? "1" : "0",
    },
    takosumiProviderProofSha256,
    takoformMigrationEvidenceSha256: takoformMigrationSha256,
    rollbackArtifactManifestSha256,
  };
  return {
    policy,
    policySha256,
    fixtureAuthority,
    evidence,
    inventories: [inventory],
    inventoryDigests: [inventorySha256],
    takosumiProviderProofValidated: true,
    takosumiProviderProofSha256,
    takoformMigrationEvidence,
    takoformMigrationSha256,
    rollbackArtifactManifest,
    rollbackArtifactManifestSha256,
    now,
  };
}

function sha(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
