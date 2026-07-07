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
- Takosumi Cloud の公開価格、無料枠、usage billing、spend guard の fail-closed 動作
- secret を再表示しない、logs に出さない、Run sandbox にだけ注入する、といった security contract

公開 contract として必要な情報を、非公開メモを読まないと分からない状態にはしません。

## 公開ページは self-contained にする

公開ページは、読者が内部メモや operator runbook を読まなくても判断できる
粒度で書きます。

| Topic                       | 公開 docs に必ず書くこと                                         | 内部に残すこと                                      |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| product / edition boundary  | Takosumi、Takosumi for Operator、Takosumi Cloud の外部定義       | 設計候補、迷った案、未確定ロードマップ              |
| API / compatibility surface | endpoint、capability、認証、error、supported/preview/unsupported | handler wiring、closed repo path、private route     |
| Resource Shape              | schema、lifecycle、state/import/drift の外部挙動                 | adapter 実装詳細、private target inventory          |
| Cloud pricing / billing     | customer price、無料枠、spend guard、auto charge 挙動      | price id、原価表、margin guard、reconciliation 手順 |
| security / secret handling  | secret 非再表示、log redaction、run-scoped injection             | secret file path、vault path、operator token        |

公開 docs から `docs/internal/` や `docs/operations/` へ直接リンクして、仕様説明を
肩代わりさせません。内部メモの内容を公開する必要がある場合は、public-safe な
contract としてこの docs 配下に書き直します。

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
usage prices
spend guard behavior
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
