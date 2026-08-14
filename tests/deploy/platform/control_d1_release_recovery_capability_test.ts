import { resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  buildControlD1ReleaseRecoveryCapability,
  CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND,
} from "../../../deploy/platform/control_d1_release_recovery_capability.ts";
import { runControlD1SchemaCli } from "../../../deploy/platform/control_d1_schema_cli.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const SOURCE_COMMIT = "a".repeat(40);

test("control D1 recovery capability proves worst-case bounded success and rollback without provider authority", async () => {
  const capability = await buildControlD1ReleaseRecoveryCapability({
    root: ROOT,
    sourceCommit: SOURCE_COMMIT,
    toolVersion: "1.3.14-test",
    packageVersion: "1.0.0-test",
  });

  expect(capability).toMatchObject({
    kind: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND,
    version: 2,
    status: "ready",
    sourceCommit: SOURCE_COMMIT,
    tool: {
      name: "bun",
      version: "1.3.14-test",
      packageVersion: "1.0.0-test",
      command:
        "bun scripts/control-d1-schema.ts release-recovery-capability",
    },
    scope: {
      evidenceClass: "provider_neutral_worst_case_regression",
      providerNeutralOnly: true,
      userTableCount: 221,
      guardedTableCount: 219,
      guardTriggerCount: 657,
    },
    plan: {
      kind: "takosumi.control-d1-maintenance-release-plan@v1",
      statementCount: 672,
      guardInsertStatementCount: 6,
      migrationInsertStatementCount: 1,
      guardedTableCount: 219,
      guardTriggerCount: 657,
      maxStatementBindings: 0,
      statementBindingLimit: 100,
      statementLimitBytes: 100_000,
    },
    exactShapeSuccess: {
      importCount: 1,
      inactiveReceiptExact: true,
      guardTriggerCountAfter: 0,
      reservedRelationsAbsentAfter: true,
    },
    injectedMidImportRollback: {
      injectionPoint: "before_expected_migration_insert",
      importAttemptCount: 1,
      releaseRejected: true,
      maintenanceFenceActiveAfter: true,
      guardTriggerCountAfter: 657,
      reservedRelationsAbsentAfter: true,
    },
    targetAuthorization: {
      status: "not_authorized",
      localSQLiteIsNotTargetAuthorization: true,
      disposableLiveD1EvidenceRequired: true,
      requiredEvidenceKind:
        "takosumi.control-d1-release-recovery-live-evidence@v1",
      requiredEvidence: [
        "exact_shape_success",
        "injected_mid_import_rollback",
      ],
    },
  });
  expect(capability.plan.maxStatementBytes).toBeLessThan(100_000);
  expect(capability.plan.totalImportBytes).toBeLessThanOrEqual(
    capability.plan.importLimitBytes,
  );
  expect(capability.exactShapeSuccess.importBytes).toBe(
    capability.plan.totalImportBytes,
  );
  expect(capability.exactShapeSuccess.importDigest).toBe(
    capability.plan.digest,
  );
  expect(capability.sourceFiles).toHaveLength(6);
  expect(capability.sourceFilesDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(capability.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(capability)).not.toContain("provider-neutral-placeholder");
});

test("control D1 release-recovery-capability CLI is provider-free and separate from v1", async () => {
  const outputs: string[] = [];
  let remoteCalls = 0;
  const code = await runControlD1SchemaCli(
    ["release-recovery-capability"],
    {},
    (value) => outputs.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      createRemoteDatabase: () => {
        remoteCalls += 1;
        throw new Error("must remain provider-free");
      },
      buildReleaseRecoveryCapability: (options) =>
        buildControlD1ReleaseRecoveryCapability({
          root: ROOT,
          sourceCommit: options.sourceCommit,
          toolVersion: "1.3.14-test",
          packageVersion: "1.0.0-test",
        }),
    },
  );
  expect(code).toBe(0);
  expect(remoteCalls).toBe(0);
  expect(JSON.parse(outputs.at(-1) ?? "{}")).toMatchObject({
    kind: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND,
    version: 2,
    status: "ready",
    targetAuthorization: { status: "not_authorized" },
  });
});

test("release-recovery-capability rejects provider or environment arguments", async () => {
  for (const argv of [
    ["release-recovery-capability", "--environment", "staging"],
    ["release-recovery-capability", "--confirm-manifest", `sha256:${"0".repeat(64)}`],
  ]) {
    const outputs: string[] = [];
    const code = await runControlD1SchemaCli(
      argv,
      {},
      (value) => outputs.push(value),
      { sourceCommit: SOURCE_COMMIT },
    );
    expect(code).toBe(1);
    expect(JSON.parse(outputs.at(-1) ?? "{}")).toMatchObject({
      kind: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND,
      status: "failed",
      failureCode: "arguments_invalid",
    });
  }
});

test("control D1 CLI help publishes the sealed recovery contract", async () => {
  const outputs: string[] = [];
  expect(
    await runControlD1SchemaCli(
      ["--help"],
      {},
      (value) => outputs.push(value),
      { sourceCommit: SOURCE_COMMIT },
    ),
  ).toBe(0);
  const help = outputs.join("\n");
  expect(help).toContain("release-recovery-capability");
  expect(help).toContain("release-status --environment");
  expect(help).toContain("--confirm-release-status-digest");
  expect(help).toContain("--confirm-release-authorization-digest");
  expect(help).toContain("--confirm-release-readiness-digest");
  expect(help).toContain("--confirm-tool-source-commit");
  expect(help).toContain("--confirm-target-digest");
  expect(help).toContain("never retry release automatically");
});
