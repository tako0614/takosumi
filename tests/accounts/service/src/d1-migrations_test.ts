import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";

import {
  applyD1AccountsMigrationBatch,
  assessD1AccountsWorkerState,
  backfillD1AccountsActivationDigests,
  d1AccountsMigrationBatchStatements,
  type D1AccountsMigrationDatabase,
  type D1AccountsMigrationPreparedStatement,
  loadD1AccountsMigrationCatalog,
  readD1AccountsMigrationState,
} from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Accounts owns one checksummed D1 v0-v4 catalog without a v4 self-reference", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();

  expect(
    catalog.migrations.map(({ version, name }) => ({ version, name })),
  ).toEqual([
    { version: 0, name: "bootstrap_accounts_store" },
    { version: 1, name: "generalize_billing_provider_storage" },
    { version: 2, name: "remove_commercial_billing_persistence" },
    { version: 3, name: "refresh_chain_retention_indexes" },
    { version: 4, name: "oidc_client_activation_digest" },
  ]);
  expect(catalog.headVersion).toBe(4);
  expect(catalog.migrations).toHaveLength(5);
  expect(catalog.migrations.map((migration) => migration.checksum)).toEqual([
    "sha256:d53076a57ce2216b532702ac5d3ca4b5cd12f33a277dd5ca3387bd58b0f54fc2",
    "sha256:a0bb01ce9957ed8b4adb82096faafe0973b7e6f38c65704da5304f72bd0b2367",
    "sha256:9cfe9a5c5c0b3cf895882e4a66b3bcfbb49884f239508404c156fad8b19d82eb",
    "sha256:c188a19bf1ab1290b88ce3a441479f2e517a200962c2521a10fa1b9b4aed8529",
    "sha256:ee715130a39f84397649c39fb6f059abb13547817fd4d52a13b339882639fc97",
  ]);
  expect(catalog.digest).toBe(
    "sha256:3e13ba1a72d568787e3375072b30da875e4cffa819b8ec8d4fde6c36a4c366ee",
  );
  expect(catalog.policyDigest).toBe(
    "sha256:7b643d6239d89e62063897ea111f94f1c072d08f9c11cd058e8e37a61bd807cd",
  );
  expect(catalog.preLedgerPolicy).toMatchObject({
    kind: "takosumi.accounts.d1-pre-ledger-policy@v1",
    bucket: "oidc_clients",
    cursorColumn: "key",
    chunkSize: 100,
  });
  expect(catalog.schemaClosures.map(({ headVersion, digest }) => ({
    headVersion,
    digest,
  }))).toEqual([
    {
      headVersion: 0,
      digest: "sha256:dfdca177ceb007a4028b4e0678aa01d5f7f85e50d2931b66323245b7cd9d615c",
    },
    {
      headVersion: 1,
      digest: "sha256:dfdca177ceb007a4028b4e0678aa01d5f7f85e50d2931b66323245b7cd9d615c",
    },
    {
      headVersion: 2,
      digest: "sha256:dfdca177ceb007a4028b4e0678aa01d5f7f85e50d2931b66323245b7cd9d615c",
    },
    {
      headVersion: 3,
      digest: "sha256:7bc98b487ba59ef5112b0edc583bdd3279b771769cf2afa9423d1073cebe1c18",
    },
    {
      headVersion: 4,
      digest: "sha256:bdda3ce2b7c6df8d311b9f511c3c529c2268592b5d18469674900bf75131b706",
    },
  ]);

  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");
  const canonicalBody = JSON.stringify(v4.body);
  expect(canonicalBody).not.toContain(v4.checksum);
  expect(canonicalBody).not.toContain("INSERT INTO takosumi_accounts_schema_migrations");
  const receipt = d1AccountsMigrationBatchStatements(v4, 1_000).at(-1);
  expect(receipt?.sql).toStartWith(
    "INSERT INTO takosumi_accounts_schema_migrations",
  );
  expect(receipt?.sql).not.toContain("OR IGNORE");
  expect(receipt?.params).toEqual([4, v4.name, v4.checksum, 1_000]);
});

