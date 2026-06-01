# @takosjp/takosumi/cli

Operator CLI for the manifestless Takosumi Installer API.

## Install

```bash
npm install -g @takosjp/takosumi
takosumi version
```

## Quickstart

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
export TAKOSUMI_REMOTE_URL=http://localhost:8788

takosumi server --port 8788 &

mkdir hello-takosumi && cd hello-takosumi
printf '{"name":"hello-takosumi","version":"0.1.0"}\n' > package.json

takosumi install dry-run --source . --space space_personal
takosumi install --source . --space space_personal
takosumi deploy <installation-id> --source .
takosumi rollback <installation-id> <deployment-id>
```

The public surface is Source, Installation, Deployment, and PlatformService. The CLI calls the five installer endpoints
under `/v1/installations/*`.

## Commands

| Command | Purpose |
| --- | --- |
| `takosumi install <source>` | create an Installation and first Deployment |
| `takosumi install dry-run <source>` | dry-run a new Installation |
| `takosumi deploy <installation-id> [--source <source>]` | apply a new Deployment to an Installation |
| `takosumi deploy dry-run <installation-id> [--source <source>]` | dry-run an Installation update |
| `takosumi rollback <installation-id> <deployment-id>` | move current pointer to a retained Deployment |
| `takosumi server [--port] [--no-agent]` | boot the local kernel server |
| `takosumi runtime-agent serve` | standalone generic agent host |
| `takosumi runtime-agent list` | show registered connectors on an agent |
| `takosumi runtime-agent verify` | smoke-test connectors |
| `takosumi artifact push <file> --kind <kind>` | optional DataAsset upload |
| `takosumi migrate [--dry-run]` | run kernel DB migrations |
| `takosumi init [<output>] [--template]` | generic repo metadata starter |
| `takosumi version` | print version |

## Env vars

Priority:

1. CLI flag (`--remote` / `--token`)
2. Command-specific env (`TAKOSUMI_INSTALLER_TOKEN`, `TAKOSUMI_AGENT_TOKEN`)
3. Remote URL env (`TAKOSUMI_REMOTE_URL`)
4. Config file (`~/.takosumi/config.yml`)

| Env var | Used by |
| --- | --- |
| `TAKOSUMI_REMOTE_URL` | default kernel URL for remote CLI commands |
| `TAKOSUMI_INSTALLER_TOKEN` | bearer token for `/v1/installations/*` |
| `TAKOSUMI_DEPLOY_TOKEN` | bearer token for optional DataAsset write endpoints |
| `TAKOSUMI_AGENT_URL` / `TAKOSUMI_AGENT_TOKEN` | `takosumi runtime-agent {list,verify}` target |
| `TAKOSUMI_DEV_MODE=1` | dev opt-out for strict production guards |

## See also

- `@takosjp/takosumi/kernel`
- `@takosjp/takosumi/runtime-agent`
- `@takosjp/takosumi-plugins/connectors`
