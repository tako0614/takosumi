# External Descriptor Registry モデル {#external-descriptor-registry-model}

Takosumi core の public concepts は AppSpec / Installation / Deployment です。
core public HTTP surface は 5 Installer API endpoint です。component kind の
semantics は operator distribution が descriptor と alias として取り込み、
runtime behavior は operator-selected execution binding として接続する。

`https://takosumi.com/kinds/v1/*` の descriptor は official catalog descriptor
documents である。operator が採用できる reusable semantic input として扱う。
`https://takosumi.com/reference/kernel/**` は reference kernel の内部
conformance metadata の identity であり、この registry model の public catalog
source では ない。

## Descriptor source と runtime authority {#descriptor-source-vs-runtime-authority}

```text
Descriptor documents:
  external semantic source, often JSON-LD

Operator registry:
  select descriptors, validate shape, apply operator policy

Execution bindings:
  descriptor URI -> provider implementation

ResolutionSnapshot:
  deployment-specific evidence recorded by the operator/kernel implementation
```

JSON-LD は descriptor の表現形式です。descriptor の取り込み、alias 採用、Space
ごとの許可は operator distribution が管理します。

## Operator registry の例 {#operator-registry-example}

operator は registry をどのように分割してもよい。以下は implementation pattern
の例です。

```text
Kind Alias Registry:
  short alias -> external kind URI

Descriptor Registry:
  catalog descriptor URI/document -> normalized descriptor metadata

External Publication Registry:
  space-scoped external publication path -> ExternalPublicationDeclaration snapshot

Execution Registry:
  kind URI -> provider implementation

Deployment Policy:
  allow / deny / approval defaults

DataAsset Policy:
  optional operator extension limits, if the distribution exposes DataAsset routes
```

## Descriptor ドキュメント {#descriptor-documents}

Descriptor は semantic data を定義する。runtime behavior は operator-selected
execution binding が持つ。

Descriptor family:

```text
ComponentKind
Protocol
AccessSurface
Compatibility
InputSchema
```

Implementation packaging は operator implementation 側に置く。Takosumi reference
implementation は descriptor identity を runtime behavior に bind するための
registry / adapter を持つ。別実装は同じ descriptor identity を別の registry /
controller / adapter に bind できる。

## AppSpec との関係 {#relationship-to-appspec}

Public v1 AppSpec は `components.<name>.kind` に opaque string を置く。URI を
直接置いてもよいし、operator が `kindAliases` で opt-in した short alias を
置いてもよい。どちらの場合も、kind の意味、input schema、provider mapping、
policy は operator distribution が与える。
