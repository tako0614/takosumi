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
- dashboard から PlanRun / ApplyRun / DeploymentOutput を見せる
- managed offering を開く場合は billing、OIDC、support boundary、audit evidence を揃える

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
