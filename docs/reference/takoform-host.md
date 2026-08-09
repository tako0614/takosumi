# Takoform provider integration

> Migration boundary note: Takosumi OSS retired its embedded Resource/Form Host.
> This page records the remaining provider/Host boundary; it is not a supported
> Resource authoring guide.

Takosumi OSS は Takoform Host を実装しません。Takoform は Cloudflare、AWS、その他の
OpenTofu provider と同じく、repository の module が選ぶ外部 provider の一つです。

## 実行経路

```text
repository module
  → ProviderConnection / ProviderBinding
  → runner 内だけで credential を materialize
  → OpenTofu が Takoform provider を実行
  → 設定された外部 Host
  → state / typed Output
  → 必要な Interface を generic post-apply projection
```

Takosumi は Run、OpenTofu state、Output、audit、Interface / InterfaceBinding の認可を
所有します。Host は provider が作る resource instance と backend lifecycle を所有します。
同じ resource を Takosumi の別 ledger に複製しません。

## 接続

Host endpoint と credential は通常の ProviderConnection として Workspace に登録し、
ProviderBinding で module の provider requirement に結びます。credential は runner に
だけ渡され、repository、plan 表示、state、Output、Interface document には保存しません。

Takosumi Cloud が current Takoform Host を公開した場合も、この経路は変わりません。
Cloud の既定接続は便利な初期値であり、hidden runner mode や first-party provider では
ありません。利用者は自分が選んだ互換 Host 接続に差し替えられます。

## Protocol version

Takosumi の docs は Takoform の未公開 candidate version、FormRef、schema digest、Host
route を複製しません。利用可能な protocol と exact identity は、公開済み Takoform
provider と接続先 Host の discovery/contract を確認してください。未公開 candidate を
production capability として広告しません。

旧 Takosumi Resource Shape/Form Host の endpoint と provider 設定は supported product
flow ではありません。既存データの operator-only drain は非公開 runbook と
[configuration reference](./configuration.md) に限定し、新規の apply/import/refresh を
受け付けません。
