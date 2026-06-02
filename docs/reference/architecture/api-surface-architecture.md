# API Surface アーキテクチャ {#api-surface-architecture}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。endpoint reference は [Reference Takosumi Route Inventory](../service-http-api.md) が一次資料。
:::

本ページは surface split の設計判断だけを扱う。

## Surface 分割 {#surface-split}

Takosumi は caller の信頼境界ごとに surface を分離する。

| Surface           | Prefix                                                        | Auth                                |
| ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| Public installer  | Installer endpoints under `/v1/installations`                 | `TAKOSUMI_INSTALLER_TOKEN` bearer   |
| Internal control  | `/api/internal/v1/*`                                          | `TAKOSUMI_INTERNAL_API_SECRET` HMAC |
| Runtime-agent RPC | `/api/internal/v1/runtime/agents/*` and agent lifecycle paths | internal HMAC / runtime-agent token |
| Probe/discovery   | `/health`, `/livez`, `/readyz`, `/openapi.json`               | unauthenticated                     |

public installer は Source / Installation / Deployment lifecycle を扱う。 internal control と runtime-agent RPC は operator backplane 用です。

`/v1/artifacts` のような asset route は operator extension として提供し、 installer auth / installer OpenAPI / public Takosumi spec とは credential と reference を分離する。

## 認証モデル {#authentication-model}

- installer endpoint は `TAKOSUMI_INSTALLER_TOKEN` bearer。
- internal routes は HMAC-SHA256 + timestamp + request id replay protection。
- token 未設定で disabled な public endpoint は 404 を返す。

credential は scope ごとに最小化し、同一 token を installer / internal RPC に流用しない。asset extension を持つ operator は、その extension 用 credential を installer credential から分ける。

## バージョニング {#versioning}

public installer surface は [Installer API](../installer-api.md) を current v1 contract とする。同じ prefix の下に operator account layer API が存在しても、それらは operator-distribution surface であり Installer API conformance ではありません。breaking change は spec / implementation / tests / docs を同時に更新する。 old/new dual-run の約束は docs に置かない。

internal surface は operator が両端を運用するため、rolling update で互換を維持できる範囲の shape 追加を許す。

## 書き込みとリトライ {#writes-and-retry}

installer writes は client retry が発生しうる。retry-safe な dry-run → apply flow では、**source pin + expected guard** で reviewed source と binding resolution からの drift を防ぐ。git source では caller が resolved commit guard を送り、prepared source では source digest guard を送る。既存 Installation の deploy では `expected.currentDeploymentId` と `expected.planSnapshotDigest` も送り、review した base pointer と dry-run plan を guard する。local source は dev / operator-local 用で portable source byte guard を持たないため、`planSnapshotDigest` が review した source snapshot と binding resolution の guard になる。Takosumi は素材が更新済なら `409 failed_precondition`、サイズ超過なら `413 resource_exhausted` を返す。public Installer API のエラーレスポンス体系は [Installer API](../installer-api.md#error-envelope) が正本です。syntax / local reference / invalid selection は `400 invalid_argument`、well-formed だが Space で未採用 / 不可視 / unavailable な PlatformService や binding selection は `409 failed_precondition`、採用済み operator extension に対する implementation binding が無い場合は `501 not_implemented` として扱う。

## ページネーション {#pagination}

Installation / Deployment の参照 API は operator が公開する互換 surface です。cursor / filtering policy、route names、auth は operator の設定が定義します。reference Takosumi の HMAC read route は実装例であり、portable write API は [Installer API](../installer-api.md) です。

## OpenAPI {#openapi}

`/openapi.json` はその Takosumi process に mount された HTTP surface inventory です。public Installer API だけを表す正本は [Installer API](../installer-api.md) です。internal control plane、runtime-agent RPC、operator extension はそれぞれの operator-facing reference に置く。public-only OpenAPI が必要な distribution は、 mounted surface inventory とは別の生成物として公開します。

## クロスリファレンス {#cross-references}

- [Reference Takosumi Route Inventory](../service-http-api.md)
- [Installer API](../installer-api.md)
- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Lifecycle Protocol](../lifecycle.md)
