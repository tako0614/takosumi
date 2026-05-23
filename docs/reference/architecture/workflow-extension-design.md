# Workflow 拡張設計 {#workflow-extension-design}

> このページでわかること: workflow / webhook / cron を installer lifecycle の
> 前段に置く理由。

Workflow runner は installer API の前段で source ref を選び、必要なら prepared
source snapshot を作ります。kernel の public HTTP surface は AppSpec /
Installation / Deployment の installer lifecycle を扱う `/v1/installations/*` の
5 endpoint です。

## 境界 {#boundary}

- build は BuildSpec / build service / CI に置く。
- webhook / cron / CI trigger / pre-post automation は upstream automation
  に置く。
- upstream automation は source ref を選び、必要なら prepared source snapshot を
  用意し、installer API に AppSpec source または prepared source を渡す。
- upstream automation は workflow-specific endpoint、trigger registration
  endpoint、 event signature verification endpoint を持てる。

## 現行 統合ポイント {#current-integration-point}

```text
external trigger / CI / scheduler
  ↓ choose source ref
  ↓ optional BuildSpec batch + prepared source snapshot
  ↓ optional source.kind=prepared handoff
POST /v1/installations/{id}/deployments
```

新規 install では `POST /v1/installations`、 dry-run では対応する dry-run
endpoint を使う。 auth は `TAKOSUMI_INSTALLER_TOKEN`。

## Current Flow Boundary {#current-flow-boundary}

raw deploy route、中間 AppSpec submit、retired authoring extension strip /
string interpolation materialization は current flow から外れている。 AppSpec が
public source of truth で、Deployment は installer lifecycle の結果として記録
される。
