# コントロールプレーンアーキテクチャ {#control-plane-architecture}

> このページでわかること: current kernel control-plane と operator surface
> の関係。

Takosumi kernel control plane は AppSpec installer lifecycle を処理し、
Installation / Deployment / runtime dispatch evidence を永続化する。 public
contract は AppSpec (`.takosumi.yml`) / Installation / Deployment の 3 entity と
5 installer endpoint に閉じる。

## 公開契約 {#public-contract}

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

auth は `TAKOSUMI_INSTALLER_TOKEN` bearer。

## Kernel の責務 {#owned-responsibilities}

- parse / validate `.takosumi.yml`
- create and update Installation records
- record Deployment history and rollback evidence
- resolve component kind / provider decisions through operator registry
- dispatch lifecycle work to runtime-agent
- record audit / WAL / observation evidence
- expose internal ledger reads for the operator backplane

## Operator / runtime の責務 {#operator-runtime-responsibilities}

- account / subscription / identity issuer ownership
- workflow runner / webhook / cron execution
- cloud SDK credentials (runtime-agent host)
- app runtime sessions beyond launch-token / OIDC integration boundaries

## 内部 surface {#internal-surfaces}

operator automation は internal HMAC routes で ledger を読む:

```text
GET /api/internal/v1/installations
GET /api/internal/v1/installations/{id}
GET /api/internal/v1/installations/{id}/deployments
GET /api/internal/v1/installations/{id}/events
```

runtime-agent control RPC は internal route boundary に置かれ、public installer
contract は source install / deploy / rollback の 5 endpoint を提供する。

## Current surface {#current-surface}

current control-plane surface は source install / deploy /
rollback、Installation ledger、Deployment history、runtime-agent dispatch
evidence で構成される。AppSpec は authoring / runtime に分けず、local
publication / listen と kind-specific `spec` で materialization input を表す。

## クロスリファレンス {#cross-references}

- [Installer API](../installer-api.md)
- [Reference Kernel Route Inventory](../kernel-http-api.md)
- [AppSpec](../app-spec.md)
