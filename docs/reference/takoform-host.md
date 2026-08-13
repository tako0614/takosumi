# Takoform provider integration

> Migration boundary note: Takosumi OSS retired its embedded Resource/Form Host.
> This page records the remaining provider/Host boundary; it is not a supported
> Resource authoring guide.

Takosumi OSS の platform edge は既定では Takoform Host を mount せず、旧 route は
`404` のままです。Takoform は Cloudflare、AWS、その他の OpenTofu provider と同じく、
repository の module が選ぶ外部 provider の一つです。

OSS は、既存の exact v1alpha1 Resource を安全に移行するための generic な
in-process compatibility composition だけを保持します。これは host code が明示的に
完全な maintenance lane を注入した場合に限って mount され、通常の OSS edge や text
environment flag から有効にはできません。実際の Host、backend、許可する transition
pair、Form の install/retain は Takosumi Cloud または別の external Host が所有します。

## 実行経路

```text
repository module
  → ProviderConnection / ProviderBinding
  → runner 内だけで credential を materialize
  → OpenTofu が Takoform provider を実行
  → 設定された外部 Host
  → state / typed Output
  → 必要な Interface を generic post-apply projection
```

Takosumi は Run、OpenTofu state、Output、audit、Interface / InterfaceBinding の認可を
所有します。Host は provider が作る resource instance と backend lifecycle を所有します。
同じ resource を Takosumi の別 ledger に複製しません。

## 接続

Host endpoint と credential は通常の ProviderConnection として Workspace に登録し、
ProviderBinding で module の provider requirement に結びます。credential は runner に
だけ渡され、repository、plan 表示、state、Output、Interface document には保存しません。

Takosumi Cloud が current Takoform Host を公開した場合も、この経路は変わりません。
Cloud の既定接続は便利な初期値であり、hidden runner mode や first-party provider では
ありません。利用者は自分が選んだ互換 Host 接続に差し替えられます。

## Protocol version

Takosumi の docs は Takoform の未公開 candidate version、FormRef、schema digest、Host
route を複製しません。利用可能な protocol と exact identity は、公開済み Takoform
provider と接続先 Host の discovery/contract を確認してください。未公開 candidate を
production capability として広告しません。

旧 Takosumi Resource Shape/Form Host の endpoint と provider 設定は supported product
flow ではありません。既存データの operator-only drain は非公開 runbook と
[configuration reference](./configuration.md) に限定します。上記の明示的な frozen
compatibility composition はこの一般 drain とは別で、同一 origin に discovery、exact
Form availability、旧 exact read/observe/preview/update/delete、下記 transition を一式で
提供しなければなりません。transition だけを広告する構成は不正です。

## Exact Resource Form transition

通常の `PUT` は Resource の exact Form identity を変更できません。Form identity の変更は
`POST {endpoints.api}/resources/:kind/:name/form-transitions?space=...` だけで行います。
request は closed object で、次を含みます。

- `operationId`: `takoform.resource-form-transition-operation@v1` と RFC 8785 canonical JSON
  から求めた `formtx_` + SHA-256。preimage は logical Resource identity、exact
  `fromForm` / `toForm`、desired spec digest、`expected`、transition evidence で、
  `operationId` 自身は除きます。
- `fromForm` / `toForm`: API version、kind、definition version、schema digest、package
  digest を含む exact structured FormRef。
- `resource`: `toForm` に bind された desired Resource。name/space/kind は不変で、spec は
  new Form schema に合格し、metadata の current `resourceVersion: N` が必須で、
  secret-like field/private-key material を含まない必要があります。
- `expected.resourceVersion`: 必須の current generation `N`。同じ値を quoted
  `If-Match` に送り、`Idempotency-Key` は `operationId` と一致させます。
- `expected.nativeIdentity`: provider state が保持している場合だけ送る exact non-secret
  native type/id。
- `transitionEvidence`: product/module が宣言した marker と exact pair を bind する
  `takoform.module-form-transition@v1` SHA-256 evidence。

owner、Workspace/Capsule/Run、ResolutionLock、storage revision/revision id、native evidence、
credential audience/scopes は body に含めません。Host は現在の authenticated Run、
ProviderBinding、ProviderConnection、CredentialRecipe、canonical Resource/lock からこれらを
再取得し、host dispatch より前に value-free な precondition snapshot と Resource claim を
永続化します。claim の CAS は Resource revision だけでなく exact ResolutionLock/native
evidence と identity fence も同じ transaction で検査します。ledger に secret、credential、
native payload は保存しません。

provider は mutation の前に
`GET {endpoints.api}/resources/:kind/:name/form-transitions/:operationId?space=...`
を行います。`404` の `code:resource_not_found` +
`hostCode:form_transition_operation_not_found` か、同じ
`operationId` / `requestDigest` を持つ `202 prepared` かつ
`dispatchAttempted:false` の場合だけ POST できます。`prepared` + true、
`indeterminate`、digest mismatch、GET transport uncertainty では POST しません。同じ
operation の POST は dispatch fence を CAS するため、host call は最大 1 回です。
`requestDigest` は `takoform.resource-form-transition-request@v1` domain の RFC 8785
SHA-256 で、`operationId` を含む exact request を bind します。committed は `200`、
unresolved は `202`、definitive rejection は operation/digest/failure code を持つ stable
`409` です。

commit proof は同じ native identity、exact old/new FormRef、evidence digest、observed spec
digest、operation id、`N + 1` resource version を bind します。Core はまず proof を
exact operation ledger に記録し、その operation の claim が一致した場合だけ Resource
FormRef/spec、ResolutionLock、native Form evidence を 1 transaction で `N + 1` に進めて
claim を消します。同じ operation の
terminal status を記録する直前に crash しても Resource の operation-bound revision id が
normal lifecycle mutation を fence し、exact readback が terminal status を repair します。
同じ operation の
replay/readback は後続 generation が存在してもこの同じ `N + 1` receipt を返し、再 increment
しません。definite host rejection は old Form/spec/ResolutionLock/native identity を変えず、
durable rejection receipt の後で claim だけを解放します。timeout/lost acknowledgement は
`202 indeterminate` で、GET は provider/backend mutation を dispatch しません。exact host
ledger がすでに committed と証明した場合だけ、同じ claim と desired spec digestを使って
canonical DB を forward-repair できます。
