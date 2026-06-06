# CLI

Takosumi の CLI は npm publish されません。 clone した source に対して in-repo で動く operator 向け CLI です。
正本は [`packages/cli/src`](../../packages/cli) と [`src/cli`](../../src/cli) で、 本 doc が矛盾した場合は code が優先します。

CLI は 2 つの surface に分かれます。

- **in-repo operator CLI** (`src/cli`): service を起動し、 migration / scaffold を流す。 `server` / `migrate` / `init` / `version` / `completions`。
- **accounts / installations CLI** (`packages/cli`): accounts plane の internal `/v1` seam を叩く薄い client。 `accounts ...` / `installations ...` / `launch-readiness ...`。

OpenTofu configuration を解釈する正本ではありません。 install / plan / apply の正本 flow は dashboard と [`/api`](./deploy-control-api.md) です。

## In-repo operator CLI

```bash
cd takosumi
bun install
bun src/cli/main.ts --help
```

### server

local の Takosumi service HTTP server を起動します。

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

`--detach` は process を fork しません。 systemd / docker compose / nohup の supervisor template を表示します。
Production では `TAKOSUMI_DEV_MODE` を使わず、 persistent storage・managed auth・secret store・runner substrate を
operator config で注入します (詳細は [Operator](./operator.md))。

### migrate / init

```bash
bun src/cli/main.ts migrate          # apply schema migrations
bun src/cli/main.ts init [output]    # scaffold generic repository metadata
```

`init` は user repo に Takosumi 独自 manifest を要求しません (core は no-in-repo-manifest)。 生成するのは generic な
repository metadata だけです。

## Accounts / installations CLI

accounts plane の internal `/v1` seam (公開語彙の外) を叩く client です。 endpoint と bearer は operator が選びます。

```bash
export TAKOSUMI_ACCOUNTS_URL=https://app.takosumi.com
export TAKOSUMI_ACCOUNTS_TOKEN=<accounts-session-or-pat-bearer>
bun packages/cli/src/main.ts --help
```

`--accountsUrl` / `--token` で env を上書きできます。 implicit な takosumi default はありません。

### installations

Installation ledger を読む / 状態を変える操作です。

```bash
bun packages/cli/src/main.ts installations list --space space_personal
bun packages/cli/src/main.ts installations inspect ins_01ABCDEF
bun packages/cli/src/main.ts installations uninstall ins_01ABCDEF --reason "..."
bun packages/cli/src/main.ts installations status ins_01ABCDEF --status ready
```

`--space` を省くと `TAKOS_SPACE_ID` を読みます。 これらは accounts plane の `/v1/installations` seam に当たります
(plan / apply は dashboard または [`/api`](./deploy-control-api.md) の Run surface で行います)。

### accounts / launch-readiness

```bash
bun packages/cli/src/main.ts accounts tokens list --token <accounts-session-bearer>
bun packages/cli/src/main.ts accounts migrate --database-url postgres://...
bun packages/cli/src/main.ts launch-readiness validate --file evidence.json
```

`accounts` は OIDC / billing / personal access token / migration、 `launch-readiness` は managed offering の launch
evidence を扱います。 各 subcommand の option は `--help` で確認できます。

## Environment

| Variable | Surface | 用途 |
| --- | --- | --- |
| `TAKOSUMI_DEV_MODE` | in-repo CLI | dev 用の in-memory storage / relaxed auth (production では使わない) |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | in-repo CLI | control-plane bearer |
| `TAKOSUMI_DATABASE_URL` | in-repo CLI | Postgres substrate |
| `TAKOSUMI_ACCOUNTS_URL` | accounts CLI | accounts plane endpoint (`--accountsUrl` で上書き) |
| `TAKOSUMI_ACCOUNTS_TOKEN` / `TAKOS_TOKEN` | accounts CLI | accounts session / PAT bearer (`--token` で上書き) |
| `TAKOS_SPACE_ID` | accounts CLI | default Space (`--space` で上書き) |
