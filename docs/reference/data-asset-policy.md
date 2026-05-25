# Optional Operator DataAsset Extension Policy {#dataasset-policy}

DataAsset は operator が optional extension として有効化できる content-addressed
blob です。diagnostic bundle、large runtime input、 operator-owned generated
payload のように、source handoff とは別の blob storage と lifecycle policy
で扱いたいデータに使います。Takosumi core Installer API の source handoff は
`git` / `prepared` / `local` source descriptor を使い、 prepared source archive
が build 後 source tree を運びます。

AppSpec authoring では runtime intent と runtime file path を kind-specific
`spec`、source handoff を prepared source archive で表します。build 後の source
tree や worker bundle は DataAsset に分けず、prepared source archive として
Installer API に渡します。source-backed connector は resolved source snapshot と
kind-specific `spec` を読みます。

## Compatibility names {#compatibility-names}

DataAsset is the operator-extension concept name. The reference implementation's
optional DataAsset extension exposes current compatibility wires with `artifact`
names. These names are current reference extension wires, not AppSpec fields,
not Installer API source kinds, and not Takosumi core conformance requirements:

| Concept          | Reference extension compatibility name                                   |
| ---------------- | ------------------------------------------------------------------------ |
| DataAsset route  | `/v1/artifacts`                                                          |
| DataAsset CLI    | `takosumi artifact ...`                                                  |
| DataAsset env    | `TAKOSUMI_ARTIFACT_*`                                                    |
| DataAsset id/ref | `artifact:*`, `artifact_*` event / error / field names in that extension |

## Reference extension enforcement {#current-enforcement-points}

operator が DataAsset extension を mount した場合、その extension は DataAsset
policy を 3 箇所で強制します。この extension は Installer API 5 endpoint と分離
された operator-mounted blob route surface です。

### Reference extension upload {#artifact-upload}

operator が current reference DataAsset extension の `/v1/artifacts`
を有効化した 場合、`POST /v1/artifacts` は DataAsset writer/admin bearer
を要求します。この reference extension は `sha256` を計算し、upload-declared
digest (`expectedDigest` in current compatibility wire) を verify し、size cap
を強制し ます。Operator は AppSpec / Installation / Deployment conformance
を変えずに、 この blob surface を省略・移動・置換できます。

### Reference extension fetch {#artifact-fetch}

operator が current reference DataAsset extension の `/v1/artifacts`
を有効化した 場合、`GET` または `HEAD` の `/v1/artifacts/:hash` は DataAsset
writer/admin bearer と read-only artifact-fetch bearer
のいずれかを受け付けます。`:hash` は `sha256:<64 lowercase hex>` です。malformed
hash syntax は `400 invalid_argument`、正しい形だが blob が存在しない場合は
`404 not_found` です。これらの HTTP route / code は current reference extension
behavior です。

### Runtime-agent apply {#runtime-agent-apply}

DataAsset-backed lifecycle request は DataAsset descriptor を明示します。
descriptor は `kind` と `hash` または `uri` を持ち、dispatcher は `kind` を
connector の `acceptedArtifactKinds` と照合します。`acceptedArtifactKinds` が空
の source-backed connector は DataAsset descriptor を受け取らず、resolved source
snapshot と kind-specific `spec` を読みます。

## Build / prepared source との分担

build / prepare は build service、CI、または operator automation が実行します。
DataAsset routes はアップロード済み blob の保存・取得・GC を扱います。

| 対象                 | 置き場所 / surface                                      |
| -------------------- | ------------------------------------------------------- |
| build command        | `.takosumi.build.yml` convention / CI / operator policy |
| runtime file path    | AppSpec の kind-specific `spec`                         |
| build 後 source tree | prepared source archive (`source.kind: "prepared"`)     |
| optional blob upload | DataAsset extension (`/v1/artifacts`)                   |

## サイズポリシー {#size-policy}

