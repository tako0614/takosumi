# 公開 Docs Contract

このページは `takosumi.com/docs` で公開する docs の契約です。公開 docs は、
ユーザー、self-host operator、Takosumi Cloud の利用者が外部 contract として
依存できる情報だけを扱います。

## 公開 docs に含める情報

公開 docs には次の情報を載せます。

- Takosumi / Takosumi for Operator / Takosumi Cloud の定義と edition 境界
- Quickstart、Git URL install、OpenTofu Stack flow、Resource Shape flow の使い方
- API endpoint、request / response shape、認証、error shape
- Resource Shape、Compatibility API、ProviderConnection、CredentialRecipe、ProviderBinding の公開仕様
- supported / preview / planned / unsupported の compatibility matrix
- Takosumi Cloud の公開価格、無料枠、credit 消費、残高不足時の fail-closed 動作
- secret を再表示しない、logs に出さない、Run sandbox にだけ注入する、といった security contract

公開 contract として必要な情報を、非公開メモを読まないと分からない状態にはしません。

## 公開 docs に含めない情報

公開 docs には次の情報を載せません。

- production / staging deploy 手順
- secret rotation、operator token、vault path、local secret file path
- raw readiness record、smoke transcript、incident drill transcript
- payment provider の concrete price ID、同期手順、margin guard、reconciliation 手順
- closed implementation の file path、handler wiring、private resource ID
- operator-only support / abuse / evidence collection の実行手順

これらは公開 product contract ではなく、operator runbook または private evidence の範囲です。

## Memo から公開 contract へ移すルール

内部メモの内容がユーザーや operator の判断に必要になった場合は、内部ページへリンクせず、
必要な部分だけを public-safe な仕様に書き直します。

書き直すときは次を削ります。

- private path
- secret や token の名前・保存場所
- raw evidence ref
- closed implementation の具体ファイル名
- handler wiring や deploy 手順
- payment provider 同期の実装 detail

残すべきものは、外部 contract として安定した API、capability、price、security、
failure behavior だけです。

## 矛盾を避けるルール

公開 docs 内で内容が衝突した場合は、より具体的な reference を優先します。

```text
API / pricing / legal reference
  > Cloud / Resource reference
  > Quickstart
  > overview
```

内部メモや operator runbook は公開 contract を上書きしません。内部メモで決まった方針が
外部 contract になる場合は、この公開 docs 側の該当ページも同時に更新します。

## Pricing の分離

公開 pricing page に載せるもの:

```text
customer pays
free tier
included credits
usage prices
credit exhaustion behavior
auto charge behavior
refund / cancellation surface
```

公開 docs に載せないもの:

```text
payment provider price id
runtime price book storage
cost estimate spreadsheet
margin guard implementation
invoice export or reconciliation procedure
```

公開価格は customer-facing contract です。運用上の同期・原価・reconciliation は
public docs ではなく operator runbook の範囲です。
