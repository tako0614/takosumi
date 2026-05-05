# CLI Reference

> Stability: stable Audience: operator See also:
> [Kernel HTTP API](/reference/kernel-http-api),
> [Environment Variables](/reference/env-vars),
> [Migration & Upgrade](/reference/migration-upgrade)

`takosumi` is the command-line companion to the Takosumi PaaS kernel. It authors
and submits Manifests, manages content-addressed DataAssets, operates the
runtime-agent, and runs the kernel server itself. The CLI is not the semantic
authority for any of these operations — every authoritative decision
(resolution, planning, journaling, activation) is made by the kernel inside the
public deploy Space selected for the deploy bearer, or by the internal
control-plane Space context for operator-only routes.

## Modes

`takosumi` runs in two modes:

| Mode     | Trigger                                         | State                                      | Use cases                                         |
| -------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `local`  | no remote URL is resolved                       | in-process kernel; ephemeral; lost on exit | authoring, single-host experiments, test fixtures |
| `remote` | a remote URL is resolved (flag, env, or config) | persisted by the remote kernel             | shared development, staging, production           |

Local mode does not maintain Space state; resolution happens against the bundled
shape / provider registry inside the same process. Remote mode talks to a
Takosumi kernel HTTP server, which performs Space-scoped resolution, planning,
and journaling per the [WAL Stages](/reference/wal-stages) reference.

## Installation

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

Deno 2.x is the supported runtime. The CLI has no kernel-side or
runtime-agent-side install dependency: a CLI host can run without ever hosting a
kernel.

## Authentication

Remote-mode commands authenticate to the kernel with a bearer token. The token
granted to the CLI is the operator-issued `TAKOSUMI_DEPLOY_TOKEN`, which scopes
deploy and DataAsset endpoints. Runtime-Agent subcommands use a separate bearer
(`TAKOSUMI_AGENT_TOKEN`) scoped to the runtime-agent service.

The public deploy bearer maps to one kernel-side public deploy Space / tenant
scope. Operators set that scope with `TAKOSUMI_DEPLOY_SPACE_ID`; when unset it
is `takosumi-deploy`. The CLI does not send a Space field in the manifest.

A token is resolved from one of these sources, in this exact order:

1. command flag (`--token`)
2. `TAKOSUMI_DEPLOY_TOKEN` env (deploy / artifact paths) or
   `TAKOSUMI_AGENT_TOKEN` env (runtime-agent paths)
3. `TAKOSUMI_TOKEN` env (generic; warns once on first use)
4. config file `token` field

A remote URL is resolved from:

1. `--remote` flag
2. `TAKOSUMI_REMOTE_URL` env
3. config file `remote_url` field

Missing both flag and any source places the CLI in local mode. Endpoints that
require remote (`status`, `artifact ...`) exit with code 2 in that case.

## Config file

The CLI reads `~/.takosumi/config.yml` once per process. The path may be
overridden with `TAKOSUMI_CONFIG_FILE`. The schema is closed:

```yaml
remote_url: <string, optional> # bare URL of the kernel HTTP server
token: <string, optional> # bearer token for the kernel
```

Behaviour:

- `$HOME` (or `$USERPROFILE` on Windows) unset and no `TAKOSUMI_CONFIG_FILE`
  override: the file is skipped silently.
- File missing or empty: skipped silently.
- File present but not a YAML mapping: a single stderr warning is printed and
  the file is ignored.
- Any other read error: a single stderr warning is printed and the file is
  ignored.

Process env always overrides the config file. Both are overridden by an explicit
command flag.

## Commands

### `takosumi server`

Start the kernel HTTP server.

```text
takosumi server [--port <n>] [--agent-port <n>] [--no-agent] [--detach]
```

| Flag           | Type   | Default | Notes                                                                              |
| -------------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| `--port`       | number | `8788`  | kernel HTTP listen port                                                            |
| `--agent-port` | number | `8789`  | port for the embedded runtime-agent (only used when `TAKOSUMI_AGENT_URL` is unset) |
| `--no-agent`   | switch | off     | skip the embedded runtime-agent; the operator must run one separately              |
| `--detach`     | switch | off     | print a recommended systemd / docker / nohup template and exit                     |

`--detach` does not fork the process; Deno does not provide a portable detach
primitive. The CLI prints supervisor templates so the operator can wire systemd,
docker compose, or nohup themselves.

Examples:

```bash
takosumi server
takosumi server --port 9000 --agent-port 9001
takosumi server --no-agent
takosumi server --detach > takosumi-api.service
```

Exit codes: `0` on clean shutdown via SIGINT/SIGTERM, `1` on bind failure or
kernel boot error.

