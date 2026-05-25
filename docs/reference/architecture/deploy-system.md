# Deploy システム {#deploy-system}

Takosumi core の public concepts は **AppSpec (`.takosumi.yml`) / Installation /
Deployment** の 3 entity です。public Installer API は
[Installer API](../installer-api.md) の 5 endpoint に閉じます。

## ライフサイクル {#lifecycle}

```text
git source / prepared source archive
  └─ .takosumi.yml (= AppSpec)
      ↓ POST /v1/installations[/dry-run]
    Installation
      ↓ POST /v1/installations/{id}/deployments[/dry-run]
    Deployment
```

- AppSpec は source root の `.takosumi.yml` 1 file。
- Installation は Space 内に install された AppSpec source と current state。
- Deployment は Installation に対する apply の履歴。
- rollback は `POST /v1/installations/{id}/rollback` で過去 Deployment を入力に
  current pointer を戻す。

Deployment の apply は operator-selected execution によって実体化されます。
runtime-agent、provider connector、in-process controller などの packaging は
operator implementation の選択です。

## Workflow placement {#workflow-placement}

workflow / webhook / cron / CI runner は upstream automation として source ref
または prepared source archive を選び、Installer API に渡します。
`.takosumi.yml` が AppSpec の source of truth で、Deployment は Installer API
lifecycle の結果として記録されます。

## クロスリファレンス {#cross-references}

- [Installer API](../installer-api.md)
- [AppSpec](../app-spec.md)
- [Reference Kernel Route Inventory](../kernel-http-api.md)
