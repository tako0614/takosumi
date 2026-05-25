# オペレーター境界 {#operator-boundaries}

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御する。

## オペレーターが制御する領域 {#operator-controlled-areas}

```text
Space creation, deletion, and membership
Space platform service registry visibility
Space publication sharing
Kind alias assignment
Descriptor selection and binding loading
Provider adapter attachment and credentials
Platform service registry policy, reserved/operator publications, visibility, and cross-Space sharing
Profile and policy packs
Secret store and Space partitions
Runtime / connector credentials
Optional asset API policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

Takosumi apply は deployment-local な component `publish` entry を retained
ResolvedPlan / implementation evidence 内の local publish の出力として記録します。
public な platform service path resolution は別の operator-owned publish
surface です。

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

manifest は `Component.kind`、local の publish の出力、local binding を参照する。外部の
出力データが必要な場合だけ platform service path で operator-owned external
publish の出力を listen する。short kind alias と binding は
operator が Space policy で与える。manifest が component intent を宣言し、
operator が対応する implementation package を Space に見せる。

## Credential 境界 {#credential-boundary}

core canonical state は reference と handle を保存し、raw secret
値は保存しない。外部 I/O と credential は implementation / connector / runtime
境界の内側に留まる。secret partition は operator policy で明示共有しない限り
Space scope である。

## Connector 境界 {#connector-boundary}

connector は operator がインストールし、operator が管理する。
[Connector Guide](../connector-contract.md) に従って reference connector
inventory id を持つ。manifest が connector を命名 する代わりに、kind URI と
publication / binding を宣言する。connector の可視性 と accepted asset
metadata は operator 統治で Space scope である。

## 本番モード {#production-mode}

本番では、必要な operator port、kind alias、binding、 Space
policy が欠けた場合 fail-closed しなければならない。本番で dev fallback
を黙って受け入れてはならない。

## Kind の定義と binding の更新 {#kind-descriptor-and-implementation-binding-updates}

kind alias と binding attachment の更新は operator operation
である。 Space への visible set 変更は直列化される。deployment は自身の Space
に見える alias / binding set に対して resolve する。

## Space publish の出力の共有 {#space-publication-sharing}

Space を跨ぐ publish の出力の sharing は予約語彙です。current v1 は Space-local
の publish の出力と operator policy visibility を基本にする。 source Space、
destination Space、publication path、publication snapshot id、allowed access、
(あれば) expiry、policy decision reference を持つ。Space を跨ぐ sharing はデフォ
ルトで拒否され、instance を跨ぐ sharing は採用しない。
