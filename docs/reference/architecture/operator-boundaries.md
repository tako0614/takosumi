# オペレーター境界 {#operator-boundaries}

> このページでわかること: operator の責務境界と kernel との接点。

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## オペレーターが制御する領域 {#operator-controlled-areas}

```text
Space creation, deletion, and membership
Space namespace registry visibility
Space export sharing
Kind alias assignment
Descriptor selection and implementation binding loading
Provider adapter attachment and credentials
Namespace registry policy, reserved/operator exports, visibility, and cross-Space sharing
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Optional DataAsset API policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

Kernel apply writes deployment-local component `publish` entries under that
operator namespace policy.

## Space 管理 {#space-administration}

Space は operator が統治する isolation 境界である。operator は次を定義する。

```text
who can deploy into the Space
which kind aliases and implementation bindings are visible
which policy pack applies
which namespace exports are visible
which operator namespaces are granted
which secrets and optional DataAssets are visible
which groups exist or may be created
```

AppSpec は Space を作成・設定しない。

## AppSpec と implementation code {#appspec-and-implementation-code}

AppSpec は `Component.kind` と namespace path を参照する。short kind alias と
implementation binding は operator が Space policy で与える。AppSpec が
component contract を宣言し、operator が対応する implementation package を Space
に見せる。

## Credential 境界 {#credential-boundary}

core canonical state は reference と handle を保存し、raw secret
値は保存しない。 外部 I/O と credential は implementation / connector / runtime
境界の内側に 留まる。secret partition は operator policy で明示共有しない限り
Space scope で ある。

## Connector 境界 {#connector-boundary}

connector は operator がインストールし、operator が管理する。
[Data Asset Model — Connector Guide](./namespace-export-model.md#connector-contract)
に従って `connector:<id>` で addressing される。AppSpec が connector を命名
する代わりに、kind URI と namespace path を宣言する。connector の可視性と
accepted DataAsset metadata は operator 統治で Space scope である。

## 本番モード {#production-mode}

本番では、必要な operator port、kind alias、implementation binding、 Space
policy が欠けた 場合 fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Kind descriptor と implementation binding の更新 {#kind-descriptor-and-plugin-updates}

kind alias と implementation binding attachment の更新は operator operation
である。 Space への visible set 変更は直列化される。deployment は自身の Space
に見える alias / implementation binding set に対して resolve する。

## Space export の共有 {#space-export-sharing}

Space を跨ぐ export sharing は予約語彙です。current v1 は Space-local export と
operator grant を基本にする。 source Space、destination Space、export
path、export snapshot id、allowed access、(あれば) expiry、policy decision
reference を持つ。Space を跨ぐ sharing はデフォルトで拒否され、instance を跨ぐ
sharing は採用しない。
