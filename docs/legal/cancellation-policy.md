# Takosumi Cloud Cancellation Policy

Takosumi Cloud の利用はいつでも停止できます。

## 月額 plan

月額 plan をキャンセルすると、次回更新以降の請求は止まります。
すでに開始した請求期間の料金は、[Refund Policy](./refund-policy.md) に定める場合を除き、
原則として返金されません。

キャンセル後も、現在の請求期間が終了するまでは plan に含まれる機能を利用できる場合があります。
請求期間終了後、managed resource の新規作成、更新、または有料実行は停止されます。

## Usage credit

購入済み credit は、Takosumi Cloud の usage balance として扱います。
credit が不足した場合、Takosumi Cloud は有料 resource の実行、deploy、AI Gateway
request、または managed resource operation を実行前に止めます。

cleanup、destroy、export など、ユーザーが作成済み resource を安全に削除または退避するための
操作は、可能な限り残高不足でも利用できるようにします。

## データと resource の整理

キャンセル前に、必要な state、outputs、logs、source URL、provider-side resource、
Object Storage data、database backup を確認してください。

Takosumi Cloud で作成した managed resource を削除する場合は、Dashboard、API、または
OpenTofu destroy flow から削除します。削除しない resource が残ると、利用可能な credit
がある間は usage が発生する場合があります。

## 問い合わせ

キャンセル、請求停止、resource cleanup に関する問い合わせは
`support@takosumi.com` へ連絡してください。
