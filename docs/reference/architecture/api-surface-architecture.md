# API Surface アーキテクチャ {#api-surface-architecture}

endpoint reference は [Reference Kernel Route Inventory](../kernel-http-api.md)
が一次資料。本ページは surface split の設計判断だけを扱う。Takosumi public spec
concepts は AppSpec / Installation / Deployment です。public Installer API は 5
つの installer endpoint です。

## Surface 分割 {#surface-split}

kernel は caller の信頼境界ごとに surface を分離する。

| Surface           | Prefix                                                        | Auth                                |
| ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| Public installer  | 5 Installer endpoints under `/v1/installations`               | `TAKOSUMI_INSTALLER_TOKEN` bearer   |
| Internal control  | `/api/internal/v1/*`                                          | `TAKOSUMI_INTERNAL_API_SECRET` HMAC |
| Runtime-agent RPC | `/api/internal/v1/runtime/agents/*` and agent lifecycle paths | internal HMAC / runtime-agent token |
| Probe/discovery   | `/health`, `/livez`, `/readyz`, `/openapi.json`               | unauthenticated                     |

public installer は AppSpec / Installation / Deployment lifecycle を扱う。
internal control と runtime-agent RPC は operator backplane 用です。

`/v1/artifacts` のような DataAsset route は operator extension として提供し、
installer auth / installer OpenAPI / public Takosumi spec とは credential と
reference を分離する。

## 認証モデル {#authentication-model}

- installer endpoint は `TAKOSUMI_INSTALLER_TOKEN` bearer。
- internal routes は HMAC-SHA256 + timestamp + request id replay protection。
- token 未設定で disabled な public endpoint は 404 を返す。

credential は scope ごとに最小化し、同一 token を installer / internal RPC に
流用しない。DataAsset extension を持つ operator は、その extension 用 credential
を installer credential から分ける。

## バージョニング {#versioning}

public installer surface は [Installer API](../installer-api.md) の 5 endpoint
を current v1 contract とする。同じ prefix の下に operator account-plane API が
存在しても、それらは operator-distribution surface であり Installer API
conformance ではありません。breaking change は spec / implementation / tests /
docs を同時に更新する。 old/new dual-run の約束は docs に置かない。

internal surface は operator が両端を運用するため、rolling update で互換を維持
できる範囲の shape 追加を許す。

## 書き込みとリトライ {#writes-and-retry}

installer writes は client retry が発生しうる。retry-safe な dry-run → apply
flow では、**source pin + expected guard** で reviewed source からの drift
を防ぐ: git source では caller が `expected.commit` と `expected.manifestDigest`
を送り、prepared source では `expected.sourceDigest` と
`expected.manifestDigest` を送る。既存 Installation の deploy では
`expected.currentDeploymentId` も送り、review した base pointer を guard する。
local source は dev / operator-local 用で portable source byte guard を持たず、
`expected.manifestDigest` は `.takosumi.yml` drift だけを guard する。kernel
は素材が更新済なら `409 failed_precondition`、サイズ超過なら
`413 resource_exhausted` を返す。 unresolved kind / provider / listen は source
race ではないため、 `400 invalid_argument` または、operator
がその機能を提供しない場合の `501 not_implemented` として扱う。

## ページネーション {#pagination}

Installation / Deployment の read projection は operator が公開する互換 surface
です。cursor / filtering policy、route names、auth は operator distribution
または reference implementation profile が定義します。reference kernel の HMAC
read route は実装例であり、portable write API は Installer API の 5 endpoint
です。

## OpenAPI {#openapi}

`/openapi.json` はその kernel process に mount された HTTP surface inventory
です。public Installer API だけを表す正本は [Installer API](../installer-api.md)
です。internal control plane、runtime-agent RPC、operator extension はそれぞれの
operator-facing reference に置く。public-only OpenAPI が必要な distribution は、
mounted surface inventory とは別の生成物として公開します。

## クロスリファレンス {#cross-references}

- [Reference Kernel Route Inventory](../kernel-http-api.md)
- [Installer API](../installer-api.md)
- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Lifecycle Protocol](../lifecycle.md)
