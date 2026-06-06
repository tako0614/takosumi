# Quickstart

この手順は local Takosumi service に対して、Space 直下の Installation を作り plan / apply する最小例です (core-spec §23)。

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

curl -s -X POST "$BASE/api/sources/<sourceId>/sync" -H "$AUTH"
# source_sync Run が ref を commit に固定し SourceSnapshot を作ります
```

## 3. Installation を作る

InstallConfig は公式カタログ由来のもの (`GET /api/install-configs`) か Space 自身のものを使います。

```bash
curl -s "$BASE/api/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
# -> {"installation":{"id":"inst_...","status":"installing", ...}}
```

## 4. plan → (approve) → apply

```bash
curl -s -X POST "$BASE/api/installations/<installationId>/plan" -H "$AUTH"
# -> plan Run。SourceSnapshot と DependencySnapshot が固定され、policy 層が plan JSON を評価します

curl -s "$BASE/api/runs/<runId>" -H "$AUTH"
# status が waiting_approval (destroy / destructive change のみ) なら:
curl -s -X POST "$BASE/api/runs/<runId>/approve" -H "$AUTH"
```

apply は saved plan のみを実行し、plan digest / source snapshot / dependency snapshot / state generation を検証します。成功すると StateSnapshot 世代が進み、OutputSnapshot と Deployment が記録されます。

```bash
curl -s "$BASE/api/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/activity" -H "$AUTH"
```

dashboard を使う場合は Install from Git flow (`/install?git=...&ref=...&path=...` link からの prefill 対応) が同じ手順を UI で実行します。

## 次

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Runner profiles](../reference/runner-profiles.md)
