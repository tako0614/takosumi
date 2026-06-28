// AppCapsule ledger: ledger accounts, spaces, installations, internal
// service binding material records, compatibility grant validation shims, and
// the append-only event log. Free functions delegate raw queries to a
// PostgresQueryClient.

import type {
  ServiceBindingMaterialRecord,
  ServiceGrantMaterialRecord,
  CapsuleEventRecord,
  CapsuleRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  WorkspaceRecord,
} from "../ledger.ts";
import { and, asc, eq, sql } from "drizzle-orm";
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import {
  assertValidServiceBindingMaterialRecord,
  assertValidServiceGrantMaterialRecord,
} from "../ledger.ts";
import { LedgerAccountOwnershipConflictError } from "../store.ts";
import {
  serviceBindingMaterialFromRow,
  type ServiceBindingMaterialRow,
  appCapsuleFromRow,
  type AppCapsuleRow,
  installationEventFromRow,
  type CapsuleEventRow,
  ledgerAccountFromRow,
  type LedgerAccountRow,
  postgresDrizzle,
  type PostgresQueryClient,
  runFirst,
  runQuery,
  spaceFromRow,
  type WorkspaceRow,
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
  workspaceId: text("space_id").primaryKey(),
  accountId: text("account_id").notNull(),
  kind: text("kind").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const appCapsules = installation.table("app_installations", {
  capsuleId: text("installation_id").primaryKey(),
  accountId: text("account_id").notNull(),
  workspaceId: text("space_id").notNull(),
  appId: text("app_id").notNull(),
  sourceGitUrl: text("source_git_url").notNull(),
  sourceRef: text("source_ref").notNull(),
  sourceCommit: text("source_commit").notNull(),
  sourcePath: text("source_path"),
  planDigest: text("plan_digest").notNull(),
  artifactDigest: text("artifact_digest"),
  mode: text("mode").notNull(),
  billingAccountId: text("billing_account_id"),
  status: text("status").notNull(),
  createdBySubject: text("created_by_subject").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

const serviceBindingMaterials = installation.table(
  "service_binding_materials",
  {
    bindingId: text("binding_id").primaryKey(),
    capsuleId: text("installation_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    configRef: text("config_ref").notNull(),
    secretRefs: text("secret_refs").array().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  },
);

const installationEventChainLocks = installation.table(
  "installation_event_chain_locks",
  {
    capsuleId: text("installation_id").primaryKey(),
  },
);

const installationEvents = installation.table("installation_events", {
  eventId: text("event_id").primaryKey(),
  capsuleId: text("installation_id").notNull(),
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
  appCapsules,
  serviceBindingMaterials,
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

export async function saveWorkspace(
  client: PostgresQueryClient,
  record: WorkspaceRecord,
): Promise<void> {
  const values = spaceValues(record);
  await postgresDrizzle(client, installationSchema)
    .insert(spaces)
    .values(values)
    .onConflictDoUpdate({
      target: spaces.workspaceId,
      set: {
        accountId: values.accountId,
        kind: values.kind,
        displayName: values.displayName,
        updatedAt: values.updatedAt,
      },
    });
}

export async function findWorkspace(
  client: PostgresQueryClient,
  workspaceId: string,
): Promise<WorkspaceRecord | undefined> {
  const row = await postgresDrizzle(client, installationSchema)
    .select(spaceColumns)
    .from(spaces)
    .where(eq(spaces.workspaceId, workspaceId))
    .limit(1)
    .then((rows) => rows[0] as WorkspaceRow | undefined);
  return row ? spaceFromRow(row) : undefined;
}

export async function listWorkspacesForAccount(
  client: PostgresQueryClient,
  accountId: string,
): Promise<readonly WorkspaceRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(spaceColumns)
    .from(spaces)
    .where(eq(spaces.accountId, accountId))
    .orderBy(asc(spaces.createdAt), asc(spaces.workspaceId))) as WorkspaceRow[];
  return rows.map(spaceFromRow);
}

export async function listWorkspacesForOwner(
  client: PostgresQueryClient,
  subject: string,
): Promise<readonly WorkspaceRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(spaceColumns)
    .from(spaces)
    .innerJoin(ledgerAccounts, eq(spaces.accountId, ledgerAccounts.accountId))
    .where(eq(ledgerAccounts.legalOwnerSubject, subject))
    .orderBy(asc(spaces.createdAt), asc(spaces.workspaceId))) as WorkspaceRow[];
  return rows.map(spaceFromRow);
}

export async function saveAppCapsule(
  client: PostgresQueryClient,
  record: CapsuleRecord,
): Promise<void> {
  // Wave 6 dropped the `runtime_binding_id` column from
  // `installation_v1.app_installations`. The write path no longer
  // references it. `CapsuleRecord.runtimeBindingId` is silently
  // ignored when persisting; the in-memory store still tracks it for
  // materialize helper state that has not crossed the Postgres boundary.
  const values = appCapsuleValues(record);
  await postgresDrizzle(client, installationSchema)
    .insert(appCapsules)
    .values(values)
    .onConflictDoUpdate({
      target: appCapsules.capsuleId,
      set: {
        accountId: values.accountId,
        workspaceId: values.workspaceId,
        appId: values.appId,
        sourceGitUrl: values.sourceGitUrl,
        sourceRef: values.sourceRef,
        sourceCommit: values.sourceCommit,
        sourcePath: values.sourcePath,
        planDigest: values.planDigest,
        artifactDigest: values.artifactDigest,
        mode: values.mode,
        billingAccountId: values.billingAccountId,
        status: values.status,
        updatedAt: values.updatedAt,
      },
    });
}

export async function findAppCapsule(
  client: PostgresQueryClient,
  capsuleId: string,
): Promise<CapsuleRecord | undefined> {
  const row = await postgresDrizzle(client, installationSchema)
    .select(appCapsuleColumns)
    .from(appCapsules)
    .where(eq(appCapsules.capsuleId, capsuleId))
    .limit(1)
    .then((rows) => rows[0] as AppCapsuleRow | undefined);
  return row ? appCapsuleFromRow(row) : undefined;
}

export async function listAppCapsulesForWorkspace(
  client: PostgresQueryClient,
  workspaceId: string,
): Promise<readonly CapsuleRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(appCapsuleColumns)
    .from(appCapsules)
    .where(eq(appCapsules.workspaceId, workspaceId))
    .orderBy(
      asc(appCapsules.createdAt),
      asc(appCapsules.capsuleId),
    )) as AppCapsuleRow[];
  return rows.map(appCapsuleFromRow);
}

