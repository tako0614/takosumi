# @takosjp/takosumi/cli

In-repo operator CLI for the Takosumi service (server boot / DB migrations /
OpenTofu module scaffold).

Takosumi is not npm-published: the deploy-control plane has no public routes and
is consumed in-process by the host worker. The earlier `plan` / `install` /
`deploy` / `rollback` remote-HTTP wire commands (which required `--remote` + a
bearer token and posted raw PlanRun/ApplyRun calls) have been retired — the
unified worker is the only caller of deploy-control. Create Installations and
runs through the in-process deploy-control seam, not this CLI.

## Run

The CLI runs against the cloned source (no global install):

```bash
bun src/cli/main.ts version
```

## Quickstart

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-deploy-control-token

bun src/cli/main.ts server --port 8788 &
```

## Commands

| Command | Purpose |
| --- | --- |
| `takosumi server [--port]` | boot the local Takosumi service |
| `takosumi migrate [--dry-run]` | run Takosumi service DB migrations |
| `takosumi init [<output>] [--template]` | optional OpenTofu module scaffold |
| `takosumi version` | print version |

## Env vars

| Env var | Used by |
| --- | --- |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | bearer token for deploy control routes |
| `TAKOSUMI_DATABASE_URL` | Takosumi service database connection |
| `TAKOSUMI_DEV_MODE=1` | dev opt-out for strict production guards |

## See also

- `@takosjp/takosumi`
- `@takosjp/takosumi/contract`
- `@takosjp/takosumi/contract/deploy-control-api`
