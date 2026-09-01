# Data endpoints

> **歴史資料（アーカイブ）— 現行の正本ではありません。** このページは退役した
> Takosumi Cloud の計画・実装を記録したものです。現行の availability、pricing、SLA、
> support、production authority を示しません。Takosumi Hosted が新しい
> retail/commerce/client composition docs を所有し、managed supply、capacity、provider
> credential、Offering は Takoserver が所有します。本文は歴史的証拠として保持しており、
> 現行サービスの根拠に使わないでください。

Takosumi Cloud は既存の service instance に標準 protocol で接続する data endpoint を提供
できます。endpoint は object の lifecycle API ではありません。作成、更新、削除は Git
repository の OpenTofu provider graph で行います。

## Endpoint discovery

endpoint URL、audience、必要な permission は Run の Output または authorized Interface
から取得します。base URL や tenant hostname を推測しないでください。

認証済み Cloud catalog は現在利用できる protocol family を返します。

```bash
curl https://app.takosumi.com/v1/cloud/catalog \
  -H "authorization: Bearer $TAKOSUMI_CLOUD_API_KEY"
```

通常の Cloud API key、S3 access key、runtime Interface credential は別の authority です。
相互に使い回しません。

## S3-compatible object access

Base path: `/compat/s3/v1`

S3 client は、その bucket に対して発行された access key を AWS Signature Version 4 で
使用します。通常の Takosumi Cloud API key は S3 secret access key ではありません。

```text
endpoint: https://app.takosumi.com/compat/s3/v1
authentication: AWS SigV4
```

この path は既存 bucket 内の object を読み書きするためのものです。bucket の create/delete
や provider state の変更は行いません。bucket lifecycle は repository の provider graph が
所有します。

## OpenAI-compatible AI access

Base path: `/gateway/ai/v1`

OpenAI-compatible client は、その AI service / Interface に許可された bearer credential を
使用します。

```text
base URL: https://app.takosumi.com/gateway/ai/v1
authentication: Bearer
```

model availability、limits、price は Cloud catalog と [Pricing](./pricing.md) を確認して
ください。この endpoint は model resource や provider configuration を作成しません。

## API keys

Account settings で Cloud API key を作成し、表示された secret を一度だけ保存します。
automation では最小 scope と一つの Workspace を選びます。secret は repository、OpenTofu
state、Output、Interface document に書きません。

data endpoint 固有の credential は、対応する service の Interface / credential flow から
取得します。Cloud API key を data-plane credential へ変換しません。

## Billing and failure behavior

有料 request は backend call 前に Workspace、permission、availability、credit、quota を確認
します。未構成、権限不足、残高不足は安全側に停止し、別 service へ自動 fallback しません。

retryable error でも、同じ logical request を重複課金・重複 mutation しない fence が必要です。
backend outcome が不明な場合は成功を返さず、同じ request identity で recovery します。

問題が続く場合は response の request ID を [Support](./support.md) へ添えてください。secret、
access key、Authorization header は送らないでください。