test("the feature bridge accepts only exact v3 or exact v4 Accounts D1 closure", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();

  const exactV3 = await databaseAtHead(3);
  expect(
    assessD1AccountsWorkerState(
      await readD1AccountsMigrationState(exactV3, catalog),
    ),
  ).toMatchObject({ compatible: true, headVersion: 3 });
  await exactV3
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'bridge-backfill', ?, 2000)",
    )
    .bind(
      JSON.stringify({
        clientId: "bridge-backfill",
        capsuleId: "cap_bridge_backfill",
      }),
    )
    .run();
  expect(
    assessD1AccountsWorkerState(
      await readD1AccountsMigrationState(exactV3, catalog),
    ),
  ).toMatchObject({ compatible: true, headVersion: 3 });

  const exactV4 = await databaseAtHead(4);
  expect(
    assessD1AccountsWorkerState(
      await readD1AccountsMigrationState(exactV4, catalog),
    ),
  ).toMatchObject({ compatible: true, headVersion: 4 });

  const mutations: readonly ((database: SqliteFakeD1) => Promise<void>)[] = [
    async () => {}, // exact v2 is older than the bridge window
    async (database) => {
      await database
        .prepare(
          "UPDATE takosumi_accounts_schema_migrations SET name = 'drift' WHERE version = 3",
        )
        .run();
    },
    async (database) => {
      await database
        .prepare(
          "ALTER TABLE takosumi_accounts_schema_migrations ADD COLUMN checksum TEXT",
        )
        .run();
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const database = await databaseAtHead(index === 0 ? 2 : 3);
    await mutate(database);
    expect(
      assessD1AccountsWorkerState(
        await readD1AccountsMigrationState(database, catalog),
      ).compatible,
    ).toBe(false);
  }

  const v4Drifts: readonly ((database: SqliteFakeD1) => Promise<void>)[] = [
    async (database) => {
      await database
        .prepare(
          "UPDATE takosumi_accounts_schema_migrations SET checksum = NULL WHERE version = 2",
        )
        .run();
    },
    async (database) => {
      await database
        .prepare(
          "UPDATE takosumi_accounts_schema_migrations SET checksum = 'sha256:drift' WHERE version = 4",
        )
        .run();
    },
    async (database) => {
      await database
        .prepare("DELETE FROM takosumi_accounts_schema_migrations WHERE version = 4")
        .run();
    },
    async (database) => {
      await database
        .prepare("DROP INDEX takosumi_accounts_auth_code_token_links_retention")
        .run();
    },
    async (database) => {
      await database
        .prepare(
          "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'late-legacy', ?, 4000)",
        )
        .bind(JSON.stringify({ clientId: "late-legacy" }))
        .run();
    },
    async (database) => {
      await database
        .prepare(
          "INSERT INTO takosumi_accounts_schema_migrations (version, name, checksum, applied_at) VALUES (5, 'future', 'sha256:future', 5000)",
        )
        .run();
    },
  ];
  for (const mutate of v4Drifts) {
    const database = await databaseAtHead(4);
    await mutate(database);
    expect(
      assessD1AccountsWorkerState(
        await readD1AccountsMigrationState(database, catalog),
      ).compatible,
    ).toBe(false);
  }
});

