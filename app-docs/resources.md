# Resources and providers

Takosumi Cloud で使う cloud resource は、Git repository の OpenTofu module が宣言し、
選択した provider が作成します。Takosumi は provider を置き換えず、Run と state の境界を
提供します。

## どの provider を使えるか

module の `required_providers` が選択の正本です。例えば次の経路を同じ Workspace で
利用できます。

- 自分の Cloudflare、AWS、その他の cloud account
- self-host または third-party provider endpoint
- 公開後の Takosumi Cloud Takoform Host

Takosumi Cloud は provider 名から account、region、secret、価格を推測しません。
Connection を作り、module の provider requirement へ Binding します。credential は Run の
間だけ runner に materialize され、plan 表示、Output、Interface、ログへ書きません。

## Lifecycle

```text
repository commit
  → provider requirements and variables
  → reviewed OpenTofu plan
  → provider apply
  → versioned state and Output
```

更新と削除も同じ graph で行います。Dashboard の別操作や data endpoint から同じ object を
作り直しません。provider が失敗した場合は Run に診断を残し、別 backend へ勝手に迂回せず
fail closed します。

## Cloud catalog

認証済み `GET /v1/cloud/catalog` は、現在の Workspace で利用できる hosted service、価格、
protocol、availability を返します。catalog は discovery と表示のための情報で、OpenTofu
state や provider graph の authority ではありません。

次は別々に判定されます。

- provider / protocol が公開済みか
- Cloud backend と容量が構成済みか
- commercial offering が有効か
- Workspace の credit、quota、permission が足りるか

いずれかが欠ける場合は、provider や billing backend を呼ぶ前に停止します。

## Output と Interface

provider が返した typed Output は Run と state に記録されます。アプリが利用する接続情報は
generic Interface として projection できます。

Interface は endpoint や protocol document を表し、InterfaceBinding は誰が利用できるかを
表します。bearer token、private key、provider credential を public Output や Interface
document に入れません。表示された endpoint を利用し、hostname を推測しないでください。

## Takoform の提供状態

Takoform は portable contract と OpenTofu/Terraform provider を所有します。Takosumi Cloud
は official Host を提供する予定ですが、未公開 candidate を catalog に available として
出しません。公開済みの exact contract、production adapter、billing/recovery、staging
evidence がそろった後にだけ利用可能になります。

VM のような未対応 compute family は、対応済みと推測しません。現在の truth は hard-coded
resource list ではなく認証済み catalog です。

## Billing and deletion

有料 operation は実行前に quote、credit、spend limit を確認します。使用量は発生元
Workspace と支払い owner に紐づきます。価格は [Pricing](./pricing.md) を参照してください。

既存 object の削除は、作成に使った provider graph から行います。残高不足を理由に cleanup
を不可能にせず、曖昧な backend outcome は成功扱いしません。
