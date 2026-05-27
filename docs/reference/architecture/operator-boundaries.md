# オペレーター境界 {#operator-boundaries}

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## オペレーターが制御する領域 {#operator-controlled-areas}

```text
Space creation, deletion, and membership
Space platform service registry visibility
Future cross-Space service sharing policy
Kind alias assignment
Descriptor selection and binding loading
Backend adapter attachment and credentials
Platform service registry policy, reserved/operator services, visibility, and future cross-Space sharing
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Optional asset API policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

Takosumi apply は component output と root `publish` entry を retained
ResolvedPlan / implementation evidence 内の local output evidence として記録します。
root `publish` は選ばれた component output を Installation output service path
exposure として宣言する manifest surface である。operator-owned platform service registry
は manifest 外 service entry の visibility と snapshot を管理する別 surface です。

## Space 管理 {#space-administration}

Space は operator が統治する isolation 境界である。operator は次を定義する。

```text
who can deploy into the Space
which kind aliases and bindings are visible
which policy pack applies
which platform services are visible
which platform services are visible and authorized
which secrets and optional assets are visible
which groups exist or may be created
```

manifest は Space を作成・設定しない。

## Manifest と implementation code {#appspec-and-implementation-code}

manifest は `Component.kind`、same-manifest の `connect.<binding>.output`、
platform service の `listen.<binding>.path`、root `publish` を宣言する。外部の
出力データが必要な場合だけ operator-owned platform service path を listen する。
short kind alias と binding は operator が Space policy で与える。manifest が
component intent を宣言し、 operator が対応する implementation package を Space
に見せる。

## Credential 境界 {#credential-boundary}

core canonical state は reference と handle を保存し、raw secret
値は保存しない。外部 I/O と credential は implementation / connector / runtime
境界の内側に留まる。secret partition は operator policy で明示共有しない限り
Space scope である。

## Connector 境界 {#connector-boundary}

connector は operator がインストールし、operator が管理する。
[Connector Guide](../connector-contract.md) に従って reference connector
inventory id を持つ。manifest が connector を命名する代わりに、kind URI と
connect/listen binding を宣言する。connector の可視性と accepted asset metadata
は operator 統治で Space scope である。

## 本番モード {#production-mode}

本番では、必要な operator port、kind alias、binding、 Space policy が欠けた場合
fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Kind の定義と binding の更新 {#kind-descriptor-and-implementation-binding-updates}

kind alias と binding attachment の更新は operator operation である。 Space への
visible set 変更は直列化される。deployment は自身の Space に見える alias /
binding set に対して resolve する。

## Cross-Space service sharing {#cross-space-service-sharing}

Space を跨ぐ service sharing は future RFC scope です。current v1 は Space-local
の component output、root publish、operator policy visibility を基本にする。
将来 RFC が導入する場合は source Space、destination Space、platform service path、
service snapshot id、allowed access、expiry、policy decision reference をまとめて
定義する。Space を跨ぐ sharing はデフォルトで拒否され、instance を跨ぐ sharing
は採用しない。
