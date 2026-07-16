import { expect, test } from "bun:test";
import { formRefKey, type FormRef } from "takosumi-contract";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  D1FormRegistryStore,
  SqlFormRegistryStore,
  type FormActivationRecord,
  type FormDefinitionRecord,
  type FormPackageRecord,
  type FormRegistryStore,
} from "../../../../core/domains/service-forms/mod.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const now = "2026-07-16T00:00:00.000Z";

type StoreHandle = {
  readonly store: FormRegistryStore;
  readonly close: () => Promise<void>;
};

const dialects = ["d1", "postgres"] as const;

for (const dialect of dialects) {
  test(`${dialect} Form registry installs atomically and pages exact definitions`, async () => {
    const handle = await createStore(dialect);
    try {
      const first = fixture("EdgeWorker", "a", "1");
      const second = fixture("ObjectBucket", "b", "2");
      expect(
        (await handle.store.installPackage(first.package, [first.definition]))
          .status,
      ).toBe("installed");
      expect(
        (await handle.store.installPackage(first.package, [first.definition]))
          .status,
      ).toBe("already_installed");
      expect(
        (await handle.store.installPackage(second.package, [second.definition]))
          .status,
      ).toBe("installed");

      const page1 = await handle.store.listDefinitions({ limit: 1 });
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await handle.store.listDefinitions({
        limit: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.identity.formRef.kind).not.toBe(
        page1.items[0]?.identity.formRef.kind,
      );
      expect(page2.nextCursor).toBeUndefined();

      const conflictingPackage = {
        ...second.package,
        packageDigest: digest("e"),
        definitionRefs: [first.ref],
      };
      const conflictingDefinition = {
        ...first.definition,
        identity: {
          formRef: first.ref,
          packageDigest: conflictingPackage.packageDigest,
        },
      };
      const conflict = await handle.store.installPackage(conflictingPackage, [
        conflictingDefinition,
      ]);
      expect(conflict).toEqual({
        status: "conflict",
        reason: "form_ref_conflict",
      });
      expect(
        await handle.store.getPackage(conflictingPackage.packageDigest),
      ).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  test(`${dialect} Form registry fences package and activation races`, async () => {
    const handle = await createStore(dialect);
    try {
      const installed = fixture("Queue", "d", "3");
      await handle.store.installPackage(installed.package, [
        installed.definition,
      ]);
      expect(
        (
          await handle.store.updatePackageStatus(
            installed.package.packageDigest,
            "revoked",
            "2026-07-16T00:00:01.000Z",
          )
        ).status,
      ).toBe("updated");
      expect(
        (
          await handle.store.updatePackageStatus(
            installed.package.packageDigest,
            "deprecated",
            "2026-07-16T00:00:02.000Z",
          )
        ).status,
      ).toBe("invalid_transition");

      const activation = activationFixture(installed);
      expect((await handle.store.createActivation(activation)).status).toBe(
        "created",
      );
      const next = {
        ...activation,
        status: "active" as const,
        revision: 2,
        updatedAt: "2026-07-16T00:00:03.000Z",
      };
      expect((await handle.store.updateActivation(next, 1)).status).toBe(
        "updated",
      );
      expect((await handle.store.updateActivation(activation, 1)).status).toBe(
        "conflict",
      );
      expect((await handle.store.getActivation(activation.id))?.revision).toBe(
        2,
      );
    } finally {
      await handle.close();
    }
  });
}

async function createStore(
  dialect: (typeof dialects)[number],
): Promise<StoreHandle> {
  if (dialect === "d1") {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    return { store: new D1FormRegistryStore(db), close: async () => {} };
  }
  const client = await PGliteSqlClient.create();
  return {
    store: new SqlFormRegistryStore(client),
    close: async () => await client.close(),
  };
}

function fixture(kind: string, digestCharacter: string, suffix: string) {
  const ref: FormRef = {
    apiVersion: "forms.example.test/v1alpha1",
    kind,
    definitionVersion: `1.0.${suffix}`,
    schemaDigest: digest(digestCharacter),
  };
  const packageDigest = digest(
    String.fromCharCode(digestCharacter.charCodeAt(0) + 1),
  );
  const definition: FormDefinitionRecord = {
    identity: { formRef: ref, packageDigest },
    operations: ["create", "read", "delete"],
    installedAt: `2026-07-16T00:00:0${suffix}.000Z`,
  };
  const packageRecord: FormPackageRecord = {
    packageDigest,
    artifactRef: `memory:${kind}`,
    verifierId: "test.data-only.v1",
    status: "installed",
    definitionRefs: [ref],
    installedAt: definition.installedAt,
    installedBy: "acct_operator",
    updatedAt: definition.installedAt,
  };
  return { ref, definition, package: packageRecord };
}

function activationFixture(
  installed: ReturnType<typeof fixture>,
): FormActivationRecord {
  return {
    id: `activation_${formRefKey(installed.ref).length}`,
    identity: {
      formRef: installed.ref,
      packageDigest: installed.package.packageDigest,
    },
    scope: { type: "operator" },
    audience: {},
    policy: {},
    eligibleTargetPoolClasses: [],
    status: "inactive",
    revision: 1,
    createdAt: now,
    createdBy: "acct_operator",
    updatedAt: now,
    updatedBy: "acct_operator",
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