DataAsset size policy applies to the optional operator extension routes and
connectors described above.

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800`
バイト。operator は env を設定するか、DataAsset route をマウントするときに
`maxBytes` を渡せます。

登録済み DataAsset metadata kind は current reference extension で `maxSize`
を持ちうる。存在する場合、その `maxSize` はその metadata kind について route
default を上書きします。

```ts
registerArtifactKind({
  kind: "operator.example/log-bundle",
  description: "Operator-owned diagnostic bundle",
  contentTypeHint: "application/gzip",
  maxSize: 50 * 1024 * 1024,
});
```

未知 / 未登録の metadata kind は global cap を使います。content-length preflight
は既知の最大 cap を使い、post-parse body check が submitted metadata kind に
対して厳密な cap を強制します。

Failure mode:

### Upload exceeds effective cap {#upload-exceeds-effective-cap}

- HTTP / code: `413 resource_exhausted`
- Recovery: `TAKOSUMI_ARTIFACT_MAX_BYTES` を上げる、より大きい `maxSize` を
  register する、DataAsset を圧縮する、R2 / S3 / GCS へ storage を移す

### Digest mismatch {#digest-mismatch}

- HTTP / code: `409 failed_precondition`
- Recovery: 計算済 digest で re-upload するか、declared digest を修正

malformed digest syntax は `400 invalid_argument` です。digest 文字列は正しいが
bytes と一致しない場合は apply guard と同じ `409 failed_precondition` です。

### DataAsset credential missing {#dataasset-credential-missing}

- HTTP / code: enabled extension route with missing or invalid credential
  returns `401 unauthenticated`; an operator that does not mount the DataAsset
  extension exposes no discovery or route and returns `404` from that surface.
- Recovery: reference DataAsset extension の writer/admin credential
  (`TAKOSUMI_DEPLOY_TOKEN` compatibility env var) or read-only fetch credential
  (`TAKOSUMI_ARTIFACT_FETCH_TOKEN`) を用途に合わせて設定。

## Accepted DataAsset metadata policy {#accepted-kind-policy}

DataAsset metadata `kind` は operator-owned open metadata です。各 connector は
受け付けるものを宣言します。例:

- DataAsset-backed custom connectors: explicitly registered operator-owned
  metadata kinds
- Source-backed worker / web-service connectors: `acceptedArtifactKinds: []` and
  resolved source snapshot + kind-specific `spec`

runtime-agent は connector code が動く前に mismatch を reject します。reference
component kind level の validation はより厳しいことがあります。Takosumi official
type catalog の `worker` descriptor を採用した operator profile は
`spec.entrypoint` を要求し、DataAsset descriptor は要求しません。

The reference extension's compatibility wire can accept
`ArtifactReference = string | Artifact`. The string form is operator-local
shorthand. DataAsset-backed connector へ dispatch する前に operator resolver が
`{ kind, hash | uri, metadata? }` descriptor へ正規化します。 正規化できない
DataAsset reference は `invalid_argument` です。

## 認証ポリシー {#auth-policy}

DataAsset surface は write / read credential を分離します。下記 env var は
current reference extension の compatibility names です。

- `TAKOSUMI_DEPLOY_TOKEN`: DataAsset writer/admin bearer for upload、list、
  delete、GC、read
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`: runtime-agent host 向けの read-only `GET` /
  `HEAD /v1/artifacts/:hash`

runtime-agent が apply のために upload された bytes を fetch する場合、read-only
token を受け取ります。

## オペレーター surface {#operator-surface}

DataAsset extension を有効化した operator のコントロール:

- `TAKOSUMI_ARTIFACT_MAX_BYTES`: global upload cap
- `registerArtifactKind(..., { allowOverride })`: operator-controlled bootstrap
  / implementation loading 時の discovery metadata と optional per-kind size
  登録
- `takosumi artifact kinds`: read-only discovery for operator metadata
- `takosumi artifact gc`: unreferenced blob の mark-and-sweep cleanup

policy reload command や transform 承認 workflow を追加する場合は、対応する
reference docs と CLI surface を一緒に更新します。

## 関連ページ

- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [Connector Guide](./connector-contract.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Environment Variables](./env-vars.md)
- [Audit Events](./audit-events.md)
