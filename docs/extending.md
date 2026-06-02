# Takosumi を拡張する {#extending}

Takosumi v1 の拡張は operator integration です。source repo に Takosumi 専用 DSL を増やすことではありません。

| やりたいこと | 所有者 |
| --- | --- |
| DB / OIDC / bucket / queue などを使える service として出す | operator PlatformService inventory |
| OpenTofu output を inventory に取り込む | operator distribution importer |
| workload runtime へ credential / endpoint を渡す | runtime-agent handler / backend adapter |
| account / billing / dashboard / deploy facade を出す | operator distribution |

## PlatformService importer

OpenTofu output、HCP Stacks publish output、remote state、cloud API、static config などを読み、operator inventory に
PlatformService を登録します。

```json
{
  "path": "data.primary.postgres",
  "kind": "postgres",
  "labels": { "tier": "primary" },
  "material": {
    "host": "db.example.internal",
    "port": 5432,
    "credentialRef": "secret:postgres-primary"
  }
}
```

## Runtime handler

runtime-agent handler は selected PlatformService material や Deployment source summary を読み、operator が選んだ runtime
へ env、mount、secret reference、gateway target などを渡します。

Runtime handler は implementation detail です。Takosumi の public v1 は Source / Installation / Deployment /
PlatformService と Installer API に閉じます。

## OpenTofu との境界

OpenTofu provider を Takosumi-specific adapter で再実装しません。OpenTofu が state を持つべき resource は operator layer で
materialize し、Takosumi は output inventory を参照します。

## 確認項目

- provider credential を Takosumi に入れない。
- raw secret value を Deployment output / log / audit に出さない。
- inventory importer は deterministic な service path / labels を出す。
- binding resolver は absent / ambiguous / policy denied を apply 前に止める。
- runtime handler は selected binding snapshot を説明できる evidence を残す。

## 関連ページ

- [仕様境界](./reference/spec-boundaries.md)
- [プラットフォームサービス](./reference/platform-services.md)
- [Installer API](./reference/installer-api.md)