`takosumi server` の rolling upgrade / drain / kernel ↔ runtime-agent skew
tolerance / schema migration window については
[Migration / Upgrade](/reference/migration-upgrade) を参照してください。

### `takosumi deploy <manifest>`

Submit a Manifest for apply.

```text
takosumi deploy <manifest> [--remote <url>] [--token <t>] [--dry-run]
```

| Flag        | Type   | Notes                                |
| ----------- | ------ | ------------------------------------ |
| `--remote`  | url    | overrides resolved remote URL        |
| `--token`   | string | overrides resolved token             |
| `--dry-run` | switch | validate and plan only; do not apply |

Behaviour:

- Remote: posts `POST /v1/deployments` with body
  `{ mode: "apply" | "plan", manifest }`. The public deploy Space is selected by
  kernel configuration (`TAKOSUMI_DEPLOY_SPACE_ID`, default `takosumi-deploy`).
  Each remote write carries a fresh `X-Idempotency-Key` so transport retries
  replay the first kernel response instead of re-running apply.
- Local: expands the manifest with the bundled registry and runs an in-process
  apply (or plan, when `--dry-run` is set). State is discarded on exit.

Exit codes: `0` accepted, `1` validation or apply failure, `2` malformed flags.

Examples:

```bash
takosumi deploy ./manifest.yml
takosumi deploy ./manifest.yml --dry-run
takosumi deploy ./manifest.yml --remote https://kernel.example.com --token $TAKOSUMI_DEPLOY_TOKEN
```

### `takosumi plan <manifest>`

Validate and print the resolved plan without applying.

```text
takosumi plan <manifest> [--remote <url>] [--token <t>]
```

| Flag       | Type   | Notes                         |
| ---------- | ------ | ----------------------------- |
| `--remote` | url    | overrides resolved remote URL |
| `--token`  | string | overrides resolved token      |

Remote-mode `plan` posts `POST /v1/deployments` with `mode: "plan"` and prints
the kernel's response body verbatim. The request carries a fresh
`X-Idempotency-Key` just like `deploy`, even though plan has no provider side
effects. Local-mode `plan` runs the bundled validators in-process and prints
`{ status, outcome }` as JSON on stdout. In both modes,
`outcome.operationPlanPreview` carries deterministic DesiredSnapshot /
OperationPlan digests and WAL idempotency tuple previews; no WAL entry is
written by `plan`.

Exit codes: `0` plan succeeded, `1` plan failed.

### `takosumi destroy <manifest>`

Tear down resources declared by a previously applied manifest.

```text
takosumi destroy <manifest> [--remote <url>] [--token <t>] [--force]
```