test("the feature bridge rejects same-named tables and indexes with structural drift", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();

  const wrongDocuments = await databaseAtHead(3);
  await wrongDocuments.prepare("DROP TABLE takosumi_accounts_documents").run();
  await wrongDocuments
    .prepare(
      "CREATE TABLE takosumi_accounts_documents (bucket TEXT NOT NULL, key TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, bucket))",
    )
    .run();
  for (const index of [
    [
      "takosumi_accounts_refresh_chain_links_retention",
      "createdAt",
      "refresh_chain_links",
    ],
    [
      "takosumi_accounts_refresh_chain_access_tokens_retention",
      "createdAt",
      "refresh_chain_access_tokens",
    ],
    [
      "takosumi_accounts_revoked_refresh_roots_retention",
      "revokedAt",
      "revoked_refresh_roots",
    ],
    [
      "takosumi_accounts_consumed_authorization_codes_retention",
      "consumedAt",
      "consumed_authorization_codes",
    ],
    [
      "takosumi_accounts_auth_code_token_links_retention",
      "createdAt",
      "auth_code_token_links",
    ],
  ] as const) {
    await wrongDocuments
      .prepare(
        `CREATE INDEX ${index[0]} ON takosumi_accounts_documents(CAST(json_extract(document, '$.${index[1]}') AS INTEGER), key) WHERE bucket = '${index[2]}'`,
      )
      .run();
  }
  const wrongDocumentsState = await readD1AccountsMigrationState(
    wrongDocuments,
    catalog,
  );
  expect(assessD1AccountsWorkerState(wrongDocumentsState).compatible).toBe(
    false,
  );
  expect(wrongDocumentsState.issues).toContain("schema_closure_mismatch");

  const wrongIndex = await databaseAtHead(4);
  await wrongIndex
    .prepare("DROP INDEX takosumi_accounts_refresh_chain_links_retention")
    .run();
  await wrongIndex
    .prepare(
      "CREATE INDEX takosumi_accounts_refresh_chain_links_retention ON takosumi_accounts_documents(key) WHERE bucket = 'refresh_chain_links_wrong'",
    )
    .run();
  const wrongIndexState = await readD1AccountsMigrationState(wrongIndex, catalog);
  expect(assessD1AccountsWorkerState(wrongIndexState).compatible).toBe(false);
  expect(wrongIndexState.issues).toContain("schema_closure_mismatch");
});

test("Accounts D1 v4 atomically upgrades exact v3 and preserves current activation digests", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = new SqliteFakeD1();
  for (const migration of catalog.migrations.slice(0, 4)) {
    await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
  }
  await database
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(
      "oidc_clients",
      "legacy",
      JSON.stringify({ clientId: "legacy", capsuleId: "cap_legacy" }),
      2_000,
    )
    .run();
  await database
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(
      "oidc_clients",
      "current",
      JSON.stringify({
        clientId: "current",
        capsuleId: "cap_current",
        activationDigest: `sha256:${"a".repeat(64)}`,
      }),
      2_001,
    )
    .run();

  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");
  await backfillD1AccountsActivationDigests(database);
  await applyD1AccountsMigrationBatch(database, v4, 3_000);

  const columns = await database
    .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
    .all<{ readonly name: string }>();
  expect((columns.results ?? []).map((column) => column.name)).toEqual([
    "version",
    "name",
    "applied_at",
    "checksum",
  ]);
  const rows = await database
    .prepare(
      "SELECT version, name, checksum, applied_at FROM takosumi_accounts_schema_migrations ORDER BY version",
    )
    .all<{
      readonly version: number;
      readonly name: string;
      readonly checksum: string;
      readonly applied_at: number;
    }>();
  expect(rows.results).toEqual(
    catalog.migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied_at: 1_000 + migration.version === 1_004
        ? 3_000
        : 1_000 + migration.version,
    })),
  );
  const documents = await database
    .prepare(
      "SELECT key, document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' ORDER BY key",
    )
    .all<{ readonly key: string; readonly document: string }>();
  expect((documents.results ?? []).map((row) => JSON.parse(row.document))).toEqual([
    {
      clientId: "current",
      capsuleId: "cap_current",
      activationDigest: `sha256:${"a".repeat(64)}`,
    },
    {
      clientId: "legacy",
      capsuleId: "cap_legacy",
      activationDigest: null,
    },
  ]);
});

