# @takos/takosumi-cli

Operator CLI for the Takosumi self-host PaaS toolkit. Wraps the kernel HTTP API
and the runtime-agent embed for a single-command dev experience.

## Install

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

## Quickstart (single VM dev)

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788

# Boot kernel + embedded runtime-agent on the same machine
takosumi server --port 8788 &

# Install + deploy
takosumi install --source . --space space:personal
takosumi deploy <installation-id>
takosumi rollback <installation-id> <deployment-id>
```

> The public surface is AppSpec (`.takosumi.yml`), Installation, and Deployment.
> The CLI calls the five installer endpoints under `/v1/installations/*`.

## Commands

| Command                                                             | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `takosumi install <source>`                                         | create an Installation and first Deployment          |
| `takosumi install dry-run <source>`                                 | dry-run a new Installation                           |
| `takosumi deploy <installation-id> [--source <source>]`             | apply a new Deployment to an Installation            |
| `takosumi deploy dry-run <installation-id> [--source <source>]`     | dry-run an Installation update                       |
| `takosumi rollback <installation-id> <deployment-id>`               | create a rollback Deployment                         |
| `takosumi server [--port] [--no-agent]`                             | boot kernel + embedded agent                         |
| `takosumi runtime-agent serve`                                      | standalone agent (multi-host production)             |
| `takosumi runtime-agent list`                                       | show registered connectors on an agent               |
| `takosumi runtime-agent verify`                                     | smoke-test connectors (read-only API call per cloud) |
| `takosumi artifact push <file> --kind <kind>`                       | optional DataAsset upload                            |
| `takosumi artifact list [--limit]` / `rm <hash>` / `gc [--dry-run]` | optional DataAsset store management                  |
| `takosumi artifact kinds`                                           | list operator DataAsset metadata kinds               |
| `takosumi migrate [--dry-run]`                                      | run kernel DB migrations                             |
| `takosumi init [<output>] [--template]`                             | AppSpec scaffold (stdout if no `<output>`)           |
| `takosumi version`                                                  | print version                                        |

## Env vars

Priority (highest first):

1. CLI flag (`--remote` / `--token`)
2. Command-specific env (`TAKOSUMI_INSTALLER_TOKEN`, `TAKOSUMI_AGENT_TOKEN`)
3. Remote URL env (`TAKOSUMI_REMOTE_URL`)
4. Config file (`~/.takosumi/config.yml`)

| Env var                                       | Used by                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `TAKOSUMI_REMOTE_URL`                         | default kernel URL for remote CLI commands                        |
| `TAKOSUMI_INSTALLER_TOKEN`                    | bearer token for `/v1/installations/*`                            |
| `TAKOSUMI_DEPLOY_TOKEN`                       | bearer token for optional DataAsset write endpoints               |
| `TAKOSUMI_AGENT_URL` / `TAKOSUMI_AGENT_TOKEN` | `takosumi runtime-agent {list,verify}` target                     |
| `TAKOSUMI_DEV_MODE=1`                         | dev opt-out: plaintext secrets / unencrypted DB / unsafe defaults |
| `TAKOSUMI_LOG_LEVEL=warn`                     | suppress dev-mode in-memory fallback notices                      |

See
[`docs/getting-started/quickstart.md`](../../docs/getting-started/quickstart.md)
for full multi-host production setup, cloud credential placement, and
troubleshooting.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)

> The `@takos/` JSR scope is the reference Takosumi distribution published by
> Takos. The contract is the authority. Alternative publishers such as
> `@example/takosumi-cli` can ship compatible CLI implementations; current
> verification covers the reference distribution.