export async function listAppCapsulesForBillingAccount(
  client: PostgresQueryClient,
  billingAccountId: string,
): Promise<readonly CapsuleRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(appCapsuleColumns)
    .from(appCapsules)
    .where(eq(appCapsules.billingAccountId, billingAccountId))
    .orderBy(
      asc(appCapsules.createdAt),
      asc(appCapsules.capsuleId),
    )) as AppCapsuleRow[];
  return rows.map(appCapsuleFromRow);
}

export function saveRuntimeBinding(
  client: PostgresQueryClient,
  record: RuntimeBindingRecord,
): Promise<void> {
  // Wave 6 dropped `installation_v1.runtime_bindings`. The record remains a
  // live orchestration entity (shared-cell warm-pool, materialize continuity,
  // dashboard render) but is no longer persisted; INSERT against the dropped
  // table raised "relation does not exist" (production-blocking SQL drift).
  // No-op shim mirrors the Phase E precedent in `listServiceBindingMaterialsForCapsule`.
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
  // `installation.runtimeBindingId` being set, and `appCapsuleFromRow`
  // already returns it as undefined, so this read path is unreachable in
  // production. Returning undefined keeps the contract honest.
  void client;
  void runtimeBindingId;
  return Promise.resolve(undefined);
}

export function saveServiceBindingMaterial(
  client: PostgresQueryClient,
  record: ServiceBindingMaterialRecord,
): Promise<void> {
  try {
    assertValidServiceBindingMaterialRecord(record);
  } catch (error) {
    return Promise.reject(error);
  }
  const values = serviceBindingMaterialValues(record);
  return postgresDrizzle(client, installationSchema)
    .insert(serviceBindingMaterials)
    .values(values)
    .onConflictDoUpdate({
      target: serviceBindingMaterials.bindingId,
      set: {
        capsuleId: values.capsuleId,
        name: values.name,
        kind: values.kind,
        configRef: values.configRef,
        secretRefs: values.secretRefs,
        updatedAt: values.updatedAt,
      },
    })
    .then(() => {});
}

export function listServiceBindingMaterialsForCapsule(
  client: PostgresQueryClient,
  capsuleId: string,
): Promise<readonly ServiceBindingMaterialRecord[]> {
  return postgresDrizzle(client, installationSchema)
    .select(serviceBindingMaterialColumns)
    .from(serviceBindingMaterials)
    .where(eq(serviceBindingMaterials.capsuleId, capsuleId))
    .orderBy(
      asc(serviceBindingMaterials.createdAt),
      asc(serviceBindingMaterials.bindingId),
    )
    .then((rows) =>
      (rows as ServiceBindingMaterialRow[]).map(serviceBindingMaterialFromRow),
    );
}

export function saveServiceGrantMaterial(
  client: PostgresQueryClient,
  record: ServiceGrantMaterialRecord,
): Promise<void> {
  // Wave 6 dropped `installation_v1.app_grants`. Validation invariants are
  // still enforced; only the SQL INSERT is removed. Mirrors the Phase E
  // no-op precedent in `listServiceGrantMaterialsForCapsule`. Validation throws
  // are converted to promise rejections so `assertRejects` tests pass.
  try {
    assertValidServiceGrantMaterialRecord(record);
  } catch (error) {
    return Promise.reject(error);
  }
  void client;
  return Promise.resolve();
}

