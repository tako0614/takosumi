# オペレーター境界 {#operator-boundaries}

> このページでわかること: operator の責務境界と kernel との接点。

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## オペレーターが制御する領域 {#operator-controlled-areas}

```text
Space creation, deletion, and membership
Space catalog release assignment
Space namespace registry visibility
Space export sharing
CatalogRelease activation
Descriptor ingestion and trust
Namespace registry writes
Implementation registry
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Artifact policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

## Space 管理 {#space-administration}

Space は operator が統治する isolation 境界である。operator は次を定義する。

```text
who can deploy into the Space
which CatalogRelease ids are allowed
which policy pack applies
which namespace exports are visible
which operator namespaces are granted
which secrets and artifacts are visible
which groups exist or may be created
```

AppSpec は Space を作成・設定しない。

## AppSpec は implementation コードをインストールしない {#appspec-does-not-install-implementation-code}

AppSpec はアクティブな Space で見える catalog alias と namespace path を参照
する。implementation package を install することはない。

## Credential 境界 {#credential-boundary}

core canonical state は reference と handle を保存し、raw secret
値は保存しない。 外部 I/O と credential は implementation / connector / runtime
境界の内側に 留まる。secret partition は operator policy で明示共有しない限り
Space scope で ある。

## Connector 境界 {#connector-boundary}

connector は operator がインストールし、operator が管理する。
[Data Asset Model — Connector contract](./namespace-export-model.md#connector-contract)
に従って `connector:<id>` で addressing される。AppSpec が connector を命名
することはない。connector の可視性、acceptedKinds、signing expectation は
operator 統治で Space scope である。

## 本番モード {#production-mode}

本番では、必要な operator port、信頼 implementation、Space policy、Space catalog
割当てが欠けた場合 fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Catalog release の activation {#catalog-release-activation}

CatalogRelease の activation は直列化された operator operation である。Space
への CatalogRelease 割当ても直列化される。deployment は自身の Space に許可
された release id に対して resolve する。

## Space export の共有 {#space-export-sharing}

Space を跨ぐ export sharing は予約語彙で、current v1 のデフォルトではない。
source Space、destination Space、export path、export snapshot id、allowed
access、(あれば) expiry、policy decision reference を持つ。Space を跨ぐ sharing
はデフォルトで拒否され、instance を跨ぐ sharing は採用しない。
