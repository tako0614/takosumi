# Takosumi、BYOC、外部 managed Host の境界

Takosumi OSS は、利用者が自分の vendor account と credential を持つ BYOC
(bring your own cloud) control plane です。Takosumi Cloud という名前は退役した
過去の identity であり、`app.takosumi.com` の availability、pricing、SLA、support
を現在の正本として扱いません。

| 名前 | authority / 役割 |
| --- | --- |
| **Takosumi** | このリポジトリの AGPL-3.0 OSS control plane。Git/OpenTofu の Stack、Run、state、Output、audit、credential delivery を所有します。 |
| **Takosumi Hosted** | 必要な場合に retail、commerce、client composition を所有する別の hosted product です。managed supply や provider execution の authority ではありません。 |
| **Takoserver** | optional な managed supply の外部 Takoform Host です。managed service の Offering、capacity、provider installation/credential、backend、実行、WfP namespace/dispatcher/native identity を所有します。 |
| **Takosumi Cloud** | 退役した historical identity。現在の availability、pricing、SLA、support、managed supply の authority ではありません。 |

## Takosumi OSS が提供するもの

Takosumi OSS の supported user path は、Git に置いた OpenTofu / Terraform module を
実行する 1 つの Stack flow です。次を提供します。

- Git module の plan、確認、apply、state、Output、audit
- Workspace / Project / Capsule / Run の lifecycle
- ProviderConnection、CredentialRecipe、ProviderBinding と run-scoped runner
- dashboard、API、CLI、OIDC discovery、Interface / InterfaceBinding

Takosumi は専用の `.tf` 記法や first-party provider を配布しません。Cloudflare、AWS、
Kubernetes、Takoform はすべて通常の OpenTofu provider です。provider 側の resource を
別の Takosumi Resource ledger に複製して、第二の lifecycle を作りません。

## Customer BYOC の実行経路

通常の BYOC では Workspace/customer が vendor account と credential、そして作成される
resource の authority を持ちます。Takosumi は次の順にだけ接続を仲介します。

```text
ProviderConnection
  → CredentialRecipe
  → ProviderBinding
  → run-scoped runner materialization
  → standard OpenTofu provider
  → customer-owned resource
```

Credential の値は Run 中の runner にだけ materialize され、Takosumi の Output、state、
log、audit には入りません。provider、account、region、backend、capacity は module と
customer/operator が選びます。Takosumi は vendor account を作成・所有・推測しません。

## Optional managed supply: Takoserver Takoform Host

利用者が module から Takoform provider を選び、managed supply を使う場合でも、Takoform
は通常の provider のままです。Takosumi は external Takoserver Takoform Host に対する
Host-scoped credential を通常の ProviderConnection として登録し、ProviderBinding を
通じて Run の runner に渡せます。

この経路で Takosumi が受け取ったり選択したりしないものは、Takoserver の親 provider
credential、provider installation、backend、capacity、Workers for Platforms (WfP)
namespace、dispatcher、native identity です。これらと managed service の Offering は
Takoserver の authority です。Takosumi は Host の endpoint と Run の結果だけを、通常の
provider/Interface の境界で扱います。

## Retired Resource / Form surface

Resource Shape、Form Registry、FormActivation、TargetPool、SpacePolicy、Resolver、
Adapter と旧 `/v1/resources` lifecycle は supported authoring ではありません。残る route、
schema、store、migration は既存データの移行・削除 custody のための compatibility surface
です。新しい integration は Git module と通常の provider を使い、Takosumi Core の
authoring authority としてこれらを選びません。

Generic Offering API/route/store も Takosumi Core の supported authority ではありません。
現在存在する endpoint は legacy/operator-only の実装 conformance gap であり、新しい
integration では使わないでください。削除を進める migration surface で、managed Offering
の正本は Takoserver です。

## Operator と hosted product

自分で Takosumi を運用する operator は、database、runner、backup、provider 接続、
support、SLA、利用量の扱いを自分で決めます。Takosumi Hosted が retail/commerce/client
composition を提供する場合も、Takoserver の managed supply authority や customer の
BYOC credential ownership を吸収しません。

Takosumi Hosted の現行 retail 文書が公開されるまでは、この OSS repository や旧
`app.takosumi.com` Cloud 文書から availability、pricing、SLA、support を推測しないで
ください。

## 関連

- [全体像](./index.md)
- [認証情報](./credentials.md)
- [Resource migration internals](./resources.md)
- [API](../reference/api.md)
