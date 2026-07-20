# Takosumi software

Takosumi は、Git に置いた OpenTofu/Terraform module を、計画 → 確認 → 反映の流れで
安全にデプロイ・管理する基盤ソフトウェアです。普通の OpenTofu/Terraform module を
そのまま実行でき、必要な場合は現在の Resource Shape API 互換 surface を
Target / Adapter に解決できます。採用済みの target では、portable な定義を Service Form、
exact identity を FormRef と呼び、Takosumi は Form Package が 0 個でも動く optional host です
(用語のひとこと説明は [用語集](./reference/glossary.md) を参照)。

このページは、software としての Takosumi と Takosumi for Operator の docs です。
私たちが運営する公式 hosted service、Takosumi Cloud の docs は
[app.takosumi.com/docs](https://app.takosumi.com/docs/) に分けています。

## どちらを読むか

| 読みたいこと                                                                                     | 読む場所                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Takosumi の model、API、Run、StateVersion、Output                                                | この Software docs                                                                                                                                                             |
| self-host / operator が使う OpenTofu Stack flow                                                  | [Quickstart](./getting-started/quickstart.md) と [Model reference](./reference/model.md)                                                                                       |
| Service Form host（現在の Resource Shape 互換 API）、Compatibility API framework、Adapter system | [Takosumi API](./reference/api.md) と [Model reference](./reference/model.md)                                                                                                  |
| `app.takosumi.com` の managed resources、pricing、API key、usage                                 | [Takosumi Cloud docs](https://app.takosumi.com/docs/)                                                                                                                          |
| Cloud の endpoint family、compatibility matrix、billing contract                                 | [Cloud resources](https://app.takosumi.com/docs/resources)、[Cloud endpoints](https://app.takosumi.com/docs/endpoints)、[Cloud pricing](https://app.takosumi.com/docs/pricing) |

## Product split

```text
Takosumi OSS:
  Git-based OpenTofu control plane
  + plain OpenTofu stack execution
  + optional zero-form Service Form host
  + current Resource Shape compatibility API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Secret / Policy
  + Compatibility API framework
  + Adapter system

Takosumi for Operator:
  Takosumi
  + customer / tenant operation
  + billing / metering / quota
  + DB-backed operator configuration
  + CLI / API / runbook operations
  + managed target catalog

Takosumi Cloud:
  official hosted Takosumi for Operator
  + official managed targets
  + Cloud-operated managed service backends
  + official billing / SLA / support
```

境界は次のとおりです。

```text
portable project は Service Form / FormRef / Form Package / typed client conformance を持つ。
Takosumi OSS は generic host lifecycle と API を持つ。
Operator / Cloud は商用運用と managed capacity を持つ。
```

Cloud は Takosumi の本体ではなく、公式 hosted deployment です。Software docs では
任意の Takosumi endpoint、self-host、operator 運用でも成立する API と model を説明します。
Cloud docs では `app.takosumi.com` の managed resources、pricing、spend guard、
Cloud endpoint を説明します。

## Takosumi が管理すること

Takosumi は OpenTofu/Terraform の外側を管理します。

```text
Git repo / Source を登録する
ProviderConnection を保存する
CredentialRecipe に従って Run の実行中だけ env/file を渡す
OpenTofu/Terraform を runner sandbox で実行する
plan / apply / destroy を Run として記録する
StateVersion / Output / log / AuditEvent を保存する
exact Service Form-backed Resource を TargetPool / Policy / Adapter に解決する
```

中心にある価値はこれです。

```text
Same manifest, different connection.
Same form, different target.
```

同じ `.tf` を使い、ProviderBinding だけを変えて dev/prod、別 account、別 provider
alias に流せます。同じ exact Service Form を使い、TargetPool / Policy / Adapter によって
operator が有効化した target へ解決できます。現在の wire と廃止済み provider の既存 state
に残る compatibility alias では、この flow を Resource Shape と呼びます。

## 作り直さないもの

業界標準の API / protocol / OpenTofu provider で足りるものを、
Takosumi は作り直しません。

```text
標準 API / protocol / OpenTofu provider がある:
  その surface を Stack flow または scoped compatibility profile で使う。

標準 surface がなく、繰り返し使う service form がある:
  portable governance を通した typed Service Form として定義する。

一回限りの不足:
  generic-env ProviderConnection と通常の OpenTofu module で扱う。
```

`takosumi/takosumi` provider は廃止済みで、新規設定には使いません。既存 provider は
Stack flow でそのまま使えます。portable Service Form と Form-backed Resource の
Interface descriptor は Takoform、Capsule Interface は service-side InstallConfig
blueprint、operator 管理は Takosumi API / CLI / dashboard を使います。旧 provider
source は既存 state の migration / rollback custody のためだけに残ります。

## Compatibility API

Compatibility API は OSS Takosumi の framework と capability surface です。
`compat.s3.v1`、`compat.oci.v1`、`compat.cloudevents.v1`、
`compat.kubernetes.crd.v1` のように scope と version を明示します。

これらは provider API 全体の compatibility を意味しません。
普通の S3/R2/GCS、registry、queue、database 利用で既存 provider や標準 endpoint が
足りる場合は、それを使います。

## 画面で使う言葉

通常画面では、内部 model をそのまま前面に出しません。

| 画面の言葉    | 意味                                              |
| ------------- | ------------------------------------------------- |
| サービス      | ホストするアプリ、worker、API、site、storage など |
| 接続          | Cloudflare / AWS / GCP などのアカウント連携       |
| 変更内容      | deploy 前に確認する plan / resource summary       |
| 履歴          | いつ誰が何を変更したか                            |
| Restore point | state version を使った復元点                      |

ほかの用語のひとこと説明は [用語集](./reference/glossary.md) に、詳細は
[Model reference](./reference/model.md) にあります。
外部の web / desktop / mobile / CLI からサービス作成へつなぐ場合は
[App Handoff Protocol](./reference/app-handoff.md) を使います。

## Docs の境界

公開 docs は、ユーザー、self-host operator、Takosumi Cloud 利用者が外部 contract として
依存できる情報だけを扱います。内部メモ、operator runbook、secret rotation、raw readiness
record、pricing 同期手順、implementation-only wiring は公開 product contract ではありません。

詳しい分類は [Published docs contract](./reference/docs-contract.md) に固定しています。

## 次に読むもの

- [Quickstart](./getting-started/quickstart.md)
- [Model reference](./reference/model.md)
- [Takosumi API](./reference/api.md)
- [Deploy-Control API](./reference/deploy-control-api.md)
- [Operator control MCP](./reference/operator-control-mcp.md)
- [Takosumi Cloud docs](https://app.takosumi.com/docs/)