| Flag       | Type   | Notes                                                                                                                                 |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--remote` | url    | overrides resolved remote URL                                                                                                         |
| `--token`  | string | overrides resolved token                                                                                                              |
| `--force`  | switch | destroy by resource name when no prior apply record exists; safe only for self-hosted resources whose handle equals the resource name |

Remote mode posts `POST /v1/deployments` with `mode: "destroy"` so the kernel
can look up persisted handles and submit them through the runtime-agent. The
remote request carries a fresh `X-Idempotency-Key` so a retry cannot run
provider destroy twice. Local mode destroys in-process; without prior state the
operation is best-effort.

Exit codes: `0` all destroyed, `1` partial or validation failure.

### `takosumi status [<name>]`

Query the kernel for deployment state. Remote-only.

```text
takosumi status [<name>] [--remote <url>] [--token <t>]
```

Without `<name>`, lists every deployment by calling `GET /v1/deployments`. With
`<name>`, fetches a single deployment via `GET /v1/deployments/:name`. Both
endpoints return the [Status Output](/reference/status-output) document; the CLI
renders a small text table whose columns are
`deployment / resource / shape / provider / status`.

Exit codes: `0` rendered, `1` kernel error or unsupported route, `2` if remote /
token are missing.

### `takosumi migrate`

Run kernel database migrations.

```text
takosumi migrate [--env <name>] [--dry-run]
```

| Flag        | Type   | Default | Notes                                                            |
| ----------- | ------ | ------- | ---------------------------------------------------------------- |
| `--env`     | string | `local` | `local` / `staging` / `production`, or any operator-defined name |
| `--dry-run` | switch | off     | report planned migrations without applying                       |

The `--env` value selects which env-specific `*_DATABASE_URL` is preferred (see
[Environment Variables](/reference/env-vars)). Dry-run does not require a URL
even for staging or production.

Exit codes: `0` migrated or dry-run printed, `1` migration error or kernel
script missing, `2` required env unset for non-dry-run staging / production.

### `takosumi init [<output>]`

Scaffold a Manifest.

```text
takosumi init [<output>] [--template <name>]
```

| Flag         | Type   | Default                | Notes                                  |
| ------------ | ------ | ---------------------- | -------------------------------------- |
| `--template` | string | `selfhosted-single-vm` | one of `selfhosted-single-vm`, `empty` |

If `<output>` is given, the rendered Manifest is written to that path; otherwise
it is printed to stdout. Templates render with `apiVersion: "1.0"` and
`kind: Manifest` set, matching the contract envelope.

### `takosumi artifact <push | list | rm | gc | kinds>`

Manage content-addressed DataAssets in the kernel artifact store. Every
subcommand requires a remote URL and a deploy-scoped token; missing either exits
with code 2.

```text
takosumi artifact push <file> --kind <kind> [--metadata k=v ...] [--remote <url>] [--token <t>]
takosumi artifact list                       [--limit <n>] [--remote <url>] [--token <t>]
takosumi artifact rm <hash>                  [--remote <url>] [--token <t>]
takosumi artifact gc                         [--dry-run] [--remote <url>] [--token <t>]
takosumi artifact kinds                      [--table] [--remote <url>] [--token <t>]
```

`push` uploads bytes via `POST /v1/artifacts` and prints the
`{ hash, kind, size, uploadedAt }` envelope; the operator embeds the returned
hash into the manifest. `list` walks paginated `GET /v1/artifacts` results. `rm`
deletes a single hash. `gc` runs the kernel mark-and-sweep against the persisted
DesiredSnapshot reference graph. `kinds` calls `GET /v1/artifacts/kinds` to list
the kinds the kernel currently understands. See
[DataAsset Kinds](/reference/artifact-kinds) for the registry semantics.

### `takosumi runtime-agent <serve | list | verify>`

Operate the Takosumi runtime-agent, which holds cloud credentials and performs
lifecycle work on behalf of the kernel.

```text
takosumi runtime-agent serve  [--port <n>] [--hostname <h>] [--token <t>] [--env-file <path>]
takosumi runtime-agent list   [--url <url>] [--token <t>]
takosumi runtime-agent verify [--url <url>] [--token <t>] [--shape <s>] [--provider <p>]
```

`serve` starts the agent HTTP server (default `127.0.0.1:8789`); when `--token`
and `TAKOSUMI_AGENT_TOKEN` are both unset, a random token is generated and
printed. `list` queries `GET /v1/connectors`. `verify` posts
`POST /v1/lifecycle/verify` and runs each connector's read-only smoke test;
failed connectors cause exit code 2.

### `takosumi completions <shell>`

Print a completion script for `bash`, `zsh`, or `fish`. Generated by the bundled
cliffy completions command.

```bash
takosumi completions bash > /etc/bash_completion.d/takosumi
takosumi completions zsh  > "${fpath[1]}/_takosumi"
takosumi completions fish > ~/.config/fish/completions/takosumi.fish
```

### `takosumi version`

Print the CLI version. No flags.

## Exit codes

The CLI uses a small reserved set:

| Code | Meaning                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | command succeeded                                                                                                                                             |
| `1`  | command-specific failure (kernel returned ≥ 400; plan or apply failed; partial destroy; migration failed)                                                     |
| `2`  | usage error or precondition failure (malformed flag value, missing required env, remote-only command without remote URL, `verify` reported failed connectors) |

Codes `70` and above are reserved for future signal-driven exits and are not
currently emitted. The CLI does not mirror process signals into distinct exit
codes.

## Deprecation policy

The CLI prints a one-shot stderr warning when an operator relies on a selector
that has been superseded but is still resolved for compatibility. Each warning
is emitted at most once per process. Setting `TAKOSUMI_NO_DEPRECATION_WARN=1`
suppresses every CLI deprecation warning at once. The grace window for any
deprecated alias is one minor release of the CLI; the next minor release after a
warning is introduced removes the alias.

Currently warned aliases:

- `TAKOSUMI_KERNEL_URL` — replaced by `TAKOSUMI_REMOTE_URL`.
- `TAKOSUMI_TOKEN` (used as a deploy / artifact token) — replaced by
  `TAKOSUMI_DEPLOY_TOKEN`.

## Related

- Reference: [Manifest](/manifest),
  [Environment Variables](/reference/env-vars),
  [DataAsset Kinds](/reference/artifact-kinds),
  [Migration / Upgrade](/reference/migration-upgrade)

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る:

- `docs/design/cli-companion-design-note.md` — CLI surface design rationale
