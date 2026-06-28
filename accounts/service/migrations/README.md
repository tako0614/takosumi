# Takosumi Accounts migrations

Postgres-backed migrations for the `accounts_v1` schema used by Takosumi
Accounts (identity, billing, Installation ownership, OIDC issuer).

- **Substrate**: Postgres (the `node-postgres` reference distribution and any
  compatible operator deployment).
- **Ledger table**: `accounts_v1.schema_migrations(version, name, checksum,
applied_at)`.
- **Checksum**: each applied migration records `sha256:<hex>` of the SQL
  file. The runner refuses to re-apply if the file is later edited.
- **Concurrency guard**: the runner takes a Postgres advisory lock keyed by
  `hashtext('takosumi_accounts_migrations')` before reading the ledger.
- **Runner source**: `takosumi/cli/src/cli-accounts-db.ts`
  (`loadAccountsMigrations`, `applyAccountsMigrations`).

## Naming convention

Files use a zero-padded 3-digit prefix and snake_case description:

```
NNN_short_description.sql
```

The numeric prefix must be contiguous from `001` and equal to the file's
position in the sorted list. The runner validates this and rejects gaps.

## Operator runbook

1. **Dry-run** (no DB connection required):

   ```bash
   cd takosumi
   bun run cli -- accounts migrate --dry-run --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
   ```

   Prints an ordered plan as `takosumi.accounts.migrate@v1`.

2. **Apply** (against the production / staging Postgres):

   Set `TAKOSUMI_PRIVATE` to the operator-private checkout or vault mount that
   contains the gitignored `.secrets/<env>/` files.

   ```bash
   cd takosumi
   TAKOSUMI_ACCOUNTS_DATABASE_URL="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/TAKOSUMI_ACCOUNTS_DATABASE_URL")" \
     bun run cli -- accounts migrate
   ```

   Acquires the advisory lock, replays each pending migration inside a
   transaction, and prints `Takosumi Accounts migrations applied: <n>`.

3. **Forensics**:

   ```sql
   SELECT version, name, checksum, applied_at
   FROM accounts_v1.schema_migrations
   ORDER BY version;
   ```

   If a row's checksum no longer matches the on-disk SQL, the next runner
   invocation will error explicitly.

For restore / disaster-recovery procedures, see
[`takosumi/docs/operations/`](../../../docs/operations/).

## Boundary

This is Takosumi Accounts internal storage maintenance. It is not a Capsule/app
migration contract and does not require Takosumi to expose DB-specific
migration APIs for installed apps.
