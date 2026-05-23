# Deploy システム {#deploy-system}

> このページでわかること: current Takosumi deploy lifecycle の public contract。

Takosumi の public surface は **AppSpec (`.takosumi.yml`) / Installation /
Deployment** の 3 entity に閉じる。 kernel が公開する installer API は次の 5
endpoint だけ。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

`TAKOSUMI_INSTALLER_TOKEN` が installer endpoint の bearer。 token 未設定時は
endpoint が 404 を返す。

## ライフサイクル {#lifecycle}

```text
source repo / catalog / local source
  └─ .takosumi.yml (= AppSpec)
      ↓ POST /v1/installations[/dry-run]
    Installation
      ↓ POST /v1/installations/{id}/deployments[/dry-run]
    Deployment
      ↓ internal lifecycle dispatch
    runtime-agent / provider connector
```

- AppSpec は source root の `.takosumi.yml` 1 file。
- Installation は Space 内に install された AppSpec source と current state。
- Deployment は Installation に対する apply / rollback の履歴。
- rollback は `POST /v1/installations/{id}/rollback` で過去 Deployment を入力に
  新しい Deployment を作る。

## 非ゴール {#non-goals}

kernel は workflow / webhook / cron / CI runner の public route を持たない。
これらは upstream automation が AppSpec source を installer API に渡す形で実装
する。

過去 docs の `.takosumi/app.yml`、中間 deployment document、 public raw deploy
endpoint は廃止済み。 current public contract では登場しない。

## クロスリファレンス {#cross-references}

- [Installer API](../installer-api.md)
- [AppSpec](../app-spec.md)
- [Kernel HTTP API](../kernel-http-api.md)
- [AppSpec](../app-spec.md)
