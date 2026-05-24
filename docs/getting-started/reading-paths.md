# 読む順序 {#reading-paths}

Takosumi docs は役割ごとに読む順序を分けると追いやすくなります。最初から内部設計
や provider 実装まで読む必要はありません。

## AppSpec author

アプリを install / deploy したい人向けの順序です。

1. [クイックスタート](./quickstart.md)
2. [コンセプト](./concepts.md)
3. [AppSpec](../reference/app-spec.md)
4. [Kind Descriptor Examples](../reference/kind-registry.md)
5. 必要になったら [Build service handoff](../reference/build-spec.md)

読了後に分かること:

- `.takosumi.yml` の root field と component field
- `kind` / `spec` / `publish` / `listen` の役割
- source file path を AppSpec のどこに書くか
- build が必要な source を prepared source として渡す考え方

## Operator

Takosumi kernel を起動し、Space に Installation を受け付ける人向けの順序です。

1. [コンセプト](./concepts.md)
2. [オペレーター](../operator/index.md)
3. [セルフホスト運用](../operator/self-host.md)
4. [Operator Bootstrap](../operator/bootstrap.md)
5. [runtime-agent 分離](../operator/runtime-agent.md)
6. [Environment Variables](../reference/env-vars.md)

読了後に分かること:

- dev 起動と production 起動で固定する設定の違い
- installer token、storage、secret、provider credential の置き場所
- reference kernel に provider implementation を渡す方法
- runtime-agent を分離する判断基準

## Provider / extension author

新しい cloud / runtime / resource を Takosumi から扱いたい人向けの順序です。

1. [Takosumi を拡張する](../extending.md)
2. [Provider Implementations](../reference/providers.md)
3. [Reference Plugin Loading](../reference/plugin-loading.md)
4. [Connector Guide](../reference/connector-contract.md)
5. [Runtime-Agent API](../reference/runtime-agent-api.md)

読了後に分かること:

- kind descriptor と implementation binding の分担
- takosumi.com reference descriptor は JSON-LD で型・入出力 metadata を表すこと
- `KernelPlugin` が reference kernel の実装手段であること
- connector / runtime-agent が副作用を実行する境界

## Core contributor

Takosumi kernel の内部設計や実装を追う人向けの順序です。

1. [リファレンス索引](../reference/index.md)
2. [Reference Kernel Route Inventory](../reference/kernel-http-api.md)
3. [Lifecycle Protocol](../reference/lifecycle.md)
4. [内部設計の概要](../reference/architecture/index.md)
5. 必要に応じて [RFC / design record](../rfc/0001-kernel-kind-agnostic.md)

読了後に分かること:

- public installer API と internal/runtime-agent API の境界
- Deployment lifecycle、journal、status、risk、approval の設計
- current spec と設計履歴の置き場所
