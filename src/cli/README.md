# Takosumi in-repo operator CLI

In-repo operator CLI for the Takosumi service (server boot / DB migrations /
OpenTofu module scaffold).

Takosumi's CLI is not npm-published. It runs against the cloned source for
operator tasks. The canonical external install / plan / apply flow is the
dashboard and public `/api` Run surface; the earlier CLI `plan` / `install` /
`deploy` / `rollback` remote-HTTP wire commands have been retired.

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

- `docs/reference/cli.md`
- `docs/reference/deploy-control-api.md`
