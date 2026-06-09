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
  public model は単一 Takosumi platform worker が Space / Source / Connection /
  Provider Templates / Provider Env Set / OpenTofu Capsule / Installation /
  InstallConfig / DeploymentProfile / ProviderBinding / Dependency / SourceSnapshot /
  DependencySnapshot / StateSnapshot / Run / RunGroup / OutputSnapshot /
  Deployment / Backup / UsageEvent / Billing / Activity を所有する。
- R2: `takosumi-source` / `takosumi-artifacts` / `takosumi-state` /
  `takosumi-backups`
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
push は `takosumi run secrets apply` で行う。CLI は secret 値を表示せず、
`wrangler secret put` の標準入力で Worker に渡す。

不足している safe generated secret は `apply` が operator vault に作成する。OIDC
signing key、secret-store passphrase、pairwise secret、provider credential は
protected/manual class として自動上書きしない。key material を作る場合は
operator-approved generator を使い、出力先は必ず operator vault にし、生成値を
repo に commit しない。

必須 secret classes:

- accounts OIDC signing keypair
- pairwise subject / launch / export signing secrets
- internal accounts/control-plane bearer or handshake token, when the realized
  platform build enables bearer-gated internal control routes
- upstream OAuth provider secrets, after provider registration
- Stripe / payment processor secrets, only when hosted billing `enforce` is enabled
- operator default Cloudflare connection bootstrap credentials, only when hosted
  managed default plan/apply may mint Cloudflare credentials
- Space Connection driver secrets for verified providers (AWS / GCP / GitHub /
  Kubernetes) are Space-owned Connection / SecretBlob material, not generic
  operator default bootstrap credentials
- User env set provider credentials are Space-owned and must be paired with
  provider env set policy, egress policy, and custom runner class evidence

現行 production platform worker の accounts/control-plane bearer secret は
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` だけです。値は operator vault にだけ置き、
public API response、logs、docs、PR comment に出してはいけません。

Cloudflare / AWS / GCP / GitHub / Kubernetes / Provider Env Set の provider
credential は、将来対応範囲が増えても raw Worker env として増やさない。Hosted
managed default に昇格した provider は operator default Connection + sealed
SecretBlob / Vault material として管理し、Space 用 provider は Space-owned
Connection / SecretBlob として管理する。runner へは plan / apply / destroy の
credential mint phase で run / phase / provider scoped credential だけを渡す。
つまり production Worker secrets の一覧に `AWS_ACCESS_KEY_ID`、
`GOOGLE_APPLICATION_CREDENTIALS`、provider-specific API token などを直接追加する
ことはしない。

Operator default provider credential は CLI で Connection として登録する。例:

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_SECRETS/TAKOSUMI_DEPLOY_CONTROL_TOKEN")"

# token body は repo 外の operator vault path に置く。CLI は値を表示しない。
takosumi run connections set-cloudflare-token \
  --api-token-file "$TAKOSUMI_PRIVATE/.secrets/provider/cloudflare-api-token" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --default cloudflare

takosumi run connections defaults list
```

AWS / GCP / その他 provider を将来 hosted managed default に昇格する場合も同じ
形にする。credential file は repo 外、登録先は Connection / SecretBlob、default
化は `connections defaults set <provider> <connection-id>` で行う。

platform Worker secret の確認と適用:

```bash
takosumi run secrets status
takosumi run secrets apply
takosumi run secrets apply --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
```

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

| var                                                   | 内容                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE`                  | `enforce` にすると evidence 不足時に internal gate が 503                                                                                                                    |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF`    | real Cloudflare Container smoke 証跡への commit-pinned `git+...@<commit>#path`                                                                                               |
| `TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST` | 上記証跡の `sha256:<64hex>`                                                                                                                                                  |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF`            | WfP outbound Worker / dispatch namespace egress enforcement 証跡への commit-pinned `git+...@<commit>#path`                                                                   |
| `TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST`         | 上記証跡の `sha256:<64hex>`                                                                                                                                                  |
| `TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF`              | Cloudflare managed-default / provider env set provider / Provider Env Set policy evidence                                                                                  |
| `TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST`           | 上記証跡の `sha256:<64hex>`                                                                                                                                                  |
| `TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF`               | provider credentials / control-plane tokens / state backend credentials が diagnostics、audit payload、OutputSnapshot、tenant Worker bindings に漏れないことの live evidence |
| `TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST`            | 上記証跡の `sha256:<64hex>`                                                                                                                                                  |

operator は4証跡を `takosumi.production-hardening-evidence@v1` manifest にまとめ、repo 側 validator で
shape、coverage、commit-pinned evidence ref、証跡ファイル本体の digest を確認してから realized config へ反映する:

```bash
cd takosumi
mkdir -p "$TAKOSUMI_PRIVATE/evidence"
bun run production-hardening:evidence -- --print-template \
  > "$TAKOSUMI_PRIVATE/evidence/production-hardening.json"

# 4つの evidence/*.md を実証結果で埋め、evidence ref の commit / run ID /
# state/output ID 等を実値に置き換える。その後、digest を自動反映して検証する。
bun run production-hardening:evidence -- --update-digests \
  "$TAKOSUMI_PRIVATE/evidence/production-hardening.json"
```

validator は証跡ファイル本文の意味解析はしない。operator が manifest に記録した structured evidence claim と、
commit-pinned evidence ref、証跡ファイル本体の digest 一致を fail-closed に検証する。validator は以下を fail-closed にする:

- evidence ref が commit-pinned `git+...@<commit>#path` ではない、または fixture / todo / localhost を指す
- evidence ref の `#path` が operator evidence root 内のファイルとして読めない、または `evidenceDigest` と一致しない
- digest が `sha256:<64hex>` ではない
- manifest の Cloudflare Container smoke claim が live `OpenTofuRunnerObject` の `/healthz` と non-production provider
  apply 成功を記録していない
- manifest の egress claim が outbound Worker の allow / deny 両 probe を記録していない
- manifest の Provider Template claim が Cloudflare managed default、AWS/GCP/GitHub/Kubernetes provider env set provider、
  Provider Env Set の egress / runner policy gate を記録していない
- manifest の secret-boundary claim が runner diagnostics、failure audit payload、OutputSnapshot、tenant Worker bindings の
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

`containerSmoke.ok` / `egressEnforcement.ok` / `providerTemplates.ok` /
`secretBoundary.ok` がすべて `true` になるまで
`TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS = "open"` にしない。Container smoke は
Miniflare / local Docker ではなく、deployed `OpenTofuRunnerObject` が Cloudflare Container を起動し、
runner `/healthz` と operator-approved non-production OpenTofu fixture の plan/apply を通した証跡にする。
egress 証跡は dispatch namespace に outbound Worker が設定され、operator-internal execution boundary / policy
allowlist と同じ deny/allow 判断を live request で示したものにする。
Provider Template evidence は Cloudflare managed-default credential source/default eligibility、AWS/GCP/GitHub/Kubernetes
provider-template policy、Provider Env Set の egress / runner policy gate を含める。
Secret boundary evidence は live runner diagnostics、failure audit payload、OutputSnapshot projection、tenant Worker
bindings のいずれにも provider credentials、Deploy Control tokens、state backend credentials が出ないことを示す。

`/internal/platform/hardening-gates` は operator-only internal route です。Run /
Connection / ProviderBinding / credential mint の public contract ではありません。
