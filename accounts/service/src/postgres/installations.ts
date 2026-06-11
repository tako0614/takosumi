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
import { and, asc, eq, sql } from "drizzle-orm";
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import {
  assertValidAppBindingRecord,
  assertValidAppGrantRecord,
} from "../ledger.ts";
import { LedgerAccountOwnershipConflictError } from "../store.ts";
import {
  appInstallationFromRow,
  type AppInstallationRow,
  installationEventFromRow,
  type InstallationEventRow,
  ledgerAccountFromRow,
  type LedgerAccountRow,
  postgresDrizzle,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  spaceFromRow,
  type SpaceRow,
  toDate,
} from "./internal.ts";

const installation = pgSchema("installation_v1");

const ledgerAccounts = installation.table("ledger_accounts", {
  accountId: text("account_id").primaryKey(),
  legalOwnerSubject: text("legal_owner_subject").notNull(),
  billingAccountId: text("billing_account_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const spaces = installation.table("spaces", {
  spaceId: text("space_id").primaryKey(),
  accountId: text("account_id").notNull(),
  kind: text("kind").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const appInstallations = installation.table("app_installations", {
  installationId: text("installation_id").primaryKey(),
  accountId: text("account_id").notNull(),
  spaceId: text("space_id").notNull(),
  appId: text("app_id").notNull(),
  sourceGitUrl: text("source_git_url").notNull(),
  sourceRef: text("source_ref").notNull(),
  sourceCommit: text("source_commit").notNull(),
  planDigest: text("plan_digest").notNull(),
  artifactDigest: text("artifact_digest"),
  mode: text("mode").notNull(),
  billingAccountId: text("billing_account_id"),
  status: text("status").notNull(),
  createdBySubject: text("created_by_subject").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const installationEventChainLocks = installation.table(
  "installation_event_chain_locks",
  {
    installationId: text("installation_id").primaryKey(),
  },
);

const installationEvents = installation.table("installation_events", {
  eventId: text("event_id").primaryKey(),
  installationId: text("installation_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  previousEventHash: text("previous_event_hash"),
  eventHash: text("event_hash").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  eventSequence: text("event_sequence"),
});

const installationSchema = {
  ledgerAccounts,
  spaces,
  appInstallations,
  installationEventChainLocks,
  installationEvents,
};

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
  const values = ledgerAccountValues(record);
  const written = await postgresDrizzle(client, installationSchema)
    .insert(ledgerAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: ledgerAccounts.accountId,
      set: {
        billingAccountId: values.billingAccountId,
        updatedAt: values.updatedAt,
      },
      where: eq(
        ledgerAccounts.legalOwnerSubject,
        sql`excluded.legal_owner_subject`,
      ),
    })
    .returning({ account_id: ledgerAccounts.accountId });
  if (written[0] === undefined) {
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
  const row = await postgresDrizzle(client, installationSchema)
    .select(ledgerAccountColumns)
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.accountId, accountId))
    .limit(1)
    .then((rows) => rows[0] as LedgerAccountRow | undefined);
  return row ? ledgerAccountFromRow(row) : undefined;
}

export async function saveSpace(
  client: PostgresQueryClient,
  record: SpaceRecord,
): Promise<void> {
  const values = spaceValues(record);
  await postgresDrizzle(client, installationSchema)
    .insert(spaces)
    .values(values)
    .onConflictDoUpdate({
      target: spaces.spaceId,
      set: {
        accountId: values.accountId,
        kind: values.kind,
        displayName: values.displayName,
        updatedAt: values.updatedAt,
      },
    });
}

export async function findSpace(
  client: PostgresQueryClient,
  spaceId: string,
): Promise<SpaceRecord | undefined> {
  const row = await postgresDrizzle(client, installationSchema)
    .select(spaceColumns)
    .from(spaces)
    .where(eq(spaces.spaceId, spaceId))
    .limit(1)
    .then((rows) => rows[0] as SpaceRow | undefined);
  return row ? spaceFromRow(row) : undefined;
}

export async function listSpacesForAccount(
  client: PostgresQueryClient,
  accountId: string,
): Promise<readonly SpaceRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(spaceColumns)
    .from(spaces)
    .where(eq(spaces.accountId, accountId))
    .orderBy(asc(spaces.createdAt), asc(spaces.spaceId))) as SpaceRow[];
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
  const values = appInstallationValues(record);
  await postgresDrizzle(client, installationSchema)
    .insert(appInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: appInstallations.installationId,
      set: {
        accountId: values.accountId,
        spaceId: values.spaceId,
        appId: values.appId,
        sourceGitUrl: values.sourceGitUrl,
        sourceRef: values.sourceRef,
        sourceCommit: values.sourceCommit,
        planDigest: values.planDigest,
        artifactDigest: values.artifactDigest,
        mode: values.mode,
        billingAccountId: values.billingAccountId,
        status: values.status,
        updatedAt: values.updatedAt,
      },
    });
}

export async function findAppInstallation(
  client: PostgresQueryClient,
  installationId: string,
): Promise<InstallationRecord | undefined> {
  const row = await postgresDrizzle(client, installationSchema)
    .select(appInstallationColumns)
    .from(appInstallations)
    .where(eq(appInstallations.installationId, installationId))
    .limit(1)
    .then((rows) => rows[0] as AppInstallationRow | undefined);
  return row ? appInstallationFromRow(row) : undefined;
}

