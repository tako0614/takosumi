# Takosumi Kind カタログ仕様 {#type-catalog}

Takosumi は `takosumi.com` から reusable な kind の定義 / output type の語彙を公開します。Kind カタログは core 仕様に隣接する別章です。Takosumi Cloud などの operator profile は、自分の docs で catalog vocabulary を採用します。operator はこれらの kind の定義をそのまま採用したり、short alias を対応付けたり、provider policy で拡張したり、別 domain の catalog を採用したりできます。

このページは catalog specification です。Takosumi type vocabulary、kind の定義 identity、output type name、projection-family name、公式カタログの JSON-LD publish format を定義します。

## 規定範囲

Kind カタログの範囲:

- `https://takosumi.com/kinds/v1/*` 配下の kind の定義 identity
- `spec`、publish slot、publish vocabulary、expected な出力の型を説明する kind の定義 metadata field
- `http-endpoint`、`service-binding`、`object-store`、`identity.oidc@v1`、 `billing.port@v1` などの output type name
- `env`、`secret-env`、`upstream`、`config-mount` などの projection-family name
- access mode enum、sensitivity class、safe default access などの access metadata vocabulary
- `https://takosumi.com/kinds/v1/*` の JSON-LD kind schema document と `https://takosumi.com/contexts/v1.jsonld` の context document

catalog は reusable な出力データの型の vocabulary を定義します。concrete external publish の出力 path、OIDC issuer operation、billing behavior、account layer record、provider provisioning、dashboard API は、その vocabulary を採用する operator profile spec に置きます。

operator profile は kind の有効化を管理します。Space で見える catalog entry、 active alias、kind の定義を実装する provider / local runtime、operator が offer する platform service path を operator profile が決めます。

## Catalog の役割

| Role                 | Example                                         | 意味                                                |
| -------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Kind schema          | `https://takosumi.com/kinds/v1/worker`          | component `kind` schema と publish vocabulary。     |
| Output type          | `http-endpoint`                                 | `publish.<name>.as` が offer する出力の型。         |
| Injection mode       | `env`, `secret-env`, `upstream`, `config-mount` | listened な出力データを consumer に渡す形式。       |
| External output type | `identity.oidc@v1`                              | platform service 用の reusable な出力の型。         |
| Access metadata      | `invoke-only`, `restricted`                     | external material の access / projection metadata。 |

manifest は `kind`、`publish.<name>.as`、`listen.<binding>.as` などの catalog reference を string として記録します。operator resolution が kind の定義 semantics を接続し、Space で見える catalog entry を選び、それを実現する binding を選びます。

## 公式 catalog kind schema

現在の `takosumi.com` v1 catalog descriptor です。これは closed built-in kind set ではありません。operator は別の descriptor URI も採用できます。

| Suggested alias | Kind URI                                     | Typical publication               |
| --------------- | -------------------------------------------- | --------------------------------- |
| `worker`        | `https://takosumi.com/kinds/v1/worker`       | `http` as `http-endpoint`         |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`  | `http` as `http-endpoint`         |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`     | `connection` as `service-binding` |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store` | `bucket` as `object-store`        |
| `gateway`       | `https://takosumi.com/kinds/v1/gateway`      | `public` as `http-endpoint`       |

kind short alias は operator-selected convenience です。URI が descriptor identity です。descriptor document は `referenceAliases` を suggestion として publish できますが、alias を有効にするのは operator profile です。

## Output type

Output type は `publish.<name>.as` または platform service declaration が offer する出力データの portable shape を定義します。publisher path、provider resource、dashboard route、account layer lifecycle は、その出力データを offer する operator / product distribution spec に置きます。

