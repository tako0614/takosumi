import {
  assessD1AccountsWorkerState,
  loadD1AccountsMigrationCatalog,
  readD1AccountsMigrationState,
  type D1AccountsMigrationDatabase,
} from "../../../accounts/service/src/d1-migrations.ts";

export interface AccountsD1WorkerSchemaEvidence {
  readonly headVersion: 3 | 4;
  readonly catalogDigest: string;
  readonly ledgerDigest: string;
  readonly schemaDigest: string;
}

/**
 * Read-only transient bridge gate for the activationDigest feature Worker.
 * Exact legacy v3 and exact checksummed v4 are the only accepted closures.
 */
export async function ensureAccountsD1WorkerSchema(
  database: D1AccountsMigrationDatabase,
): Promise<AccountsD1WorkerSchemaEvidence> {
  const catalog = await loadD1AccountsMigrationCatalog();
  const state = await readD1AccountsMigrationState(database, catalog);
  const assessment = assessD1AccountsWorkerState(state);
  if (!assessment.compatible || assessment.headVersion === null) {
    console.error(
      JSON.stringify({
        event: "accounts_d1_schema_incompatible",
        issues: assessment.issues,
        ledgerDigest: state.ledgerDigest,
        schemaDigest: state.schemaDigest,
        catalogDigest: catalog.digest,
      }),
    );
    throw new TypeError("accounts_d1_schema_incompatible");
  }
  return {
    headVersion: assessment.headVersion,
    catalogDigest: catalog.digest,
    ledgerDigest: state.ledgerDigest,
    schemaDigest: state.schemaDigest,
  };
}
