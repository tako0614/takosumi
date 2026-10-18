# Updating Takosumi itself (upgrade)

This page updates the Takosumi you run yourself. To update a service you added, see
[Update, restore, or delete a service](../getting-started/after-adding.md).

Review the target commit, both database migrations, and runner compatibility before updating.
Migrations are forward-only. A predecessor can serve again only if it accepts the new schema;
an additive change alone does not establish that compatibility.

## Bun and PostgreSQL

Follow the [distribution README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md). Review the pending
migrations and compatibility, then take a backup immediately before the update. For the
default Compose project, run from `deploy/node-postgres` and keep its default project and
automatically loaded override. If the deployment started with custom `-p` or `-f` arguments,
pass those same arguments on every operation.

Applied migrations are recorded in `storage_migrations` for the control plane and in
`accounts_v1.schema_migrations` for Accounts. `bun run db:migrate:dry-run` prints the whole
catalog, not only what this database has not applied yet. Check the applied versions with the
commands below and compare them with the new commit's catalog.

```bash
cd deploy/node-postgres
docker compose exec -T postgres psql -U takosumi -d takosumi_accounts \
  -c 'select id, version, applied_at from storage_migrations order by version desc limit 5'
docker compose exec -T postgres psql -U takosumi -d takosumi_accounts \
  -c 'select version, name from accounts_v1.schema_migrations order by version desc limit 5'
```

Switch to the new commit (for example with `git switch --detach <commit>`) and update in this
order. The migration service applies the control-plane schema followed by the Accounts schema.

```bash
set -euo pipefail
cd deploy/node-postgres
compose() { docker compose "$@"; }
compose stop accounts
compose build accounts migrations
migrate_log="$HOME/takosumi-migrate-$(date -u +%Y%m%dT%H%M%SZ).log"
compose run --rm migrations 2>&1 | tee "$migrate_log"
# After migrations succeed, start Caddy too in production.
compose up -d --wait accounts caddy
compose ps
curl -fsS https://app.example.com/healthz # replace with the configured public hostname
```

Stop `accounts` before migrating, and do not serve the new image before migrations succeed.
If a migration fails, the block stops there and `accounts` stays stopped. Migrations only move
forward, so there is no command that undoes a failed one. Each migration commits on its own,
so the ones that finished before the failure stay applied. The `migrations` container is
removed when it exits, so read its output from the `$migrate_log` file; if the shell closed and
lost the variable, find it with `ls -t "$HOME"/takosumi-migrate-*.log`. Find the migration
that stopped, restore the backup you just took into a separate project as in the
[restore drill](./backup-restore.md) to inspect it, and then decide how to proceed.

For a local test project, keep the same dedicated project and Compose files for every
operation (`local_project` and `local_dir` are the ones set in
[Local loopback check](./bun-postgres.md#local-loopback-check)). The example below uses only the base file and its temporary loopback override;
add only reviewed secret mappings there if needed. It does not load
`docker-compose.override.yml`.

```bash
set -euo pipefail
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose stop accounts
local_compose build accounts migrations
local_compose run --rm migrations
local_compose up -d --wait accounts
local_compose ps
curl -fsS http://localhost:26401/healthz
```

`--wait` requires Docker Compose v2. The stock composition has no runner to
check. A custom composition that adds one must separately verify its protocol, artifact
storage, and state storage.

After updating, check sign-in, existing Capsule/Run reads, and credential-dependent
operations in your own test Workspace. Keep the previous image reference and backup until
these checks pass.

## Cloudflare

Accounts D1 and control D1 have separate schema owners. Review their plans, backup evidence,
and application sequence before publishing. Use the
[Control D1 schema predeploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/control-d1-schema-predeploy.md) and
[platform worker deploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/platform-worker-deploy.md) runbooks.
Request-time schema bootstrap is not an upgrade procedure for an existing deployment.

Upgrade the Accounts D1 with the same `takosumi accounts migrate-d1` sequence as a new
installation: backup-status, plan, apply, verify (see
[Putting it on Cloudflare](./cloudflare.md)). Each Worker
accepts specific Accounts D1 versions, so whether you apply or deploy the Worker first
depends on the version. Upgrading from a v3 Accounts D1 has a fixed order: deploy the
bridge Worker, apply v4, then switch to a Worker that accepts only v4 and later. Just
before it applies v4, `apply` backfills the existing OIDC client records in chunks of
100. After v4, you cannot go back to a Worker that accepts only v3. Follow
[online DB migrations](https://github.com/tako0614/takosumi/blob/main/docs/operations/online-db-migrations.md)
for this order and its caveats.

## When retired tables still have rows

PostgreSQL migration 110 (`retired.host_schema.drop_empty`) and Cloudflare D1 migration 66
(`d1_retired_host_schema_drop_empty`) drop the tables that held the former Resource Shape, Form Host,
TargetPool, SpacePolicy, Offering, resolution lock, identity fence, and similar records (and, on D1,
idempotency records).
The upgrade stops at that migration in either of two cases. The error contains one of these names
(upper case in PostgreSQL, lower case in D1):

- `RETIRED_HOST_ROWS_REQUIRE_OPERATOR_DISPOSITION` — one of the tables to drop still has rows. The
  tables are dropped only when all of them are empty.
- `RETAINED_INTERFACE_HOST_EVIDENCE_REQUIRES_OPERATOR_DISPOSITION` — some retained Interface or
  InterfaceBinding records depend on retired Resource or Form Host state, or their structure cannot
  prove that they do not. These tables are not dropped.

If it stops:

1. List and export the affected rows with the immediately previous release or an external database
   tool.
2. Record explicitly how each row will be handled.
3. As recorded, empty the tables to drop, or correct or remove the affected Interface and
   InterfaceBinding records.
4. Run the migration again.

The current Takosumi has no typed Host migration operation or setting that moves retired Host
records.

## Failure handling

Record whether failure occurred before or after durable state was touched. After mutation,
retain the fence and execution evidence, verify the applied schema, and repair forward.
A predecessor Worker Version or image alone does not prove database compatibility.
Do not use automatic down migrations or blind retries.
