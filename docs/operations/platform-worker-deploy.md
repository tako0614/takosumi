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
- D1 control ledger: accounts plane と control plane の ledger。Cloudflare realized
  config では account-plane DB と control-plane DB を別 binding にしてもよいが、
  primary public model は単一 Takosumi platform worker が Workspace / Project / Capsule / Source /
  ProviderConnection / ProviderBinding / Run / StateVersion / Output / AuditEvent を所有する。
  CredentialRecipe / Source identity / output-to-input dependency evidence / Backup / UsageEvent / Billing は
  supporting resource / evidence として同じ platform worker が扱う。
- R2: `takosumi-source` / `takos-artifacts` / `takosumi-state` /
  `takosumi-backups`
- queue: `takosumi-runs` / `takosumi-runs-dlq`
- container: `OpenTofuRunnerObject`（`takosumi/runner/Dockerfile`、docker 必須）

canonical bindings:

- `TAKOSUMI_ACCOUNTS_DB`
- `TAKOSUMI_CONTROL_DB`
- `R2_SOURCE`
- `R2_ARTIFACTS`
- `R2_STATE`
- `R2_BACKUPS`
- `RUN_QUEUE`
- `COORDINATION`
- `RUN_OWNER`
- `RUNNER`

canonical Durable Object classes are `CoordinationObject` and
`OpenTofuRunOwnerObject` and `OpenTofuRunnerObject`. Future class renames
require a production-safe DO migration plan; do not rely on state discard.

## デプロイ

本番 `app.takosumi.com` を最初の real-cloud 検証先にしない。先に
[`real-cloud-staging.md`](./real-cloud-staging.md) の staging cell
(`https://app-staging.takosumi.com`) をデプロイし、platform probe、Layer 1
Cloudflare smoke、Layer 2 platform-control-plane smoke、rollback / restore
rehearsal を通してから production closed deploy に進む。

```bash
# 1. dashboard SPA を build
cd takosumi/dashboard && bun install && bun run build

# 2. deploy host preflight（ecosystem root から、wrangler deploy を走らせる同じhostで）
cd ../..  # ecosystem root
bun run prepare:cloudflare-deploy-host
export TAKOSUMI_BUILDX_BUILDER="takosumi-remote"
export WRANGLER_DOCKER_BIN="$PWD/scripts/wrangler-docker-buildx-wrapper.sh"
bun run check:cloudflare-deploy-host

# 3. staging dry-run → deploy
bunx wrangler@latest deploy --dry-run --config takosumi-private/platform/wrangler.staging.toml
bunx wrangler@latest deploy --config takosumi-private/platform/wrangler.staging.toml

# 4. production closed dry-run → deploy
bunx wrangler@latest deploy --dry-run --config takosumi-private/platform/wrangler.toml
bunx wrangler@latest deploy --config takosumi-private/platform/wrangler.toml
```

Worker-only deploy で `takosumi/runner/Dockerfile` と runner inputs を変更していない
場合に限り、既存の local runner image tag を再利用して Wrangler の container
rebuild/load を避けられる:

```bash
export TAKOSUMI_REUSE_EXISTING_CONTAINER_IMAGE=1
```

この env は operator の明示 opt-in。runner image を変更した deploy では設定せず、
通常の buildx build を走らせる。Wrangler が immutable tag
(`takosumi-opentofurunnerobject:<version>`) を要求した場合、wrapper は同じ
repository の既存 `:worker` image からその tag を作って build を skip する。

`check:cloudflare-deploy-host` は Docker/buildx が Wrangler の Cloudflare
Containers build path に耐えるかを確認する operator preflight。デフォルトの
`docker run --rm hello-world` が AppArmor で落ち、`--security-opt
apparmor=unconfined` 付きだけ通る host では `wrangler deploy` を実行しない。
同時に Wrangler 4.103.0 以上を確認する。古い Wrangler は Worker script upload
と image push が通っても、最後の Cloudflare Containers application finalize で
`Unauthorized` になることがあるため、real deploy は `bunx wrangler@latest ...`
で実行する。
Wrangler の内部 Container build はその security option を直接受け取れないため、
`prepare:cloudflare-deploy-host` が起動する privileged BuildKit remote builder と
`WRANGLER_DOCKER_BIN` wrapper で `docker build` を `docker buildx build --builder
takosumi-remote` に逃がす。これでも preflight が落ちる場合は、別 deploy host / CI
で build するか、Cloudflare registry image URI 方式に切り替える。

