# オペレーター境界 {#operator-boundaries}

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## オペレーターが制御する領域 {#operator-controlled-areas}

```text
Space creation, deletion, and membership
Space external publication registry visibility
Space publication sharing
Kind alias assignment
Descriptor selection and implementation binding loading
Provider adapter attachment and credentials
External publication registry policy, reserved/operator publications, visibility, and cross-Space sharing
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Optional DataAsset API policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

Kernel apply records deployment-local component `publish` entries as local
publications in retained ResolutionSnapshot / implementation evidence. Public
external publication path resolution is a separate operator-owned publication
surface.

## Space 管理 {#space-administration}

Space は operator が統治する isolation 境界である。operator は次を定義する。

```text
who can deploy into the Space
which kind aliases and implementation bindings are visible
which policy pack applies
which external publications are visible
which external publications are granted
which secrets and optional DataAssets are visible
which groups exist or may be created
```

AppSpec は Space を作成・設定しない。

## AppSpec と implementation code {#appspec-and-implementation-code}

AppSpec は `Component.kind`、local publication、local binding を参照する。外部
material が必要な場合だけ external publication path で operator-owned external
publication を listen する。short kind alias と implementation binding は
operator が Space policy で与える。AppSpec が component contract
を宣言し、operator が対応する implementation package を Space に見せる。

## Credential 境界 {#credential-boundary}

core canonical state は reference と handle を保存し、raw secret
値は保存しない。外部 I/O と credential は implementation / connector / runtime
境界の内側に留まる。secret partition は operator policy で明示共有しない限り
Space scope である。

## Connector 境界 {#connector-boundary}

connector は operator がインストールし、operator が管理する。
[Connector Guide](../connector-contract.md) に従って reference connector
inventory id を持つ。AppSpec が connector を命名 する代わりに、kind URI と
publication / binding を宣言する。connector の可視性 と accepted DataAsset
metadata は operator 統治で Space scope である。

## 本番モード {#production-mode}

本番では、必要な operator port、kind alias、implementation binding、 Space
policy が欠けた場合 fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Kind descriptor と implementation binding の更新 {#kind-descriptor-and-implementation-binding-updates}

kind alias と implementation binding attachment の更新は operator operation
である。 Space への visible set 変更は直列化される。deployment は自身の Space
に見える alias / implementation binding set に対して resolve する。

## Space publication の共有 {#space-publication-sharing}

Space を跨ぐ publication sharing は予約語彙です。current v1 は Space-local
publication と operator grant を基本にする。 source Space、destination
Space、publication path、publication snapshot id、allowed access、(あれば)
expiry、policy decision reference を持つ。Space を跨ぐ sharing
はデフォルトで拒否され、instance を跨ぐ sharing は採用しない。
