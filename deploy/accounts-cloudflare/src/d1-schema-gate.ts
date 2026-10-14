import {
  assessD1AccountsWorkerState,
  loadD1AccountsMigrationCatalog,
  readD1AccountsMigrationState,
  type D1AccountsMigrationDatabase,
} from "../../../accounts/service/src/d1-migrations.ts";

export interface AccountsD1WorkerSchemaEvidence {
  readonly headVersion: 4 | 5;
  readonly catalogDigest: string;
  readonly ledgerDigest: string;
  readonly schemaDigest: string;
}

/**
 * Read-only exact checksummed closure gate. Ordinary clients can retain the
 * v4 activationDigest ledger during the additive v5 identity transition;
 * shared-hosted composition separately requires v5 before enabling its profile.
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
