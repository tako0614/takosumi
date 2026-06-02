# コントロールプレーンアーキテクチャ {#control-plane-architecture}

→ [Installer API](../installer-api.md) / [Takosumi service](./takosumi-service.md)

## 概要 {#overview}

コントロールプレーンは Takosumi が管理する内部層であり、Installation と Deployment の状態管理、参照 API の提供、およびライフサイクルイベントの記録を担います。外部から見える public API surface は Installer API の 5 endpoint に限定されますが、コントロールプレーン内部では以下の責務を持ちます:

- **Installation 状態管理**: Space ごとの Installation record を保持し、current Deployment pointer と public status (`installing` / `ready` / `failed` / `suspended`) を追跡する
- **Deployment 履歴**: apply ごとに Deployment record を作成し、source identity、`planSnapshotDigest`、plan snapshot、binding snapshot、apply 結果を時系列で記録する。rollback は current pointer を過去の `succeeded` Deployment に戻す操作として実装される
- **ObservationState / OperationJournal**: runtime-agent が報告する現在状態の観測結果と、recovery に必要な操作履歴を保持する ([Observation の保持](../observation-retention.md) 参照)

## Takosumi service との関係 {#relationship-to-takosumi-service}

[Takosumi service](./takosumi-service.md) はコントロールプレーンの実装そのものです。Takosumi の installer pipeline が Installer API request を受け取り、Source validation、InstallPlan resolution、implementation binding への apply delegation、Deployment record の書き込みまでを一貫して実行します。コントロールプレーンという語は、この一連の状態管理と参照 API を論理層として参照するときに使います。

implementation binding (= reference `TakosumiPlugin`) は operator が Takosumi に attach する implementation であり、コントロールプレーンの一部ではありません。コントロールプレーンは kind-agnostic な状態管理に専念し、kind ごとのリソースの作成・更新は binding に委譲します。

## Read Projection と Reference Internal Surface {#internal-surfaces}

operator automation は operator 参照 API を通じて Installation / Deployment の履歴を読みます。以下の internal route は **operator tooling 向けの内部 API** であり、public Installer API (5 endpoint) には含まれません。route 名と auth scheme は operator が決め、reference Takosumi は HMAC 認証付きの以下の route を公開できます:

```text
GET /api/internal/v1/installations
GET /api/internal/v1/installations/{id}
GET /api/internal/v1/installations/{id}/deployments
GET /api/internal/v1/installations/{id}/events
```

これらは operator が dashboard や monitoring に接続するための read-only 参照 API です。tenant workload や外部 consumer が直接呼ぶことは想定していません。認証・認可の詳細は operator の設定が決定します。

## 関連ページ

- [Reference Takosumi Route Inventory](../service-http-api.md)
- [Installer API](../installer-api.md)
- [Observation の保持](../observation-retention.md)
