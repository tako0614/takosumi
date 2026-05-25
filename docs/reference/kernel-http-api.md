# Reference Kernel Route Inventory {#kernel-http-api}

本ページは `takosumi-api` role が mount する reference kernel route inventory
です。Takosumi public lifecycle model は AppSpec / Installation / Deployment
で表し、public Installer API は 5 endpoint です。internal control
plane、runtime-agent control RPC、probe route は operator runtime surface です。

> 実装は reference kernel の Hono router 群です。role ごとに mount される route
> 集合が変わります。repository source path は maintainer-facing
> [Spec Maintenance Map](./public-spec-source-map.md) で扱います。

## 概要 {#overview}

| Surface           | Path prefix                                                      | 想定 caller                                   |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| Public installer  | 5 Installer endpoints under `/v1/installations`                  | Operator / actor の Takosumi CLI / automation |
| Internal control  | `/api/internal/v1/*`                                             | Operator が運営する CLI / automation / agent  |
| Runtime-Agent RPC | `/api/internal/v1/runtime/agents/*`                              | Operator-installed runtime-agent process      |
| Discovery / probe | `/health`, `/livez`, `/readyz`, `/openapi.json`, `/capabilities` | Operator orchestrator                         |

すべての endpoint は kernel の base URL に対する相対 path です。 credential は
kernel が保持せず、 operator が env 経由で inject します。

## 認証 {#authentication}

kernel は v1 で 2 種類の credential を区別し、 credential ごとに作用範囲を
完全に分離します。

| Credential           | Env var                        | 適用範囲                                                  | 認証方式                        |
| -------------------- | ------------------------------ | --------------------------------------------------------- | ------------------------------- |
| Installer bearer     | `TAKOSUMI_INSTALLER_TOKEN`     | 5 endpoint Installer API                                  | `Authorization: Bearer <token>` |
| Internal HMAC secret | `TAKOSUMI_INTERNAL_API_SECRET` | `/api/internal/v1/*` 全体 (runtime-agent endpoint も含む) | HMAC-SHA256 + replay protection |

規則:

- `TAKOSUMI_INSTALLER_TOKEN` が unset の間、5 endpoint Installer API route は
  **404** を返します (401 で「token 未設定」を隠蔽しないため)。
- Installer bearer の Space scope は token claims から resolve します。actor
  単位の multi-Space auth / entitlement check は operator token issuer
  の責務です。
- Internal HMAC は `method` / `path` / `query` / `body digest` / `actor` を
  canonical 化して署名し、 `x-takosumi-internal-signature` /
  `x-takosumi-internal-timestamp` / `x-takosumi-request-id` で検証します。
- timestamp skew は 5 分、 request id は replay protection store で TTL 5 分。
- `/health` / `/livez` / `/readyz` / `/capabilities` / `/openapi.json`
  は無認証。

### Optional DataAsset extension credentials {#dataasset-extension-credentials}

DataAsset route は operator extension surface です。mount する operator は
installer bearer / internal HMAC と別の credential family を使います。

