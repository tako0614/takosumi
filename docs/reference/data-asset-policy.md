# Optional Operator asset Extension Policy {#dataasset-policy}

asset は operator が optional extension として有効化できる content-addressed blob です。diagnostic bundle、large runtime input、 operator-owned generated payload のように、source handoff とは別の blob storage と lifecycle policy で扱いたいデータに使います。Takosumi Installer API の source handoff は `git` / `prepared` / `local` Source descriptor を使い、 prepared source archive が build 後 source tree を運びます。

Takosumi v1 は manifestless です。runtime intent は Source repository の通常の project files、operator build service、PlatformService binding selection、または operator policy から解決します。build 後の source tree や worker bundle は asset に分けず、prepared source archive として Installer API に渡します。source-backed runtime handler は resolved source view と operator-selected adapter input を読みます。

## 互換名 {#compatibility-names}

asset は operator extension の概念名です。reference implementation の optional asset extension は `artifact` という名前で current compatibility wire を公開します。これらの名前は current reference extension wire であり、Source field でも Installer API source kind でも Takosumi conformance requirement でもありません:

| Concept      | Reference extension compatibility name                                   |
| ------------ | ------------------------------------------------------------------------ |
| asset route  | `/v1/artifacts`                                                          |
| asset CLI    | `takosumi artifact ...`                                                  |
| asset env    | `TAKOSUMI_ARTIFACT_*`                                                    |
| asset id/ref | `artifact:*`, `artifact_*` event / error / field names in that extension |

## Reference extension の強制ポイント {#current-enforcement-points}

operator が asset extension を mount した場合、その extension は asset policy を 3 箇所で強制します。この extension は Installer API と分離された operator-mounted blob route surface です。

### Reference extension upload {#artifact-upload}

operator が current reference asset extension の `/v1/artifacts` を有効化した場合、`POST /v1/artifacts` は asset writer/admin bearer を要求します。この reference extension は `sha256` を計算し、upload で宣言された digest (current compatibility wire の `expectedDigest`) を verify し、size cap を強制します。operator は Installation / Deployment conformance を変えずに、この blob surface を省略・移動・置換できます。

### Reference extension fetch {#artifact-fetch}

operator が current reference asset extension の `/v1/artifacts` を有効化した場合、`GET` または `HEAD` の `/v1/artifacts/:hash` は asset writer/admin bearer と read-only artifact-fetch bearer のいずれかを受け付けます。`:hash` は `sha256:<64 lowercase hex>` です。malformed hash syntax は `400 invalid_argument`、正しい形だが blob が存在しない場合は `404 not_found` です。これらの HTTP route / code は current reference extension behavior です。

### Runtime-agent apply {#runtime-agent-apply}

asset-backed lifecycle request は asset descriptor を明示します。 current compatibility wire の descriptor は `kind` と `hash` または `uri` を持ちます。この `kind` は asset metadata value であり、Source authoring vocabulary ではありません。dispatcher はその metadata value を runtime handler の `acceptedArtifactKinds` と照合します。`acceptedArtifactKinds` が空の source-backed runtime handler は asset descriptor を受け取らず、resolved source view と operator-selected adapter input を読みます。

## Build / prepared source との分担

build / prepare は build service、CI、または operator automation が実行します。 asset routes はアップロード済み blob の保存・取得・GC を扱います。

| 対象                 | 置き場所 / surface                                      |
| -------------------- | ------------------------------------------------------- |
| build command        | CI / build service / operator policy                    |
| runtime file path    | project source files / operator adapter input           |
| build 後 source tree | prepared source archive (`source.kind: "prepared"`)     |
| optional blob upload | asset extension (`/v1/artifacts`)                       |

## サイズポリシー {#size-policy}

