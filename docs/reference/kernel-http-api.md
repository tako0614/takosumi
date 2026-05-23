# Kernel HTTP API {#kernel-http-api}

> このページでわかること: kernel HTTP surface の endpoint と認証境界。

本ページは `takosumi-api` role が mount する Takosumi kernel endpoint を説明し
ます。公開 lifecycle は Installer API の 5 endpoint と AppSpec / Installation /
Deployment で表します。internal control plane と runtime-agent control RPC は
operator runtime surface です。

> 実装は
> [`packages/kernel/src/api/`](https://github.com/tako0614/takosumi/tree/main/packages/kernel/src/api)
> の Hono router 群。 role ごとに mount される route 集合が変わります。

## 概要 {#overview}

| Surface           | Path prefix                                                      | 想定 caller                                   |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| Public installer  | `/v1/installations/*`                                            | Operator / actor の Takosumi CLI / automation |
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
| Installer bearer     | `TAKOSUMI_INSTALLER_TOKEN`     | `/v1/installations/*`                                     | `Authorization: Bearer <token>` |
| Internal HMAC secret | `TAKOSUMI_INTERNAL_API_SECRET` | `/api/internal/v1/*` 全体 (runtime-agent endpoint も含む) | HMAC-SHA256 + replay protection |

規則:

- `TAKOSUMI_INSTALLER_TOKEN` が unset の間、 `/v1/installations/*` route は
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
boundary に置きます。

現在 mount される署名付き internal route:

| Method | Path                                              | Purpose                               |
| ------ | ------------------------------------------------- | ------------------------------------- |
| GET    | `/api/internal/v1/spaces`                         | actor が見える Space summary 一覧     |
| POST   | `/api/internal/v1/spaces`                         | Space 作成                            |
| GET    | `/api/internal/v1/installations`                  | Space 内 Installation 一覧 (= ledger) |
| GET    | `/api/internal/v1/installations/{id}`             | 単一 Installation 詳細                |
| GET    | `/api/internal/v1/installations/{id}/deployments` | Deployment 履歴                       |
| GET    | `/api/internal/v1/installations/{id}/events`      | hash-chain audit log (= internal)     |

すべて internal HMAC 署名 (`TAKOSUMI_INTERNAL_API_SECRET`) が必須。 署名失敗は
401 `unauthenticated`、 actor 拒否は 403 `permission_denied`。

## Runtime-Agent control RPC {#runtime-agent-control-rpc}

runtime-agent process の lifecycle / lease / drain を kernel が制御する internal
RPC。 すべて `/api/internal/v1/runtime/agents/...` 配下で、 internal HMAC 必須。
詳細 schema / state machine は [Runtime-Agent API](./runtime-agent-api.md)。

| Method | Path                                                        | Purpose                                                     |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/internal/v1/runtime/agents/enroll`                    | runtime-agent registry へ enrollment                        |
| POST   | `/api/internal/v1/runtime/agents/:agentId/heartbeat`        | runtime-agent からの heartbeat 報告                         |
| POST   | `/api/internal/v1/runtime/agents/:agentId/leases`           | lease (実行責務) を取得                                     |
| POST   | `/api/internal/v1/runtime/agents/:agentId/reports`          | lease 結果 (progress / completed / failed) を kernel へ返却 |
| POST   | `/api/internal/v1/runtime/agents/:agentId/drain`            | drain を要求                                                |
| POST   | `/api/internal/v1/runtime/agents/:agentId/gateway-manifest` | gateway URL を Ed25519 で署名してから返す                   |

## Workflow / trigger / hook の境界 {#workflow-trigger-hook-boundary}

workflow / trigger / schedule / declarable hook は upstream automation として
installer API の前段に置きます。build service / CI / orchestrator が git source
または prepared source snapshot を用意し、Installer API に渡します。

## エラーエンベロープ {#error-envelope}

v1 error envelope は closed shape です。

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

`DomainErrorCode` は v1 で 9 個の closed enum:

| `code`                   | HTTP | 主な発生要因                                                             |
| ------------------------ | ---- | ------------------------------------------------------------------------ |
| `invalid_argument`       | 400  | AppSpec schema / form input / publish-listen cycle                       |
| `unauthenticated`        | 401  | bearer 不足、 internal HMAC 検証失敗                                     |
| `permission_denied`      | 403  | space 越境、 token claim 不足                                            |
| `not_found`              | 404  | endpoint disabled (token unset)、 Installation / Deployment 不在         |
| `failed_precondition`    | 409  | expected source / manifest mismatch、 collision-detected、 approval 失効 |
| `resource_exhausted`     | 413  | source snapshot / provider quota / request size 上限超過                 |
| `not_implemented`        | 501  | issuer 未配線、 operator が opt-in していない機能                        |
| `readiness_probe_failed` | 503  | `/livez` / `/readyz` / dependent port が ready でない                    |
| `internal_error`         | 500  | unhandled exception                                                      |

`details` に sensitive key (`authorization` / `cookie` / `token` / `secret` /
`password` / `credential` / `api_key` / `private_key`) を含む field があれば
自動で `[redacted]` に置換されます。

## クロスリファレンス {#cross-references}

- [Installer API](./installer-api.md) — 5 endpoint の完全 spec
- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Build service handoff](./build-spec.md) — build service と prepared source の
  handoff
- [Reference Kind Examples](./kind-registry.md#reference-component-kinds) —
  takosumi.com reference kind examples + operator-defined kind
- [Runtime-Agent API](./runtime-agent-api.md)
- [Closed Enums](./closed-enums.md)
