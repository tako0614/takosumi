# takosumi/deploy — operator deployment profiles

Takosumi ships the OpenTofu-native deploy-control contract, service entry, CLI,
dashboard/account-plane entry points, and reference operator deployment profiles.
The public service surface is centered on Workspace, Project, Capsule, Source,
ProviderConnection, CredentialRecipe, ProviderBinding, Secret, Run,
StateVersion, Output, Runner, AuditEvent, and Operator. OSS Takosumi runs
existing OpenTofu/Terraform providers as-is. Compatibility API framework and
scoped provider compatibility profiles are Takosumi capabilities; official
managed resources, billing enforcement, and operated backend capacity belong to
Takosumi for Operator / Takosumi Cloud.

The directories under `deploy/` are therefore **build-target templates and
substrate runbooks**, not a separate public product surface. The canonical
operator target is the single Takosumi platform worker in `deploy/platform/`,
served from `app.takosumi.com`, which composes the accounts plane, the
in-process `/api` control plane, the dashboard SPA, and the OpenTofu runner
container. There is no separate Cloudflare control-plane scaffold: the
control-plane handler (`worker/src/handler.ts`) and account-plane handler
(`deploy/accounts-cloudflare/src/handler.ts`) are composed directly by
`deploy/platform/worker.ts`.

## What lives here

| Directory          | Role                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/`        | Operator Takosumi platform worker (the single composed build target): accounts plane + in-process control plane + dashboard SPA + OpenTofu runner container.                                                           |
| `accounts-cloudflare/` | Account-plane handler entry point (OIDC issuer / billing / dashboard / deploy facade), mounted in-process by the platform worker or a self-hosted Takos worker.                                                        |
| `node-postgres/`   | Bun + Postgres reference composer (`buildComposedServer`) consumed by `local-substrate/`'s cloud profile.                                                                                                               |
| `local-substrate/` | Local Pebble + CoreDNS + Caddy dev substrate for production-equivalent hostname access.                                                                                                                                |
| `observability/`   | Reference observability wiring.                                                                                                                                                                                        |

## Why these stay here

These examples are intentionally kept stable:

- The Takos product distribution profile (`takos/deploy/distributions/cloudflare.json`)
  pins artifact refs inside Takos's own deploy template (`takos/deploy/cloudflare/wrangler.toml`),
  not this repo's deploy templates.
- `deploy/local-substrate/` builds and boots the single `deploy/platform/worker.ts`
  composed worker through its Miniflare worker runner and compose wiring, and
  composes the account plane through `deploy/node-postgres/src/server.ts`.

They remain reference templates; production composition and serving belong to
`deploy/platform/` plus operator-private realized config.
