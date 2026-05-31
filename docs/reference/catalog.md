# Takosumi 公式カタログ {#catalog}

Takosumi core は kind-agnostic です。reusable な kind の定義 / material kind
の語彙は、公式カタログや operator distribution が供給します。この catalog は
core 仕様に隣接する別章です。Takosumi Cloud などの operator distribution は、
自分の docs で catalog vocabulary を採用します。operator はこれらの kind
の定義をそのまま採用したり、short alias を対応付けたり、別 domain の catalog
を採用したりできます。

このページは catalog specification です。Takosumi catalog vocabulary、kind
の定義 identity、material kind name、projection-family name、JSON-LD catalog
metadata format を定義します。kind の定義の repository source は kind package
ごとに置きます。公式 vocabulary を TypeScript で扱う code は
`@takosjp/takosumi/contract/catalog` を使えます。material vocabulary の公開名は
`OfficialMaterialKindName` です。

catalog selector の名前は `kind` に揃えます。AppSpec の component `kind` は作るもの、
`publish.kind` / `listen.kind` は offer / consume する material kind です。`type`
という語は JSON-LD の `@type`、JSON Schema の `type`、TypeScript の型名の文脈だけで使います。

## Kind の分類

| 分類              | 例                                                                                                          | 意味                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| kind family       | worker / web-service / postgres / sqlite / object-store / kv-store / message-queue / vector-store / gateway | docs 上の分類。manifest で選ぶ値ではない。                  |
| portable kind     | `worker`, `postgres`                                                                                        | 共通最小契約。operator が具体実装へ bind する。             |
| native kind       | `cloudflare-worker`, `aws-rds-postgres`                                                                     | substrate 固有契約。backend 固有 field や output を持てる。 |
| reference adapter | `cloudflareWorkerPlugin({ lifecycle })`                                                                     | reference kernel の実装手段。仕様上の必須概念ではない。     |

backend によって valid `spec` や output shape が変わる場合は native kind
を分けます。manifest に `provider` selector はありません。

## 規定範囲

公式カタログの範囲:

- `https://takosumi.com/kinds/v1/*` 配下の kind の定義 identity
- `spec`、output slot、material vocabulary、expected な出力の形を説明する kind
  の定義 metadata field
- `http-endpoint`、`service-binding`、`object-store`、`event-channel`、`identity.oidc@v1`、
  `billing.port@v1`、`mcp-server@v1` などの material kind name
- `env`、`secret-env`、`upstream`、`config-mount` などの projection-family name
- access mode enum、sensitivity class、safe default access などの access
  metadata vocabulary
- package-owned `spec/kind.jsonld` と `https://takosumi.com/contexts/v1.jsonld`
  の context document

catalog は reusable な出力データの material kind vocabulary
を定義します。concrete platform service path、OIDC issuer operation、billing
behavior、account layer record、backend provisioning、dashboard API は、その
vocabulary を採用する operator distribution spec に置きます。

operator distribution は kind の有効化を管理します。Space で見える catalog
entry、 active alias、kind の定義を実装する backend / local runtime、operator が
offer する platform service path を operator distribution が決めます。

## Catalog の役割

| Role              | Example                                         | 意味                                                        |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Kind schema       | `https://takosumi.com/kinds/v1/worker`          | component `kind` schema と output vocabulary。              |
| Material kind     | `http-endpoint`                                 | output slot が offer する material の kind。                |
| Injection mode    | `env`, `secret-env`, `upstream`, `config-mount` | resolved output material を consumer に渡す形式。           |
| Platform material | `identity.oidc@v1`, `mcp-server@v1`             | platform service 用の reusable な material kind。           |
| Access metadata   | `invoke-only`, `restricted`                     | platform service material の access / projection metadata。 |

manifest は `kind` と `connect` / `listen` の `inject` を string
として記録します。operator resolution が kind の定義 semantics を接続し、Space
で見える catalog entry を選び、それを実現する binding を選びます。

## 公式 kind definitions

現在の `takosumi.com` v1 catalog の portable kind definitions です。これは
closed built-in kind set ではありません。operator は別の descriptor URI
も採用できます。

