import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type {
  Capsule,
  InstallConfig,
} from "takosumi-contract/install-configs";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import {
  InMemoryOpenTofuControlStore,
  type CapsuleInitialAuthorityInput,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const NOW = "2026-09-04T00:00:00.000Z";
const LATER = "2026-09-04T00:00:01.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function installConfig(id: string, workspaceId?: string): InstallConfig {
  return {
    id,
    ...(workspaceId ? { workspaceId } : {}),
    name: id,
    variableMapping: { region: "ap-northeast-1" },
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function capsule(
  id: string,
  installConfigId: string,
  status: Capsule["status"] = "pending",
): Capsule {
  return {
    id,
    workspaceId: `workspace_${id}`,
    projectId: `project_${id}`,
    name: id,
    slug: id,
    sourceId: `source_${id}`,
    installConfigId,
    installingPrincipalId: `principal_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function initialAuthority(suffix: string): CapsuleInitialAuthorityInput {
  const row = capsule(
    `capsule_initial_${suffix}`,
    `config_initial_${suffix}`,
  );
  const config = installConfig(row.installConfigId, row.workspaceId);
  const providerBindingSet: ProviderBindingSet = {
    id: `binding_initial_${suffix}`,
    workspaceId: row.workspaceId,
    capsuleId: row.id,
    environment: row.environment,
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { installConfig: config, capsule: row, providerBindingSet };
}

test("initial Capsule authority is one create-only atomic unit across every store", async () => {
  for (const [label, store] of await stores()) {
    const concurrent = initialAuthority(`${label}_concurrent`);
    const concurrentResults = await Promise.all([
      store.createCapsuleInitialAuthority(concurrent),
      store.createCapsuleInitialAuthority(concurrent),
    ]);
    expect(concurrentResults.map((result) => result.status).sort()).toEqual([
      "created",
      "replayed",
    ]);

    const input = initialAuthority(label);
    expect(await store.createCapsuleInitialAuthority(input)).toEqual({
      status: "created",
      capsule: input.capsule,
    });
    expect(await store.getInstallConfig(input.installConfig.id)).toEqual(
      input.installConfig,
    );
    expect(await store.getCapsule(input.capsule.id)).toEqual(input.capsule);
    expect(
      await store.getProviderBindingSetByCapsule(
        input.capsule.id,
        input.capsule.environment,
      ),
    ).toEqual(input.providerBindingSet);
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(input.capsule.id),
    ).toBe(1);

    expect(await store.createCapsuleInitialAuthority(input)).toEqual({
      status: "replayed",
      capsule: input.capsule,
    });
    const conflicting: CapsuleInitialAuthorityInput = {
      ...input,
      installConfig: {
        ...input.installConfig,
        variableMapping: { region: "must-not-overwrite" },
      },
    };
    expect(await store.createCapsuleInitialAuthority(conflicting)).toEqual({
      status: "conflict",
    });
    expect(await store.getInstallConfig(input.installConfig.id)).toEqual(
      input.installConfig,
    );
    expect(await store.getCapsule(input.capsule.id)).toEqual(input.capsule);

    const partial = initialAuthority(`${label}_partial`);
    await store.putInstallConfig(partial.installConfig);
    expect(await store.createCapsuleInitialAuthority(partial)).toEqual({
      status: "conflict",
    });
    expect(await store.getCapsule(partial.capsule.id)).toBeUndefined();
    expect(
      await store.getProviderBindingSetByCapsule(
        partial.capsule.id,
        partial.capsule.environment,
      ),
    ).toBeUndefined();
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(partial.capsule.id),
    ).toBeUndefined();

    const occupiedSlot = initialAuthority(`${label}_occupied_slot`);
    const occupyingAuthority: CapsuleInitialAuthorityInput = {
      ...occupiedSlot,
      providerBindingSet: {
        ...occupiedSlot.providerBindingSet,
        id: `${occupiedSlot.providerBindingSet.id}_other`,
      },
    };
    expect(await store.createCapsuleInitialAuthority(occupyingAuthority)).toEqual({
      status: "created",
      capsule: occupiedSlot.capsule,
    });
    expect(await store.createCapsuleInitialAuthority(occupiedSlot)).toEqual({
      status: "conflict",
    });
    expect(await store.getInstallConfig(occupiedSlot.installConfig.id)).toEqual(
      occupiedSlot.installConfig,
    );
    expect(await store.getCapsule(occupiedSlot.capsule.id)).toEqual(
      occupiedSlot.capsule,
    );
    expect(
      await store.getProviderBindingSetByCapsule(
        occupiedSlot.capsule.id,
        occupiedSlot.capsule.environment,
      ),
    ).toEqual(occupyingAuthority.providerBindingSet);
    expect(
      await store.getCapsuleExecutionAuthorityEpoch(occupiedSlot.capsule.id),
    ).toBe(1);
  }
});

test("shared template CAS permits only unattached rows and counts destroyed references across every store", async () => {
  for (const [label, store] of await stores()) {
    const shared = installConfig(`config_shared_${label}`);
    const replacement: InstallConfig = {
      ...shared,
      variableMapping: { region: "us-east-1" },
      updatedAt: LATER,
    };
    await store.putInstallConfig(shared);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(shared, replacement),
    ).toBe(true);
    expect(await store.getInstallConfig(shared.id)).toEqual(replacement);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(shared, {
        ...replacement,
        updatedAt: "2026-09-04T00:00:02.000Z",
      }),
    ).toBe(false);
    expect(await store.getInstallConfig(shared.id)).toEqual(replacement);

    const referenced = installConfig(`config_referenced_${label}`);
    const referencedReplacement = {
      ...referenced,
      variableMapping: { region: "must-not-change" },
      updatedAt: LATER,
    };
    const reference = capsule(`capsule_reference_${label}`, referenced.id);
    await store.putInstallConfig(referenced);
    await store.putCapsule(reference);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(
        referenced,
        referencedReplacement,
      ),
    ).toBe(false);
    expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);

    await store.putCapsule({
      ...reference,
      status: "destroyed",
      updatedAt: LATER,
    });
    expect(
      await store.replaceUnreferencedSharedInstallConfig(
        referenced,
        referencedReplacement,
      ),
    ).toBe(false);
    expect(await store.getInstallConfig(referenced.id)).toEqual(referenced);

    const workspaceScoped = installConfig(
      `config_workspace_${label}`,
      `workspace_${label}`,
    );
    await store.putInstallConfig(workspaceScoped);
    expect(
      await store.replaceUnreferencedSharedInstallConfig(workspaceScoped, {
        ...workspaceScoped,
        variableMapping: { region: "must-not-change" },
        updatedAt: LATER,
      }),
    ).toBe(false);
    expect(await store.getInstallConfig(workspaceScoped.id)).toEqual(
      workspaceScoped,
    );
  }
});