| Credential                      | Env var                         | 適用範囲                           |
| ------------------------------- | ------------------------------- | ---------------------------------- |
| DataAsset writer/admin bearer   | `TAKOSUMI_DEPLOY_TOKEN`         | upload / list / delete / GC / read |
| DataAsset read-only fetch token | `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | single-hash `GET` / `HEAD` read    |

DataAsset URL や token は Deployment outputs に出さず、operator evidence /
export policy で扱います。Installer API v1 の public digest set は
`manifestDigest` と source pin / digest を正本にします。

## Public installer routes {#public-installer-routes}

正本: [Installer API](./installer-api.md)。 5 endpoint 全て:

| Method | Path                                         | Purpose                                  |
| ------ | -------------------------------------------- | ---------------------------------------- |
| POST   | `/v1/installations/dry-run`                  | 新規 install の dry-run (= 変更差分予測) |
| POST   | `/v1/installations`                          | Installation 作成 + 最初の Deployment    |
| POST   | `/v1/installations/{id}/deployments/dry-run` | upgrade の dry-run                       |
| POST   | `/v1/installations/{id}/deployments`         | Installation に対する apply              |
| POST   | `/v1/installations/{id}/rollback`            | 過去 Deployment への巻き戻し             |

request / response shape は [Installer API](./installer-api.md) 参照。

## Internal control plane routes {#internal-control-plane-routes}

`/api/internal/v1/*` は operator-only。automation が caller で、internal route
boundary に置きます。Space / Group management routes are reference
dev/operator-internal convenience surfaces; core conformance is the 5 endpoint
Installer API above.

The routes in this section are reference implementation inventory. Client
applications, product integrations, and compatible operators do not depend on
these route names. Public install/deploy/rollback compatibility comes from the
Installer API, and read/history compatibility comes from the operator read
projection documented by that operator.

現在 mount される署名付き internal route family:

| Method | Path                                                | Purpose                           |
| ------ | --------------------------------------------------- | --------------------------------- |
| GET    | `/api/internal/v1/spaces`                           | actor が見える Space summary 一覧 |
| POST   | `/api/internal/v1/spaces`                           | Space 作成                        |
| GET    | `/api/internal/v1/groups?spaceId=...`               | Space 内 Group summary 一覧       |
| POST   | `/api/internal/v1/groups`                           | Group 作成                        |
| POST   | `/api/internal/v1/deployments`                      | internal manifest resolve / plan  |
| POST   | `/api/internal/v1/deployments/{deploymentId}/apply` | resolved deployment apply         |

すべて internal HMAC 署名 (`TAKOSUMI_INTERNAL_API_SECRET`) が必須。署名失敗は
401 `unauthenticated`、 actor 拒否は 403 `permission_denied`。

## Runtime-Agent control RPC {#runtime-agent-control-rpc}

runtime-agent process の lifecycle / lease / drain を kernel が制御する internal
RPC。すべて `/api/internal/v1/runtime/agents/...` 配下で、 internal HMAC 必須。
詳細 schema / state machine は
[Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)。

| Method | Path                                                        | Purpose                                                     |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/internal/v1/runtime/agents/enroll`                    | runtime-agent registry へ enrollment                        |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`        | runtime-agent からの heartbeat 報告                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`           | lease (実行責務) を取得                                     |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`          | lease 結果 (progress / completed / failed) を kernel へ返却 |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`            | drain を要求                                                |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest` | gateway manifest を internal authenticated channel で返す   |

## Workflow / trigger / hook の境界 {#workflow-trigger-hook-boundary}

workflow / trigger / schedule / declarable hook は upstream automation として
installer API の前段に置きます。build service / CI / orchestrator が git source
または prepared source archive を用意し、Installer API に渡します。

## エラーエンベロープ {#error-envelope}

reference kernel route inventory は次の error envelope を返します。

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
```

`requestId` は常に存在。 caller が `X-Request-Id` を送らなければ kernel が ULID
を生成し、 log と response 両方に同じ値を載せます。

public installer error envelope の正本は [Installer API](./installer-api.md)
です。reference kernel の internal / probe route は同じ envelope shape と
reference-kernel code set を使い、route 種別に応じて次の code を返します。

| `code`                   | HTTP | 主な発生要因                                                                                                 |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------ |
| `invalid_argument`       | 400  | AppSpec schema / form input / operator inventory/policy で解決できない kind or listen / publish-listen cycle |
| `unauthenticated`        | 401  | bearer 不足、 internal HMAC 検証失敗                                                                         |
| `permission_denied`      | 403  | space 越境、token claim 不足、operator policy による拒否                                                     |
| `not_found`              | 404  | endpoint disabled (token unset)、 Installation / Deployment 不在                                             |
| `failed_precondition`    | 409  | expected source / manifest mismatch                                                                          |
| `resource_exhausted`     | 413  | source snapshot / request body / manifest size 上限超過                                                      |
| `not_implemented`        | 501  | endpoint / optional extension / mounted implementation contract がこの operator binary に実装されていない    |
| `readiness_probe_failed` | 503  | `/livez` / `/readyz` / dependent port が ready でない                                                        |
| `internal_error`         | 500  | unhandled exception                                                                                          |

`details` に sensitive key (`authorization` / `cookie` / `token` / `secret` /
`password` / `credential` / `api_key` / `private_key`) を含む field があれば
自動で `[redacted]` に置換されます。

## クロスリファレンス {#cross-references}

- [Installer API](./installer-api.md) — 5 endpoint の完全 spec
- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Build service handoff](./build-spec.md) — build service と prepared source の
  handoff
- [Takosumi Official Type Catalog Specification](./type-catalog.md) — official
  kind descriptor and material contract vocabulary
- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)
- [Enum and Value Index](./closed-enums.md)