| Suggested alias | Kind URI                                      | Descriptor source                    | Typical output slot                        |
| --------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| `worker`        | `https://takosumi.com/kinds/v1/worker`        | `docs/kinds/v1/worker.jsonld`        | `http` as `http-endpoint`                  |
| `web-service`   | `https://takosumi.com/kinds/v1/web-service`   | `docs/kinds/v1/web-service.jsonld`   | `http` as `http-endpoint`                  |
| `postgres`      | `https://takosumi.com/kinds/v1/postgres`      | `docs/kinds/v1/postgres.jsonld`      | `connection` as `service-binding`          |
| `sqlite`        | `https://takosumi.com/kinds/v1/sqlite`        | `docs/kinds/v1/sqlite.jsonld`        | `connection` as `service-binding`          |
| `object-store`  | `https://takosumi.com/kinds/v1/object-store`  | `docs/kinds/v1/object-store.jsonld`  | `bucket` as `object-store`                 |
| `kv-store`      | `https://takosumi.com/kinds/v1/kv-store`      | `docs/kinds/v1/kv-store.jsonld`      | `store` as `service-binding`               |
| `message-queue` | `https://takosumi.com/kinds/v1/message-queue` | `docs/kinds/v1/message-queue.jsonld` | `producer` / `consumer` as `event-channel` |
| `vector-store`  | `https://takosumi.com/kinds/v1/vector-store`  | `docs/kinds/v1/vector-store.jsonld`  | `index` as `service-binding`               |
| `gateway`       | `https://takosumi.com/kinds/v1/gateway`       | `docs/kinds/v1/gateway.jsonld`       | `public` as `http-endpoint`                |

kind short alias は operator-selected convenience です。URI が kind の定義の URI
です。kind の定義 document は `referenceAliases` を suggestion として publish
できますが、alias を有効にするのは operator distribution です。

Official native kind definitions も同じ `https://takosumi.com/kinds/v1/*`
catalog URI を持ちます。native definitions は backend-specific `spec` / output
vocabulary を持てるため、package source は sibling repository の
`takosumi-plugins/packages/kind-*` に置きます。そこでは reference
plugin binding と生成 view を持ちますが、descriptor source は単一カタログに残ります。plugin は AppSpec core 仕様ではなく
reference implementation の配線です。native kind implementation の package 一覧は
[Kind Packages](/reference/kind-packages) にあります。

公式 descriptor の `spec` JSON Schema は closed shape
です。`additionalProperties: true` で未定義 field を受けるのではなく、公式
portable kind と native kind は supported field を明示します。reference package
も同じ field set を runtime validation に使うため、descriptor / TypeScript 型 /
plugin apply 前 validation は同じ schema から外れません。新しい backend-specific
field が必要な場合は、その field を持つ native kind descriptor
を更新するか、別の kind URI として定義します。AppSpec core は kind-agnostic
ですが、公式カタログの定義は typo や未定義入力を許さないことを優先します。

Portable data kind の `spec` は、provider 間で安定して意味が通る最小 field
だけを持ちます。`kv-store` は `name`、`message-queue` は `name` と optional
`deliveryDelay`、`vector-store` は `name` / `dimensions` / `metric`
を要求します。default TTL、retry count、dead-letter queue、retention、index
default などは backend ごとに意味や作成 API が違うため、portable field ではなく
native kind descriptor の field として定義します。

## Material kind

Material kind は component output slot または platform service declaration が
offer する出力データの portable shape を定義します。service path、backend
resource、dashboard route、account layer lifecycle は、その出力データを offer
する operator / product distribution spec に置きます。

Official material kind は closed shape です。operator-specific field
を追加したい場合は、別の material kind / catalog extension
として定義します。implementation-local outputs はそのまま output material
ではなく、kind の定義または implementation binding が official material shape
に射影してから output material として記録します。

