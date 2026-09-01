# Upgrading

Upgrading Takosumi goes one way: swap in the new code, then apply whatever
migrations are missing. Database migrations are forward-only — there is no
down or rollback. You can move the CODE back to a previous version, but the
applied schema stays, and newer versions assume it.

## Bun + PostgreSQL profile

```bash
git pull
bun install
bun run build:dashboard
cd deploy/node-postgres
docker compose build
docker compose up -d
```

The compose `migrations` container applies the accounts-side migrations before
the service starts. The control-plane side runs explicitly from the checkout:

```bash
cd ../..
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
```

Run `bun run db:migrate:dry-run` first to see the SQL without applying it.

## Cloudflare profile

```bash
git pull
bun install
bun run build:dashboard
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts --remote
bunx wrangler deploy --config deploy/platform/wrangler.toml
```

The control-plane D1 catches up on the first request after deploy while
`TAKOSUMI_CONTROL_D1_SCHEMA_MODE` stays at its default `bootstrap`. If you run
`predeployed`, apply migrations before deploying.

## If you need to go back

Code can go back (a previous Worker version via `wrangler versions deploy` on
Cloudflare, a previous image with compose). The schema does not: tables and
columns a newer version added remain, and the older code ignores them. That is
safe while migrations stay additive — but treat going back as a stopgap while
you fix forward, not a place to stay.
