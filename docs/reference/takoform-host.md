# External Takoform Host の境界

Takosumi OSS は Takoform Host を内蔵しません。Takoform は Cloudflare、AWS、
Kubernetes などと同じく、Git module が選ぶ通常の OpenTofu provider です。

```text
Workspace/customer ProviderConnection
  → CredentialRecipe
  → ProviderBinding
  → Run-scoped runner materialization
  → Takoform provider
  → external Host API
```

ProviderConnection が保持するのは、利用者が選んだ external Host に対する
Host-scoped credential です。Takosumi は Host の親 provider credential、provider
installation、backend、capacity、placement、Workers for Platforms namespace/
dispatcher、native resource identity を受け取ったり選択したりしません。

## Managed supply の owner

Takoserver は Host-owned supply を提供する external Takoform Host です。Takoserver
operator が調達、許可された再販、または自前運用する capacity と credential、
Offering、Resource/Deployment、migration、meter、receipt、support/commercial policy を
所有します。Takoserver に customer vendor credential を渡す BYOC lane はありません。

Takosumi Hosted は retail/commerce/client composition を提供できますが、Takoserver の
Offering、capacity、provider credential、実行 authority を引き取りません。
Takosumi Cloud は退役した historical identity です。

## Embedded Host は current surface ではない

旧 Resource Shape、Form Registry/FormActivation、TargetPool、SpacePolicy、Form Host
discovery、Generic Offering と `/v1/resources` lifecycle は supported authoring surface
ではありません。通常の platform Worker はこれらを mount せず、旧 path は `404` の
ままです。environment variable、runtime object、compatibility host injection で別の
same-origin Host lifecycle を有効にする current contract はありません。

既存の route、store、schema、configuration 名が source に残っていても、それは
implementation conformance gap と migration/delete custody です。新しい integration、
provider、dashboard、runner から依存しないでください。

## 既存データの移行

既存 Resource/Form 行は [Resource migration internals](../concepts/resources.md) に従い、
そこで定義した bounded drain から認証済みの read/observe/delete だけを行います。
drain は discovery、preview、apply、update、Form transition、Offering selection を
有効にしません。

provider mutation を伴う移行が不可避なら、platform Worker/Core の public route や
compositionへ戻さず、operator が対象を固定した一回限りの migration tool として実行
します。tool は exact identity、専用 credential、at-most-once operation、provider
receipt、backup/restore と readback evidence を持ち、完了後に削除します。これは
Takosumi Core の第二 lifecycle ではありません。

現行の Host API、Form、package、provider identity と version は owning
[Takoform Core](https://github.com/tako0614/takoform)、
[Form publisher](https://github.com/tako0614/takoform-forms)、
[OpenTofu provider](https://github.com/tako0614/terraform-provider-takoform) を正本として
exact immutable identity を pin します。
