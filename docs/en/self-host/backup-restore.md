# Backup and recovery

| Preserve | Storage or evidence |
| --- | --- |
| Accounts and control-plane records | Both PostgreSQL schemas, or their separate D1 databases |
| Sources, state, artifacts | The artifact-store directories actually composed, or each R2 bucket |
| Decryption and signing keys | The operator secret store, preserved separately from data |
| Deployment and compatibility | Commit, image digest, config, migration head, restore procedure |

The reference Bun/PostgreSQL Compose persists PostgreSQL, Caddy and `takosumi-runtime`
volumes. Control and pre-destroy exports use `TAKOSUMI_BACKUP_ARTIFACTS_DIR`
(default `/var/lib/takosumi/backups`), with owner-only 0700 directories and 0600 files.
Bundles use the existing secret-store encryption key; only public artifact manifests
stay plain. Filenames are the SHA-256 hex of the opaque ref followed by `.artifact`.
No runner is bundled. Include the actual durable paths of any custom runner/state/artifact
store in the backup as well.

Use the [distribution README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)
for PostgreSQL and the [disaster recovery](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md) and
[backup drills](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md) runbooks for Cloudflare.
Keep secret values and raw backups outside public repositories, PRs, and logs.

Workspace export does not replace whole-database, artifact-store, and key backups.
The reference Compose wires a file backup store. Owners can use the Capsule backup API
during the seven-day uninstall grace period; the finalizer also attempts an export before
destroy after the deadline. Custom runner compositions must explicitly supply a
`backupStateObjectReader` for their exact sealed state store. Missing readers or state
objects are recorded as export failures; #422's existing policy still proceeds with
teardown after failure. Preserve the volume and keys separately.
Rehearse restoration in an isolated empty environment and verify
sign-in, existing records, decryption, and state reads. These backups do not themselves
restore provider-owned infrastructure.
