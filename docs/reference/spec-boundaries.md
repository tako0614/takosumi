# 仕様境界 {#spec-boundaries}

Takosumi docs は 3 つの仕様面に分かれます。これらは 1 つに混ざった仕様ではなく、owner と compatibility promise が異なる sibling contract です。

| Surface                | 答える問い                                                         |
| ---------------------- | ------------------------------------------------------------------ |
| Takosumi core          | この source を install / deploy / rollback / record できるか。     |
| Takosumi Kind カタログ | Takosumi が公開する kind / 出力データ / projection 語彙は何か。    |
| Operator profile       | この operator が提供する account layer / backend behavior は何か。 |

Kind カタログは、core 仕様に隣接する Takosumi-published vocabulary です。core manifest envelope は小さく保ち、kind、出力データ、projection、JSON-LD vocabulary は catalog docs に置きます。Takosumi Cloud などの operator profile は core と catalog contract を採用し、自分の account layer behavior を自分の docs で定義します。

## Takosumi 本体仕様 {#takosumi-core-specification}

Core は「installer は何を受け取り、何を記録するか」に答えます。compatible installer が実装する portable contract です。

入口: [Takosumi core 仕様](./core-spec.md)

Core の範囲:

- `.takosumi.yml` root shape: `apiVersion`, `metadata`, `components`
- component fields: `kind`, `spec`, `publish`, `listen`
- same-manifest publication reference: `component.publication`
- platform service reference grammar
- Installation と Deployment lifecycle
- Installer API endpoints
- source input kind と digest guard

Core は `kind`、output type name、projection name、platform service path を string として parse し、resolution の記録を保存します。kind / 出力データ / projection vocabulary は catalog が定義します。platform service path inventory は operator または product distribution spec が定義します。

Core compatibility は manifest shape、Installer API behavior、source / digest guard、Deployment record、publish/listen resolution rule に基づきます。Takosumi 公式 catalog type を使う場合は catalog compatibility が加わります。operator-owned platform service path や account layer API を使う場合は、その operator profile との compatibility が加わります。

## Takosumi Kind カタログ仕様 {#takosumi-official-type-catalog-specification}

Kind カタログは「Takosumi が component と出力データを説明するために公開する語彙は何か」に答えます。

入口: [Takosumi Kind カタログ仕様](./type-catalog.md)

Catalog の範囲:

- `https://takosumi.com/kinds/v1/worker` などの kind schema URI
- `spec`、publish の出力 vocabulary、expected な出力の型を説明する catalog の kind の定義 metadata
- `http-endpoint`、`service-binding`、`identity.oidc@v1` などの出力の型
- `env`、`secret-env`、`upstream` などの injection mode description
- access mode enum、sensitivity class、safe default access などの access metadata vocabulary
- `https://takosumi.com/contexts/v1.jsonld` と `https://takosumi.com/kinds/v1/*` の public JSON-LD catalog document

catalog entry は reusable vocabulary と JSON-LD publish の出力 metadata を説明します。publisher root、account layer URL、billing lifecycle、identity issuer policy、dashboard behavior は、その publish の出力または API を提供する operator / product distribution spec に置きます。

## Operator profile 仕様 {#operator-distribution-specifications}

Operator profile は「Takosumi core installer の周辺で、この operator はどの concrete account layer、backend、runtime behavior を提供するか」に答えます。

Takosumi Cloud は operator profile の 1 つです。normative docs は `takosumi-cloud/docs/` に置き、Takosumi docs site には入口だけを置きます: [Takosumi Cloud](./takosumi-cloud.md)

Operator profile 仕様の範囲:

- account と Space ownership record
- workload platform service path
- account layer API、dashboard、launch flow
- billing、identity、policy behavior
- Installer API 周辺の deploy / admin facade
- implementation binding / runtime implementation choice と Deployment の記録

operator profile は Takosumi Kind カタログの output type を採用できます。 catalog は reusable な出力データの型を定義し、operator docs は concrete path、 account layer lifecycle、approval flow、runtime delivery behavior を定義します。

## 置き場所の目安

| 文書が触れるもの                                                                               | normative definition の置き場所 |
| ---------------------------------------------------------------------------------------------- | ------------------------------- |
| `apiVersion`, `metadata`, `components`                                                         | Takosumi core / manifest        |
| `publish`, `listen`, `component.publication`, platform service grammar                         | Takosumi core / manifest        |
| `https://takosumi.com/kinds/v1/*`                                                              | Takosumi Kind カタログ          |
| output type と injection mode                                                                  | Takosumi Kind カタログ          |
| `https://takosumi.com/contexts/v1.jsonld` と `https://takosumi.com/kinds/v1/*` catalog JSON-LD | Takosumi Kind カタログ          |
| operator が提供する workload publication path                                                  | その operator profile spec      |
| account API、billing flow、identity issuer endpoint、dashboard route                           | その operator profile spec      |
| Installer API 周辺の deploy / admin facade                                                     | その operator profile spec      |
| implementation-specific binding loading や kind package wiring                                 | implementation docs             |

## 読む順序

1. [Takosumi core 仕様](./core-spec.md)
2. [manifest](./manifest.md)
3. concrete kind / 出力データの語彙 が必要になったら [Takosumi Kind カタログ仕様](./type-catalog.md)
4. manifest 外の 出力データを consume するときは [プラットフォームサービス](./external-publications.md)
5. operator が管理するアカウント管理の出力 や API を使うときは operator distribution docs。Takosumi Cloud は [Takosumi Cloud](./takosumi-cloud.md) から読みます。
