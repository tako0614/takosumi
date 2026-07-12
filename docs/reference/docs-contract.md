# 公開 Docs Contract

このページは `takosumi.com/docs` で公開するソフトウェアドキュメントの契約です。公開ドキュメントは、
ユーザーと self-host / operator が外部契約として依存できる情報だけを扱います。
私たちが運営する hosted Cloud service のドキュメントは `app.takosumi.com/docs` に分けます。

## 公開 docs に含める情報

公開ドキュメントには次の情報を載せます。

- Takosumi / Takosumi for Operator / Takosumi Cloud の定義と edition 境界
- Quickstart、Git URL install、OpenTofu Stack flow、Resource Shape flow の使い方
- API endpoint、request / response shape、認証、error shape
- Resource Shape、Compatibility API、ProviderConnection、CredentialRecipe、ProviderBinding の公開仕様
- supported / preview / planned / unsupported の compatibility matrix
- Takosumi Cloud docs への外部 pointer
- secret を再表示しない、ログに出さない、Run sandbox にだけ注入する、といったセキュリティ契約

公開契約として必要な情報を、非公開メモを読まないと分からない状態にはしません。

## ソフトウェアドキュメント / hosted Cloud ドキュメントの分離

公開ドキュメントはサイト自体を分けます。`takosumi.com/docs` はソフトウェア / Operator ドキュメント、
`app.takosumi.com/docs` は hosted Cloud service ドキュメントです。

| Surface                                     | 主語                                 | 書くこと                                                                                                                                    | 書かないこと                                                                                |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Software docs (`takosumi.com/docs`)         | Takosumi OSS / Takosumi for Operator | 汎用 API、OpenTofu Stack flow、Resource Shape flow、ProviderConnection、Run 履歴、self-host / operator endpoint でも成立する動作 | `app.takosumi.com` 固有の価格、official managed resource の利用量、Cloud API key の日常操作 |
| Hosted Cloud docs (`app.takosumi.com/docs`) | Takosumi Cloud                       | 公式 hosted service、managed resources、Cloud endpoint 群、pricing、spend guard、Cloud API key、利用量                               | Takosumi core の必須動作のような書き方、任意 endpoint でも必ず存在するような書き方    |
| Operator docs / runbooks                    | operator                             | デプロイ、secret rotation、証跡、非公開の運用手順                                                                            | 公開契約の肩代わり                                                                  |

ソフトウェアドキュメントで Cloud に触れる場合は、定義とリンクに留めます。Cloud ドキュメントで
ソフトウェアモデルに触れる場合は、Cloud が同じ Takosumi モデルの hosted deployment である
ことを説明する範囲に留めます。

## 公開ページは self-contained にする

公開ページは、読者が内部メモや operator runbook を読まなくても判断できる
粒度で書きます。

| Topic                       | 公開ドキュメントに必ず書くこと                                   | 内部に残すこと                                      |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| product / edition 境界      | Takosumi、Takosumi for Operator、Takosumi Cloud の外部定義       | 設計候補、迷った案、未確定ロードマップ              |
| API / compatibility surface | endpoint、capability、認証、error、supported/preview/unsupported | handler の配線、closed repo path、private route     |
| Resource Shape              | schema、lifecycle、state/import/drift の外部挙動                 | adapter 実装詳細、private target 一覧              |
| Cloud pricing / billing     | 利用者価格、無料枠、spend guard、auto charge の挙動              | price id、原価表、margin guard、reconciliation 手順 |
| security / secret 管理      | secret 非再表示、ログ秘匿、Run 限定注入                          | secret file path、vault path、operator token        |

公開ドキュメントから `docs/internal/` や `docs/operations/` へ直接リンクして、仕様説明を
肩代わりさせません。内部メモの内容を公開する必要がある場合は、公開可能な
契約としてこのドキュメント配下に書き直します。

## 公開 docs に含めない情報

公開ドキュメントには次の情報を載せません。

- production / staging のデプロイ手順
- secret rotation、operator token、vault path、ローカル secret ファイルパス
- 未加工の readiness 記録、smoke テスト記録、incident drill 記録
- payment provider の具体的な price ID、同期手順、margin guard、reconciliation 手順
- 非公開実装のファイルパス、handler の配線、private resource ID
- operator 専用の support / abuse / evidence collection の実行手順

これらは公開の製品契約ではなく、operator runbook または非公開証跡の範囲です。

## Memo から公開 contract へ移すルール

内部メモの内容がユーザーや operator の判断に必要になった場合は、内部ページへリンクせず、
必要な部分だけを公開可能な仕様に書き直します。

書き直すときは次を削ります。

- 非公開パス
- secret や token の名前・保存場所
- 未加工の証跡参照
- 非公開実装の具体ファイル名
- handler の配線やデプロイ手順
- payment provider 同期の実装詳細

残すべきものは、外部契約として安定した API、capability、価格、セキュリティ、
失敗時の動作だけです。

## 矛盾を避けるルール

公開ドキュメント内で内容が衝突した場合は、より具体的なリファレンスを優先します。

```text
API / pricing / legal reference
  > Cloud / Resource reference
  > Quickstart
  > overview
```

内部メモや operator runbook は公開契約を上書きしません。内部メモで決まった方針が
外部契約になる場合は、この公開ドキュメント側の該当ページも同時に更新します。

## Pricing の分離

公開 pricing page は `app.takosumi.com/docs` の hosted Cloud ドキュメントに置きます。
載せるもの:

```text
customer pays
free tier
usage prices
spend guard behavior
auto charge behavior
refund / cancellation surface
```

公開ソフトウェアドキュメント / hosted Cloud ドキュメントに載せないもの:

```text
payment provider price id
runtime price book storage
cost estimate spreadsheet
margin guard implementation
invoice export or reconciliation procedure
```

公開価格は利用者向けの契約です。運用上の同期・原価・reconciliation は
公開ドキュメントではなく operator runbook の範囲です。
