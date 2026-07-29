import { describe, expect, test } from "bun:test";
import type { InstallConfigResourceMigrationAction } from "takosumi-contract";
import { releaseActivationCommands } from "../../../../core/domains/deploy-control/mod.ts";
import { validateResourceMigrationDeclaration } from "../../../../core/domains/deploy-control/resource_migrations.ts";

const action: InstallConfigResourceMigrationAction = {
  apiVersion: "takosumi.dev/v1alpha1",
  kind: "resource_migration",
  id: "yurucommu-schema",
  phase: "post_apply",
  executor: "operator",
  runnerCapability: "resource.migration.sqlite.v1",
  target: {
    resourceAddress: "takoform_relational_database.database",
  },
  bundle: {
    format: "takosumi.resource-migrations/v1",
    manifestPath: "deploy/takoform/migrations/manifest.json",
    digest:
      "sha256:3b3f36501936a84ed19b9bef37e5581c3e04948733b947ebaa002f196e66817c",
  },
};

describe("typed Resource migration lifecycle action", () => {
  test("keeps only Plan-pinned address and immutable bundle selection", () => {
    expect(() =>
      validateResourceMigrationDeclaration(action, "lifecycleActions[0]"),
    ).not.toThrow();
    expect(releaseActivationCommands([action], "post_apply")).toEqual([
      {
        kind: "resource_migration",
        id: "yurucommu-schema",
        phase: "post_apply",
        executor: "operator",
        target: {
          resourceAddress: "takoform_relational_database.database",
        },
        bundle: action.bundle,
      },
    ]);
    const payload = JSON.stringify(
      releaseActivationCommands([action], "post_apply"),
    );
    for (const forbidden of [
      "outputName",
      "database_id",
      "account_id",
      "sql",
      "credential",
      "resourceId",
      "generation",
    ]) {
      expect(payload).not.toContain(forbidden);
    }
  });

  test("rejects pre-destroy, runner, path traversal, and non-canonical digest declarations", () => {
    for (const invalid of [
      { ...action, phase: "pre_destroy" },
      { ...action, executor: "runner" },
      {
        ...action,
        bundle: { ...action.bundle, manifestPath: "../migrations.json" },
      },
      {
        ...action,
        bundle: { ...action.bundle, digest: "sha256:not-a-digest" },
      },
    ]) {
      expect(() =>
        validateResourceMigrationDeclaration(
          invalid as InstallConfigResourceMigrationAction,
          "lifecycleActions[0]",
        ),
      ).toThrow();
    }
  });
});
