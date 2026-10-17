# Backup and recovery

Preserve the database, encryption and signing keys, the artifact/source/state stores you
actually use, and deployment records together.

The reference Bun/PostgreSQL Compose persists PostgreSQL, Caddy and `takosumi-runtime`
volumes. Control and pre-destroy exports use `TAKOSUMI_BACKUP_ARTIFACTS_DIR`
(default `/var/lib/takosumi/backups`), with owner-only 0700 directories and 0600 files.
Bundles use the existing secret-store encryption key; only public artifact manifests
stay plain. Filenames are the SHA-256 hex of the opaque ref followed by `.artifact`.
No runner is bundled. Include the actual durable paths of any custom runner/state/artifact
store in the backup as well.

Treat `TAKOSUMI_BACKUP_ARTIFACTS_DIR` as required to preserve exports before destroy.
The reference Compose supplies a default; when starting without Compose, explicitly
configure a durable directory too. If unset, export is recorded as `skipped`
(`backups_unavailable`) and destroy proceeds without an export.

## PostgreSQL Compose

Accounts and control-plane schemas share the `takosumi_accounts` PostgreSQL database. The
commands below target the existing default Compose project started from `deploy/node-postgres`
without extra `-p` or `-f` arguments. If it was started with a named project or extra Compose
files, pass those exact arguments on every operation. Keep the backup outside the checkout.

```bash
cd deploy/node-postgres
set -euo pipefail
umask 077
backup_dir=/var/backups/takosumi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$backup_dir/takosumi-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose() { docker compose "$@"; }
compose stop accounts
compose exec -T postgres pg_dump -U takosumi -d takosumi_accounts -Fc > "$backup_file"
chmod 600 "$backup_file"
compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
compose up -d --wait accounts
```

For a local smoke-test project, do not use the default Compose commands above. In the same
shell as the local startup, keep its project and override variables (`local_project` and
`local_dir` are the ones set in [Local loopback check](../concepts/self-host.md#local-loopback-check)) and run:

```bash
set -euo pipefail
umask 077
backup_dir=/var/backups/takosumi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_file="$backup_dir/takosumi-local-$(date -u +%Y%m%dT%H%M%SZ).dump"
local_files=(-f docker-compose.yml -f "$local_dir/compose.local-test.yml")
local_compose() { docker compose -p "$local_project" "${local_files[@]}" "$@"; }
local_compose stop accounts
local_compose exec -T postgres pg_dump -U takosumi -d takosumi_accounts -Fc > "$backup_file"
chmod 600 "$backup_file"
local_compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
local_compose up -d --wait accounts
```

In a separate operator secret store, preserve `POSTGRES_PASSWORD`,
`TAKOSUMI_SECRET_STORE_PASSPHRASE`, `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`,
`TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK`, `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET`,
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`, and any configured upstream-provider secrets. Losing the
sealing or signing keys can make stored data unreadable or prevent existing tokens from
being verified. After changing `TAKOSUMI_SECRET_STORE_PASSPHRASE`, the new value cannot
decrypt past exports; losing the value used to create them makes decryption impossible.
Record the configuration, Git commit, image digest, and migration head.
Caddy certificate state can be reissued, though backing up its volumes avoids another ACME
issuance.

Rehearse restoration against an empty database in a separate Compose project. Its dedicated
project name creates a new volume, leaving the original database untouched. Do not use
`--clean`. Reuse the checkout's `.env` and image/migrations; do not start Caddy during the
restore check. This checks health and the anonymous dashboard shell. Authenticated record
reads require restore-specific provider/client configuration.
Run the restore block in the same shell as the backup so `backup_file` still points to that
archive. In a new shell, set `backup_file` to the actual archive path first.

```bash
set -euo pipefail
# In a new shell, set this to the exact custom-format archive created above.
# backup_file=/path/to/verified-backup.dump
restore_project="takosumi-restore-check-$(date +%s)-$$"
restore_dir="$(mktemp -d)"
cat > "$restore_dir/compose.restore-check.yml" <<'YAML'
services:
  accounts:
    environment:
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: ""
      TAKOSUMI_ACCOUNTS_ISSUER: http://localhost:26402
      TAKOSUMI_ACCOUNTS_REDIRECT_URIS: http://localhost:26402/oauth/callback
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID: localhost
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN: http://localhost:26402
    ports:
      - "127.0.0.1:26402:8787"
YAML
restore_files=(-f docker-compose.yml -f "$restore_dir/compose.restore-check.yml")
restore_compose() { docker compose -p "$restore_project" "${restore_files[@]}" "$@"; }
restore_compose up -d --wait postgres
restore_compose exec -T postgres \
  pg_restore -U takosumi -d takosumi_accounts --exit-on-error --no-owner < "$backup_file"
restore_compose run --rm migrations
restore_compose up -d --wait accounts
curl -fsS http://localhost:26402/healthz
```

Docker Compose v2 with `up --wait` is required. Explicit `-f` files disable automatic loading
of `docker-compose.override.yml`. Add required upstream secret mappings individually to the
temporary restore override; do not include the entire operator override, which may publish
extra host ports. Set the restore project's issuer, provider descriptor `redirectUri`, client
JSON `redirectUris`, and passkey origin to `localhost:26402` as appropriate, and update the
IdP callback and secret mapping too. If `TAKOSUMI_ACCOUNTS_CLIENTS` is set, singular
`TAKOSUMI_ACCOUNTS_REDIRECT_URIS` is ignored. Without this restore-specific authentication
configuration, verify health and that the unauthenticated dashboard loads; do not assume
sign-in will succeed. For an additional sign-in check, add the restore-specific provider
descriptor/client JSON and secret mapping to the temporary override, then apply it with
`restore_compose up -d --wait accounts`. Inspect authenticated records only after that setup.
After the check, inspect the dedicated project containers and volume before removing them.
Do not target the original deployment project or its volume. Remove the temporary
`restore_dir` configuration when finished. With restore-specific authentication configured,
also verify sign-in, existing Accounts / Workspace / Run records, and ProviderConnection
decryption. The stock distribution has no runner, and this PostgreSQL backup does not
restore Git sources, plan artifacts, or provider-owned infrastructure. Restore the
`takosumi-runtime` volume and any custom composition's actual durable stores separately.

Workspace export does not replace whole-database, artifact-store, and key backups.
The reference Compose wires a file backup store. Owners can use the Capsule backup API
during the seven-day uninstall grace period; the finalizer also attempts an export before
destroy after the deadline. Custom runner compositions must explicitly supply a
`backupStateObjectReader` for their exact sealed state store. Missing readers or state
objects are recorded as export failures; #422's existing policy still proceeds with
teardown after failure. Preserve the volume and keys separately.

For Cloudflare, use the [disaster recovery](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md) and
[backup/restore drills](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md) runbooks. Keep secret values and raw backups
out of public repositories, PRs, and logs.