| Contract           | Public / non-secret fields                                                                                                                                                                                                                                                                 | Secret refs                                               | Typical projections               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------- |
| `http-endpoint`    | callable upstream の `targets[]` と optional public `endpoints[]`。target は `url`、`host` + `port`、または両方を持てる。`protocol` / `basePath` は `host` + `port` と一緒に使う。endpoint は `url`, `scheme`, `host`, `listener`, `visibility`, `primary`, optional `routes[]` を持てる。 | none                                                      | `upstream`, `env`, `config-mount` |
| `service-binding`  | `protocol` と、`service` / `connectionUrl` / `host` + `port` のいずれか。加えて `database`, optional `username`, `caCertRef` を持てる。                                                                                                                                                    | `passwordRef`, token refs                                 | `secret-env`, `config-mount`      |
| `object-store`     | `bucket`, `endpoint`, `region`, `pathStyle`, optional `publicBaseUrl`, policy refs                                                                                                                                                                                                         | `accessKeyIdRef`, `secretAccessKeyRef`, `sessionTokenRef` | `secret-env`, `config-mount`      |
| `event-channel`    | `channel`, `protocol`, endpoint / topic / queue / stream identity, delivery policy refs                                                                                                                                                                                                    | producer / consumer credential refs                       | `secret-env`, `config-mount`      |
| `identity.oidc@v1` | issuer URL, discovery URL, client id, redirect / callback origin, optional public JWKS / discovery refs                                                                                                                                                                                    | `clientSecretRef`                                         | `secret-env`, `config-mount`      |
| `billing.port@v1`  | billing portal URL, usage report endpoint, billing subject ref                                                                                                                                                                                                                             | `meteringCredentialRef`                                   | `secret-env`, `config-mount`      |
| `mcp-server@v1`    | Streamable HTTP MCP endpoint URL, protocol version, display name / description                                                                                                                                                                                                             | `tokenRef`                                                | `secret-env`, `config-mount`      |

`http-endpoint` は callable HTTP output を表します。workload component の HTTP
output は通常 `targets[]` を出し、gateway / ingress component の HTTP output
は通常 `endpoints[]` を出します。1 つの material には `targets[]` または
`endpoints[]` の少なくとも一方が必要です。public reachability は root service
path exposure と materialization result の property です。たとえば `web.http` は
upstream HTTP output、`public.public` は gateway / ingress component が作る
public endpoint output になれます。

Official output の値は closed shape です。secret reference は
`{ secretRef: string }` だけを持つ object です。

HTTP output では、`url` は absolute `http` / `https` URL、`scheme` / `protocol`
は `http` または `https`、`port` は 1 から 65535 の integer、`visibility` は
`private` / `space` / `public` / `internal` のいずれかです。target の `host` と
`port` は一緒に現れます。`protocol` と `basePath` は host/port 形式を補足する
field なので、`host` + `port` と一緒に使います。`basePath` と
`routes[].pathPrefix` は `/` で始まり、`?` / `#`
を含みません。`name`、`listener`、`routes[].to`、`tokenRefs` の key は ASCII の
identifier (`A-Za-z0-9_.-`) です。

`service-binding` は HTTP 以外の service 接続を表します。TCP
だけを前提にせず、material は `protocol` と、`service` / `connectionUrl` /
`host` + `port` のいずれかで接続先を識別します。credential は
`passwordRef`、`tokenRef`、または named `tokenRefs` で渡し、`connectionUrl` に
password を埋め込みません。

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
  secretRefs: [passwordRef, tokenRef, tokenRefs]
  requires: protocol plus one of service, connectionUrl, or host + port
  rule: host and port appear together; connectionUrl is an absolute URI and must not contain an embedded password; tokenRefs keys are identifiers
  allowedProjections: [secret-env, config-mount]

object-store:
  publicFields: { bucket, endpoint, region, pathStyle, publicBaseUrl, policyRefs }
  secretRefs: [accessKeyIdRef, secretAccessKeyRef, sessionTokenRef]
  rule: accessKeyIdRef and secretAccessKeyRef appear together; sessionTokenRef requires both
  allowedProjections: [secret-env, config-mount]

event-channel:
  publicFields: { channel, protocol, endpoint, topic, queue, stream, deliveryPolicyRefs }
  secretRefs: [producerCredentialRef, consumerCredentialRef]
  rule: endpoint is an absolute URI when present
  allowedProjections: [secret-env, config-mount]

identity.oidc@v1:
  publicFields: { issuerUrl, discoveryUrl, clientId, redirectOrigin, jwksRef }
  secretRefs: [clientSecretRef]
  allowedProjections: [secret-env, config-mount]

billing.port@v1:
  publicFields: { portalUrl, usageReportEndpoint, billingSubjectRef }
  secretRefs: [meteringCredentialRef]
  allowedProjections: [secret-env, config-mount]

