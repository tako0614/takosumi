# Takosumi を拡張する {#extending}

Takosumi の拡張は 2 種類あります。

| やりたいこと                                | 追加するもの                  |
| ------------------------------------------- | ----------------------------- |
| 採用済み kind を別 cloud / runtime で動かす | kind を実行環境に接続する設定 |
| 新しい runtime / resource の仕様を作る      | kind の定義 + 実装            |

Manifest には component の kind 名と `spec` を書きます。Takosumi は kind の値を解釈しません。kind は operator が opt-in した short alias でも、直接 URI でもよく、operator が kind URI から kind の定義と実行環境への接続を解決します。接続の渡し方は実装や operator の設定が選びます。Takosumi 互換の実装は、同じ kind URI と出力データの仕様を満たす限り、別の配線方式でも実行できます。

## 新しい kind を追加する

再利用可能な kind は安定した kind URI と kind の定義で意味を公開します。 operator はその URI に実行環境への接続を別途追加して実行可能にします。公式型カタログの定義は JSON-LD を公開形式として使います。

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://example.com/kinds/cache",
  "name": "cache",
  "spec": {
    "type": "object",
    "properties": {
      "engine": { "enum": ["redis", "valkey"] },
      "size": { "type": "string" }
    },
    "required": ["engine"]
  },
  "outputSlots": {
    "endpoint": {
      "contract": "http-endpoint",
      "exampleMaterialMapping": {
        "targets": [
          {
            "name": "default",
            "url": "$outputs.endpoint",
            "visibility": "private"
          }
        ]
      }
    }
  },
  "outputs": [
    { "name": "endpoint", "type": "string" }
  ]
}
```

Manifest 側では operator が解決できる `kind` を使います。

`exampleMaterialMapping` は kind の定義ドキュメント、生成された型、例示、ドキュメントチェックが参照する例示データです。実行時の出力データ生成は operator が選んだ接続設定が行い、結果は実装側の記録と公開 Deployment の出力データに分けて記録します。

```yaml
components:
  cache:
    kind: https://example.com/kinds/cache
    spec:
      engine: valkey
      size: small
  api:
    kind: https://example.com/kinds/worker
    connect:
      cache:
        output: cache.endpoint
        inject: env
        prefix: CACHE
```

## 実行環境への接続を追加する

接続設定は、kind の定義と出力の型 (`service-binding` 等) を具体的な backend runtime やリソースの作成・更新に結びつけます。公開仕様として共有されるのは、kind URI、kind の定義、出力の型、出力データの生成方法、Deployment に出す non-secret な出力データです。

接続設定の読み込み方法、別プロセス化、backend API への接続、credential 注入方法は実装や operator の設定が選びます。Manifest author が覚える component 語彙は `kind` / `spec` / `connect` / `listen` に閉じます。selected component output を Installation output service path declaration として記録する場合だけ root `publish` を使います。

## 確認項目

- spec のバリデーションエラーがリソースの作成・更新前に止まる。
- dry-run が changes[] と dry-run 時のハッシュ照合値を返す。cost estimate は operator のアカウント管理レスポンスとして扱う。
- apply が idempotent に成功する。
- destroy / rollback が対象 resource だけを処理する。
- secret value を log / audit / Deployment の記録に出さない。

## 関連ページ

- [Manifest](./reference/manifest.md)
- [公式型カタログ](./reference/type-catalog.md)
- [プラットフォームサービス](./reference/platform-services.md)
- [ビルドサービス境界](./reference/build-spec.md)