| Contract           | Public / non-secret fields                                                                                                                                                                                                                             | Secret refs                                               | Typical projections               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------- |
| `http-endpoint`    | callable upstream の `targets[]` と optional public `endpoints[]`。target は `url` または `protocol` / `host` / `port` / `basePath` を持てる。endpoint は `url`, `scheme`, `host`, `listener`, `visibility`, `primary`, optional `routes[]` を持てる。 | none                                                      | `upstream`, `env`, `config-mount` |
| `service-binding`  | `service`, `protocol`, `host`, `port`, `database`, optional `username`, `connectionUrl`, `caCertRef`                                                                                                                                                   | `passwordRef`, token refs                                 | `secret-env`, `config-mount`      |
| `object-store`     | `bucket`, `endpoint`, `region`, `pathStyle`, optional `publicBaseUrl`, policy refs                                                                                                                                                                     | `accessKeyIdRef`, `secretAccessKeyRef`, `sessionTokenRef` | `secret-env`, `config-mount`      |
| `event-channel`    | `channel`, `protocol`, endpoint / topic / queue / stream identity, delivery policy refs                                                                                                                                                                | producer / consumer credential refs                       | `secret-env`, `config-mount`      |
| `identity.oidc@v1` | issuer URL, discovery URL, client id, redirect / callback origin, optional public JWKS / discovery refs                                                                                                                                                | `clientSecretRef`                                         | `secret-env`, `config-mount`      |
| `billing.port@v1`  | billing portal URL, usage report endpoint, billing subject ref                                                                                                                                                                                         | `meteringCredentialRef`                                   | `secret-env`, `config-mount`      |

`http-endpoint` は callable HTTP material を表します。workload publication は通常 `targets[]` を出し、gateway / ingress publication は通常 `endpoints[]` を出します。1 つの material には `targets[]` または `endpoints[]` の少なくとも一方が必要です。public reachability は publisher と materialization result の property です。たとえば `web.http` は upstream HTTP material、`public.public` は gateway / ingress component が作る public endpoint material になれます。

Compact schema:

```yaml
http-endpoint:
  publicFields:
    targets[]:
      required: false
      fields: { name, url, protocol, host, port, basePath, visibility }
    endpoints[]:
      required: false
      fields: { url, scheme, host, listener, visibility, primary, routes[] }
  requires: at least one of targets[] or endpoints[]
  secretRefs: []
  allowedProjections: [upstream, env, config-mount]

service-binding:
  publicFields: { service, protocol, host, port, database, username, connectionUrl, caCertRef }
  secretRefs: [passwordRef, tokenRef]
  allowedProjections: [secret-env, config-mount]

object-store:
  publicFields: { bucket, endpoint, region, pathStyle, publicBaseUrl, policyRefs }
  secretRefs: [accessKeyIdRef, secretAccessKeyRef, sessionTokenRef]
  allowedProjections: [secret-env, config-mount]

event-channel:
  publicFields: { channel, protocol, endpoint, deliveryPolicyRefs }
  secretRefs: [producerCredentialRef, consumerCredentialRef]
  allowedProjections: [secret-env, config-mount]

identity.oidc@v1:
  publicFields: { issuerUrl, discoveryUrl, clientId, redirectOrigin, jwksRef }
  secretRefs: [clientSecretRef]
  allowedProjections: [secret-env, config-mount]

billing.port@v1:
  publicFields: { portalUrl, usageReportEndpoint, billingSubjectRef }
  secretRefs: [meteringCredentialRef]
  allowedProjections: [secret-env, config-mount]
```

`identity.oidc@v1` と `billing.port@v1` は platform service 用の neutral な出力の型です。catalog は workload が受け取れる field を名付けます。issuer operation、 client lifecycle、redirect policy、billing account lifecycle、usage authorization、payment-provider integration、concrete publish の出力 path は、その出力データを offer する operator / product distribution が定義します。

`ref` field は operator-owned reference string です。operator projection や retained evidence の stable handle であり、raw secret value ではありません。

Public Deployment output と operator の参照 API は non-secret field と refs だけを公開します。raw password、client secret、payment-provider credential、bearer token、 generated private key は ref で表し、operator-approved runtime secret mechanism だけで delivery します。

## Injection mode

Injection mode は listened output type を consumer component に提示する形式です。 manifest は selected family を `listen.<binding>.as` に記録し、selected な kind の定義と operator policy が compatibility をリソースの作成・更新前に検証します。

| Injection mode | Meaning                                                                                    | Safety rule                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `env`          | public / non-secret config を binding `prefix` 付き environment variable として渡す。      | public / non-secret field だけに有効。required secret ref を持つ material には使わない。     |
| `secret-env`   | public config と secret ref を operator secret backend 経由で runtime environment に渡す。 | public record には ref だけを残し、raw secret value は workload runtime だけに inject する。 |
| `upstream`     | HTTP endpoint material を ingress / router / upstream binding に接続する。                 | upstream routing material を受け入れる `http-endpoint` consumer slot に有効。                |
| `config-mount` | public config と refs を mounted config file、volume、SDK config object として渡す。       | mount path と file shape は descriptor-owned で、selected binding が検証する。               |