mcp-server@v1:
  publicFields: { endpointUrl, transport, protocolVersion, serverName, description }
  secretRefs: [tokenRef]
  requires: endpointUrl as an absolute http(s) URL and transport: streamable-http
  allowedProjections: [secret-env, config-mount]
```

`identity.oidc@v1`、`billing.port@v1`、`mcp-server@v1` は platform service 用の neutral
なmaterial kindです。catalog は workload が受け取れる field を名付けます。issuer
operation、 client lifecycle、redirect policy、billing account lifecycle、usage
authorization、payment-provider integration、MCP server registration、concrete platform service path
は、その出力データを offer する operator / product distribution が定義します。

`mcp-server@v1` は remote MCP server を Space-visible publication として discover
するための material kind です。current catalog は remote 接続に `transport:
streamable-http` を使います。具体的な server の登録、認可、scope、tool policy、
pathless publication をどう見せるかは operator / product distribution が定義します。

`ref` field は operator-owned reference string です。operator projection や
retained evidence の stable handle であり、raw secret value ではありません。

Public Deployment output と operator の参照 API は non-secret field と refs
だけを公開します。raw password、client secret、payment-provider
credential、bearer token、 generated private key は ref
で表し、operator-approved runtime secret mechanism だけで delivery します。

## Injection mode

Injection mode は output material を consumer component に提示する形式です。
manifest は selected family を `connect.<binding>.inject` または
`listen.<binding>.inject` に記録し、selected な kind の定義と operator policy が
compatibility をリソースの作成・更新前に検証します。

| Injection mode | Meaning                                                                                    | Safety rule                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `env`          | public / non-secret config を binding `prefix` 付き environment variable として渡す。      | public / non-secret field だけに有効。required secret ref を持つ material には使わない。     |
| `secret-env`   | public config と secret ref を operator secret backend 経由で runtime environment に渡す。 | public record には ref だけを残し、raw secret value は workload runtime だけに inject する。 |
| `upstream`     | HTTP endpoint material を ingress / router / upstream binding に接続する。                 | upstream routing material を受け入れる `http-endpoint` consumer slot に有効。                |
| `config-mount` | public config と refs を mounted config file、volume、SDK config object として渡す。       | mount path と file shape は kind の定義に従い、selected binding が検証する。                 |

`env` / `secret-env` が environment variable record に展開された後の値は、
public config なら文字列、secret なら `{ secretRef: "..." }` です。`secret-env`
は `secret://...` 文字列への flatten ではありません。implementation binding
または runtime connector は、その `{ secretRef }` を backend の secret mechanism
へ接続するか、対応していない場合は resource 作成前に fail-closed で拒否します。

Projection compatibility:

| Material kind      | `env`                                      | `secret-env` | `upstream`                     | `config-mount` |
| ------------------ | ------------------------------------------ | ------------ | ------------------------------ | -------------- |
| `http-endpoint`    | public / non-secret endpoint data なら有効 | invalid      | upstream-capable slot なら有効 | valid          |
| `service-binding`  | invalid                                    | valid        | invalid                        | valid          |
| `object-store`     | invalid                                    | valid        | invalid                        | valid          |
| `event-channel`    | invalid                                    | valid        | invalid                        | valid          |
| `identity.oidc@v1` | invalid                                    | valid        | invalid                        | valid          |
| `billing.port@v1`  | invalid                                    | valid        | invalid                        | valid          |
| `mcp-server@v1`    | invalid                                    | valid        | invalid                        | valid          |

consumer slot metadata と operator policy は、syntactically valid な組み合わせを
particular component では invalid にできます。secret-bearing なmaterial kindは
default で `env: invalid` です。secretless public config を env projection
したい場合は、別の env-safe material kind または explicit operator distribution
extension を定義します。

## Consumer slot metadata

kind の定義は manifest field を増やさずに consumer binding slot
の受け入れ条件を説明できます。この metadata は validation と docs のための
catalog vocabulary です。generated helpers は spec/output/output slot に加えて
listen slot descriptor も export します。`spec/kind.jsonld` は正本で、generated
helper は package author と operator wiring が同じ metadata
を型付きで参照するための mirror です。

