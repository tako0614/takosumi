# API Surface Architecture

> このページでわかること: kernel の API surface 設計と endpoint 分類。

endpoint catalog は [Kernel HTTP API reference](/reference/kernel-http-api)
が一次 資料。本ページは surface split の設計判断だけを扱う。

## Surface Split

kernel は caller の信頼境界ごとに surface を分離する。

| Surface           | Prefix                                                        | Auth                                |
| ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| Public installer  | `/v1/installations/*`                                         | `TAKOSUMI_INSTALLER_TOKEN` bearer   |
| Artifact          | `/v1/artifacts/*`                                             | artifact write / fetch bearer       |
| Internal control  | `/api/internal/v1/*`                                          | `TAKOSUMI_INTERNAL_API_SECRET` HMAC |
| Runtime-agent RPC | `/api/internal/v1/runtime/agents/*` and agent lifecycle paths | internal HMAC / runtime-agent token |
| Probe/discovery   | `/health`, `/livez`, `/readyz`, `/openapi.json`               | unauthenticated                     |

public installer は AppSpec / Installation / Deployment lifecycle に閉じる。
artifact routes は DataAsset storage に閉じ、 installer auth と混ぜない。
internal control と runtime-agent RPC は operator backplane 用で、public API
として 扱わない。

## Authentication Model

- installer endpoint は `TAKOSUMI_INSTALLER_TOKEN` bearer。
- artifact write は artifact credential。runtime-agent fetch は read-only fetch
  credential を使える。
- internal routes は HMAC-SHA256 + timestamp + request id replay protection。
- token 未設定で disabled な public endpoint は 404 を返す。

credential は scope ごとに最小化し、同一 token を installer / artifact /
internal RPC に流用しない。

## Versioning

public installer surface は `/v1/installations/*` の 5 endpoint を current v1
contract とする。 breaking change は spec / implementation / tests / docs を同時
に更新する。 old/new dual-run の約束は docs に置かない。

internal surface は operator が両端を運用するため、rolling update で互換を維持
できる範囲の shape 追加を許す。

## Writes And Idempotency

installer writes は client retry が発生しうる。 caller は `X-Idempotency-Key` を
送る。 kernel は key と request body digest を bind し、同一 key + 同一 body の
retry だけを replay する。同一 key + 別 body は `409 failed_precondition`。

## Pagination

public installer API は list endpoint を持たない。 Installation / Deployment の
ledger read は internal control-plane route で提供し、cursor / filtering policy
は operator tooling 側の contract として扱う。

## OpenAPI

OpenAPI は public installer / artifact surface の read-only artifact。 internal
control plane と runtime-agent RPC は public SDK consumer 向けではないため、
public OpenAPI の正本には含めない。

## Cross-references

- [Kernel HTTP API](/reference/kernel-http-api)
- [Installer API](/reference/installer-api)
- [Runtime-Agent API](/reference/runtime-agent-api)
- [Lifecycle Protocol](/reference/lifecycle)
