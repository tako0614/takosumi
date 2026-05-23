# Workflow 拡張設計 {#workflow-extension-design}

> このページでわかること: workflow / webhook / cron を current installer
> contract の外側に置く理由。

Takosumi kernel は workflow runner ではない。 public HTTP surface は AppSpec /
Installation / Deployment の installer lifecycle だけで、 endpoint は
`/v1/installations/*` の 5 つに閉じる。

## 境界 {#boundary}

- build は AppSpec ではなく BuildSpec / build service / CI に置く。
- webhook / cron / CI trigger / pre-post automation は kernel scope 外。
- upstream automation は source ref を選び、必要なら artifact を用意し、
  installer API に AppSpec source または resolved bundle を渡す。
- kernel は workflow-specific endpoint、trigger registration endpoint、event
  signature verification endpoint を公開しない。

## 現行 統合ポイント {#current-integration-point}

```text
external trigger / CI / scheduler
  ↓ choose source ref
  ↓ optional BuildSpec batch + artifact upload
  ↓ optional source.kind=bundle handoff
POST /v1/installations/{id}/deployments
```

新規 install では `POST /v1/installations`、 dry-run では対応する dry-run
endpoint を使う。 auth は `TAKOSUMI_INSTALLER_TOKEN`。

## 削除されたレガシーモデル {#removed-legacy-model}

過去の raw deploy route、中間 AppSpec submit、retired authoring extension strip
/ string interpolation materialization は current public contract では使わない。
AppSpec が public source of truth で、Deployment は installer lifecycle
の結果として記録 される。
