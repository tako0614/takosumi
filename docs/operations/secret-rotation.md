# Secret Rotation Runbook

> このページでわかること: シークレットローテーションの実行手順
> (コマンド・安全確認・ロールバック)。

> **Document role**: 本文書は Takos secret rotation の **operational runbook**
> です。実行手順 (コマンド、安全確認、rollback) を扱います。提供する保証
> (cadence、initiator、audit contract、recovery target) は governance doc
> [`./secret-rotation-policy.md`](./secret-rotation-policy.md)
> を参照してください。

本 runbook は secret rotation に関する operator 正本です。コマンドと安全確認のみを
扱います。secret 値、token body、 key material、provider credential JSON は
コミットしないこと。

> **Note**: 本 runbook の `apps/control` ベースの secret-sync コマンドは、 operator が
> Takos product を Cloudflare 上で運用していた旧構成 (= 現在は archive 済の
> `takos-private` control plane) のものです。新構成では operator がデプロイするのは
> Takosumi platform worker (`app.takosumi.com`) のみで、その 7 鍵の保管 / push は
> [`./platform-worker-deploy.md`](./platform-worker-deploy.md) の手順
> (= operator host の `/root/.takos-secrets/<env>/` + `wrangler secret bulk`)
> に従います。 以下の `apps/control` 手順は historical reference として残します。

## Operator setup

旧構成のコマンドは ecosystem checkout を root として実行します。 example の checkout
path は `/root/dev/takos` ですが、 自分の checkout 先に読み替えてください。

cadence と authorized initiator の根拠は
[`./secret-rotation-policy.md`](./secret-rotation-policy.md) にあります。
rotation の判断はそちらを、実行手順はこの runbook を参照してください。

## Required Checks

Cloudflare の rotation の前後で必ず実行:

```bash
cd /root/dev/takos   # ecosystem checkout root
bun --cwd apps/control run secrets:status:staging
bun --cwd apps/control run secrets:status:production
```

`OIDC_CLIENT_SECRET` と `CF_API_TOKEN` は Cloudflare deploy preflight において
remote authoritative です。remote Worker secret が存在する場合、これら 2 つの
local omission は許容可能ですが、その事実を run log に記録します。それ以外の
required な local omission や placeholder 値は rotation を block します。

非対話 shell では `secrets put` に必ず `--value-file` を渡すこと。空の stdin が
候補値として解釈され placeholder として reject されることがあります。

## Rotation Policy And Runner

secret 種別ごとの policy は `apps/control/secret-rotation.policy.json` に
あります。class / interval / grace period / rotation mode / generator type /
影響 worker を、secret material を保存せずに記録しています。

local secret 値を読まずに rotation を計画する:

```bash
cd /root/dev/takos   # ecosystem checkout root
bun --cwd apps/control run secrets:rotation:plan:staging
bun --cwd apps/control run secrets:rotation:plan:production
```

runner は private policy に `lastRotatedAt` evidence があればそれを使い、
無い場合は local `.secrets/<env>/<SECRET>` ファイルの mtime を使います。
planning 時に secret 値を print / read することはありません。

rotation を dry-run する:

```bash
bun apps/control/scripts/secret-rotation-runner.ts rotate \
  EXECUTOR_PROXY_SECRET \
  --env staging \
  --dry-run \
  --reason "scheduled rotation"
```

apply は下記の maintenance / online safety check を pass
した後にのみ実行します。 生成した secret は `.secrets/<env>/<SECRET>` に `0600`
で書き出されます。 operator が用意した secret は必ず `--value-file` を使います。

## Cloudflare Worker Secrets

| Secret class                                                                                              | Workers                                      | Rotation mode                                                                                                                   | Rollback                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Platform keypair (`PLATFORM_PRIVATE_KEY`, `PLATFORM_PUBLIC_KEY`)                                          | `web`, `worker`, `runtime-host`              | Maintenance window. Generate and upload the pair together. Existing signed tokens may fail after cutover.                       | Restore the previous private/public key files from the operator vault or temporary backup, then re-run the same upload commands.   |
| `ENCRYPTION_KEY`                                                                                          | `web`, `worker`                              | Maintenance window. Rotate only with a data re-encryption plan or explicit acceptance that old encrypted values are unreadable. | Restore the previous key immediately. If writes occurred under the new key, reconcile affected data before reopening traffic.      |
| `EXECUTOR_PROXY_SECRET`                                                                                   | `web`, `executor`                            | Online for staging; maintenance window recommended for production. Upload to both workers in one `secrets put` command.         | Restore the previous value and re-run `secrets put EXECUTOR_PROXY_SECRET`. Restart/tail affected workers if auth failures persist. |
| `TAKOS_INTERNAL_API_SECRET`                                                                               | `web`                                        | Online for staging. Production should use a short maintenance window unless all internal callers are confirmed compatible.      | Restore the previous value and redeploy or restart any caller that caches it.                                                      |
| OIDC client secrets (`OIDC_CLIENT_SECRET`)                                                                | `web`                                        | Online if the issuer client id is unchanged. Coordinate with Takosumi Accounts client registry changes first.                   | Restore the previous client secret in Cloudflare and in Takosumi Accounts if it was changed there.                                 |
| LLM / embedding provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `SERPER_API_KEY`) | `web`, `worker`, `executor` depending on key | Online. Rotate one provider at a time and verify a staging request path before production.                                      | Restore the previous provider key and confirm quota / billing state in the provider dashboard.                                     |
| Cloudflare API / OCI provider credentials (`CF_API_TOKEN`, `OCI_ORCHESTRATOR_TOKEN`)                      | `web`, `worker`                              | Online for staging. Production requires a maintenance window if deployments may run during rotation.                            | Restore the previous token, confirm permissions, and retry any failed deployment or provisioning job.                              |

## Staging Rotation Procedure

`EXECUTOR_PROXY_SECRET` のような online Worker secret はこの手順で扱います:

```bash
cd /root/dev/takos   # ecosystem checkout root

bun --cwd apps/control run secrets:status:staging

backup="/tmp/takos-executor-proxy-secret-staging-$(date +%s)"
cp apps/control/.secrets/staging/EXECUTOR_PROXY_SECRET "$backup"

bun -e 'const fs=require("node:fs/promises"); const path="apps/control/.secrets/staging/EXECUTOR_PROXY_SECRET"; const bytes=new Uint8Array(32); crypto.getRandomValues(bytes); const value=btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=",""); await fs.writeFile(path, value+"\\n", { mode: 0o600 }); await fs.chmod(path, 0o600);'

bun --cwd apps/control run secrets put EXECUTOR_PROXY_SECRET \
  --env staging \
  --value-file .secrets/staging/EXECUTOR_PROXY_SECRET

bun --cwd apps/control run secrets:status:staging
```

rollback:

```bash
cd /root/dev/takos   # ecosystem checkout root
cp "$backup" apps/control/.secrets/staging/EXECUTOR_PROXY_SECRET
bun --cwd apps/control run secrets put EXECUTOR_PROXY_SECRET \
  --env staging \
  --value-file .secrets/staging/EXECUTOR_PROXY_SECRET
bun --cwd apps/control run secrets:status:staging
```

日付、環境、secret class、コマンド、結果、rollback note を `PHASE-19-RUN-LOG.md`
に記録します。