test("pre-ledger activationDigest backfill is bounded, deterministic, and value-free", async () => {
  const database = await databaseAtHead(3);
  const keys = Array.from({ length: 205 }, (_, index) =>
    `client-${String(index).padStart(3, "0")}`
  );
  for (const key of keys) {
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "oidc_clients",
        key,
        JSON.stringify({ clientId: key, capsuleId: `cap_${key}` }),
        2_000,
      )
      .run();
  }
  const statements: string[] = [];
  const observed: D1AccountsMigrationDatabase = {
    prepare(sql) {
      statements.push(sql);
      return database.prepare(sql);
    },
    batch: (batch) => database.batch(batch),
  };

  const report = await backfillD1AccountsActivationDigests(observed);

  expect(report).toEqual({
    inventoryCount: 205,
    candidateCount: 205,
    chunkCount: 3,
    lostAcknowledgementReconciledChunks: 0,
    cutoverReconciled: false,
    missingAfter: 0,
  });
  const updates = statements.filter((sql) =>
    sql.startsWith("UPDATE takosumi_accounts_documents")
  );
  expect(updates).toHaveLength(3);
  expect(updates.every((sql) => sql.includes("key IN ("))).toBe(true);
  expect(updates.every((sql) => sql.includes("json_type"))).toBe(true);
  expect(JSON.stringify(report)).not.toContain(keys[0]!);
  expect(JSON.stringify(report)).not.toContain(keys.at(-1)!);
});

test("pre-ledger activationDigest backfill is restart-safe and reconciles lost acknowledgement", async () => {
  const database = await databaseAtHead(3);
  for (let index = 0; index < 150; index += 1) {
    const key = `restart-${String(index).padStart(3, "0")}`;
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "oidc_clients",
        key,
        JSON.stringify({ clientId: key, capsuleId: `cap_${key}` }),
        2_000,
      )
      .run();
  }
  let updates = 0;
  const interrupted: D1AccountsMigrationDatabase = {
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!sql.startsWith("UPDATE takosumi_accounts_documents")) {
        return statement;
      }
      updates += 1;
      if (updates === 1) return statement;
      return rejectingStatement("simulated_operator_interruption");
    },
    batch: (batch) => database.batch(batch),
  };
  await expect(
    backfillD1AccountsActivationDigests(interrupted),
  ).rejects.toThrow("activation_digest_backfill_retry_required");

  const restarted = await backfillD1AccountsActivationDigests(database);
  expect(restarted.candidateCount).toBe(50);
  expect(restarted.missingAfter).toBe(0);

  const lostAckDatabase = await databaseAtHead(3);
  await lostAckDatabase
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'lost-ack', ?, 2000)",
    )
    .bind(JSON.stringify({ clientId: "lost-ack", capsuleId: "cap_lost_ack" }))
    .run();
  let lost = false;
  const lostAck: D1AccountsMigrationDatabase = {
    prepare(sql) {
      return lostAckDatabase.prepare(sql);
    },
    async batch(statements) {
      const results = await lostAckDatabase.batch(statements);
      if (!lost) {
        lost = true;
        throw new Error("simulated_lost_ack");
      }
      return results;
    },
  };
  const reconciled = await backfillD1AccountsActivationDigests(lostAck);
  expect(reconciled).toMatchObject({
    inventoryCount: 1,
    candidateCount: 1,
    lostAcknowledgementReconciledChunks: 1,
    missingAfter: 0,
  });
});

