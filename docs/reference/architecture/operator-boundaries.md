# Operator Boundaries

> このページでわかること: operator の責務境界と kernel との接点。

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## Operator-controlled areas

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

## Space administration

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

manifest は Space を作成・設定しない。

## Public manifest does not install implementation code

manifest はアクティブな Space で見える catalog alias と namespace path を参照
する。implementation package を install することはない。

## Credential boundary

core canonical state は reference と handle を保存し、raw secret
値は保存しない。 外部 I/O と credential は implementation / connector / runtime
境界の内側に 留まる。secret partition は operator policy で明示共有しない限り
Space scope で ある。

## Connector boundary

connector は operator がインストールし、operator が管理する。
[DataAsset Model — Connector contract](./data-asset-model.md) に従って
`connector:<id>` で addressing される。public manifest が connector を命名
することはない。connector の可視性、acceptedKinds、signing expectation は
operator 統治で Space scope である。

## Production mode

本番では、必要な operator port、信頼 implementation、Space policy、Space catalog
割当てが欠けた場合 fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Catalog release activation

CatalogRelease の activation は直列化された operator operation である。Space
への CatalogRelease 割当ても直列化される。deployment は自身の Space に許可
された release id に対して resolve する。

## Space export sharing

Space を跨ぐ export sharing は予約語彙で、current v1 のデフォルトではない。
source Space、destination Space、export path、export snapshot id、allowed
access、(あれば) expiry、policy decision reference を持つ。Space を跨ぐ sharing
はデフォルトで拒否され、instance を跨ぐ sharing は採用しない。
