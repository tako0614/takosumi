# アクセスモード {#access-modes}

access mode は operator catalog が PlatformService binding に付ける権限の強さ
です。Takosumi core は enum の意味を wire record として扱い、どの binding に
どの access を許すかは operator policy が決めます。

```text
read | read-write | admin | invoke-only | observe-only
```

## Meaning

| Mode           | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `read`         | state / metadata の参照だけを許す。mutation credential は渡さない。     |
| `read-write`   | primary state surface の read と mutation を許す。lifecycle 管理は別。  |
| `admin`        | provider が許す管理操作を含む。default にはならず approval 対象。       |
| `invoke-only`  | invocation surface だけを呼べる。蓄積 state の直接 read はできない。    |
| `observe-only` | metrics / event / notification を受けるだけ。直接操作はできない。      |

## Resolution

access mode は Source に書かれた Takosumi DSL ではなく、次の入力から operator
catalog resolver が決めます。

- install / deploy request の `BindingSelection`
- account-plane UI の選択
- operator policy pack
- PlatformService inventory の safe default
- approval workflow の結果

resolved access は Deployment の `bindingsSnapshot` に保存します。`read-write` と
`admin` は明示 selection または approval を必要とする扱いにします。

## Related

- [プラットフォームサービス](./platform-services.md)
- [Installer API](./installer-api.md)
