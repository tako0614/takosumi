# Resource migration internals

> このページは supported product の使い方ではありません。Takosumi OSS は現在、Git
> の OpenTofu / Terraform module を実行する 1 つの Stack flow を提供します。
> Resource Shape、Form Host、TargetPool、SpacePolicy、旧 Resource endpoint は旧 surface
> の保存データと API/schema を移行するために一時的に残る migration internals です。

## 現在の authority

Takoform は `registry.terraform.io/tako0614/takoform` から使う通常の OpenTofu
provider です。Form の定義、package、provider、conformance、および Form を保存して
実体化する Host は Takoform または external project/operator が所有します。managed
supply の具体例は外部の **Takoserver Takoform Host** です。Takosumi OSS は Form Host を
自動で提供せず、TargetPool や SpacePolicy を利用者向け authoring surface として公開
しません。

通常の BYOC では Workspace/customer が vendor account、credential、作成される resource
を所有します。`ProviderConnection → CredentialRecipe → ProviderBinding → run-scoped
runner materialization → standard OpenTofu provider → customer-owned resource` の順で
実行し、provider 側の object を Takosumi の第二の Resource ledger に複製しません。Takoserver
Host を使う場合の Host-scoped credential は通常の ProviderConnection ですが、Takosumi は
Takoserver の親 provider credential、provider installation、backend、capacity、WfP
namespace/dispatcher/native identity、managed Offering を受け取りません。

通常の利用者は、Git module に必要な provider と `ProviderConnection` /
`ProviderBinding` を設定し、plan を確認してから Run を apply します。デプロイした
module の接続方法は `Interface`、利用許可は `InterfaceBinding` が表します。

## 残るものの扱い

既存の Resource 行、state、event、schema、migration は削除せず、読み取りや安全な
移行・削除 custody に必要な範囲で保持します。次のような旧 API/CLI 文書は wire と保存
データを調査するための内部資料で、今から新しい利用者が作成を始めるための契約では
ありません。

- 旧 Deploy / Resource lifecycle endpoint
- `takosumi resources ...` CLI
- Form Registry / FormActivation / Form Host discovery
- TargetPool / SpacePolicy / Resolver / Adapter の旧管理面

Generic Offering API / route / store も Takosumi Core の supported authority ではありません。
現存 endpoint は legacy/operator-only の implementation conformance gap で、新しい
integration では使わない removal-target の migration surface です。managed Offering の
authority は Takoserver が持ちます。

旧データの移行や復旧が必要な場合は、operator が現在の migration runbook と対象
endpoint の実装を確認してください。OSS dashboard には Resource 一覧、Resource editor、
Resource detail route を表示しません。

## 関連する現行モデル

- [全体像](./index.md)
- [Interface](./interfaces.md)
- [実行モデル](./run-model.md)
- [製品の境界](./boundaries.md)