Projection compatibility:

| Output type        | `env`                                      | `secret-env` | `upstream`                     | `config-mount` |
| ------------------ | ------------------------------------------ | ------------ | ------------------------------ | -------------- |
| `http-endpoint`    | public / non-secret endpoint data なら有効 | invalid      | upstream-capable slot なら有効 | valid          |
| `service-binding`  | invalid                                    | valid        | invalid                        | valid          |
| `object-store`     | invalid                                    | valid        | invalid                        | valid          |
| `event-channel`    | invalid                                    | valid        | invalid                        | valid          |
| `identity.oidc@v1` | invalid                                    | valid        | invalid                        | valid          |
| `billing.port@v1`  | invalid                                    | valid        | invalid                        | valid          |

consumer slot metadata と operator policy は、syntactically valid な組み合わせを particular component では invalid にできます。secret-bearing な出力の型は default で `env: invalid` です。secretless public config を env projection したい場合は、別の env-safe output type または explicit operator profile extension を定義します。

## Consumer slot metadata

kind の定義は manifest field を増やさずに `listen` binding slot の受け入れ条件を説明できます。この metadata は validation と docs のための catalog vocabulary です。generated helpers は現在、spec/output/publication alias を中心に扱い、consumer slot metadata は catalog document の正本を参照します。

official `worker` / `web-service` descriptor の wildcard listen slot は `http-endpoint` も受け取れます。workload 間の内部 HTTP 接続は、publisher が `publish.<name>.as: http-endpoint` を出し、consumer が `listen.<binding>.from` でそれを参照します。base URL のような public config として渡す場合は `as: env`、gateway / router の upstream binding として渡す場合は `as: upstream` を使います。secret-bearing output type は上の compatibility table が優先されるため、`service-binding` / `object-store` / `identity.oidc@v1` / `billing.port@v1` を plain `env` に落とすことは valid ではありません。

| Descriptor metadata                       | Meaning                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `listens.<slot>.accepts`                  | `http-endpoint` など、この consumer slot が受け入れる output type。           |
| `listens.<slot>.projectionFamilies`       | `upstream` や `secret-env` など、この slot が受け入れる injection mode。      |
| `listens.<slot>.minimumAccess`            | `read` や `invoke-only` など、material に必要な minimum access mode。         |
| `listens.<slot>.safeDefaultAccess`        | operator policy が stronger access mode を選ぶ前の default access。           |
| `listens.<slot>.requiredWhenReferencedBy` | 指定された `spec` field が binding key を参照するとき required とみなす条件。 |

operator は kind の定義 metadata、Space policy、platform service declaration を組み合わせます。manifest は access-mode field を持ちません。`listen.from` と `listen.as` を選び、kind の定義 metadata、publish の出力 declaration、policy から access を解決します。

## Gateway portable subset

operator が official `gateway` kind の定義を採用する場合、その定義は portable HTTP ingress vocabulary を公開します。`spec.listeners` map は named HTTP / HTTPS listener を宣言し、`spec.routes` array は listener と local `listen` binding name を接続します。

Portable v1 route semantics:

- `routes[].to` は local `listen` binding key。output type や URL ではない。
- `routes[].path` は HTTP path prefix。`/` または `/` で始まる string。
- `routes[].path` は configuration path string。full URL ではない。`?`、`#`、 NUL、empty string、別 path に変わる segment escape は invalid。
- matching は URL path だけを使い、query string と fragment は除外する。
- matching は case-sensitive。percent-decoding や path normalization の前の URL path string を比較する。
- percent-encoded octet は literal に比較する。`%2F` は `/` として扱わない。
- `/` は全 path に match する。`/api` は `/api` と `/api/...` に match し、 `/apiary` には match しない。`/api/` は `/api/...` に match し、`/api` には match しない。
- 同じ listener 内では longest-prefix match。segment boundary rule を使う。
- 同じ listener と path の route が複数ある場合は invalid。operator profile はこれより厳しい conflict rule を持てる。
- rewrite、strip-prefix、header matching、method matching、CORS policy は operator profile が提供する descriptor-specific extension field。
- unsupported listener、host、TLS、path-routing request の reject 方法は provider / operator conformance docs が説明する。