export function findServiceGrantMaterial(
  client: PostgresQueryClient,
  grantId: string,
): Promise<ServiceGrantMaterialRecord | undefined> {
  // Wave 6 dropped `installation_v1.app_grants`. Returning undefined matches
  // the Phase E SELECT precedent.
  void client;
  void grantId;
  return Promise.resolve(undefined);
}

export function listServiceGrantMaterialsForCapsule(
  client: PostgresQueryClient,
  capsuleId: string,
): Promise<readonly ServiceGrantMaterialRecord[]> {
  // Wave 6 dropped `installation_v1.app_grants`. ServiceGrantMaterial is no longer
  // a public concept; the table no longer exists in production schema.
  // Selecting against it raised "relation does not exist"
  // (production-blocking SQL drift). We now return an empty array so
  // account-plane callers (= envelope serialization, dashboard render path)
  // remain compatible without touching the database.
  void client;
  void capsuleId;
  return Promise.resolve([]);
}

export async function appendCapsuleEvent(
  client: PostgresQueryClient,
  record: CapsuleEventRecord,
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
      .values({ capsuleId: record.capsuleId })
      .onConflictDoNothing({
        target: installationEventChainLocks.capsuleId,
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
      [record.capsuleId],
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

export async function listCapsuleEvents(
  client: PostgresQueryClient,
  capsuleId: string,
): Promise<readonly CapsuleEventRecord[]> {
  const rows = (await postgresDrizzle(client, installationSchema)
    .select(installationEventColumns)
    .from(installationEvents)
    .where(eq(installationEvents.capsuleId, capsuleId))
    .orderBy(
      asc(installationEvents.eventSequence),
      asc(installationEvents.eventId),
    )) as CapsuleEventRow[];
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
  space_id: spaces.workspaceId,
  account_id: spaces.accountId,
  kind: spaces.kind,
  display_name: spaces.displayName,
  created_at: spaces.createdAt,
  updated_at: spaces.updatedAt,
};

const appCapsuleColumns = {
  installation_id: appCapsules.capsuleId,
  account_id: appCapsules.accountId,
  space_id: appCapsules.workspaceId,
  app_id: appCapsules.appId,
  source_git_url: appCapsules.sourceGitUrl,
  source_ref: appCapsules.sourceRef,
  source_commit: appCapsules.sourceCommit,
  source_path: appCapsules.sourcePath,
  plan_digest: appCapsules.planDigest,
  artifact_digest: appCapsules.artifactDigest,
  mode: appCapsules.mode,
  billing_account_id: appCapsules.billingAccountId,
  status: appCapsules.status,
  created_by_subject: appCapsules.createdBySubject,
  created_at: appCapsules.createdAt,
  updated_at: appCapsules.updatedAt,
};

const serviceBindingMaterialColumns = {
  binding_id: serviceBindingMaterials.bindingId,
  installation_id: serviceBindingMaterials.capsuleId,
  name: serviceBindingMaterials.name,
  kind: serviceBindingMaterials.kind,
  config_ref: serviceBindingMaterials.configRef,
  secret_refs: serviceBindingMaterials.secretRefs,
  created_at: serviceBindingMaterials.createdAt,
  updated_at: serviceBindingMaterials.updatedAt,
};

const installationEventColumns = {
  event_id: installationEvents.eventId,
  installation_id: installationEvents.capsuleId,
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

function spaceValues(record: WorkspaceRecord) {
  return {
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    kind: record.kind,
    displayName: record.displayName ?? null,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function appCapsuleValues(record: CapsuleRecord) {
  return {
    capsuleId: record.capsuleId,
    accountId: record.accountId,
    workspaceId: record.workspaceId,
    appId: record.appId,
    sourceGitUrl: record.sourceGitUrl,
    sourceRef: record.sourceRef,
    sourceCommit: record.sourceCommit,
    sourcePath: record.sourcePath ?? null,
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

function serviceBindingMaterialValues(record: ServiceBindingMaterialRecord) {
  return {
    bindingId: record.bindingId,
    capsuleId: record.capsuleId,
    name: record.name,
    kind: record.kind,
    configRef: record.configRef,
    secretRefs: [...record.secretRefs],
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function installationEventValues(record: CapsuleEventRecord) {
  return {
    eventId: record.eventId,
    capsuleId: record.capsuleId,
    eventType: record.eventType,
    payload: record.payload,
    previousEventHash: record.previousEventHash ?? null,
    eventHash: record.eventHash,
    createdAt: toDate(record.createdAt),
  };
}
