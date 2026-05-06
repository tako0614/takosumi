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
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788

# Boot kernel + embedded runtime-agent on the same machine
takosumi server --port 8788 &

# Scaffold + deploy
takosumi init ./manifest.yml --template selfhosted-single-vm
takosumi doctor --manifest ./manifest.yml
takosumi deploy ./manifest.yml
takosumi status
takosumi destroy ./manifest.yml
```

> Project-layout discovery (`.takosumi/manifest.yml` etc.) is **not** in this
> CLI; it is owned by the `takosumi-git` sibling product. Pass the manifest path
> explicitly to every `deploy` / `destroy` / `plan` / `doctor` call.

## Commands

| Command                                                             | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `takosumi deploy <manifest>`                                        | apply; manifest path is required                     |
| `takosumi destroy <manifest> [--force]`                             | tear down a previously-applied manifest              |
| `takosumi status [<name>]`                                          | query kernel for current deployment state            |
| `takosumi plan <manifest>`                                          | dry-run (validate + DAG, no provider.apply)          |
| `takosumi doctor --manifest <path>`                                 | show manifest / mode / token before deploy           |
| `takosumi server [--port] [--no-agent]`                             | boot kernel + embedded agent                         |
| `takosumi runtime-agent serve`                                      | standalone agent (multi-host production)             |
| `takosumi runtime-agent list`                                       | show registered connectors on an agent               |
| `takosumi runtime-agent verify`                                     | smoke-test connectors (read-only API call per cloud) |
| `takosumi artifact push <file> --kind <kind>`                       | content-addressed artifact upload                    |
| `takosumi artifact list [--limit]` / `rm <hash>` / `gc [--dry-run]` | artifact store management                            |
| `takosumi artifact kinds`                                           | list registered artifact kinds                       |
| `takosumi migrate [--dry-run]`                                      | run kernel DB migrations                             |
| `takosumi init [<output>] [--template]`                             | manifest scaffold (stdout if no `<output>`)          |
| `takosumi version`                                                  | print version                                        |

## Env vars

Priority (highest first):

1. CLI flag (`--remote` / `--token`)
2. Command-specific env (`TAKOSUMI_DEPLOY_TOKEN`, `TAKOSUMI_AGENT_TOKEN`)
3. Generic env (`TAKOSUMI_REMOTE_URL`, `TAKOSUMI_TOKEN`)

| Env var                                       | Used by                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `TAKOSUMI_REMOTE_URL`                         | `takosumi {deploy,destroy,status,plan,artifact}` default kernel URL |
| `TAKOSUMI_DEPLOY_TOKEN`                       | bearer token for kernel deploy/artifact endpoints                   |
| `TAKOSUMI_AGENT_URL` / `TAKOSUMI_AGENT_TOKEN` | `takosumi runtime-agent {list,verify}` target                       |
| `TAKOSUMI_DEV_MODE=1`                         | dev opt-out: plaintext secrets / unencrypted DB / unsafe defaults   |
| `TAKOSUMI_LOG_LEVEL=warn`                     | suppress dev-mode in-memory fallback notices                        |
| `TAKOSUMI_KERNEL_URL` / `TAKOSUMI_TOKEN`      | **deprecated** aliases of the above                                 |

See
[`docs/getting-started/quickstart.md`](../../docs/getting-started/quickstart.md)
for full multi-host production setup, cloud credential placement, and
troubleshooting.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
