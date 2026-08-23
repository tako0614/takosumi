# Takosumi hosted service SLA

このページは Takosumi hosted service の可用性目標とインシデント時の公開方針です。
一般公開ゲートを開くまでは GA 後の運用目標として扱い、ゲートを開いた時点から
`sla://takosumi-cloud/official-sla-v1` を適用します。
この技術識別子は互換性のため変更しません。

## 月間可用性目標

| 対象 | 目標 |
| --- | ---: |
| Control plane API、サインイン、Dashboard、Run受付・参照 | 99.9% |
| Stable として提供する公式 hosted capacity | 99.9% |
| AI Gateway（upstream modelを除く） | 99.5% |

可用性は UTC の暦月単位で測定します。Takosumi hosted service が原因の5xxと、
5分間隔のproduction synthetic probe失敗を対象にします。顧客コードのエラー、
4xx、顧客が設定した上限、spend guard、AUPに基づく停止、外部providerの障害は
Takosumi hosted service の停止時間に含めません。

AI Gatewayの目標はTakosumi hosted service のgateway部分に適用し、選択したAI modelや
upstream APIそのものの可用性は含みません。

## 計画メンテナンス

可用性に影響する計画メンテナンスは、原則として48時間前までに
[status.takosumi.com](https://status.takosumi.com/) で告知します。告知した
メンテナンス時間は月間可用性の算定から除外します。

緊急のセキュリティ対応や、利用者データを守るために即時対応が必要な場合は、
事前告知より安全性を優先し、開始後できるだけ早くstatus pageへ掲載します。

## インシデント通知

サービス状況の正本は
[status.takosumi.com](https://status.takosumi.com/) です。

| 重大度 | 初報の目標 | 継続更新 |
| --- | --- | --- |
| SEV-1: 広範な利用不能、重大なデータ・セキュリティ影響 | 検知から60分以内 | 原則60分ごと |
| SEV-2: 一部機能や一部利用者への重大な影響 | 検知から4時間以内 | 原則1日2回 |
| SEV-3: 限定的な影響 | 必要に応じて掲載 | 必要に応じて更新 |

SEV-1は復旧後に公開可能な範囲で原因と再発防止策をまとめます。公開情報には
Workspace、Resource、provider object、secretなどの顧客識別情報を含めません。

## サポート応答

公式窓口と受付内容は[サポート](./support.md)を参照してください。

- 通常の問い合わせ: 2営業日以内の受付確認
- productionのサインイン、請求、データexport障害: 1営業日以内の受付確認
- 営業日: 日本の祝日を除く月曜日から金曜日、JST 09:00–18:00

ここで定めるのは受付確認と状況通知の目標です。解決時間は障害の内容や
外部providerへの依存によって変わるため、固定値を約束しません。

## Service credit

本SLAは可用性とコミュニケーションの公開目標です。可用性目標を下回った場合の
金銭返金、利用料減額、または自動的なservice creditは提供しません。
個別の誤請求や重複請求はSLA creditではなく、通常の請求調査として扱います。

## 対象外

このSLAは公式のTakosumi hosted serviceだけに適用します。Takosumi OSS、
self-host環境、顧客自身のProvider Connection、顧客コード、previewまたは
experimentalと明示した機能には適用しません。
