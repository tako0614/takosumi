# 次のステップ {#next-steps}

[クイックスタート](./quickstart.md) で Installation を作ったあとの追加手順です。

## PlatformService binding を選ぶ {#select-platform-service-bindings}

DB や OIDC issuer などは operator inventory の PlatformService として選びます。source repo に Takosumi 専用 DSL を追加するの
ではなく、install / deploy request、operator dashboard、policy で binding selection を渡します。

```json
{
  "bindings": [
    {
      "name": "db",
      "serviceKind": "postgres",
      "labels": { "tier": "primary" },
      "required": true
    }
  ]
}
```

CLI での binding flag は operator distribution が提供する deploy facade の責務です。core Installer API の shape は
[Installer API](../reference/installer-api.md) と [プラットフォームサービス](../reference/platform-services.md) を参照してください。

## 更新と rollback を試す {#update-and-roll-back}

source を変更したら、既存 Installation に次の Deployment を apply します。

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

dry-run から apply へ進む場合は `--expected-plan-snapshot-digest` と必要な source pin を渡します。

```bash
takosumi deploy dry-run inst_... --source "$APP_ROOT"
takosumi deploy inst_... --source "$APP_ROOT" \
  --expected-current-deployment-id dep_... \
  --expected-plan-snapshot-digest sha256:...
```

前の Deployment に戻すには、戻したい Deployment の id を指定します。rollback は current pointer を戻す操作で、workload data
や provider resource を汎用 rollback しません。

```bash
takosumi rollback inst_... dep_...
```

## 次に読む

- [Installer API](../reference/installer-api.md)
- [プラットフォームサービス](../reference/platform-services.md)
- [仕様境界](../reference/spec-boundaries.md)