JSON Schema は `routes[].path` の local syntax (`/` で始まり `?` / `#` を含まないこと) と `routes[].listener` / `routes[].to` の identifier syntax を表します。 duplicate route、segment-boundary conflict、unsupported extension field の扱いは descriptor semantic validation と operator conformance check で判定します。

gateway `public` publication は `http-endpoint` output type を使います。 materialized public output は non-secret `endpoints[]` を含みます。各 endpoint は `url`、`scheme`、`host`、`listener`、`visibility`、`primary`、optional `routes[]` を記録します。`routes[]` は portable route summary (`pathPrefix`, `to`) を記録します。複数 endpoint がある場合、ちょうど 1 つが `primary: true` です。

## Workload external output type

platform service は component-local な publish の出力と同じ output type を使います。`identity.oidc@v1` と `billing.port@v1` はこの catalog の official output type です。operator / product distribution spec が、それらを Space で offer する concrete publication path を定義します。

## Access metadata

platform service declaration と materialization の記録は official access metadata vocabulary を使えます。

| Term                | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `accessModes`       | official enum: `read`, `read-write`, `admin`, `invoke-only`, `observe-only`。                    |
| `sensitivity`       | `public-config`, `restricted` などの material sensitivity class。operator-defined extension 可。 |
| `safeDefaultAccess` | operator policy が stronger access を選ぶ前の default access mode。                              |

詳細な access-mode semantics は [アクセスモード](./access-modes.md) にあります。

## Catalog descriptor metadata

Catalog の kind の定義 metadata は `https://takosumi.com/contexts/v1.jsonld` と `https://takosumi.com/kinds/v1/*` 配下に JSON-LD として publish します。JSON-LD は kind schema、vocabulary term、catalog metadata の publish format です。 runtime behavior は operator-selected binding が決めます。

`publications.<name>.contract` は `publish.<name>.as` が使う output type を名付け、publish の出力が expose できる field を説明します。kind の定義 document は generated helper type、example、documentation check のために `exampleMaterialMapping` metadata を含められます。`$outputs.*` のような marker は non-executable な例示 metadata です。provider output の収集と記録は operator binding が決め、implementation / operator の記録として保持します。

`listens.<slot>.projectionFamilies` は component-local `listen` binding slot が受け入れる injection mode を列挙します。runtime injection detail、environment variable expansion、upstream target construction、sidecar mount、SDK config file は operator-selected binding が決めます。

Kind の定義の `capabilityTerms` は matching と docs のための common capability vocabulary です。provider availability、quota、runtime limit、credential、concrete feature support は provider package / operator profile metadata です。

JSON-LD context は `manifest`、`Installation`、`Deployment` などの semantic term を含められます。これらは semantic vocabulary です。core wire shape は [manifest](./manifest.md) と [Installer API](./installer-api.md) が定義します。

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://takosumi.com/kinds/v1/worker",
  "name": "worker",
  "spec": {
    "type": "object",
    "properties": {
      "entrypoint": { "type": "string" }
    },
    "required": ["entrypoint"]
  },
  "publications": {
    "http": {
      "contract": "http-endpoint"
    }
  }
}
```

## 正本

public catalog surface は published `https://takosumi.com/kinds/v1/*`、`https://takosumi.com/kinds/v1/*.jsonld`、 `https://takosumi.com/contexts/v1.jsonld` document と、この specification page です。これらの document は vocabulary と descriptor metadata を publish します。

catalog compatibility は kind の定義 URI identity、output type name、 projection-family name、access vocabulary、documented な出力データ field shape に基づきます。runtime implementation はこれらの document を直接読んでも、equivalent な operator-adopted descriptor registry を load しても構いません。

conforming implementation は catalog を compile、mirror、vendor できます。 runtime execution は、operator-selected binding が provider / runtime binding を選びます。

Generated TypeScript helper や descriptor registry は実装上の便宜として提供できます。catalog compatibility surface は published vocabulary と JSON-LD document です。

## 関連ページ

- [仕様境界](./spec-boundaries.md)
- [Takosumi core 仕様](./core-spec.md)
- [manifest](./manifest.md)
- [HTTP 公開](./http-exposure.md)
- [プラットフォームサービス](./external-publications.md)
- [Takosumi Cloud](./takosumi-cloud.md)