prebuilt image に切り替える場合は、Docker が正常な host で runner image を build
して Cloudflare registry に push し、operator-private realized config だけを変更する:

```bash
docker buildx build --load --platform linux/amd64 --provenance=false \
  -t takosumi-runner:<tag> \
  -f takosumi/runner/Dockerfile \
  takosumi

bunx wrangler@latest containers push takosumi-runner:<tag>
```

```toml
[[containers]]
class_name = "OpenTofuRunnerObject"
image = "registry.cloudflare.com/<account-id>/takosumi-runner:<tag>"
# image_build_context は Dockerfile path build のときだけ使う。
```

## Secrets

値は `takosumi-private/.secrets/production/`（staging は `takosumi-private/.secrets/staging/`）に
1 ファイル 1 鍵で保管する（.gitignore により値は private repo にも commit されない）。
push は `takosumi secrets apply` で行う。CLI は secret 値を表示せず、
`wrangler secret put` の標準入力で Worker に渡す。

不足している rotate-safe generated secret は通常の `apply` が operator vault に作成する。
OIDC signing key、secret-store passphrase、pairwise secret、upstream OAuth subject secret は protected key なので、
初回 vault 作成時だけ `--init-protected` を明示する。既存 protected key は上書きしない。
staging / production の vault を先に作るだけなら `--local-only` を併用し、`wrangler secret put`
は deploy host / target config が決まってから実行する。provider credential は Worker secret
ではなく ProviderConnection / SecretBlob として扱う。

必須 secret classes:

- accounts OIDC signing keypair
- optional public-only previous OIDC signing JWKS during key rotation overlap
- pairwise subject / launch / export signing secrets
- internal accounts/control-plane bearer or handshake token, when the realized
  platform build enables bearer-gated internal control routes
- upstream OAuth provider secrets, after provider registration
- Stripe / payment processor secrets, only when hosted billing `enforce` is enabled
- Workspace-owned Provider Connection secrets for policy-bound user/operator-managed providers (AWS /
  GitHub / Kubernetes and custom providers) are Workspace-owned ProviderConnection /
  SecretBlob material, not generic Gateway bootstrap credentials. GCP
  remains reserved until verify / mint drivers are wired.
- Generic-env provider credentials are Workspace-owned and must be paired with
  secret-backed provider policy, egress policy, and custom runner class evidence

