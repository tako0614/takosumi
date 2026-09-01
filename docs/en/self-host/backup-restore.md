# Backup and restore

There are three things to protect. Losing each costs you something different.

| What | Where it lives | Losing it means |
| --- | --- | --- |
| The record database | PostgreSQL (compose) / D1 (Cloudflare) | Accounts, Workspaces, run history, the whole Capsule ledger |
| State and artifacts | the `takosumi-runtime` volume (compose) / R2 (Cloudflare) | The applied infrastructure's state — later plans and destroys can no longer reconcile against reality |
| The sealing keys | `TAKOSUMI_SECRET_STORE_PASSPHRASE` and the other `.env` / secret values | Stored credentials and sealed state envelopes become unreadable |

Keep the keys somewhere other than the data. A perfect database and volume
backup opens nothing without the sealing passphrase.

## Bun + PostgreSQL profile

Back up the database as ordinary PostgreSQL:

```bash
docker compose exec postgres pg_dump -U takosumi takosumi_accounts > backup.sql
```

Take the `takosumi-runtime` volume (source archives + sealed state) on the
same cadence:

```bash
docker run --rm -v node-postgres_takosumi-runtime:/data -v "$PWD":/backup \
  alpine tar czf /backup/takosumi-runtime.tar.gz -C /data .
```

Restore in reverse: bring back the `.env` secrets (above all
`TAKOSUMI_SECRET_STORE_PASSPHRASE`) with their original values, restore
PostgreSQL, write the volume back, then `docker compose up -d`.

## Cloudflare profile

`wrangler d1 export` writes the D1 databases out as SQL. Replicate the R2
buckets (`takosumi-state` / `takosumi-source` / `takos-artifacts` /
`takosumi-backups`) with any S3-compatible tool such as rclone.

## About the product's own backup feature

"Create backup" in the dashboard exports part of one Workspace's records as a
sealed bundle. It is per-Workspace evidence — not a substitute for the
database-level backups on this page. Protect the database and the volume
first; use it on top of that.

## Restore drills

A backup only exists once you have restored it. Once a quarter, walk an empty
environment through: secrets → database → volume → start → sign in on the
dashboard → the existing services are listed.
