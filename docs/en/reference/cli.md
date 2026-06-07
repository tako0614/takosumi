# CLI

The Takosumi CLI is not npm-published. It runs in-repo against the cloned source. The source of truth is
`packages/cli/src` and `src/cli`; when this doc conflicts with the code, the code wins.

The CLI has two uses:

- **in-repo operator CLI** (`src/cli`): start the service and run migrations / scaffolds. `server` / `migrate` /
  `init` / `version` / `completions`.
- **accounts / installations CLI** (`packages/cli`): a thin client over the operator distribution's account/session path.
  `accounts ...` / `installations ...` / `launch-readiness ...`.

It is not the source of truth for interpreting OpenTofu configuration. The canonical install / plan / apply flow is the
dashboard and [`/api`](./deploy-control-api.md).

## In-repo operator CLI

```bash
cd takosumi
bun install
bun src/cli/main.ts --help
```

### server

Start the local Takosumi service HTTP server.

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

`--detach` does not fork the process. It prints a systemd / docker compose / nohup supervisor template. In production,
do not use `TAKOSUMI_DEV_MODE`; inject persistent storage, managed auth, secret store, and runner substrate through
operator config (see [Operator](./operator.md)).

### migrate / init

```bash
bun src/cli/main.ts migrate          # apply schema migrations
bun src/cli/main.ts init [output]    # scaffold local starter files
```

`init` does not require a Takosumi-specific manifest in the user repo (core is no-in-repo-manifest). The canonical
Capsule install input is Git URL / ref / modulePath plus a service-side InstallConfig.

## Accounts / installations CLI

A client over the operator distribution's account/session path. This path is not the public control-plane surface.
External integrations and Capsule install / plan / apply use [`/api`](./deploy-control-api.md) and the dashboard flow as
the source of truth. The operator selects the endpoint and bearer.

```bash
export TAKOSUMI_ACCOUNTS_URL=https://app.takosumi.com
export TAKOSUMI_ACCOUNTS_TOKEN=<accounts-session-or-pat-bearer>
bun packages/cli/src/main.ts --help
```

`--accountsUrl` / `--token` override the env. There is no implicit takosumi default.

### installations

Read or change Installation ledger records.

```bash
bun packages/cli/src/main.ts installations list --space space_personal
bun packages/cli/src/main.ts installations inspect ins_01ABCDEF
bun packages/cli/src/main.ts installations uninstall ins_01ABCDEF --reason "..."
bun packages/cli/src/main.ts installations status ins_01ABCDEF --status active
```

When `--space` is omitted, `TAKOS_SPACE_ID` is used. Plan / apply happen on the dashboard or the Run surface of
[`/api`](./deploy-control-api.md).

### accounts / launch-readiness

```bash
bun packages/cli/src/main.ts accounts tokens list --token <accounts-session-bearer>
bun packages/cli/src/main.ts accounts migrate --database-url postgres://...
bun packages/cli/src/main.ts launch-readiness validate --file evidence.json
```

`accounts` covers OIDC / billing / personal access tokens / migrations; `launch-readiness` covers managed offering
launch evidence. Run `--help` on each subcommand for its options.

## Environment

| Variable                                  | Surface      | Purpose                                                    |
| ----------------------------------------- | ------------ | ---------------------------------------------------------- |
| `TAKOSUMI_DEV_MODE`                       | in-repo CLI  | dev in-memory storage / relaxed auth (never in production) |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN`           | in-repo CLI  | control-plane bearer                                       |
| `TAKOSUMI_DATABASE_URL`                   | in-repo CLI  | Postgres substrate                                         |
| `TAKOSUMI_ACCOUNTS_URL`                   | accounts CLI | accounts plane endpoint (override with `--accountsUrl`)    |
| `TAKOSUMI_ACCOUNTS_TOKEN` / `TAKOS_TOKEN` | accounts CLI | accounts session / PAT bearer (override with `--token`)    |
| `TAKOS_SPACE_ID`                          | accounts CLI | default Space (override with `--space`)                    |