test("pre-ledger chunks cannot write after the exact-v3 cutoff", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");

  for (const corruptAfterCutover of [false, true]) {
    const backing = await databaseAtHead(3);
    const key = corruptAfterCutover ? "cutover-invalid" : "cutover-clean";
    await backing
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', ?, ?, 2000)",
      )
      .bind(key, JSON.stringify({ clientId: key, capsuleId: `cap_${key}` }))
      .run();

    let cutoverCommitted = false;
    let postCutoverUpdateExecutions = 0;
    const interleaved: D1AccountsMigrationDatabase = {
      prepare(sql) {
        const statement = backing.prepare(sql);
        if (sql === catalog.preLedgerPolicy.candidateSql) {
          const candidate: D1AccountsMigrationPreparedStatement = {
            bind(...values) {
              const bound = statement.bind(...values);
              return {
                ...candidate,
                async all<T>() {
                  const rows = await bound.all<T>();
                  if (!cutoverCommitted) {
                    await backing
                      .prepare(catalog.preLedgerPolicy.updateSql)
                      .bind("oidc_clients", JSON.stringify([key]))
                      .run();
                    await applyD1AccountsMigrationBatch(backing, v4, 3_000);
                    if (corruptAfterCutover) {
                      await backing
                        .prepare(
                          "UPDATE takosumi_accounts_documents SET document = json_remove(document, '$.activationDigest') WHERE bucket = 'oidc_clients' AND key = ?",
                        )
                        .bind(key)
                        .run();
                    }
                    cutoverCommitted = true;
                  }
                  return rows;
                },
              };
            },
            run: () => statement.run(),
            first: () => statement.first(),
            all: () => statement.all(),
          };
          return candidate;
        }
        if (sql === catalog.preLedgerPolicy.updateSql) {
          const update: D1AccountsMigrationPreparedStatement = {
            bind(...values) {
              const bound = statement.bind(...values);
              return {
                ...update,
                async run() {
                  if (cutoverCommitted) postCutoverUpdateExecutions += 1;
                  return await bound.run();
                },
              };
            },
            run: () => statement.run(),
            first: () => statement.first(),
            all: () => statement.all(),
          };
          return update;
        }
        return statement;
      },
      batch: (statements) => backing.batch(statements),
    };

    if (corruptAfterCutover) {
      await expect(
        backfillD1AccountsActivationDigests(interleaved),
      ).rejects.toThrow("activation_digest_backfill_cutoff_invalid");
    } else {
      const report = await backfillD1AccountsActivationDigests(interleaved);
      expect(report.cutoverReconciled).toBe(true);
    }
    expect(postCutoverUpdateExecutions).toBe(0);
    const document = await backing
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key = ?",
      )
      .bind(key)
      .first<{ readonly document: string }>();
    const parsed = JSON.parse(document?.document ?? "null") as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(parsed, "activationDigest")).toBe(
      !corruptAfterCutover,
    );
  }
});

test("pre-ledger activationDigest inventory rejects identity and digest drift before writes", async () => {
  for (const fixture of [
    {
      key: "invalid-capsule",
      document: { clientId: "invalid-capsule", capsuleId: "   " },
    },
    {
      key: "client-key-mismatch",
      document: { clientId: "different-client", capsuleId: "cap_mismatch" },
    },
    {
      key: "invalid-activation-digest",
      document: {
        clientId: "invalid-activation-digest",
        capsuleId: "cap_invalid_digest",
        activationDigest: "not-a-digest",
      },
    },
  ] as const) {
    const database = await databaseAtHead(3);
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', ?, ?, 2000)",
      )
      .bind(fixture.key, JSON.stringify(fixture.document))
      .run();

    await expect(
      backfillD1AccountsActivationDigests(database),
    ).rejects.toThrow("activation_digest_backfill_inventory_drift");
    const document = await database
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key = ?",
      )
      .bind(fixture.key)
      .first<{ readonly document: string }>();
    expect(JSON.parse(document?.document ?? "null")).toEqual(
      fixture.document,
    );
  }
});

