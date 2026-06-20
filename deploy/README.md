# takosumi/deploy — operator deployment profiles

Takosumi ships the OpenTofu-native deploy-control contract, service entry, CLI,
dashboard/account-plane entry points, and reference operator deployment profiles.
The public service surface is centered on Workspace, Project, Capsule, Source,
ProviderConnection, CredentialRecipe, ProviderBinding, Secret, Run,
StateVersion, Output, Runner, AuditEvent, and Operator. OSS Takosumi runs
existing OpenTofu/Terraform providers as-is; compatibility gateways and managed
resources belong only to Takosumi Cloud.

The directories under `deploy/` are therefore **build-target templates and
substrate runbooks**, not a separate public product surface. The canonical
operator target is the single Takosumi platform worker in `deploy/platform/`,
served from `app.takosumi.com`, which composes the accounts plane, the
in-process `/api` control plane, the dashboard SPA, and the OpenTofu runner
container. `deploy/cloudflare/` remains a reference control-plane/runner
scaffold and internal compatibility seam, not the public API model.

## What lives here

| Directory          | Role                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/`        | Operator Takosumi platform worker template: accounts plane + in-process control plane + dashboard SPA + OpenTofu runner container.                                                                                     |
| `cloudflare/`      | Control-plane/runner scaffold used by platform composition, the Takos distribution profile, and local-substrate worker runner.                                                                                         |
| `accounts-cloudflare/` | Account-plane handler entry point (OIDC issuer / billing / dashboard / deploy facade), mounted in-process by the platform worker or a self-hosted Takos worker.                                                        |
| `node-postgres/`   | Bun + Postgres reference composer (`buildComposedServer`) consumed by `local-substrate/`'s cloud profile.                                                                                                               |
| `local-substrate/` | Local Pebble + CoreDNS + Caddy dev substrate for production-equivalent hostname access.                                                                                                                                |
| `observability/`   | Reference observability wiring.                                                                                                                                                                                        |

## Why these stay here

These examples are intentionally kept stable:

- The Takos product distribution profile (`takos/deploy/distributions/cloudflare.json`)
  pins the exact artifact refs `../takosumi/deploy/cloudflare` and
  `../takosumi/deploy/cloudflare/wrangler.toml`.
- `deploy/local-substrate/` boots `deploy/cloudflare`'s Worker scaffold through its
  worker runner and compose wiring, and composes the account plane through
  `deploy/node-postgres/src/server.ts`.

Moving them would break those cross-submodule references. They remain reference
scaffolds; production composition and serving belong to `deploy/platform/` plus
operator-private realized config.
