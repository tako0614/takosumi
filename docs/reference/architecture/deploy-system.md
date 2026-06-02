# Deploy System {#deploy-system}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

## Lifecycle {#lifecycle}

```text
git source / prepared source archive / local source
  ↓ POST /v1/installations[/dry-run]
Installation
  ↓ POST /v1/installations/{id}/deployments[/dry-run]
Deployment
```

- Source は git / prepared / local のいずれか。
- Installation は Space 内に install された source record と current Deployment pointer。
- Deployment は Installation に対する apply 履歴。
- rollback は `POST /v1/installations/{id}/rollback` で current pointer を保持済み Deployment に戻す。

Deployment の runtime side effect は operator-selected execution によって実体化されます。runtime-agent、backend connector、in-process controller、OpenTofu workflow などの packaging は operator implementation の選択です。

## Workflow Placement {#workflow-placement}

workflow / webhook / cron / CI runner は upstream automation として source ref または prepared source archive を選び、Installer API に渡します。Takosumi は build workflow を所有せず、Source identity、`InstallPlan` snapshot、`planSnapshotDigest`、Deployment record を保存します。

## Cross References {#cross-references}

- [Installer API](../installer-api.md)
- [Takosumi v1](../takosumi-v1.md)
- [Reference Takosumi Route Inventory](../service-http-api.md)