test("v4 starts with an exact-v3 zero-missing fence and has no unbounded document update", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");
  expect(v4.body[0]?.sql).toContain("exact_legacy_prefix");
  expect(v4.body[0]?.sql).toContain("sqlite_master");
  expect(v4.body[0]?.sql).toContain("tbl_name");
  expect(v4.body[0]?.sql).toContain("activationDigest");
  expect(
    v4.body.some((statement) =>
      statement.sql.startsWith("UPDATE takosumi_accounts_documents")
    ),
  ).toBe(false);

  const database = await databaseAtHead(3);
  const concurrentInsert: D1AccountsMigrationDatabase = {
    prepare: (sql) => database.prepare(sql),
    async batch(statements) {
      await database
        .prepare(
          "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'concurrent', ?, 2000)",
        )
        .bind(
          JSON.stringify({ clientId: "concurrent", capsuleId: "cap_concurrent" }),
        )
        .run();
      return await database.batch(statements);
    },
  };
  await expect(
    applyD1AccountsMigrationBatch(concurrentInsert, v4, 3_000),
  ).rejects.toThrow();
  const columns = await database
    .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
    .all<{ readonly name: string }>();
  expect((columns.results ?? []).map((column) => column.name)).not.toContain(
    "checksum",
  );

  const schemaDrift = await databaseAtHead(3);
  const concurrentSchemaDrift: D1AccountsMigrationDatabase = {
    prepare: (sql) => schemaDrift.prepare(sql),
    async batch(statements) {
      await schemaDrift
        .prepare("DROP INDEX takosumi_accounts_indexes_lookup")
        .run();
      await schemaDrift
        .prepare(
          "CREATE INDEX takosumi_accounts_indexes_lookup ON takosumi_accounts_indexes (document_key)",
        )
        .run();
      return await schemaDrift.batch(statements);
    },
  };
  await expect(
    applyD1AccountsMigrationBatch(concurrentSchemaDrift, v4, 3_000),
  ).rejects.toThrow();
  const schemaDriftColumns = await schemaDrift
    .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
    .all<{ readonly name: string }>();
  expect(
    (schemaDriftColumns.results ?? []).map((column) => column.name),
  ).not.toContain("checksum");
});

test("Accounts D1 v4 transaction rejects legacy name drift before ALTER", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = await databaseAtHead(3);
  await database
    .prepare(
      "UPDATE takosumi_accounts_schema_migrations SET name = 'drift' WHERE version = 2",
    )
    .run();
  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");

  await expect(
    applyD1AccountsMigrationBatch(database, v4, 3_000),
  ).rejects.toThrow();
  const columns = await database
    .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
    .all<{ readonly name: string }>();
  expect((columns.results ?? []).map((column) => column.name)).toEqual([
    "version",
    "name",
    "applied_at",
  ]);
  const v4Receipt = await database
    .prepare(
      "SELECT version FROM takosumi_accounts_schema_migrations WHERE version = 4",
    )
    .first<{ readonly version: number }>();
  expect(v4Receipt).toBeNull();
});

test("every failed v4 statement rolls back schema, documents, and receipt", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");

  for (let failedStatement = 0; failedStatement <= v4.body.length; failedStatement += 1) {
    const database = new SqliteFakeD1();
    for (const migration of catalog.migrations.slice(0, 4)) {
      await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
    }
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'legacy', ?, 2000)",
      )
      .bind(JSON.stringify({ clientId: "legacy", capsuleId: "cap_legacy" }))
      .run();

    await backfillD1AccountsActivationDigests(database);

    const injected = failureAt(database, failedStatement);
    await expect(
      applyD1AccountsMigrationBatch(injected, v4, 3_000),
    ).rejects.toThrow("injected_v4_statement_failure");

    const columns = await database
      .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
      .all<{ readonly name: string }>();
    expect((columns.results ?? []).map((column) => column.name)).toEqual([
      "version",
      "name",
      "applied_at",
    ]);
    const ledger = await database
      .prepare(
        "SELECT version, name FROM takosumi_accounts_schema_migrations ORDER BY version",
      )
      .all<{ readonly version: number; readonly name: string }>();
    expect(ledger.results).toEqual(
      catalog.migrations.slice(0, 4).map(({ version, name }) => ({
        version,
        name,
      })),
    );
    const document = await database
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key = 'legacy'",
      )
      .first<{ readonly document: string }>();
    expect(JSON.parse(document?.document ?? "null")).toEqual({
      clientId: "legacy",
      capsuleId: "cap_legacy",
      activationDigest: null,
    });
  }
});

