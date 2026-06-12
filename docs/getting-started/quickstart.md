# Quickstart

この手順は local Takosumi service に対して、Space 直下の OpenTofu Capsule Installation の control-plane record を作り、Compatibility Check / Plan / Apply の contract を確認する最小例です。

正本は [Core spec](../core-spec.md) です。local service で runner / R2 / billing adapter が未配線の場合、実際の OpenTofu 実行や credit による apply blocking は queued / failed / adapter-unavailable として見えることがあります。現実装の適合状況と追加拡張の候補は [Core conformance](../core-conformance.md) に集約しています。

Provider Templates / Provider Env Set が正本モデルです。Takosumi提供は Cloudflare only から始まり、AWS / GCP / GitHub / Kubernetes / 任意 provider は Space-owned Connection のユーザーenvセットで使います。

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git

## 1. service を起動

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

別 terminal で `/api/v1` を叩きます。

```bash
export BASE=http://127.0.0.1:8788
export AUTH="Authorization: Bearer dev-token"
```

## 既定経路: `takosumi deploy ./dir` (upload)

Installation を作る既定経路は **ローカル作業ディレクトリの upload** です。git Source の登録は不要で、`wrangler deploy`
と同じくローカル Capsule をそのまま Space にデプロイします。git Source への push は「繋ぐと自動ビルドしてくれる任意
の add-on」であり、Installation の前提ではありません。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=$BASE
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token

takosumi deploy ./my-capsule --space @me --name my-app --var region=apac
takosumi plan   ./my-capsule --space @me --name my-app   # upload + plan のみ
```

CLI はローカルを `tar`(zstd) で固めて `POST /api/v1/spaces/:id/uploads` に送り (R2_SOURCE に保存され **upload origin の
SourceSnapshot** が記録される)、`POST /api/v1/deploy` に「upload snapshot を pin して `@space/name` Installation を
解決/作成し plan せよ」と依頼します。upload origin なので **Source 行は不要で `Installation.sourceId` は不在**であり、
Capsule Gate / plan / apply / DAG の downstream は origin 非依存に同じ pipeline を通ります。詳細は
[CLI](../reference/cli.md) と [Control Plane API](../reference/deploy-control-api.md) の Deploy / Upload を参照。

以降の手順 (### 2 以降) は、もう一方の経路である **git Source 連携** を control-plane record として確認する流れです。

## 2. Space と Source を登録

```bash
curl -s -X POST "$BASE/api/v1/spaces" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"handle":"shota","displayName":"Shota","type":"personal","ownerUserId":"user_dev"}'
# -> {"space":{"id":"space_...", ...}}

curl -s -X POST "$BASE/api/v1/sources" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"spaceId":"<spaceId>","name":"hello","url":"https://git.example.com/example/hello.git","defaultRef":"main","defaultPath":"."}'
# -> {"source":{"id":"src_...", ...}}  (public repo なら authConnectionId は不要)
```

`url` は plain OpenTofu module-compatible configuration を含む実際に到達可能な Git repo に置き換えます。

runner substrate を構成している場合は SourceSnapshot を作成します。SourceSnapshot は Git ref を commit に固定した immutable input です。

```bash
curl -s -X POST "$BASE/api/v1/sources/<sourceId>/sync" -H "$AUTH"
# source_sync Run が ref を commit に固定し SourceSnapshot を作ります
```

## 3. Provider と Connection 方針を確認

```bash
curl -s "$BASE/api/v1/providers" -H "$AUTH"
```

Takosumi提供は Cloudflare only です。AWS / GCP / GitHub / Kubernetes / 任意 provider は Space-owned Connection の
ユーザーenvセットを使います。Provider Template route と provider-env-set Connection route が、compatibility UI / CLI の入口です。

## 4. Installation を作る

InstallConfig は公式カタログ由来のもの (`GET /api/v1/install-configs`) か Space 自身のものを使います。InstallConfig は
`modulePath` / `normalization` / variable mapping / output allowlist / policy を持つ service-side config です。

```bash
curl -s "$BASE/api/v1/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/v1/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
# -> {"installation":{"id":"inst_...","status":"pending", ...}}
```

## 5. Compatibility Check

Compatibility Check は SourceSnapshot を固定し、Capsule Normalizer と Capsule Gate を provider credential なしで実行します。runner-backed source reader が未配線の host では、`capsule_source_files_unavailable` warning を含む report になります。

```bash
curl -s -X POST "$BASE/api/v1/sources/<sourceId>/compatibility-check" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sourceSnapshotId":"<sourceSnapshotId>"}'
# -> {"report":{"id":"compat_...","level":"ready" | "auto_capsulized" | "needs_patch" | "unsupported", ...}}

curl -s "$BASE/api/v1/compatibility-reports/<reportId>" -H "$AUTH"
```

## 6. plan → (approve) → apply

この API surface は正本の Run contract です。runner-backed plan/apply が未構成の local service では、Run が queued / failed / adapter-unavailable の応答になることがあります。

```bash
curl -s -X POST "$BASE/api/v1/installations/<installationId>/plan" -H "$AUTH"
# -> plan Run。platform pipeline は SourceSnapshot / Compatibility Report / DependencySnapshot を固定し、generated root で tofu plan を実行します

curl -s "$BASE/api/v1/runs/<runId>" -H "$AUTH"
# status が waiting_approval (destroy / destructive change のみ) なら:
curl -s -X POST "$BASE/api/v1/runs/<runId>/approve" -H "$AUTH"
```

apply は saved plan のみを実行し、plan digest / source snapshot / compatibility report / dependency snapshot / state generation を検証します。成功すると StateSnapshot 世代が進み、OutputSnapshot と Deployment が記録されます。

```bash
curl -s "$BASE/api/v1/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/v1/spaces/<spaceId>/activity" -H "$AUTH"
```

## 6. Billing mode を確認

Billing は Space 単位の ledger です。self-host や local dev では `disabled`、費用表示だけをしたい場合は `showback`、hosted で apply を credit reservation によって止めたい場合は `enforce` を使います。この quickstart では ledger surface を確認します。

```bash
curl -s "$BASE/api/v1/spaces/<spaceId>/billing" -H "$AUTH"
curl -s "$BASE/api/v1/spaces/<spaceId>/usage" -H "$AUTH"
```

dashboard を使う場合は `/new`（カタログ + Git URL からの追加）が同じ手順を UI で実行します。external install link（`/install?git=...&ref=...&path=...`）は query を保持して `/new` へ転送され、取得元が入力済みの状態で開きます（pre-fill のみ — 追加には必ず確認操作を挟みます）。

## 次

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Operator](../reference/operator.md)
