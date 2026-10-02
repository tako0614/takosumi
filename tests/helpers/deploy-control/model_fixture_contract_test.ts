import { expect, test } from "bun:test";
import type { RunExecutionCommit } from "takosumi-contract/runs";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  fixtureExecutionEvidenceCommit,
  seedCapsuleModel,
  seedProviderConnections,
} from "./model_fixture.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

test("deployment model fixtures preserve current Project and connection contracts", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_fixture_contract",
    installConfig: { workspaceId: "workspace_other" },
  });

  expect(seeded.project.projectJson).toEqual({});
  expect(seeded.installConfig.workspaceId).toBe(seeded.workspace.id);

  await seedProviderConnections(store, seeded.capsule, {
    requiredProviders: [CLOUDFLARE_PROVIDER],
  });
  const connection = await store.getConnection(
    "conn_fixture_workspace_fixture_contract_cloudflare",
  );
  expect(connection).toBeDefined();
  expect(connection?.kind).toBeUndefined();
});

test("provider-failure evidence normalizes only the derived commit", () => {
  const defaultCommit: RunExecutionCommit = {
    stateVersionId: "state_default",
    outputId: "output_default",
  };
  const override: RunExecutionCommit = {
    stateVersionId: "state_override",
    outputId: "output_override",
  };

  expect(
    fixtureExecutionEvidenceCommit(
      "provider_failed_state_persisted",
      defaultCommit,
    ),
  ).toEqual({ stateVersionId: "state_default" });
  expect(
    fixtureExecutionEvidenceCommit(
      "provider_failed_state_persisted",
      defaultCommit,
      override,
    ),
  ).toBe(override);
  expect(() =>
    fixtureExecutionEvidenceCommit("provider_failed_state_persisted", {
      destroyed: true,
    }),
  ).toThrow("requires a retained state version");
  expect(() =>
    fixtureExecutionEvidenceCommit("provider_failed_state_persisted", {
      destroyed: true,
      stateVersionId: "",
    }),
  ).toThrow("requires a retained state version");
});