export async function listAppInstallationsForSpace(
  client: PostgresQueryClient,
  spaceId: string,
): Promise<readonly InstallationRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(appInstallationColumns)
    .from(appInstallations)
    .where(eq(appInstallations.spaceId, spaceId))
    .orderBy(
      asc(appInstallations.createdAt),
      asc(appInstallations.installationId),
    )) as AppInstallationRow[];
  return rows.map(appInstallationFromRow);
}

export async function listAppInstallationsForBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<readonly InstallationRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(appInstallationColumns)
    .from(appInstallations)
    .where(eq(appInstallations.billingAccountId, billingAccountId))
    .orderBy(
      asc(appInstallations.createdAt),
      asc(appInstallations.installationId),
    )) as AppInstallationRow[];
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
  // account-plane callers (= envelope serialization, dashboard render path)
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
  // account-plane callers (= envelope serialization, dashboard render path)
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
    await postgresDrizzle(client, installationSchema)
      .insert(installationEventChainLocks)
      .values({ installationId: record.installationId })
      .onConflictDoNothing({
        target: installationEventChainLocks.installationId,
      });
    // NOWAIT: surface contention immediately rather than blocking for
    // an unbounded lock timeout. Callers handle the lock-not-available
    // error by refetching the chain tail and retrying with a freshly
    // computed `previousEventHash` / `eventHash`.
    // Raw SQL is intentionally isolated here because Drizzle has no portable
    // builder API for Postgres `FOR UPDATE NOWAIT` row locks.
    await runQuery(
      client,
      `SELECT 1 FROM installation_v1.installation_event_chain_locks
         WHERE installation_id = $1 FOR UPDATE NOWAIT`,
      [record.installationId],
    );
    await postgresDrizzle(client, installationSchema)
      .insert(installationEvents)
      .values(installationEventValues(record))
      .onConflictDoNothing({ target: installationEvents.eventId });
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
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(installationEventColumns)
    .from(installationEvents)
    .where(eq(installationEvents.installationId, installationId))
    .orderBy(
      asc(installationEvents.eventSequence),
      asc(installationEvents.eventId),
    )) as InstallationEventRow[];
  return rows.map(installationEventFromRow);
}

const ledgerAccountColumns = {
  account_id: ledgerAccounts.accountId,
  legal_owner_subject: ledgerAccounts.legalOwnerSubject,
  billing_account_id: ledgerAccounts.billingAccountId,
  created_at: ledgerAccounts.createdAt,
  updated_at: ledgerAccounts.updatedAt,
};

const spaceColumns = {
  space_id: spaces.spaceId,
  account_id: spaces.accountId,
  kind: spaces.kind,
  display_name: spaces.displayName,
  created_at: spaces.createdAt,
  updated_at: spaces.updatedAt,
};

const appInstallationColumns = {
  installation_id: appInstallations.installationId,
  account_id: appInstallations.accountId,
  space_id: appInstallations.spaceId,
  app_id: appInstallations.appId,
  source_git_url: appInstallations.sourceGitUrl,
  source_ref: appInstallations.sourceRef,
  source_commit: appInstallations.sourceCommit,
  plan_digest: appInstallations.planDigest,
  artifact_digest: appInstallations.artifactDigest,
  mode: appInstallations.mode,
  billing_account_id: appInstallations.billingAccountId,
  status: appInstallations.status,
  created_by_subject: appInstallations.createdBySubject,
  created_at: appInstallations.createdAt,
  updated_at: appInstallations.updatedAt,
};

const installationEventColumns = {
  event_id: installationEvents.eventId,
  installation_id: installationEvents.installationId,
  event_type: installationEvents.eventType,
  payload: installationEvents.payload,
  previous_event_hash: installationEvents.previousEventHash,
  event_hash: installationEvents.eventHash,
  created_at: installationEvents.createdAt,
};

function ledgerAccountValues(record: LedgerAccountRecord) {
  return {
    accountId: record.accountId,
    legalOwnerSubject: record.legalOwnerSubject,
    billingAccountId: record.billingAccountId ?? null,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function spaceValues(record: SpaceRecord) {
  return {
    spaceId: record.spaceId,
    accountId: record.accountId,
    kind: record.kind,
    displayName: record.displayName ?? null,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function appInstallationValues(record: InstallationRecord) {
  return {
    installationId: record.installationId,
    accountId: record.accountId,
    spaceId: record.spaceId,
    appId: record.appId,
    sourceGitUrl: record.sourceGitUrl,
    sourceRef: record.sourceRef,
    sourceCommit: record.sourceCommit,
    planDigest: record.planDigest,
    artifactDigest: record.artifactDigest ?? null,
    mode: record.mode,
    billingAccountId: record.billingAccountId ?? null,
    status: record.status,
    createdBySubject: record.createdBySubject,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function installationEventValues(record: InstallationEventRecord) {
  return {
    eventId: record.eventId,
    installationId: record.installationId,
    eventType: record.eventType,
    payload: record.payload,
    previousEventHash: record.previousEventHash ?? null,
    eventHash: record.eventHash,
    createdAt: toDate(record.createdAt),
  };
}
