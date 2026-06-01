# Workflow 拡張設計 {#workflow-extension-design}

Workflow runner は Installer API の前段で source ref を選び、必要なら prepared source archive を作ります。

## 境界 {#boundary}

- build は BuildSpec / build service / CI に置く。
- webhook / cron / CI trigger / pre-post automation は upstream automation に置く。
- upstream automation は source ref を選び、必要なら prepared source archive を用意し、Installer API に git / prepared / local Source を渡す。
- upstream automation は workflow-specific endpoint、trigger registration endpoint、event verification endpoint を持てる。これらは automation service の surface であり、Takosumi Installer API endpoint ではない。

## 現行統合ポイント {#current-integration-point}

```text
external trigger / CI / scheduler
  ↓ choose source ref
  ↓ optional BuildSpec batch + prepared source archive
  ↓ optional source.kind: "prepared" handoff
POST /v1/installations/{id}/deployments
```

新規 install では `POST /v1/installations`、 dry-run では対応する dry-run endpoint を使う。 auth は `TAKOSUMI_INSTALLER_TOKEN`。

## Current Flow Boundary {#current-flow-boundary}

automation は source ref または prepared source archive を選び、Installer API を呼びます。Deployment は installer lifecycle の結果として source identity、plan snapshot、binding snapshot、outputs、status を記録します。workflow 固有の trigger、verification、build orchestration は automation service の責務です。