asset size policy は上記の optional operator extension route と runtime handler に適用されます。

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800` バイト。operator は env を設定するか、asset route をマウントするときに `maxBytes` を渡せます。

登録済み asset metadata value は current reference extension で `maxSize` を持ちうる。存在する場合、その `maxSize` はその metadata value について route default を上書きします。`registerArtifactKind` は current compatibility API 名であり、ここでの kind は asset metadata value を指します。

```ts
registerArtifactKind({
  kind: "operator.example/log-bundle",
  description: "Operator-owned diagnostic bundle",
  contentTypeHint: "application/gzip",
  maxSize: 50 * 1024 * 1024,
});
```

未知 / 未登録の metadata value は global cap を使います。content-length preflight は既知の最大 cap を使い、post-parse body check が submitted metadata value に対して厳密な cap を強制します。

失敗モード:

### Upload exceeds effective cap {#upload-exceeds-effective-cap}

- HTTP / code: `413 resource_exhausted`
- Recovery: `TAKOSUMI_ARTIFACT_MAX_BYTES` を上げる、より大きい `maxSize` を register する、asset を圧縮する、R2 / S3 / GCS へ storage を移す

### Digest mismatch {#digest-mismatch}

- HTTP / code: `409 failed_precondition`
- Recovery: 計算済 digest で re-upload するか、declared digest を修正

malformed digest syntax は `400 invalid_argument` です。digest 文字列は正しいが bytes と一致しない場合は apply guard と同じ `409 failed_precondition` です。

### asset credential missing {#dataasset-credential-missing}

- HTTP / code: 有効化された extension route で credential が欠落または不正な場合は `401 unauthenticated` を返す。asset extension を mount しない operator はその surface から discovery や route を公開せず `404` を返す。
- Recovery: reference asset extension の writer/admin credential (`TAKOSUMI_DEPLOY_TOKEN` compatibility env var) または read-only fetch credential (`TAKOSUMI_ARTIFACT_FETCH_TOKEN`) を用途に合わせて設定。

## Accepted asset metadata policy {#accepted-dataasset-metadata-policy}

asset metadata value は operator-owned open metadata です。各 runtime handler は受け付けるものを current compatibility field `acceptedArtifactKinds` で宣言します。例:

- asset-backed custom runtime handler: 明示的に登録された operator-owned metadata value
- source-backed worker / web-service runtime handler: `acceptedArtifactKinds: []` と resolved source view + operator-selected adapter input

runtime-agent は runtime handler code が動く前に mismatch を reject します。reference adapter metadata level の validation はより厳しいことがあります。`worker` adapter metadata を採用した operator distribution は entrypoint input を要求し、asset descriptor は要求しません。

operator runtime-agent implementation が discovery 用に登録しうる bundled asset metadata の例:

| Metadata value  | Use case                                       |
| --------------- | ---------------------------------------------- |
| `oci-image`     | OCI / Docker image referenced by URI.          |
| `js-bundle`     | ESM JavaScript bundle for serverless runtimes. |
| `lambda-zip`    | AWS Lambda deployment zip.                     |
| `static-bundle` | Static site tarball for Pages-style hosts.     |
| `wasm`          | WebAssembly module.                            |

これらの値は asset metadata value であり、Source authoring kind でも reference adapter metadata identity でもありません。

reference extension の reader-facing wire は明示的な `{ kind, hash | uri, metadata? }` descriptor です。asset-backed runtime handler へ dispatch する前に operator resolver がこの descriptor を検証します。正規化できない asset reference は `invalid_argument` です。operator-local な省略形を受け付ける場合でも、それはその operator profile の入力規約であり、portable asset reference shape ではありません。

## 認証ポリシー {#auth-policy}

asset surface は write / read credential を分離します。下記 env var は current reference extension の compatibility names です。

- `TAKOSUMI_DEPLOY_TOKEN`: asset writer/admin bearer。upload、list、delete、 GC、read に使用
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`: runtime-agent host 向けの read-only `GET` / `HEAD /v1/artifacts/:hash`

runtime-agent が apply のために upload された bytes を fetch する場合、read-only token を受け取ります。

## オペレーター surface {#operator-surface}

asset extension を有効化した operator のコントロール:

- `TAKOSUMI_ARTIFACT_MAX_BYTES`: global upload cap
- `registerArtifactKind(..., { allowOverride })`: operator が管理する bootstrap / implementation loading 時の asset metadata discovery と optional な per-metadata value size 登録
- `takosumi artifact kinds`: operator asset metadata value の read-only discovery 用 current compatibility command
- `takosumi artifact gc`: 参照されていない blob の mark-and-sweep cleanup

policy reload command や transform 承認 workflow を追加する場合は、対応する reference docs と CLI surface を一緒に更新します。

## 関連ページ

- [Reference Backend Binding](./kind-bindings.md)
- [Runtime Handler Guide](./runtime-handler-contract.md)
- [Reference Takosumi Route Inventory](./service-http-api.md)
- [Environment Variables](./env-vars.md)
- [Audit Events](./audit-events.md)