official `worker` / `web-service` kind の定義の wildcard listen slot は
`http-endpoint` も受け取れます。same-manifest dependency は、producer の
`web.http` output slot を consumer が `connect.<binding>.output` で参照します。
platform service や manifest 外の external service は exact target なら
`listen.<binding>.path`、discovery なら `listen.<binding>.kind` と `labels`
で参照します。base URL のような public config として渡す場合は
`inject: env`、gateway / router の upstream binding として渡す場合は
`inject: upstream` を使います。secret-bearing material kind は上の compatibility
table が優先されるため、`service-binding` / `object-store` / `identity.oidc@v1`
/ `billing.port@v1` / `mcp-server@v1` を plain `env` に落とすことは valid ではありません。

| Descriptor metadata                       | Meaning                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `listens.<slot>.accepts`                  | `http-endpoint` など、この consumer slot が受け入れる material kind。         |
| `listens.<slot>.projectionFamilies`       | `upstream` や `secret-env` など、この slot が受け入れる injection mode。      |
| `listens.<slot>.projectionMatrix`         | material kind ごとに有効な injection mode の machine-readable intersection。  |
| `listens.<slot>.minimumAccess`            | `read` や `invoke-only` など、material に必要な minimum access mode。         |
| `listens.<slot>.safeDefaultAccess`        | operator policy が stronger access mode を選ぶ前の default access。           |
| `listens.<slot>.requiredWhenReferencedBy` | 指定された `spec` field が binding key を参照するとき required とみなす条件。 |

operator は kind の定義 metadata、Space policy、platform service declaration
を組み合わせます。manifest は access-mode field を持ちません。`connect.output` /
`listen.path` / `listen.kind` と `inject` を選び、kind の定義 metadata、output
slot declaration、policy から access を解決します。

native worker / web-service kind は、portable base と同じ `projectionMatrix`
を持つ必要があります。backend 固有の field や output を descriptor
に追加しても、`service-binding` や `object-store` のような secret-bearing output
kind を plain `env` に落とさないという型の安全性は変えません。backend が追加の
injection mode を持つ場合は、その backend の native kind descriptor と operator
policy で明示します。

## Gateway portable subset

operator が official `gateway` kind の定義を採用する場合、その定義は portable
HTTP ingress vocabulary を公開します。`spec.listeners` map は named HTTP / HTTPS
listener を宣言し、`spec.routes` array は listener と local `connect` binding
key を接続します。

Portable v1 route semantics:

- `routes[].to` は local `connect` binding key。material
  kind、`listen.path`、URL ではない。
- `routes[].path` は HTTP path prefix。`/` または `/` で始まる string。
- `routes[].path` は configuration path string。full URL ではない。`?`、`#`、
  NUL、empty string、別 path に変わる segment escape は invalid。
- matching は URL path だけを使い、query string と fragment は除外する。
- matching は case-sensitive。percent-decoding や path normalization の前の URL
  path string を比較する。
- percent-encoded octet は literal に比較する。`%2F` は `/` として扱わない。
- `/` は全 path に match する。`/api` は `/api` と `/api/...` に match し、
  `/apiary` には match しない。`/api/` は `/api/...` に match し、`/api` には
  match しない。
- 同じ listener 内では longest-prefix match。segment boundary rule を使う。
- 同じ listener と path の route が複数ある場合は invalid。operator distribution
  はこれより厳しい conflict rule を持てる。
- rewrite、strip-prefix、header matching、method matching、CORS policy
  は、必要な backend がそれを explicit field として持つ native gateway kind
  descriptor を定義する。
- unsupported listener、host、TLS、path-routing request の reject 方法は backend
  / operator conformance docs が説明する。

JSON Schema は `routes[].path` の local syntax (`/` で始まり `?` / `#` / NUL
を含まないこと) と `routes[].listener` / `routes[].to` の identifier syntax
を表します。duplicate route、dot-segment rejection、segment-boundary matching
behavior、backend が対応しない field の reject は kind の定義の semantic
validation と operator conformance check で判定します。公式 v1 descriptor
は未定義 field を受け取りません。

gateway `public` output slot は `http-endpoint` material kind を使います。
materialized public output は non-secret `endpoints[]` を含みます。各 endpoint
は `url`、`scheme`、`host`、`listener`、`visibility`、`primary`、optional
`routes[]` を記録します。`routes[]` は portable route summary (`pathPrefix`,
`to`) を記録します。複数 endpoint がある場合、ちょうど 1 つが `primary: true`
です。

## Platform service material kind

