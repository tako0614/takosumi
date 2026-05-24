# Operator DataAsset Extension Policy {#dataasset-policy}

> このページでわかること: optional DataAsset extension のアクセスポリシーと
> lifecycle。

DataAsset は operator extension が扱う content-addressed blob です。概念名は
DataAsset です。`/v1/artifacts` route と `takosumi artifact` command には、
互換上の historical name として `artifact` が残ります。

build 後 source は DataAsset ではなく prepared source snapshot として Installer
API に渡します。source-backed connector は resolved source snapshot と
kind-specific `spec` を読みます。reference runtime-agent lifecycle ではこの
source locator を `preparedSource` field で運ぶことがあります。

## 現行の強制ポイント {#current-enforcement-points}

operator が DataAsset extension を mount した場合、その extension は DataAsset
policy を 3 箇所で強制します。

### DataAsset upload {#artifact-upload}

operator が `/v1/artifacts` を有効化した場合、`POST /v1/artifacts` は deploy
bearer を要求します。`sha256` を計算し、upload-declared digest (`expectedDigest`
in current compatibility wire) を verify し、size cap を強制 します。

### DataAsset fetch {#artifact-fetch}

operator が `/v1/artifacts` を有効化した場合、`GET` または `HEAD` の
`/v1/artifacts/:hash` は deploy bearer と read-only artifact-fetch bearer の
いずれかを受け付けます。

### Runtime-agent apply {#runtime-agent-apply}

DataAsset-backed lifecycle request では dispatcher が operator DataAsset
metadata を connector の `acceptedArtifactKinds` と照合します。source-backed
connector は resolved source snapshot と kind-specific `spec` を読みます。

## Build / prepared source との分担

build / prepare は build service、CI、または operator automation が実行します。
DataAsset routes はアップロード済み blob の保存・取得・GC を扱います。

| 対象                 | 置き場所 / surface                                      |
| -------------------- | ------------------------------------------------------- |
| build command        | `.takosumi.build.yml` convention / CI / operator policy |
| runtime file path    | AppSpec の kind-specific `spec`                         |
| build 後 source tree | prepared source snapshot (`source.kind: "prepared"`)    |
| optional blob upload | DataAsset extension (`/v1/artifacts`)                   |

## サイズポリシー {#size-policy}

DataAsset は optional operator extension の概念名です。existing wire shape には
`/v1/artifacts`、`takosumi artifact`、`TAKOSUMI_ARTIFACT_*`、`artifact*`
event/error/field 名が残りますが、これらは互換名として扱い、prose では DataAsset
を概念名にします。

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800`
バイト。operator は env を設定するか、DataAsset route をマウントするときに
`maxBytes` を渡せます。

登録済み DataAsset metadata kind は `maxSize` を持ちうる。存在する場合、その
`maxSize` はその metadata kind について route default を上書きします。

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

### Deploy bearer missing {#missing-deploy-bearer}

- HTTP / code: `401 unauthenticated` または public token 未設定時は route `404`
- Recovery: `TAKOSUMI_DEPLOY_TOKEN` を設定

## Accepted DataAsset metadata policy {#accepted-kind-policy}

DataAsset metadata `kind` は operator-owned open metadata です。各 connector は
受け付けるものを宣言します。例:

- DataAsset-backed custom connectors: explicitly registered operator-owned
  metadata kinds
- Source-backed worker / web-service connectors: `acceptedArtifactKinds: []` and
  resolved source snapshot + kind-specific `spec`

runtime-agent は connector code が動く前に mismatch を reject します。reference
component kind level の validation はより厳しいことがあります。takosumi.com
reference `worker` は `spec.entrypoint` を要求し、DataAsset descriptor は要求
しません。

## 認証ポリシー {#auth-policy}

DataAsset surface は write / read credential を分離します。

- `TAKOSUMI_DEPLOY_TOKEN`: artifact upload、list、delete、GC、read
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

- [Source files and DataAssets](./kind-registry.md#source-files-and-dataassets)
- [Connector Guide](./connector-contract.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Environment Variables](./env-vars.md)
- [Audit Events](./audit-events.md)