test("workerd D1 rolls back v4 ALTER, data, and receipt as one real batch", async () => {
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [
      {
        type: "ESModule",
        path: "accounts-d1-v4-atomic-proof.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      },
    ],
    d1Databases: { ACCOUNTS: "accounts-d1-v4-atomic-proof" },
  });
  try {
    const catalog = await loadD1AccountsMigrationCatalog();
    const database = (await runtime.getD1Database(
      "ACCOUNTS",
    )) as unknown as D1AccountsMigrationDatabase;
    for (const migration of catalog.migrations.slice(0, 4)) {
      await applyD1AccountsMigrationBatch(
        database,
        migration,
        1_000 + migration.version,
      );
    }
    await database
      .prepare(
        "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('oidc_clients', 'legacy', ?, 2000)",
      )
      .bind(JSON.stringify({ clientId: "legacy", capsuleId: "cap_legacy" }))
      .run();

    await backfillD1AccountsActivationDigests(database);

    const v4 = catalog.migrations[4];
    if (!v4) throw new Error("Accounts D1 v4 is missing");
    const invalidV4 = {
      ...v4,
      body: [
        ...v4.body,
        {
          sql: "INSERT INTO accounts_d1_v4_failure_probe_missing (value) VALUES (1)",
          params: [],
        },
      ],
    };
    await expect(
      applyD1AccountsMigrationBatch(database, invalidV4, 3_000),
    ).rejects.toThrow();

    const columns = await database
      .prepare("PRAGMA table_info('takosumi_accounts_schema_migrations')")
      .all<{ readonly name: string }>();
    expect((columns.results ?? []).map((column) => column.name)).toEqual([
      "version",
      "name",
      "applied_at",
    ]);
    const ledger = await database
      .prepare(
        "SELECT version, name FROM takosumi_accounts_schema_migrations ORDER BY version",
      )
      .all<{ readonly version: number; readonly name: string }>();
    expect(ledger.results).toEqual(
      catalog.migrations.slice(0, 4).map(({ version, name }) => ({
        version,
        name,
      })),
    );
    const document = await database
      .prepare(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key = 'legacy'",
      )
      .first<{ readonly document: string }>();
    expect(JSON.parse(document?.document ?? "null")).toEqual({
      clientId: "legacy",
      capsuleId: "cap_legacy",
      activationDigest: null,
    });
  } finally {
    await runtime.dispose();
  }
}, 30_000);

function failureAt(
  database: D1AccountsMigrationDatabase,
  statementIndex: number,
): D1AccountsMigrationDatabase {
  let prepared = 0;
  return {
    prepare(sql: string): D1AccountsMigrationPreparedStatement {
      const current = prepared++;
      if (current !== statementIndex) return database.prepare(sql);
      const failure: D1AccountsMigrationPreparedStatement = {
        bind: () => failure,
        run: () => Promise.reject(new Error("injected_v4_statement_failure")),
        first: () => Promise.reject(new Error("injected_v4_statement_failure")),
        all: () => Promise.reject(new Error("injected_v4_statement_failure")),
      };
      return failure;
    },
    batch(statements) {
      return database.batch(statements);
    },
  };
}

function rejectingStatement(
  message: string,
): D1AccountsMigrationPreparedStatement {
  const statement: D1AccountsMigrationPreparedStatement = {
    bind: () => statement,
    run: () => Promise.reject(new Error(message)),
    first: () => Promise.reject(new Error(message)),
    all: () => Promise.reject(new Error(message)),
  };
  return statement;
}

async function databaseAtHead(head: number): Promise<SqliteFakeD1> {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = new SqliteFakeD1();
  for (const migration of catalog.migrations.slice(0, head + 1)) {
    await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
  }
  return database;
}
