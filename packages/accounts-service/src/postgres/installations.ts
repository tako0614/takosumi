// AppInstallation ledger: ledger accounts, spaces, installations, runtime
// bindings, app bindings, app grants, and the append-only event log. Free
// functions delegating raw queries to a PostgresQueryClient. Behaviour
// preserved verbatim from the original PostgresAccountsStore.

import type {
  AppBindingRecord,
  AppGrantRecord,
  InstallationEventRecord,
  InstallationRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  SpaceRecord,
} from "../ledger.ts";
import {
  assertValidAppBindingRecord,
  assertValidAppGrantRecord,
} from "../ledger.ts";
import { LedgerAccountOwnershipConflictError } from "../store.ts";
import {
  appInstallationFromRow,
  type AppInstallationRow,
  appInstallationSelect,
  installationEventFromRow,
  type InstallationEventRow,
  json,
  ledgerAccountFromRow,
  type LedgerAccountRow,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  runRows,
  spaceFromRow,
  type SpaceRow,
  spaceSelect,
  toDate,
} from "./internal.ts";

export async function saveLedgerAccount(
  client: PostgresQueryClient,
  record: LedgerAccountRecord,
): Promise<void> {
  // F7 fix: defense-in-depth at the store layer. The ON CONFLICT clause
  // previously overwrote `legal_owner_subject` unconditionally, which
  // would silently re-bind an existing account to a different Takosumi
  // subject. The application path in installation-lifecycle-routes.ts
  // performs an explicit check-and-set guard before calling here, but
  // the store now refuses to overwrite a non-matching owner so a buggy
  // or malicious caller bypassing that path still cannot steal a
  // ledger account.
  //
  // The WHERE clause on the UPDATE branch only fires when the existing
  // legal_owner_subject already matches the incoming one. If the existing
  // row has a different owner, the UPDATE is a no-op and RETURNING yields
  // nothing. Previously the store silently swallowed that (a no-op with no
  // signal) while the in-memory and D1 stores diverged; it now throws
  // LedgerAccountOwnershipConflictError so all three stores reject an
  // ownership change identically.
  const written = await runFirst<{ account_id: string }>(
    client,
    `INSERT INTO installation_v1.ledger_accounts (
        account_id, legal_owner_subject, billing_account_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_id) DO UPDATE SET
        billing_account_id = EXCLUDED.billing_account_id,
        updated_at = EXCLUDED.updated_at
      WHERE installation_v1.ledger_accounts.legal_owner_subject
        = EXCLUDED.legal_owner_subject
      RETURNING account_id`,
    [
      record.accountId,
      record.legalOwnerSubject,
      record.billingAccountId ?? null,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
  if (written === undefined) {
    // 0 rows: the account exists with a different legal_owner_subject.
    const existing = await findLedgerAccount(client, record.accountId);
    throw new LedgerAccountOwnershipConflictError(
      record.accountId,
      existing?.legalOwnerSubject ?? "(unknown)",
      record.legalOwnerSubject,
    );
  }
}

export async function findLedgerAccount(
  client: PostgresQueryClient,
  accountId: string,
): Promise<LedgerAccountRecord | undefined> {
  const row = await runFirst<LedgerAccountRow>(
    client,
    `SELECT account_id, legal_owner_subject, billing_account_id, created_at, updated_at
       FROM installation_v1.ledger_accounts
       WHERE account_id = $1`,
    [accountId],
  );
  return row ? ledgerAccountFromRow(row) : undefined;
}

export async function saveSpace(
  client: PostgresQueryClient,
  record: SpaceRecord,
): Promise<void> {
  await runQuery(
    client,
    `INSERT INTO installation_v1.spaces (
        space_id, account_id, kind, display_name, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (space_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        kind = EXCLUDED.kind,
        display_name = EXCLUDED.display_name,
        updated_at = EXCLUDED.updated_at`,
    [
      record.spaceId,
      record.accountId,
      record.kind,
      record.displayName ?? null,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findSpace(
  client: PostgresQueryClient,
  spaceId: string,
): Promise<SpaceRecord | undefined> {
  const row = await runFirst<SpaceRow>(
    client,
    spaceSelect("space_id = $1"),
    [spaceId],
  );
  return row ? spaceFromRow(row) : undefined;
}

export async function listSpacesForAccount(
  client: PostgresQueryClient,
  accountId: string,
): Promise<readonly SpaceRecord[]> {
  const rows = await runRows<SpaceRow>(
    client,
    spaceSelect("account_id = $1") + " ORDER BY created_at, space_id",
    [accountId],
  );
  return rows.map(spaceFromRow);
}

export async function saveAppInstallation(
  client: PostgresQueryClient,
  record: InstallationRecord,
): Promise<void> {
  // Wave 6 dropped the `runtime_binding_id` column from
  // `installation_v1.app_installations`. The write path no longer
  // references it. `InstallationRecord.runtimeBindingId` is silently
  // ignored when persisting (in-memory store still tracks it for
  // backward compatibility with the materialize helpers).
  await runQuery(
    client,
    `INSERT INTO installation_v1.app_installations (
        installation_id, account_id, space_id, app_id, source_git_url,
        source_ref, source_commit, plan_snapshot_digest, artifact_digest,
        mode, billing_account_id, status,
        created_by_subject, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT (installation_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        space_id = EXCLUDED.space_id,
        app_id = EXCLUDED.app_id,
        source_git_url = EXCLUDED.source_git_url,
        source_ref = EXCLUDED.source_ref,
        source_commit = EXCLUDED.source_commit,
        plan_snapshot_digest = EXCLUDED.plan_snapshot_digest,
        artifact_digest = EXCLUDED.artifact_digest,
        mode = EXCLUDED.mode,
        billing_account_id = EXCLUDED.billing_account_id,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at`,
    [
      record.installationId,
      record.accountId,
      record.spaceId,
      record.appId,
      record.sourceGitUrl,
      record.sourceRef,
      record.sourceCommit,
      record.planSnapshotDigest,
      record.artifactDigest ?? null,
      record.mode,
      record.billingAccountId ?? null,
      record.status,
      record.createdBySubject,
      toDate(record.createdAt),
      toDate(record.updatedAt),
    ],
  );
}

export async function findAppInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<InstallationRecord | undefined> {
  const row = await runFirst<AppInstallationRow>(
    client,
    appInstallationSelect("installation_id = $1"),
    [installationId],
  );
  return row ? appInstallationFromRow(row) : undefined;
}

export async function listAppInstallationsForSpace(
  client: PostgresQueryClient,
  spaceId: string,
): Promise<readonly InstallationRecord[]> {
  const rows = await runRows<AppInstallationRow>(
    client,
    appInstallationSelect("space_id = $1") +
      " ORDER BY created_at, installation_id",
    [spaceId],
  );
  return rows.map(appInstallationFromRow);
}

export async function listAppInstallationsForBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<readonly InstallationRecord[]> {
  const rows = await runRows<AppInstallationRow>(
    client,
    appInstallationSelect("billing_account_id = $1") +
      " ORDER BY created_at, installation_id",
    [billingAccountId],
  );
  return rows.map(appInstallationFromRow);
}

export function saveRuntimeBinding(
  client: PostgresQueryClient,
  record: RuntimeBindingRecord,
): Promise<void> {
  // Wave 6 dropped `installation_v1.runtime_bindings`. The record remains a
  // live orchestration entity (shared-cell warm-pool, materialize continuity,
  // dashboard render) but is no longer persisted; INSERT against the dropped
  // table raised "relation does not exist" (production-blocking SQL drift).
  // No-op shim mirrors the Phase E precedent in `listAppBindingsForInstallation`.
  void client;
  void record;
  return Promise.resolve();
}

export function findRuntimeBinding(
  client: PostgresQueryClient,
  runtimeBindingId: string,
): Promise<RuntimeBindingRecord | undefined> {
  // Wave 6 dropped `installation_v1.runtime_bindings`. Callers (materialize
  // helpers / dashboard / export bundle / lifecycle routes) all guard on
  // `installation.runtimeBindingId` being set, and `appInstallationFromRow`
  // already returns it as undefined, so this read path is unreachable in
  // production. Returning undefined keeps the contract honest.
  void client;
  void runtimeBindingId;
  return Promise.resolve(undefined);
}

export function saveAppBinding(
  client: PostgresQueryClient,
  record: AppBindingRecord,
): Promise<void> {
  // Wave 6 dropped `installation_v1.app_bindings`. Validation invariants are
  // still enforced (callers depend on TypeError-as-rejection for malformed
  // records); only the SQL INSERT is removed. Mirrors the Phase E no-op
  // precedent in `listAppBindingsForInstallation`. Validation throws are
  // converted to promise rejections so `assertRejects` tests pass.
  try {
    assertValidAppBindingRecord(record);
  } catch (error) {
    return Promise.reject(error);
  }
  void client;
  return Promise.resolve();
}

export function listAppBindingsForInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<readonly AppBindingRecord[]> {
  // Wave 6 dropped `installation_v1.app_bindings`. AppBinding is no
  // longer a public concept; the table no longer exists in production
  // schema. Selecting against it raised "relation does not exist"
  // (production-blocking SQL drift). We now return an empty array so
  // legacy callers (= envelope serialization, dashboard render path)
  // remain compatible without touching the database.
  void client;
  void installationId;
  return Promise.resolve([]);
}

export function saveAppGrant(
  client: PostgresQueryClient,
  record: AppGrantRecord,
): Promise<void> {
  // Wave 6 dropped `installation_v1.app_grants`. Validation invariants are
  // still enforced; only the SQL INSERT is removed. Mirrors the Phase E
  // no-op precedent in `listAppGrantsForInstallation`. Validation throws
  // are converted to promise rejections so `assertRejects` tests pass.
  try {
    assertValidAppGrantRecord(record);
  } catch (error) {
    return Promise.reject(error);
  }
  void client;
  return Promise.resolve();
}

export function findAppGrant(
  client: PostgresQueryClient,
  grantId: string,
): Promise<AppGrantRecord | undefined> {
  // Wave 6 dropped `installation_v1.app_grants`. Returning undefined matches
  // the Phase E SELECT precedent.
  void client;
  void grantId;
  return Promise.resolve(undefined);
}

export function listAppGrantsForInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<readonly AppGrantRecord[]> {
  // Wave 6 dropped `installation_v1.app_grants`. AppGrant is no longer
  // a public concept; the table no longer exists in production schema.
  // Selecting against it raised "relation does not exist"
  // (production-blocking SQL drift). We now return an empty array so
  // legacy callers (= envelope serialization, dashboard render path)
  // remain compatible without touching the database.
  void client;
  void installationId;
  return Promise.resolve([]);
}

export async function appendInstallationEvent(
  client: PostgresQueryClient,
  record: InstallationEventRecord,
): Promise<void> {
  // F7 fix: serialize concurrent appends per installation by taking a
  // row-level lock on a synthetic chain-lock row. Two concurrent
  // appenders that both observed the same `previousEventHash` would
  // otherwise INSERT two successor events with identical
  // `previous_event_hash`, forking the hash chain. The
  // `installation_event_chain_locks` table holds one row per
  // installation. `SELECT ... FOR UPDATE NOWAIT` claims the row inside
  // a transaction; the second concurrent caller observes the
  // `55P03 lock_not_available` Postgres error and re-raises (the
  // application-layer `appendLedgerEvent` retries).
  //
  // MIGRATION REQUIREMENT (see migrations/018_event_chain_lock.sql):
  //   CREATE TABLE installation_v1.installation_event_chain_locks (
  //     installation_id text PRIMARY KEY
  //       REFERENCES installation_v1.app_installations(installation_id)
  //   );
  await runQuery(client, "BEGIN");
  try {
    // Lazily materialize the lock row for the installation. The lock
    // table is keyed by installation_id and has no other columns; the
    // row only exists to serve as a `FOR UPDATE` target. `ON CONFLICT
    // DO NOTHING` keeps the upsert idempotent so we don't need a
    // separate "create lock row on installation create" path.
    await runQuery(
      client,
      `INSERT INTO installation_v1.installation_event_chain_locks (installation_id)
         VALUES ($1)
         ON CONFLICT (installation_id) DO NOTHING`,
      [record.installationId],
    );
    // NOWAIT: surface contention immediately rather than blocking for
    // an unbounded lock timeout. Callers handle the lock-not-available
    // error by refetching the chain tail and retrying with a freshly
    // computed `previousEventHash` / `eventHash`.
    await runQuery(
      client,
      `SELECT 1 FROM installation_v1.installation_event_chain_locks
         WHERE installation_id = $1 FOR UPDATE NOWAIT`,
      [record.installationId],
    );
    await runQuery(
      client,
      `INSERT INTO installation_v1.installation_events (
          event_id, installation_id, event_type, payload, previous_event_hash,
          event_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO NOTHING`,
      [
        record.eventId,
        record.installationId,
        record.eventType,
        json(record.payload),
        record.previousEventHash ?? null,
        record.eventHash,
        toDate(record.createdAt),
      ],
    );
    await runQuery(client, "COMMIT");
  } catch (error) {
    try {
      await runQuery(client, "ROLLBACK");
    } catch {
      // Swallow rollback failure; we re-raise the original error below.
    }
    throw error;
  }
}

export async function listInstallationEvents(
  client: PostgresQueryClient,
  installationId: string,
): Promise<readonly InstallationEventRecord[]> {
  const rows = await runRows<InstallationEventRow>(
    client,
    `SELECT event_id, installation_id, event_type, payload, previous_event_hash,
         event_hash, created_at
       FROM installation_v1.installation_events
       WHERE installation_id = $1
       ORDER BY event_sequence, event_id`,
    [installationId],
  );
  return rows.map(installationEventFromRow);
}
