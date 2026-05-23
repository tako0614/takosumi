# External Descriptor Intake モデル {#external-descriptor-registry-model}

> このページでわかること: component kind descriptor と operator registry
> の境界。

Takosumi の public entrypoint は AppSpec / Installation / Deployment と
installer endpoint です。component kind の semantics は operator distribution が
descriptor と alias として取り込み、runtime behavior は implementation binding
として接続する。

`https://takosumi.com/kinds/v1/*` や `packages/plugins/spec/kinds/` の
descriptor は external reference descriptor examples である。互換実装が参照する
reusable semantic input として扱う。

## Descriptor source と runtime authority {#descriptor-source-vs-runtime-authority}

```text
Descriptor documents:
  external semantic source, often JSON-LD

Operator registry:
  select descriptors, validate shape, apply operator policy

Implementation bindings:
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
  descriptor URL -> normalized descriptor metadata

Namespace Registry:
  space-scoped namespace export path -> ExportDeclaration snapshot

Implementation Registry:
  kind URI -> provider implementation

Deployment Policy:
  allow / deny / approval defaults

DataAsset Policy:
  optional operator extension limits, if the distribution exposes DataAsset routes
```

## Descriptor ドキュメント {#descriptor-documents}

Descriptor は semantic data を定義する。runtime behavior は implementation
binding が持つ。

Descriptor family:

```text
ComponentKind
Protocol
AccessSurface
Compatibility
InputSchema
```

Implementation packaging は operator implementation 側に置く。Takosumi reference
kernel では `KernelPlugin` が descriptor identity に対応する runtime behavior を
提供する。別実装は同じ descriptor identity を別の registry / controller /
adapter に bind できる。

## AppSpec との関係 {#relationship-to-appspec}

Public v1 AppSpec は `components.<name>.kind` に opaque string を置く。URI を
直接置いてもよいし、operator が `kindAliases` で opt-in した short alias を
置いてもよい。どちらの場合も、kind の意味、input schema、provider mapping、
policy は operator distribution が与える。
