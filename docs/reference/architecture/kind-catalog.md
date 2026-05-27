# 公式型カタログモデル {#external-descriptor-registry-model}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

Component kind の semantics は operator の設定が kind の定義と alias として取り込み、 runtime behavior は operator-selected execution binding として接続する。

`https://takosumi.com/kinds/v1/*` の kind の定義は official catalog の documents である。operator が採用できる reusable semantic input として扱う。 `https://takosumi.com/reference/kernel/**` は reference Takosumi の内部 conformance metadata の identity であり、この registry model の public catalog source ではない。

## Kind の定義のソースと runtime authority {#descriptor-source-vs-runtime-authority}

```text
Kind の定義 (descriptor documents):
  external semantic source, often JSON-LD

Operator registry:
  select kind definitions, validate shape, apply operator policy

Execution bindings:
  kind URI -> implementation binding

ResolvedPlan:
  deployment-specific evidence recorded by the operator/Takosumi implementation
```

JSON-LD は kind の定義の表現形式です。kind の定義の取り込み、alias 採用、Space ごとの許可は operator の設定が管理します。

## Operator registry の例 {#operator-registry-example}

operator は registry をどのように分割してもよい。以下は implementation pattern の例です。

```text
Kind Alias Registry:
  short alias -> external kind URI

Descriptor Registry:
  catalog descriptor URI/document -> normalized descriptor metadata

Platform Service Registry:
  space-scoped platform service path -> PlatformServiceDeclaration snapshot

Execution Registry:
  kind URI -> implementation binding

Deployment Policy:
  allow / deny / approval defaults

asset Policy:
  optional operator extension limits, if the distribution exposes asset routes
```

## Kind の定義ドキュメント {#descriptor-documents}

Kind の定義は semantic data を表す。runtime behavior は operator-selected execution binding が持つ。

Kind の定義の family:

```text
ComponentKind
Protocol
AccessSurface
Compatibility
InputSchema
```

Implementation packaging は operator implementation 側に置く。Takosumi reference implementation は kind の定義の identity を runtime behavior に bind するための registry / adapter を持つ。別実装は同じ kind の定義の identity を別の registry / controller / adapter に bind できる。

## Manifest との関係 {#relationship-to-appspec}

Public v1 manifest は `components.<name>.kind` に不透明な string を置く。URI を直接置いてもよいし、operator が `kindAliases` で opt-in した short alias を置いてもよい。どちらの場合も、kind の意味、input schema、implementation binding、policy は operator の設定が与える。
