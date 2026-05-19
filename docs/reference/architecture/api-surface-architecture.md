# API Surface アーキテクチャ {#api-surface-architecture}

> このページでわかること: kernel の API surface 設計と endpoint 分類。

endpoint catalog は [Kernel HTTP API reference](../kernel-http-api.md) が一次
資料。本ページは surface split の設計判断だけを扱う。

## Surface 分割 {#surface-split}

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

## 認証モデル {#authentication-model}

- installer endpoint は `TAKOSUMI_INSTALLER_TOKEN` bearer。
- artifact write は artifact credential。runtime-agent fetch は read-only fetch
  credential を使える。
- internal routes は HMAC-SHA256 + timestamp + request id replay protection。
- token 未設定で disabled な public endpoint は 404 を返す。

credential は scope ごとに最小化し、同一 token を installer / artifact /
internal RPC に流用しない。

## バージョニング {#versioning}

public installer surface は `/v1/installations/*` の 5 endpoint を current v1
contract とする。 breaking change は spec / implementation / tests / docs を同時
に更新する。 old/new dual-run の約束は docs に置かない。

internal surface は operator が両端を運用するため、rolling update で互換を維持
できる範囲の shape 追加を許す。

## 書き込みとリトライ {#writes-and-retry}

installer writes は client retry が発生しうる。 v1 surface は
`X-Idempotency-Key` header を持たず、 replay 抑制は **source pin + expected
digest** に閉じる: caller が `source.commit` (= 期待 commit SHA) と
`expectedDigest` (= 期待 manifest digest) を送り、 kernel は素材が更新済なら
`409 failed_precondition`、 サイズ超過なら `413 resource_exhausted` を返す。

## ページネーション {#pagination}

public installer API は list endpoint を持たない。 Installation / Deployment の
ledger read は internal control-plane route で提供し、cursor / filtering policy
は operator tooling 側の contract として扱う。

## OpenAPI {#openapi}

OpenAPI は public installer / artifact surface の read-only artifact。 internal
control plane と runtime-agent RPC は public SDK consumer 向けではないため、
public OpenAPI の正本には含めない。

## クロスリファレンス {#cross-references}

- [Kernel HTTP API](../kernel-http-api.md)
- [Installer API](../installer-api.md)
- [Runtime-Agent API](../runtime-agent-api.md)
- [Lifecycle Protocol](../lifecycle.md)