platform service は same-manifest component output と同じ material kind
を使います。`identity.oidc@v1`、`billing.port@v1`、`mcp-server@v1` はこの catalog
の official material kind です。operator / product distribution spec が、それらを
Space で offer する concrete platform service path または pathless discovery
inventory を定義します。

## Access metadata

platform service declaration と materialization の記録は official access
metadata vocabulary を使えます。

| Term                | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `accessModes`       | official enum: `read`, `read-write`, `admin`, `invoke-only`, `observe-only`。                               |
| `sensitivity`       | official enum: `public-config`, `internal`, `restricted`, `secret-bearing`。operator-defined extension 可。 |
| `safeDefaultAccess` | operator policy が stronger access を選ぶ前の default access mode。                                         |

詳細な access-mode semantics は [アクセスモード](./access-modes.md) にあります。

## Catalog の kind の定義 metadata

Catalog の kind の定義 metadata は `takosumi/docs/kinds/v1/*.jsonld` と、公開時の
`https://takosumi.com/contexts/v1.jsonld` / `https://takosumi.com/kinds/v1/*` に
JSON-LD として置きます。JSON-LD は kind schema、vocabulary term、catalog
metadata の公開形式です。runtime behavior は operator-selected binding
が決めます。

`outputSlots.<name>.contract` は component output slot が使う material kind
を名付け、output material が expose できる field を説明します。kind の定義
document は generated helper type、example、documentation check のために
`exampleMaterialMapping` metadata を含められます。`exampleMaterialMapping` は
official material shape と同じ field layout を使い、secret ref は
`{ "secretRef": "$outputs.name" }` の形で表します。`$outputs.*` のような marker
は non-executable な例示 metadata です。material shape の required field や
required alternative を満たす marker は required output を参照します。例えば
`billing.port@v1` は `portalUrl` または `usageReportEndpoint` のどちらかが
required output または literal value である必要があります。backend output
の収集と記録は operator binding が決め、implementation / operator
の記録として保持します。

`listens.<slot>.projectionFamilies` は component-local consumer slot
が受け入れる injection mode を列挙します。manifest では same-manifest output を
`connect` で、platform / external publication を `listen.path` または
`listen.kind` でその slot へ接続します。runtime injection detail、environment
variable expansion、upstream target construction、sidecar mount、SDK config file
は operator-selected binding が決めます。

Kind の定義の `capabilityTerms` は matching と docs のための common capability
vocabulary です。availability、quota、runtime limit、credential、concrete
feature support は kind package / operator distribution metadata です。

JSON-LD context は `manifest`、`Installation`、`Deployment` などの semantic term
を含められます。これらは semantic vocabulary です。core wire shape は
[manifest](./manifest.md) と [Installer API](./installer-api.md) が定義します。

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
  "outputSlots": {
    "http": {
      "contract": "http-endpoint"
    }
  }
}
```

## 正本

public catalog surface は package-owned
`packages/kind-*/spec/kind.jsonld`、sibling
`takosumi-plugins/packages/kind-*/spec/kind.jsonld`、published
`https://takosumi.com/kinds/v1/*`、`https://takosumi.com/kinds/v1/*.jsonld`、`https://takosumi.com/contexts/v1.jsonld`
document、この specification page、`@takosjp/takosumi/contract/catalog` の
TypeScript helper です。これらの document と helper は vocabulary と kind の定義
metadata を公開します。

catalog compatibility は kind の定義 URI identity、material kind name、
projection-family name、access vocabulary、documented な出力データ field shape
に基づきます。runtime implementation はこれらの document
を直接読んでも、equivalent な operator-adopted kind の定義 registry を load
しても構いません。

conforming implementation は catalog を compile、mirror、vendor
できます。runtime execution は、operator-selected binding が backend / runtime
binding を選びます。

Generated TypeScript helper や kind の定義 registry
は実装上の便宜として提供できます。catalog compatibility surface は published
vocabulary と JSON-LD document です。

## 関連ページ

- [仕様境界](./spec-boundaries.md)
- [Takosumi core 仕様](./core-spec.md)
- [manifest](./manifest.md)
- [HTTP 公開](./http-exposure.md)
- [Kind Packages](/reference/kind-packages)
- [プラットフォームサービス](./platform-services.md)
- [Takosumi Cloud](./takosumi-cloud.md)
