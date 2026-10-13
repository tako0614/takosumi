# Backup and recovery

| Preserve | Storage or evidence |
| --- | --- |
| Accounts and control-plane records | Both PostgreSQL schemas, or their separate D1 databases |
| Sources, state, artifacts | The artifact-store directories actually composed, or each R2 bucket |
| Decryption and signing keys | The operator secret store, preserved separately from data |
| Deployment and compatibility | Commit, image digest, config, migration head, restore procedure |

The reference Bun/PostgreSQL Compose persists PostgreSQL and Caddy volumes. It includes
neither an artifact-store volume nor a runner. If you compose a runner or artifact
store yourself, include its actual durable paths in the backup.

Use the [distribution README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md)
for PostgreSQL and the [disaster recovery](https://github.com/tako0614/takosumi/blob/main/docs/operations/disaster-recovery.md) and
[backup drills](https://github.com/tako0614/takosumi/blob/main/docs/operations/backup-restore-drills.md) runbooks for Cloudflare.
Keep secret values and raw backups outside public repositories, PRs, and logs.

Workspace export does not replace whole-database, artifact-store, and key backups.
The stock Bun/PostgreSQL composition has no backup artifact store wired, so do not assume
export is available. Rehearse restoration in an isolated empty environment and verify
sign-in, existing records, decryption, and state reads. These backups do not themselves
restore provider-owned infrastructure.
