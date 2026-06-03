# Operator

Operator は Takosumi distribution を動かし、RunnerProfile、storage、auth、dashboard、billing / OIDC、hosted runner を管理します。

## Responsibilities

- Deploy Control API の token と auth boundary を設定する
- RunnerProfile を定義する
- provider credential reference と secret delivery を管理する
- state backend と lock backend を管理する
- OpenTofu runner image / container / queue を管理する
- Cloudflare Workers for Platforms を使う場合は dispatch namespace、outbound Worker、tenant Worker binding policy を管理する
- provider credential / Deploy Control token / state backend credential を tenant Worker に渡さない証跡を管理する
- dashboard から PlanRun / ApplyRun / Deployment / DeploymentOutput / Workload Service projection を見せる
- managed offering を開く場合は billing、OIDC、support boundary、audit evidence を揃える

## Workload Services

Workload Services は Accounts / operator distribution が deployed workload に渡す service projection です。Takosumi core の
public concept ではありません。core の public surface は Installation / PlanRun / ApplyRun / Deployment /
DeploymentOutput / RunnerProfile のままです。

v1 の reference distribution は次を返します。

| Service | Material kind | Secret | Meaning |
| --- | --- | --- | --- |
| `identity.primary.oidc` | `identity.oidc@v1` | no | operator OIDC issuer と per-installation public client |
| `billing.primary.default` | `billing.port@v1` | yes | billing portal と usage report endpoint |
| `deployment.outputs.http` | `deployment.outputs.http@v1` | no | OpenTofu output から投影した public HTTP URL |
| `events.webhook.default` | `events.webhook@v1` | yes | workload から Accounts event ledger へ送る ingest endpoint |
| `takosumi.control.space` | `takosumi.control@v1` | yes | 同じ Space 内の workload control service |

API:

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/v1/workload-services` | account session / PAT read |
| GET | `/v1/installations/{id}/services` | owner account session / PAT read |
| POST | `/v1/installations/{id}/services/{serviceId}/rotate-token` | owner account session / PAT write |
| POST | `/v1/installations/{id}/events/ingest` | current `events.webhook.default` workload token |

`rotate-token` が返す raw token は一度だけ表示します。通常の GET、App detail、DeploymentOutput、public event serialization
には raw token を出さず、`secret_ref` と expiry だけを返します。token rotation は InstallationEvent に記録した current token
hash で判定するため、D1 / Postgres のどちらでも古い token は次の rotation 後に無効になります。

`takosumi.control.space` token は same-space workload control 用です。許可される対象は same-space installation の
list / detail / events / outputs / deploy / rollback / materialize / export / usage report に限定され、RunnerProfile、provider
credential、state backend、billing owner、account token、OIDC issuer の管理には使えません。

## Production readiness

Reference implementation checks が passing でも、managed offering が public GA とは限りません。public GA には次の operator evidence が必要です。

| Area | Required evidence |
| --- | --- |
| Website | `takosumi.com` custom domain、TLS、`/docs/` build |
| Hosted runner | Cloudflare Container runner で non-production provider apply が成功した記録 |
| Account surface | dashboard、OIDC、billing、credential delivery、audit trail |
| State | remote state backend と lock evidence |
| Policy | provider allowlist / credential refs / network policy / allowed host pattern の enforcement |
| Provider live proof | 有効化する Cloudflare / AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean profile ごとの non-production `plan/apply/destroy` 証跡 |
| Tenant runtime | Workers for Platforms dispatch namespace と outbound Worker の isolation proof |
| Secret boundary | runner diagnostics、failure audit、OpenTofu output、tenant Worker binding の leak test |

## Local service

```bash
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token>
export TAKOSUMI_DEV_MODE=1
bun src/cli/main.ts server --port 8788
```

Production では `TAKOSUMI_DEV_MODE` を使わず、persistent storage、managed auth、secret store、runner substrate を operator config で注入します。

## Public site

`takosumi/website/` は landing page、`takosumi/docs/` は docs site です。`bun run website:build` は landing と `/docs/` と `/contexts/` を単一 Cloudflare Pages artifact にまとめます。