現行 production platform worker の accounts/control-plane bearer secret は
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` です。加えて account session を安全に保存・検証するため
`TAKOSUMI_ACCOUNT_SESSION_HASH_SALT` を必ず設定します。値は operator vault にだけ置き、
public API response、logs、docs、PR comment に出してはいけません。

Cloudflare / AWS / GitHub / Kubernetes / custom ProviderConnection の provider
credential は、将来対応範囲が増えても generic raw Worker env として増やさない。
Workspace 用 provider は Workspace-owned ProviderConnection / SecretBlob として管理する。
runner へは plan / apply / destroy の
credential mint phase で run / phase / provider scoped credential だけを渡す。
つまり production Worker secrets の一覧に `AWS_ACCESS_KEY_ID`、
`GOOGLE_APPLICATION_CREDENTIALS`、provider-specific API token などを直接追加する
ことはしない。

Cloud extension OAuth introspection client は Service Graph runtime token
検証にも使う。公式 Cloud では、非 secret var として
`TAKOSUMI_ACCOUNTS_CLIENT_SERVICE_GRAPH_TOKEN_INTROSPECTION="enabled"` を
platform worker config に設定する。この flag は secret を持つ confidential
client でだけ有効にでき、`tokenEndpointAuthMethod="none"` の public client では
設定エラーにする。これにより `/gateway/ai/v1/*` は `taksrv_...` Service Graph
token を `ai.model` + endpoint scope で検証し、closed AI Gateway worker へは
raw bearer を渡さず pre-auth context だけを渡す。
通常のOAuth clientはこの例外を持たず、他client発行tokenをintrospectできない。

Cloud-only WfP / AI / managed resource usage の顧客向け単価は
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK` に置く。これは secret ではないが、production
の billing behavior を決める operator config なので `takosumi-private` の realized
platform config を正本にする。価格表、無料枠、最低粗利 guard は
[`cloud-pricing.md`](cloud-pricing.md) を参照する。

Operator default provider credential は CLI で Connection として登録する。例:

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_SECRETS/TAKOSUMI_DEPLOY_CONTROL_TOKEN")"

# token body は repo 外の operator vault path に置く。CLI は値を表示しない。
takosumi connections set-cloudflare-token \
  --api-token-file "$TAKOSUMI_PRIVATE/.secrets/provider/cloudflare-api-token" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID"
```

AWS / GCP / その他 provider を追加する場合も credential file は repo 外に置き、
dashboard/API の ProviderConnection flow で扱う。OSS platform worker は Compatibility
Gateway や managed resource backend を公開しません。

platform Worker secret の確認と適用:

```bash
# 初回 vault 初期化。値は local operator vault にだけ作り、remote Worker へは push しない。
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS" \
  --init-protected \
  --local-only

# remote Worker secret 名と local vault を確認する。
takosumi secrets status \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS"

# deploy target が確定した後に remote Worker へ push する。
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS"

takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS" \
  --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

`status` は local operator vault と remote Worker secret 名だけを比較し、値は表示しない。
Stripe は Cloudflare platform worker では
`TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY` / `TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET`、node-postgres profile では
`TAKOSUMI_ACCOUNTS_STRIPE_API_KEY` / `TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET` を読む。
usage invoice item 同期を有効にする場合は、非 secret の
`TAKOSUMI_STRIPE_USAGE_INVOICE_ITEM_PRICES` に meter / unit / unitAmount /
currency の JSON 配列を設定し、operator-only secret の
`TAKOSUMI_ACCOUNTS_BILLING_USAGE_SYNC_TOKEN` を入れる。同期 route は
`POST /v1/billing/stripe/usage-invoice-items` で、
`x-takosumi-billing-usage-sync-token` が必要。

Google sign-in is configured through `TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_*`.
Production readiness probes must show the provider as enabled before GA.
built-in Google sign-in is enabled only when `CLIENT_ID` / `CLIENT_SECRET` /
`REDIRECT_URI` are all present. Google OAuth app は application type
`Web application` で作成し、authorized JavaScript origin には platform
origin、authorized redirect URI には `https://<platform-origin>/sign-in/callback`
だけを登録する。`/v1/auth/upstream/callback` は SPA が同一 origin で呼ぶ
backend completion endpoint で、外部 OAuth provider の redirect target にはしない。
Stripe、passkey。

Pre-GA の公式 Cloud origin (`https://app-staging.takosumi.com` /
`https://app.takosumi.com`) は、コード側で
`shoutatomiyama0614@gmail.com` の verified Google account だけに固定する。
`TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST="*"` や別メールの env を入れても
公式 Cloud では解除されない。self-host / local-substrate の operator origin
だけが `TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST` を operator policy として使える。

Google OAuth の非 secret 値は operator-private realized config の `[vars]` にだけ入れる:

```toml
# staging
TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID = "<google-web-client-id>"
TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_REDIRECT_URI = "https://app-staging.takosumi.com/sign-in/callback"

# production
TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID = "<google-web-client-id>"
TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_REDIRECT_URI = "https://app.takosumi.com/sign-in/callback"
```

`TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET` は `wrangler.toml` に書かない。
operator vault の secret file と Worker secret にだけ置く。

Google OAuth app で client secret を表示できたら、値を shell history や transcript に残さず
operator vault に書く。`write:takosumi-oauth-secret` は realized config の `CLIENT_ID` / `REDIRECT_URI`
を検証し、`CLIENT_SECRET` file を `0600` で作る。secret 値は出力しない。

```bash
# secret を直接表示しない editor flow
bun run write:takosumi-oauth-secret -- \
  --environment production \
  --provider google \
  --edit

# staging は別 OAuth app / 別 client secret を使う
bun run write:takosumi-oauth-secret -- \
  --environment staging \
  --provider google \
  --edit

# path だけ確認したい場合
bun run write:takosumi-oauth-secret -- \
  --environment production \
  --provider google \
  --dry-run
```

secret file 作成後は sign-in scope だけを先に確認し、問題なければ remote Worker secret へ push する。

```bash
bun run check:takosumi-live-evidence-prereqs -- \
  --environment both \
  --scope sign-in

cd takosumi
bun run cli -- secrets status \
  --config ../takosumi-private/platform/wrangler.toml \
  --secrets-dir ../takosumi-private/.secrets/production
bun run cli -- secrets apply \
  --config ../takosumi-private/platform/wrangler.toml \
  --secrets-dir ../takosumi-private/.secrets/production
```

## 動作確認

```bash
TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
  bun run probe:takosumi-live-state -- \
    --base-url https://app-staging.takosumi.com \
    --expected-issuer https://app-staging.takosumi.com \
    --json

TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/production/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
  bun run probe:takosumi-live-state -- \
    --base-url https://app.takosumi.com \
    --expected-issuer https://app.takosumi.com \
    --json
```

The probe checks `/`, JSON `ok:true` from `/healthz` and `/readyz`, OIDC
discovery issuer, same-origin JWKS with at least one public JWK,
unauthenticated control-plane API gate, dashboard
`/install?git=...&ref=...&path=...` prefill reachability, and the
operator-bearer hardening gate without printing the bearer token. Use
`--require-ready` only when production hardening is meant to be enforced.

Cloud-only extension worker smoke は account session token を使うが、証跡には
token / cookie / token file path を保存しない。通常の deploy smoke は endpoint
mount、platform-side session auth、Cloud extension catalog、AI Gateway、
Cloudflare compatibility envelope、および Cloudflare Workers script の
`PUT -> GET -> DELETE` lifecycle を確認する。
AI Gateway status が `workers_ai_fallback` の場合、基礎の managed AI は
動作しているが、明示 profile としてはまだ固定されていない。Production Cloud
AI Gateway は `openai_compatible` または `workers_ai_binding` の profile を
少なくとも1つ設定する。sandbox 完結の推奨形は Cloudflare AI Gateway REST API
と Unified Billing の `openai_compatible` profile で、`apiKeyEnv` には
`TAKOSUMI_AI_GATEWAY_CLOUDFLARE_API_TOKEN` を使う。DeepSeek / Z.AI GLM /
Gemini / OpenAI などを direct/BYOK provider として Takosumi が直接持つ場合だけ、
provider-specific upstream key を repo 外の operator secret に置く。外部
provider を Cloud の提供機能として告知する release では、明示 profile と
operator-held credential を設定したうえで `--require-ai-upstream-profile` を付ける。
Cloudflare Unified Billing を sandbox / default AI 経路にする場合は
`--require-ai-cloudflare-unified-billing-profile` も付ける。AI Gateway の
請求証跡まで GA 判定に含める場合は、Service Graph runtime token 経由の
chat/embeddings 呼び出し後に対象 Workspace の usage ledger を読み、
同じ Installation の `resource_meter` / `ai_request` event が増えたことを
`--require-ai-usage-ledger` で必須化する。
Cloudflare Workers script materialization がまだ 501 の場合、script は `status: "passed"` でも
`gaReady: false` と `cloudflare_compat_materialization_not_enabled` gap を出す。
GA 判定では `--require-compat-materialization` と `--require-provider-e2e`
を必ず付け、501 と OpenTofu provider の `init -> plan -> apply -> destroy`
不成立を失敗にする。Cloudflare Compatibility Gateway の請求証跡まで GA 判定に
含める場合は、compat lifecycle / provider E2E 後に対象 Workspace の usage
ledger を読み、`resource_meter` / `gateway_compute` または
`gateway_storage_gb_hour` event が増えたことを
`--require-cloudflare-compat-usage-ledger` で必須化する。

```bash
cd takosumi

# mounted Cloud-only extension smoke: deploy 後の reachability/auth/AI/compat-list 確認
bun run smoke:cloud-extensions -- \
  --url https://app.takosumi.com \
  --session-token-file ../takosumi-private/.secrets/production/TAKOSUMI_ACCOUNT_SESSION_TOKEN \
  --platform-version <wrangler-platform-version-id> \
  --ai-gateway-version <wrangler-ai-gateway-version-id> \
  --cloudflare-compat-version <wrangler-cloudflare-compat-version-id> \
  --out-file ../takosumi-private/evidence/cloud-extension-smoke-production.json \
  --json

# GA strict: Cloudflare Compatibility Gateway materialization / provider E2E / usage ledger
bun run smoke:cloud-extensions -- \
  --url https://app.takosumi.com \
  --session-token-file ../takosumi-private/.secrets/production/TAKOSUMI_ACCOUNT_SESSION_TOKEN \
  --require-compat-materialization \
  --require-provider-e2e \
  --require-cloudflare-compat-usage-ledger \
  --cloudflare-compat-usage-workspace-id <workspace-id> \
  --cloudflare-compat-usage-installation-id <compat-installation-id> \
  --json

# GA strict + external AI upstream claim only:
bun run smoke:cloud-extensions -- \
  --url https://app.takosumi.com \
  --session-token-file ../takosumi-private/.secrets/production/TAKOSUMI_ACCOUNT_SESSION_TOKEN \
  --require-compat-materialization \
  --require-provider-e2e \
  --require-ai-upstream-profile \
  --require-ai-cloudflare-unified-billing-profile \
  --require-ai-service-graph-token \
  --ai-service-installation-id <ai-gateway-installation-id> \
  --require-ai-usage-ledger \
  --ai-usage-workspace-id <workspace-id> \
  --require-cloudflare-compat-usage-ledger \
  --cloudflare-compat-usage-workspace-id <workspace-id> \
  --cloudflare-compat-usage-installation-id <compat-installation-id> \
  --json
```

## 公開ゲート

`TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS = "closed"`（wrangler.toml の vars）の間、Stripe checkout と
platform-cell の materialize は `launch_readiness_not_complete` の 503 を返す。公開時にこの var を変更して再デプロイ。
これは Stripe checkout と platform-cell materialize だけの公開ゲート。OIDC / PAT / upstream OAuth /
Capsule / Run / StateVersion / rollback / export は通常の session・Workspace 権限で動き続ける。

GA 前の運営 readiness drill は例外的に `TAKOSUMI_DEPLOY_CONTROL_TOKEN` 相当の operator token を専用ヘッダーで渡し、
customer-facing 公開ゲートだけを越える。これは account session / Installation ownership / idempotency /
cost acknowledgement / permission digest を bypass しない。

```bash
cd takosumi
TAKOSUMI_ACCOUNTS_TOKEN="$(< ../takosumi-private/.secrets/production/TAKOSUMI_ACCOUNT_SESSION_TOKEN)" \
  bun run cli -- internal installations materialize <scratchInstallationId> \
    --accounts-url https://app.takosumi.com \
    --mode dedicated \
    --region <dedicatedRegion> \
    --compute <computePlan> \
    --database <databasePlan> \
    --object-store <objectStorePlan> \
    --cutover-strategy blue-green \
    --drain-seconds <drainSeconds> \
    --cost-ack \
    --idempotency-key <materializeIdempotencyKey> \
    --drill-token-file ../takosumi-private/.secrets/production/TAKOSUMI_DEPLOY_CONTROL_TOKEN \
    --json
```

## takos.jp からの public install 導線

Takos の public hosted CTA は `takos.jp` から platform worker の dashboard prefill route へ向ける:

```txt
https://app.takosumi.com/install?git=https://github.com/tako0614/takos.git&ref=<release-tag-or-commit>&path=deploy/opentofu
```

`/install` は server-side install API ではなく、dashboard SPA が query を `/new` に引き継ぐ client-handled prefill route。
ユーザーは sign-in、Workspace 選択、compatibility check、ProviderConnection review、plan review、apply confirmation を通る。

公開前に operator は次を確認する:

- `takos/website` build が `VITE_TAKOS_INSTALL_REF=<release-tag-or-commit>` を使い、moving ref (`main` / `latest` / `HEAD`)
  を public CTA に出していない
- `takos/website` は Cloudflare Pages project `takos-landing` に deploy され、custom domain `takos.jp` と
  `www.takos.jp` が Pages 側で `active` になっている
- `takos.jp` / `www.takos.jp` の DNS は Pages target `takos-landing.pages.dev` に向いている。既存の placeholder
  `A 192.0.2.1` や wildcard fallback に吸われて 522 になっていない
- `takos.jp` の CTA が `https://app.takosumi.com/install?...` だけを指し、retired accounts/deploy-control host を使っていない
- `app.takosumi.com/install?...` が dashboard `/new` に query を保持して到達し、Git URL / ref / module path が prefill される
- compatibility check から plan / apply / StateVersion / Output / launch URL まで、scratch Workspace で 1 回通る
- `TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS = "open"` は、下記 production hardening gate と launch readiness evidence が
  accepted になった後だけ設定する
- launch readiness の private JSON が未完成な間は、root から
  `bun run status:takosumi-readiness-gaps -- --file "$TAKOSUMI_PRIVATE/evidence/platform-readiness-production.json"`
  を実行し、`launch-readiness validate --json` の `gapDetails` を domain / rehearsal / structured field 単位に分解してから
  証跡を集める。これは補助 report であり、`ready:true` や public summary accepted の代替にはしない

operator の public CTA smoke:

```bash
cd takos/website
npm run build
wrangler pages deploy .output/public --project-name takos-landing

node --input-type=module <<'NODE'
for (const url of ['https://takos.jp/', 'https://www.takos.jp/']) {
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const installLinks = [
    ...text.matchAll(/https:\/\/app\.takosumi\.com\/install\?[^"'<>\\s)]+/g),
  ].map((match) => match[0].replaceAll('&amp;', '&'));
  console.log(JSON.stringify({
    url,
    status: res.status,
    hasMovingRef: text.includes('ref=main') || text.includes('ref=latest') || text.includes('ref=HEAD'),
    installLinks: installLinks.slice(0, 3),
  }, null, 2));
}
NODE
```

Then open the first CTA in a browser and confirm it lands on
`https://app.takosumi.com/new?...` or the sign-in return URL with the same Git
URL, pinned ref, and `path=deploy/opentofu`.

production で hosted Takosumi access を開く前に、real Cloudflare substrate の hardening gate も通す。`observe` は gate JSON
を返す診断モードで、証跡不足でも internal gate は 503 にしない。ただし hosted Takosumi access の `open` は `observe` では拒否され、
`TAKOSUMI_PRODUCTION_HARDENING_GATE = "enforce"` と 7 証跡すべての ref / digest が必要。

| var                                                     | 内容                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE`                    | `observe` は診断のみ。`enforce` にすると evidence 不足時に internal gate が 503 になり、hosted Takosumi access `open` の必須条件になる                               |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF`      | real Cloudflare Container smoke 証跡への commit-pinned `git+...@<commit>#path`                                                                                       |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST`   | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF`    | Layer 2 platform control-plane smoke (install → plan → apply → deployment verify → destroy) 証跡への commit-pinned `git+...@<commit>#path`                           |
| `TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST` | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF`              | runner egress enforcement 証跡への commit-pinned `git+...@<commit>#path`                                                                                             |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST`           | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF`               | platform control-plane backup / restore rehearsal 証跡への commit-pinned `git+...@<commit>#path`                                                                     |
| `TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST`            | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF`                | ProviderConnection policy / CredentialRecipe / generic-env / internal resolver evidence                                                                              |
| `TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST`             | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF`                | `takosumi/deploy/observability/grafana/takosumi-cost-attribution.json` provision / fresh sample evidence への commit-pinned `git+...@<commit>#path`                  |
| `TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST`             | 上記証跡の `sha256:<64hex>`                                                                                                                                          |
| `TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF`                 | provider credentials / control-plane tokens / state backend credentials が diagnostics、audit payload、Output、tenant Worker bindings に漏れないことの live evidence |
| `TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST`              | 上記証跡の `sha256:<64hex>`                                                                                                                                          |

Prometheus scrape を使う operator は `TAKOSUMI_METRICS_SCRAPE_TOKEN` を secret として push する。
platform worker は `/metrics` を in-process deploy-control service へ転送し、 token 未設定時は dashboard SPA に
fall back せず fail-closed にする。Deploy overview evidence はこの scrape token か operator monitoring system の
同等 credential で取得した production fresh sample を根拠にする。

operator は7証跡を `takosumi.production-hardening-evidence@v1` manifest にまとめ、repo 側 validator で
shape、coverage、commit-pinned evidence ref、証跡ファイル本体の digest を確認してから realized config へ反映する:

```bash
cd takosumi
mkdir -p "$TAKOSUMI_PRIVATE/evidence"
bun run production-hardening:evidence -- --print-template \
  > "$TAKOSUMI_PRIVATE/evidence/production-hardening.json"

# 7つの evidence/*.md を実証結果で埋め、evidence ref の commit / run ID /
# state/output ID / backup ID / cost dashboard sample 等を実値に置き換える。
# その後、digest を自動反映して検証する。
bun run production-hardening:evidence -- --update-digests \
  "$TAKOSUMI_PRIVATE/evidence/production-hardening.json"
```

`TAKOSUMI_RELEASE_ACTIVATOR_URL` を設定して post-apply app publication を有効化する場合は、
hardening evidence とは別に release activation evidence も必須にする。これは platform open の証跡ではなく、
optional materializer が apply ledger から独立して成功/失敗を記録できることの証跡:

```bash
cd takosumi
bun run operator:release-activator -- serve \
  --source-bucket "$TAKOSUMI_RELEASE_SOURCE_BUCKET" \
  --wrangler-config "$TAKOSUMI_RELEASE_WRANGLER_CONFIG"

bun run release-activation:evidence -- --print-template \
  > "$TAKOSUMI_PRIVATE/evidence/release-activation.json"

# successful activation / failed or pending activation surfacing /
# ledger independence / payload boundary の4証跡を live 値で埋める。
bun run release-activation:evidence -- --update-digests \
  "$TAKOSUMI_PRIVATE/evidence/release-activation.json"
```

`release-activation:evidence` の出力 `env` に含まれる4組の
`TAKOSUMI_RELEASE_ACTIVATION_*_EVIDENCE_REF` / `_DIGEST` を realized config
へ反映する。`TAKOSUMI_RELEASE_ACTIVATOR_URL` が設定されている場合、
platform readiness `open` はこれらの証跡と
`TAKOSUMI_RELEASE_ACTIVATOR_TOKEN` が欠けると fail-closed する。

validator は以下を fail-closed にする:

- release activation 証跡 ref が commit-pinned `git+...@<commit>#path` ではない、または fixture / todo / localhost を指す
- successful activation が `takosumi.operator.release-activation@v1` payload、`succeeded` status、public launch URL、200 health check を記録していない
- failure surfacing が Activity と run timeline の両方に failed/pending activation を記録していない
- apply ledger / StateVersion / Output / Deployment が release activation status によって rollback されないことを示していない
- captured payload / evidence が provider credentials、runner env、secret outputs、release activator token を含まないことを示していない

validator は証跡ファイル本文の意味解析はしない。operator が manifest に記録した structured evidence claim と、
commit-pinned evidence ref、証跡ファイル本体の digest 一致を fail-closed に検証する。validator は以下を fail-closed にする:

- evidence ref が commit-pinned `git+...@<commit>#path` ではない、または fixture / todo / localhost を指す
- evidence ref の `#path` が operator evidence root 内のファイルとして読めない、または `evidenceDigest` と一致しない
- digest が `sha256:<64hex>` ではない
- manifest の Cloudflare Container smoke claim が live `OpenTofuRunnerObject` の `/healthz` と non-production provider
  apply 成功を記録していない
- manifest の Layer 2 claim が ProviderConnection resolution、scratch Capsule、plan、apply、StateVersion / Output verify、destroy
  を platform API 経由で記録していない
- manifest の egress claim が outbound Worker の allow / deny 両 probe を記録していない
- manifest の restore rehearsal claim が isolated recovery / staging restore、control ledger、StateVersion、
  Output、audit chain verification を記録していない
- manifest の ProviderConnection policy / CredentialRecipe claim が Cloudflare / AWS / GCP service-account JSON /
  GitHub / Kubernetes ProviderConnections、provider allowlist、internal resolver の egress / runner policy gate、
  GCP OAuth / impersonation reserved-helper status を記録していない
- manifest の cost attribution claim が Takosumi cost-attribution dashboard JSON、required metrics / labels、fresh sample、
  unattributed spend threshold を記録していない
- manifest の secret-boundary claim が runner diagnostics、failure audit payload、Output、tenant Worker bindings の
  全 leak target と provider credentials / Deploy Control tokens / state backend credentials の全 secret class を記録していない

realized config (`takosumi-private/platform/wrangler.toml`) に non-fixture 値を入れた後、
operator bearer で確認する。`production-hardening:gates` は live internal gate を直接取得できるため、
公開前の標準確認では curl で中間 JSON を手作業保存しない:

```bash
export TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME=TAKOSUMI_DEPLOY_CONTROL_TOKEN
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_SECRETS/$TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME")"

bun run production-hardening:gates -- \
  "$TAKOSUMI_PRIVATE/evidence/production-hardening.json" \
  --url https://app.takosumi.com/internal/platform/hardening-gates \
  --require-enforced
```

Public docs には private manifest path / gate URL / evidence ref を貼らず、同じ verifier の public-safe row だけを使う:

```bash
bun run production-hardening:gates -- \
  "$TAKOSUMI_PRIVATE/evidence/production-hardening.json" \
  --url https://app.takosumi.com/internal/platform/hardening-gates \
  --require-enforced \
  --markdown-row
```

監査用に gate response JSON も保存したい場合だけ、file mode verifier を使う:

```bash
curl -fsS \
  -H "Authorization: Bearer ${TAKOSUMI_DEPLOY_CONTROL_TOKEN}" \
  https://app.takosumi.com/internal/platform/hardening-gates \
  > "$TAKOSUMI_PRIVATE/evidence/hardening-gates.json"

bun run production-hardening:gates -- \
  "$TAKOSUMI_PRIVATE/evidence/production-hardening.json" \
  "$TAKOSUMI_PRIVATE/evidence/hardening-gates.json" \
  --require-enforced
```

`containerSmoke.ok` / `platformControlPlaneSmoke.ok` / `egressEnforcement.ok` /
`restoreRehearsal.ok` / `providerCatalog.ok` / `costAttribution.ok` /
`secretBoundary.ok` がすべて `true` になるまで
`TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS = "open"` にしない。Container smoke は
Miniflare / local Docker ではなく、deployed `OpenTofuRunnerObject` が Cloudflare Container を起動し、
runner `/healthz` と operator-approved non-production OpenTofu fixture の plan/apply を通した証跡にする。
Layer 2 smoke は signed-in user path と同じ platform control-plane loop で scratch Workspace に
`cloudflare-hello-worker` Capsule を作成し、ProviderConnection resolution、Capsule Gate、policy、StateVersion / Output、
provider API verify、destroy verify を通した証跡にする。
egress 証跡は operator-internal execution boundary / policy allowlist と同じ deny/allow 判断を live request で示したものにする。
restore rehearsal evidence は production を上書きしない isolated recovery / staging target で control ledger、
StateVersion、Output、audit chain を検証したものにする。
ProviderConnection policy / CredentialRecipe evidence は Cloudflare / AWS / GCP service-account JSON / GitHub /
Kubernetes provider allowlist policy、GCP OAuth / impersonation reserved-helper status、ProviderConnection の egress /
runner policy gate を含める。
Cost attribution evidence は `takosumi/deploy/observability/grafana/takosumi-cost-attribution.json` が provision され、
`takosumi_cloud_spend_cents_total` / `takosumi_usage_credits_total` /
`takosumi_installation_usage_units_total` の fresh sample と required labels を示すものにする。
Deploy overview evidence は `takosumi/deploy/observability/grafana/takosumi-deploy-overview.json` が provision
され、 `takosumi_deploy_operation_count` / `takosumi_apply_duration_seconds_bucket` /
`takosumi_runner_queue_age_seconds` / `takosumi_runner_active_runs` /
`takosumi_runner_container_startup_seconds_bucket` / `takosumi_api_request_duration_seconds_bucket` /
`takosumi_oidc_request_count` の fresh sample と `environment` / `runtime_cell_id` / `space_id` /
`capsule_id` / `operationKind` / `status` labels を示すものにする。dashboard artifact の shape は
root の `bun run check:takosumi-observability-artifacts` で検証し、production readiness の
`metric-labels` / `dashboard-link` は artifact だけではなく operator environment で provision 済みの
dashboard ref と production sample evidence で埋める。
Secret boundary evidence は live runner diagnostics、failure audit payload、Output projection、tenant Worker
bindings のいずれにも provider credentials、Deploy Control tokens、state backend credentials が出ないことを示す。

`/internal/platform/hardening-gates` は operator-only hardening route family です。Run /
ProviderConnection / credential mint の public contract ではありません。
