# Updating

Review the target commit, both database migrations, and runner compatibility before updating.
Migrations are forward-only. A predecessor can serve again only if it accepts the new schema;
an additive change alone does not establish that compatibility.

## Bun and PostgreSQL

Follow the [distribution README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md). Review the pending
migrations and compatibility, then take a backup immediately before the update. For the
default Compose project, run from `deploy/node-postgres` and keep its default project and
automatically loaded override. If the deployment started with custom `-p` or `-f` arguments,
pass those same arguments on every operation. Switch to the new commit and update in this
order. The migration service applies the control-plane schema followed by the Accounts schema.

```bash
set -euo pipefail
cd deploy/node-postgres
compose() { docker compose "$@"; }
compose stop accounts
compose build accounts migrations
compose run --rm migrations
# After migrations succeed, start Caddy too in production.
compose up -d --wait accounts caddy
compose ps
curl -fsS https://app.example.com/healthz # replace with the configured public hostname
```

Stop `accounts` before migrating, and do not serve the new image before migrations succeed.
For a local test project, keep the same dedicated project and Compose files for every
operation (`local_project` and `local_dir` are the ones set in
[Local loopback check](../concepts/self-host.md#local-loopback-check)). The example below uses only the base file and its temporary loopback override;
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
[Putting it on Cloudflare](../concepts/self-host.md#putting-it-on-cloudflare)). Each Worker
accepts specific Accounts D1 versions, so whether you apply or deploy the Worker first
depends on the version. Upgrading from a v3 Accounts D1 has a fixed order: deploy the
bridge Worker, apply v4, then switch to a Worker that accepts only v4 and later. Just
before applying v4, apply backfills the existing OIDC client records in chunks of 100. After v4, you
cannot go back to a Worker that accepts only v3. Follow
[online DB migrations](https://github.com/tako0614/takosumi/blob/main/docs/operations/online-db-migrations.md)
for this order and its caveats.

## Failure handling

Record whether failure occurred before or after durable state was touched. After mutation,
retain the fence and execution evidence, verify the applied schema, and repair forward.
A predecessor Worker Version or image alone does not prove database compatibility.
Do not use automatic down migrations or blind retries.
