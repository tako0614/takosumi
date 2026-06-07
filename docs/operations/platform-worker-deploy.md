# Takosumi platform worker (app.takosumi.com) デプロイ手順

operator が運用する唯一の worker。Takos product は公式にはどこにもデプロイしない
（ユーザーが自分のインフラに self-host する。`takos/deploy/cloudflare/wrangler.toml`
は self-host 用 template であり、operator はこれをデプロイしない）。

## 構成

- worker 名: `takosumi` / custom domain: `app.takosumi.com`（DNS/TLS は deploy が自動管理）
- entry: `takosumi/deploy/platform/worker.ts`（accounts plane + in-process control plane + dashboard + runner dispatch）
- config: **`takosumi-private/platform/wrangler.toml`（実値の正本）**。
  `takosumi/deploy/platform/wrangler.toml` は placeholder の reference template（相対パスは config dir 基準）
- dashboard SPA: `takosumi/dashboard/`（vite + solid）→ `dist/` を ASSETS で配信
- D1 / SQL: accounts plane と control plane の ledger。Cloudflare realized
  config では account-plane DB と control-plane DB を別 binding にしてもよいが、
  public model は単一 Takosumi platform worker が Space / Source / Connection /
  Installation / Run / StateSnapshot / OutputSnapshot / Deployment / Billing /
  Activity を所有する。
- R2: `takosumi-source` / `takosumi-artifacts` / `takosumi-state` /
  `takosumi-backups` / account export bucket
- queue: `takosumi-runs` / `takosumi-runs-dlq`
- container: `OpenTofuRunnerObject`（`takosumi/runner-image/Dockerfile`、docker 必須）

canonical bindings:

- `TAKOS_D1`
- `R2_SOURCE`
- `R2_ARTIFACTS`
- `R2_STATE`
- `R2_BACKUPS`
- `RUN_QUEUE`
- `COORDINATION`
- `RUNNER`

canonical Durable Object classes are `CoordinationObject` and
`OpenTofuRunnerObject`. Future class renames require a production-safe DO
migration plan; do not rely on state discard.

## デプロイ

```bash
# 1. dashboard SPA を build
cd takosumi/dashboard && bun install && bun run build

# 2. dry-run → deploy（ecosystem root から、docker が動いていること）
cd ../..  # ecosystem root
bunx wrangler deploy --dry-run --config takosumi-private/platform/wrangler.toml
bunx wrangler deploy --config takosumi-private/platform/wrangler.toml
```

## Secrets

値は `takosumi-private/.secrets/production/`（staging は `takosumi-private/.secrets/staging/`）に
1 ファイル 1 鍵で保管する（.gitignore により値は private repo にも commit されない）。
push は bulk JSON を一時生成して `wrangler secret bulk` し、JSON は即削除する。

鍵生成は operator-approved generator で行う。現行 script は
`takos/scripts/generate-platform-keys.ts` を利用できるが、出力先は必ず
operator vault にし、生成値を repo に commit しない。

必須 secret classes:

- accounts OIDC signing keypair
- pairwise subject / launch / export signing secrets
- internal accounts/control-plane bearer or handshake token, when the realized
  platform build enables bearer-gated internal control routes
- upstream OAuth provider secrets, after provider registration
- Stripe / payment processor secrets, only when hosted billing `enforce` is enabled
- operator default connection bootstrap credentials, only when plan/apply may mint
  provider credentials

現行実装の env 名には `TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_TOKEN` /
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` が残る場合があります。operations docs ではこれを
split service boundary ではなく、単一 platform worker 内の accounts/control-plane
bearer secret class として扱います。値は operator vault にだけ置き、public API
response、logs、docs、PR comment に出してはいけません。

未設定（運用 TODO）: `TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_*` / `TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_*`
（upstream OAuth app を登録して push するまで sign-in に使える provider が出ない）、Stripe、passkey。

## 動作確認

```bash
curl -s https://app.takosumi.com/healthz
curl -s https://app.takosumi.com/.well-known/openid-configuration | head -c 200  # issuer = bare origin
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/oauth/jwks       # 200
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/                 # 200 (dashboard SPA)
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/api/spaces       # 401
```

## 公開ゲート

`TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS = "closed"`（wrangler.toml の vars）の間、`/start` は
`launch_readiness_not_complete` の 503 を返す。公開時にこの var を変更して再デプロイ。

production で managed offering を開く前に、real Cloudflare substrate の hardening gate も通す:

| var | 内容 |
| --- | --- |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE` | `enforce` にすると evidence 不足時に internal gate が 503 |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF` | real Cloudflare Container smoke 証跡への `git+...#path` |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST` | 上記証跡の `sha256:<64hex>` |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF` | WfP outbound Worker / dispatch namespace egress enforcement 証跡への `git+...#path` |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST` | 上記証跡の `sha256:<64hex>` |

realized config (`takosumi-private/platform/wrangler.toml`) に non-fixture 値を入れた後、
operator bearer で確認する:

```bash
export TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME=TAKOSUMI_DEPLOY_CONTROL_TOKEN
export TAKOSUMI_CONTROL_PLANE_BEARER="$(cat "$TAKOSUMI_SECRETS/$TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME")"

curl -fsS \
  -H "Authorization: Bearer ${TAKOSUMI_CONTROL_PLANE_BEARER}" \
  https://app.takosumi.com/internal/platform/hardening-gates
```

`containerSmoke.ok` と `egressEnforcement.ok` が両方 `true` になるまで
`TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS = "open"` にしない。Container smoke は
Miniflare / local Docker ではなく、deployed `OpenTofuRunnerObject` が Cloudflare Container を起動し、
runner `/healthz` と operator-approved non-production OpenTofu fixture の plan/apply を通した証跡にする。
egress 証跡は dispatch namespace に outbound Worker が設定され、internal execution profile / policy
allowlist と同じ deny/allow 判断を live request で示したものにする。

`/internal/platform/hardening-gates` は operator-only internal route です。Run /
Connection / CapabilityBinding / credential mint の public contract ではありません。
