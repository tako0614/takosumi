# Quickstart

この手順は local Takosumi service に対して、Space 直下の OpenTofu Capsule Installation の control-plane record を作り、Compatibility Check / Plan / Apply の contract を確認する最小例です。

完成形の正本は [Core spec](../core-spec.md) です。現時点では Runner-backed Capsule Normalizer / Capsule Gate、Compatibility Report の apply guard 統合、billing enforce は実装中です。local service だけでは実際の OpenTofu 実行や credit による apply blocking まで完了したと誤読しないでください。実装差分は [Core conformance](../core-conformance.md) に集約しています。

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

別 terminal で `/api` を叩きます。

```bash
export BASE=http://127.0.0.1:8788
export AUTH="Authorization: Bearer dev-token"
```

## 2. Space と Source を登録

```bash
curl -s -X POST "$BASE/api/spaces" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"handle":"shota","displayName":"Shota","type":"personal","ownerUserId":"user_dev"}'
# -> {"space":{"id":"space_...", ...}}

curl -s -X POST "$BASE/api/sources" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"spaceId":"<spaceId>","name":"hello","url":"https://git.example.com/example/hello.git","defaultRef":"main","defaultPath":"."}'
# -> {"source":{"id":"src_...", ...}}  (public repo なら authConnectionId は不要)
```

`url` は plain OpenTofu module-compatible configuration を含む実際に到達可能な Git repo に置き換えます。

runner substrate を構成している場合は SourceSnapshot を作成します。SourceSnapshot は Git ref を commit に固定した immutable input です。

```bash
curl -s -X POST "$BASE/api/sources/<sourceId>/sync" -H "$AUTH"
# source_sync Run が ref を commit に固定し SourceSnapshot を作ります
```

## 3. Installation を作る

InstallConfig は公式カタログ由来のもの (`GET /api/install-configs`) か Space 自身のものを使います。InstallConfig は
`modulePath` / `normalization` / variable mapping / output allowlist / policy を持つ service-side config です。

```bash
curl -s "$BASE/api/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
# -> {"installation":{"id":"inst_...","status":"pending", ...}}
```

## 4. Compatibility Check

Compatibility Check は SourceSnapshot を固定し、完成形では Capsule Normalizer と Capsule Gate を provider credential なしで実行します。現在の local service は metadata-only report を返す場合があります。これは API contract の確認用であり、Runner-backed Gate が完成済みであることを意味しません。

```bash
curl -s -X POST "$BASE/api/sources/<sourceId>/compatibility-check" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sourceSnapshotId":"<sourceSnapshotId>"}'
# -> {"report":{"id":"compat_...","level":"ready" | "auto_capsulized" | "needs_patch" | "unsupported", ...}}

curl -s "$BASE/api/compatibility-reports/<reportId>" -H "$AUTH"
```

## 5. plan → (approve) → apply

この API surface は正本の Run contract です。runner-backed plan/apply が未構成の local service では、Run が queued / failed / 実装中の応答になることがあります。

```bash
curl -s -X POST "$BASE/api/installations/<installationId>/plan" -H "$AUTH"
# -> plan Run。完成形では SourceSnapshot / Compatibility Report / DependencySnapshot を固定し、generated root で tofu plan を実行します

curl -s "$BASE/api/runs/<runId>" -H "$AUTH"
# status が waiting_approval (destroy / destructive change のみ) なら:
curl -s -X POST "$BASE/api/runs/<runId>/approve" -H "$AUTH"
```

完成形の apply は saved plan のみを実行し、plan digest / source snapshot / dependency snapshot / state generation を検証します。成功すると StateSnapshot 世代が進み、OutputSnapshot と Deployment が記録されます。

```bash
curl -s "$BASE/api/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/activity" -H "$AUTH"
```

## 6. Billing mode を確認

Billing は Space 単位の ledger です。self-host や local dev では `disabled`、費用表示だけをしたい場合は `showback`、hosted で apply を credit reservation によって止めたい場合は `enforce` を使います。現時点の billing enforce は実装中なので、この quickstart では ledger surface の確認に留めます。

```bash
curl -s "$BASE/api/spaces/<spaceId>/billing" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/usage" -H "$AUTH"
```

dashboard を使う場合は Install OpenTofu Capsule flow (`/install?git=...&ref=...&path=...` link からの prefill 対応) が同じ手順を UI で実行します。

## 次

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Operator](../reference/operator.md)
