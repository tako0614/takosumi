# Reference Metadata モデル {#external-descriptor-registry-model}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) と [Platform Services](../platform-services.md) を参照。
:::

Takosumi v1 は Source DSL や mandatory kind catalog を要求しません。`https://takosumi.com/kinds/v1/*` の JSON-LD documents は reference adapter metadata であり、operator が採用できる reusable semantic input です。Source authoring vocabulary ではありません。

## Metadata source と runtime authority {#descriptor-source-vs-runtime-authority}

```text
Reference metadata documents:
  optional semantic / validation input for reference adapters

Operator registry:
  PlatformService inventory, visibility, policy, ownership, credentials

Execution bindings:
  service capability / adapter metadata -> implementation binding

Deployment record:
  source summary, plan snapshot, binding snapshot, outputs, status
```

JSON-LD は reference adapter metadata の表現形式です。metadata の採用、Space ごとの許可、implementation binding、provider credentials は operator distribution が管理します。

## Operator registry の例 {#operator-registry-example}

operator は registry をどのように分割してもよい。以下は implementation pattern の例です。

```text
PlatformService Registry:
  space-scoped service capability records

Reference Metadata Registry:
  optional adapter metadata documents adopted by the operator

Execution Registry:
  selected service / adapter identity -> implementation binding

Deployment Policy:
  allow / deny / approval defaults

Asset Policy:
  optional operator extension limits, if the distribution exposes asset routes
```

## Reference metadata documents {#descriptor-documents}

Reference metadata は runtime behavior そのものではありません。runtime behavior は operator-selected execution binding が持ちます。

Reference metadata が表せるもの:

```text
adapter identity
optional validation metadata
material helper vocabulary
projection helper vocabulary
compatibility hints
```

Implementation packaging は operator implementation 側に置きます。Takosumi reference implementation は metadata identity を runtime behavior に bind するための registry / adapter を持てます。別実装は同じ Installer API と Deployment record を保ったまま、別の registry / controller / adapter に bind できます。

## Source との関係 {#relationship-to-source}

Source repo は Takosumi 専用 metadata field、component kind、provider selector、root publication を書きません。Source identity は git / prepared / local input から決まり、依存先は operator PlatformService inventory と install / deploy request の binding selection から決まります。

Reference metadata は operator が resolution と validation を実装するときの補助です。公開 v1 contract の正本は Source / Installation / Deployment / PlatformService と Installer API です。
