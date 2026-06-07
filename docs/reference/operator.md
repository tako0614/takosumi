# Operator

Operator は Takosumi platform worker を動かし、storage、auth、dashboard、billing / OIDC、hosted runner、内部 execution
profile を管理します。core の public surface は Space / Source / Connection / OpenTofu Capsule / Installation /
Dependency / Run / RunGroup / Deployment / OutputSnapshot / Billing / Activity です。

## Responsibilities

- control-plane の token と auth boundary を設定する
- internal execution profile (substrate / runner image / resource limit / provider allowlist seed) を定義する ([Internal execution profiles](./runner-profiles.md))
- Connection / operator default connection と secret delivery を管理する
- state backend と lock backend を管理する
- OpenTofu runner image / container / queue を管理する
- Cloudflare Workers for Platforms を使う場合は dispatch namespace、outbound Worker、tenant Worker binding policy を管理する
- provider credential / control-plane token / state backend credential を tenant Worker に渡さない証跡を管理する
- dashboard から Installation / Run / Deployment / OutputSnapshot / Activity / Billing projection を見せる
- managed offering を開く場合は billing、OIDC、support boundary、audit evidence を揃える

## Workload integrations

Hosted/operator distribution は、OIDC client material、billing portal link、webhook ingest endpoint、same-Space
control callback のような integration token / service projection を deployed workload に渡せます。これらは
**operator integration detail** であり、Takosumi core の public concept ではありません。新しい core resource にせず、
Installation / Deployment / OutputSnapshot / Billing / Activity / Connection policy record から導出します。

Integration token rule:

- raw token value は作成/rotation 時に一度だけ返す
- 通常の read は secret reference、expiry、非 secret metadata だけを返す
- token は 1 つの Space と 1 つの intended capability に scope する
- token は execution profile、provider credential、state backend、billing ownership、account token、OIDC issuer
  configuration を管理できない
- token 作成、rotation、利用は token value を保存せず Activity または redacted internal audit evidence に記録する

## Production readiness

Reference implementation checks が passing でも、managed offering が public GA とは限りません。public GA には次の operator evidence が必要です。

| Area                | Required evidence                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Website             | `takosumi.com` custom domain、TLS、`/docs/` build                                                                                      |
| Hosted runner       | Cloudflare Container runner で non-production provider apply が成功した記録                                                            |
| Account surface     | dashboard、OIDC、billing、credential delivery、audit trail                                                                             |
| State               | remote state backend と lock evidence                                                                                                  |
| Policy              | provider allowlist / credential delivery evidence / network policy / allowed host pattern の enforcement                               |
| Provider live proof | 有効化する Cloudflare / AWS / GCP / Azure / Kubernetes / GitHub / DigitalOcean execution boundary ごとの non-production `plan/apply/destroy` 証跡 |
| Tenant runtime      | Workers for Platforms dispatch namespace と outbound Worker の isolation proof                                                         |
| Secret boundary     | runner diagnostics、failure audit、OpenTofu output、tenant Worker binding の leak test                                                 |

## Local service

```bash
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token>
export TAKOSUMI_DEV_MODE=1
bun src/cli/main.ts server --port 8788
```

Production では `TAKOSUMI_DEV_MODE` を使わず、persistent storage、managed auth、secret store、runner substrate を operator config で注入します。

## Public site

`takosumi/website/` は landing page、`takosumi/docs/` は docs site です。`bun run website:build` は landing と `/docs/` と `/contexts/` を単一 Cloudflare Pages artifact にまとめます。
