# Control Plane API

Takosumi の control plane は OpenTofu Installation DAG を Space 直下で管理する HTTP API です。正本は
[`docs/core-spec.md`](../core-spec.md) で、公開 surface は [§30](../core-spec.md#30-api)、外部 install link は
[§12](../core-spec.md#12-external-install-link) / [§30](../core-spec.md#30-api)、error code は
contract (`takosumi-contract/deploy-control-api`) が所有します。本ドキュメントが spec と矛盾した場合は spec が勝ちます。

公開語彙は **Space / Source / Connection / Installation (+InstallConfig) / Dependency / Run / RunGroup / Deployment /
OutputSnapshot / Activity** です。`PlanRun` / `ApplyRun` / `App` / `Environment` / `InstallProfile` / `RunnerProfile` /
`DeploymentOutput` は退役語彙で、現行 surface には現れません (run は `Run` + `type`、出力は `OutputSnapshot` /
`outputsPublic`)。RunnerProfile は公開語彙から外れ、内部 execution profile (substrate / image / limits) として
Connection + CapabilityBinding + policy 層の下に従属します。

## Surface と認証モデル

3 つの surface があり、それぞれ別の認証を持ちます。

| Surface | 用途 | 認証 |
| --- | --- | --- |
| `/api/*` + `/install` | §30 公開 control plane | operator bearer token (`Authorization: Bearer <token>`) |
| `/v1/control/*` | dashboard SPA | account-plane session (operations facade pass-through) |
| `/v1/*` seam | accounts plane / CLI | in-process fetch seam (operator bearer) |

### `/api` operator bearer

`/api` の各 route は bearer token で保護されます。reference fallback では token は `TAKOSUMI_DEPLOY_CONTROL_TOKEN` から
供給され、token も bearer resolver も未設定の host は `/api` route を `404 not_found` で隠します (未設定 surface を
public host で漏らさない)。

operator / account-plane は bearer resolver を差し替えて、`actor` / `spaceIds` / `operations` / `runnerProfileIds` を
持つ scoped principal を返せます。scope は **default deny** で、resolver が省略した scope は許可になりません:

- read は対象 record の `spaceId` で許可されます。
- mutation は `operations` (`create` / `update` / `destroy` …) と `runnerProfileIds` で許可されます。
- Space 作成・operator-scope Connection・operator connection defaults は instance-wide なので、無制限 bearer
  (`spaceIds: "*"`) だけが触れます。
- `GET /api/connections` を `spaceId` なしで呼ぶと operator-scope Connection 一覧になり、これも無制限 bearer 専用です。

scope 外の request は `403 permission_denied` になり、API 起点の audit event に `actor` が記録されます。default の
fallback bearer は `spaceIds`/`operations`/`runnerProfileIds` すべて `"*"` の principal です。

### `/v1/control/*` dashboard session

dashboard SPA は deploy-control bearer を持ちません。account-plane の session-authed `/v1/control/*` route を呼び、
platform worker がそれを embedded control plane の typed operations facade に pass-through します
([`core-spec.md` §31](../core-spec.md#31-ui))。session gate を通過しても facade が未配線なら `503` を返します。

### `/v1/*` 内部 seam

`/v1/plan-runs` / `/v1/apply-runs` / `/v1/runner-profiles` / `/v1/installations/:id` (+ `/deployments` /
`/deployment-outputs`) は accounts plane と CLI が consume する **内部 fetch seam** です。§30 公開語彙の一部ではなく、
`/api` cutover 後も `/v1` prefix のまま残ります。これらは internal execution profile (旧 RunnerProfile) と低レベル
plan/apply ledger を露出するため、dashboard や外部統合からは使いません。

## `/api` surface (§30)

version prefix は付けず `/api` にまとめます ([§30](../core-spec.md#30-api))。全 route は operator bearer 認証です。

### Spaces (§4)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/spaces` | Space 作成 (`@handle` owner namespace)。無制限 bearer 専用。 |
| GET | `/api/spaces` | principal が見える Space 一覧 |
| GET | `/api/spaces/{spaceId}` | Space 取得 |
| PATCH | `/api/spaces/{spaceId}` | Space 更新 (MVP: `displayName` のみ) |

### Sources (§6)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/sources` | git Source 登録 (URL policy 検証、ls-remote は queued `source_sync`)。hook secret を一度だけ返す。 |
| GET | `/api/sources?spaceId=` | Space の Source 一覧 (hook secret は含まない) |
| GET | `/api/sources/{sourceId}` | Source 取得 |
| PATCH | `/api/sources/{sourceId}` | Source 更新 (name / defaultRef / defaultPath / auth / status) |
| POST | `/api/sources/{sourceId}/sync` | default ref を archive snapshot に解決する `source_sync` Run を作成 |
| GET | `/api/sources/{sourceId}/snapshots` | Source の SourceSnapshot 一覧 |

`POST /hooks/sources/{sourceId}` は forge webhook の inbound seam で、bearer ではなく hook secret 認証です。

### Connections (§9)

connection 作成は kind / provider / authMethod を固定した薄い subroute です。credential `values` は write-only で、
log にも response にも出ません。

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/connections/source/https-token` | git source HTTPS-token Connection (optional username) |
| POST | `/api/connections/source/ssh-key` | git source SSH-key Connection (`scopeHints.knownHostsEntry` 必須) |
| POST | `/api/connections/cloudflare/token` | Cloudflare API-token Connection (optional account/zone scope) |
| POST | `/api/connections/aws/assume-role` | **501** AWS assume-role Connection (MVP 未実装) |
| GET | `/api/connections?spaceId=` | Space の Connection 一覧、`spaceId` 省略時は operator-scope 一覧 (無制限 bearer 専用)。secret 値は含まない。 |
| POST | `/api/connections/{connectionId}/test` | 保存済み credential を provider で検証 |
| POST | `/api/connections/{connectionId}/revoke` | Connection を revoke し sealed secret blob を削除 |

`GET` / `PUT /api/operator-connection-defaults` は instance-wide な capability 既定 Connection を読み書きします
(無制限 bearer 専用)。

### Installations + InstallConfigs (§5 / §11)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/spaces/{spaceId}/installations` | Space 直下に Installation 作成 (`UNIQUE(space, name, environment)`、Source + InstallConfig から) |
| GET | `/api/spaces/{spaceId}/installations` | Space の Installation 一覧 |
| GET | `/api/installations/{installationId}` | Installation 取得 |
| PATCH | `/api/installations/{installationId}` | **501** Installation 更新 (MVP 未実装; status は run lifecycle 経由) |
| DELETE | `/api/installations/{installationId}` | **501** Installation 削除 (MVP 未実装; destroy-plan flow を使う) |
| GET | `/api/install-configs?spaceId=` | InstallConfig 一覧 (公式 catalog、`spaceId` 指定時はその Space の config も) |

### Dependencies (§14 / §15)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/installations/{installationId}/dependencies` | consumer をこの Installation とする Dependency edge 作成 (same-Space / `variable_injection`、cycle 拒否) |
| GET | `/api/installations/{installationId}/dependencies` | Dependency 一覧 (asProducer / asConsumer view) |
| DELETE | `/api/dependencies/{dependencyId}` | Dependency edge 削除 (consumer の Space permission gate) |

### Runs (§10 / §23)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/installations/{installationId}/plan` | Installation-driven plan Run (最新 SourceSnapshot を解決し installation state scope で dispatch) |
| POST | `/api/installations/{installationId}/destroy-plan` | destroy-plan Run (常に `waiting_approval` で着地、§23) |
| GET | `/api/runs/{runId}` | unified Run projection (source_sync / plan / apply ledger 横断) |
| GET | `/api/runs/{runId}/logs` | structured diagnostics + run-level audit trail (redacted) |
| GET | `/api/runs/{runId}/events` | run-level audit-event trail |
| POST | `/api/runs/{runId}/approve` | waiting-approval な Run (destroy / destructive change) を承認し apply gate を解除 |
| POST | `/api/runs/{runId}/cancel` | queued / waiting-approval な Run を cancel |

### Run groups (§19 / §24)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/spaces/{spaceId}/plan-update` | `space_update` RunGroup を作成 (stale Installation + downstream を topo 順に re-plan) |
| GET | `/api/run-groups/{runGroupId}` | RunGroup + member Run + 計算済み status を取得 |
| POST | `/api/run-groups/{runGroupId}/approve` | waiting-approval な member Run を一括承認 |

### Deployments (§16)

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/installations/{installationId}/deployments` | Installation の Deployment 一覧 |
| GET | `/api/deployments/{deploymentId}` | Deployment ledger record 取得 |
| POST | `/api/deployments/{deploymentId}/rollback-plan` | その Deployment の source snapshot に pin した rollback plan Run (通常の approval/apply flow に乗る) |

### Output shares (§18)

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/output-shares` | **501** cross-Space OutputShare 作成 (MVP 未実装) |
| GET | `/api/output-shares` | **501** OutputShare 一覧 (MVP 未実装) |
| POST | `/api/output-shares/{shareId}/revoke` | **501** OutputShare revoke (MVP 未実装) |

### Activity (§27 / §34)

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/spaces/{spaceId}/activity?limit=` | Space の Activity audit trail (newest first、`limit` は 1..500) |

## 501 surfaces

以下は spec 上 surface として存在しますが、認証を通過した後 `501 not_implemented` を返します (未設定 handler を
漏らさず discoverable に保つため)。

- `POST /api/connections/aws/assume-role` — AWS assume-role Connection (post-MVP)
- `PATCH /api/installations/{installationId}` — Installation 更新 (status は run lifecycle 経由)
- `DELETE /api/installations/{installationId}` — Installation 削除 (代わりに `POST /api/installations/{id}/destroy-plan`)
- `POST` / `GET /api/output-shares`、`POST /api/output-shares/{shareId}/revoke` — cross-Space OutputShare (post-MVP)

## Error envelope

全 error は同じ封筒で返ります。`requestId` は `x-request-id` / `x-correlation-id` (UUID / ULID 形) を引き継ぎ、なければ
新規発行します。

```json
{
  "error": {
    "code": "failed_precondition",
    "message": "expected.planDigest does not match plan run",
    "requestId": "req_...",
    "details": {}
  }
}
```

| Code | HTTP | 意味 |
| --- | --- | --- |
| `invalid_argument` | 400 | body / param / query 形が不正 (unknown_field 含む) |
| `unauthenticated` | 401 | bearer 欠落 / 不一致 |
| `permission_denied` | 403 | scope 外 (default deny) |
| `not_found` | 404 | record 不在、または surface 無効 |
| `failed_precondition` | 409 | guard / generation mismatch |
| `resource_exhausted` | 413 | body が 1 MiB limit 超過 |
| `not_implemented` | 501 | 上記 501 surface |
| `internal_error` | 500 | 未分類 server error |

## External install link ([§12](../core-spec.md#12-external-install-link))

外部サイトは Git URL を渡して install flow に deep-link します。link は platform worker (accounts handler) が parse +
URL policy 検証し、dashboard の Install from Git flow へ 302 します (bearer 不要、session gate は dashboard 側)。

```txt
GET /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
GET /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

`source=` は Terraform/OpenTofu module address 形 (`git::https://...//path?ref=`)、簡易形は `git` / `ref` / `path` の
個別 query です。git URL は `https://` のみで credential 埋め込み禁止、literal private / loopback / metadata IP host は
拒否されます。
