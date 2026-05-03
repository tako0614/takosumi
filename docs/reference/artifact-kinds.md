# Artifact Kinds

Takosumi の **artifact store** は content-addressed (`sha256:<hex>`) で
バイト列を保管し、manifest の `spec.artifact: { kind, hash }` から参照されます。
`kind` は **open string** で、第三者 connector が新しい種類を増やせる構造になっています。
このページは bundled kind / 拡張 API / upload 経路 / GC を整理します。

## なぜ registry が必要か

`Artifact.kind` は protocol 上 `string` のため、kernel は POST 時点では
任意の文字列を受け付けます。実際の "この connector はどの kind を
処理できるか" の判断は **runtime-agent の dispatcher** が
`Connector.acceptedArtifactKinds` と spec を突き合わせて行います
([Runtime-Agent API](/reference/runtime-agent-api))。

それでも registry を持つ理由は 3 つ:

1. **Discovery** — operator が `takosumi artifact kinds` を叩けば、
   この kernel に register されている全 kind と description / content-type
   hint を一覧できる。CLI の `--kind` 値の補助になる。
2. **Per-kind size override** — `RegisteredArtifactKind.maxSize` で
   kind 単位に upload 上限を上書きできる (kernel 全体の
   `TAKOSUMI_ARTIFACT_MAX_BYTES` を越える bundle を許す等)。
3. **3rd-party 拡張** — 新しい connector が新 kind を追加したい場合は
   `registerArtifactKind(...)` を呼ぶだけで CLI / discovery endpoint に
   反映される。contract package を fork する必要はない。

::: tip
kernel は POST `/v1/artifacts` で kind の妥当性を検証しません
(unknown kind でもアップロードは成功する)。**実際の弾き先は
runtime-agent dispatcher** で、spec の `artifact.kind` が connector の
`acceptedArtifactKinds` に含まれていなければ `ArtifactKindMismatchError`
を返します。
:::

## Bundled kinds

`@takos/takosumi-plugins` が `registerBundledArtifactKinds()` で登録する 5
種類です。Source:
[`packages/plugins/src/shape-providers/_artifact_kinds_bundled.ts`](https://github.com/tako0614/takosumi/blob/master/packages/plugins/src/shape-providers/_artifact_kinds_bundled.ts)

| kind            | description                                     | content-type hint          | accepted by (bundled)                                                                                                                       |
| --------------- | ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `oci-image`     | OCI / Docker container image (URI 参照、upload 不要) | —                          | `aws-fargate` / `cloud-run` / `cloudflare-container` / `azure-container-apps` / `k3s-deployment` / `docker-compose` / `systemd-unit`        |
| `js-bundle`     | ESM JS bundle for serverless runtimes           | `application/javascript`   | `cloudflare-workers` / `deno-deploy-workers`                                                                                                |
| `lambda-zip`    | AWS Lambda deployment zip                       | `application/zip`          | (将来の Lambda connector 用に予約 — bundled connector はまだ無し)                                                                                       |
| `static-bundle` | Static site tarball for Pages-style hosts       | `application/x-tar`        | (将来の Pages connector 用に予約)                                                                                                                  |
| `wasm`          | WebAssembly module                              | `application/wasm`         | (将来の WASM runtime connector 用に予約)                                                                                                            |

::: warning
`oci-image` は **registry URI で参照する pointer kind** です。bytes は
upload せず、`spec.artifact: { kind: "oci-image", uri: "ghcr.io/me/api:v1" }`
のように `uri` で渡します。content-addressed store には乗りません。
他の kind は基本的に `hash` (`sha256:...`) で参照される **byte kind** です。
:::

## API for extension

新 kind を追加する 3rd-party connector は `registerArtifactKind` を呼びます。
Source:
[`packages/contract/src/runtime-agent-lifecycle.ts`](https://github.com/tako0614/takosumi/blob/master/packages/contract/src/runtime-agent-lifecycle.ts)

```ts
import { registerArtifactKind } from "takosumi-contract";

registerArtifactKind({
  kind: "deno-zip",
  description: "Deno self-contained executable bundle",
  contentTypeHint: "application/zip",
  // Optional: per-kind override of TAKOSUMI_ARTIFACT_MAX_BYTES.
  maxSize: 200 * 1024 * 1024,
});
```

API 一覧:

```ts
// Upsert (collision time に warn を出す；同一 payload は silent)。
registerArtifactKind(kind, { allowOverride?: boolean }): RegisteredArtifactKind | undefined;

// Discovery: 全 kind の readonly snapshot
listArtifactKinds(): readonly RegisteredArtifactKind[];

// 単独 lookup
getArtifactKind(kind): RegisteredArtifactKind | undefined;
isArtifactKindRegistered(kind): boolean;

// テスト / dynamic plugin teardown 用
unregisterArtifactKind(kind): boolean;
```

`registerArtifactKind` は process-global `Map` に対する upsert です。
別 metadata で同じ `kind` を上書きすると `console.warn` を出します
(`allowOverride: true` を渡すと抑制)。

::: tip
registry は **discovery layer** なので、connector が新 kind を実装するだけなら
登録は必須ではありません — 登録していなくても upload も apply も通ります。
ただし `takosumi artifact kinds` に出ないと operator が仕様を見つけられないので、
public 提供する connector は登録しておくのが推奨です。
:::

## Upload flow

```
┌────────────┐   POST /v1/artifacts (multipart)   ┌─────────────────────┐
│ takosumi   │ ────────────────────────────────▶ │  kernel             │
│ artifact   │   form: kind, body, metadata?     │  - sha256 計算      │
│ push <f>   │                                    │  - size cap 検査    │
│ --kind k   │ ◀──────────────────────────────── │  - object storage   │
└────────────┘   { hash: "sha256:...", size }    │    に key= artifacts│
                                                  │    /<hex> で put    │
                                                  └─────────────────────┘

manifest:
  spec:
    artifact:
      kind: js-bundle
      hash: sha256:abc123...

┌─────────────────────┐  POST /v1/lifecycle/apply ┌────────────────────┐
│ kernel apply 段階   │ ─────────────────────────▶│ runtime-agent      │
│   artifactStore:    │   { spec, artifactStore } │ ┌──────────────┐  │
│     baseUrl, token  │                            │ │ connector    │  │
└─────────────────────┘                            │ │ acceptedKinds│  │
                                                   │ └──────────────┘  │
                                                   │   ↓               │
                                                   │ ArtifactFetcher   │
                                                   │   GET artifacts/  │
                                                   │   <hash>          │
                                                   └────────────────────┘
```

主な振る舞い:

- **Auth** — write 系 (`POST` / `DELETE` / `gc`) は
  `TAKOSUMI_DEPLOY_TOKEN` を要求。read 系 (`GET` / `HEAD` の `/:hash`) は
  `TAKOSUMI_ARTIFACT_FETCH_TOKEN` も accept する (runtime-agent 側に scoped)。
- **Hash** — server side で SHA-256 を再計算するため、client 側 `expectedDigest`
  field との不一致は 400。
- **Size cap** — `TAKOSUMI_ARTIFACT_MAX_BYTES` (default 50 MiB)。
  `Content-Length` と buffer 後の長さの両方で 413 を返す。kernel は body を
  全て memory に乗せるので、大きい bundle は外部 object storage backend
  (R2 / S3 / GCS) に切り替えて kernel 経由を避けるのが本筋。
- **Storage layout** — `<bucket>/artifacts/<sha256-hex>`。bucket 既定値は
  `takosumi-artifacts`。

manifest 側の参照は [Manifest § artifact](/manifest) を参照。

## GC

```bash
# 何が消えるかだけ確認
takosumi artifact gc --dry-run --remote $URL --token $TOKEN

# 実際に削除
takosumi artifact gc --remote $URL --token $TOKEN
```

GC アルゴリズム (`POST /v1/artifacts/gc`):

1. `recordStore.listReferencedArtifactHashes()` を呼び、persisted な
   全 deployment record (destroyed 含む — race protection のため) から
   hash 集合を作る。
2. object storage を全 page walk して、その集合に **含まれない** blob を
   削除する。
3. response: `{ deleted: [...], retained: <count>, dryRun: <bool> }`。

::: warning
`recordStore` が wire されていないと GC は **何も削除しません** — 安全側。
in-memory record store では kernel restart で reference 情報が消えるため、
production では SQL backed store
(`SqlTakosumiDeploymentRecordStore`) を必ず inject してください
([Operator Bootstrap](/operator/bootstrap))。
:::

## CLI 概要

```bash
takosumi artifact push <file> --kind <kind> [--metadata k=v ...]   # upload
takosumi artifact list                                             # paginate
takosumi artifact rm <hash>                                        # delete
takosumi artifact kinds [--table]                                  # discovery
takosumi artifact gc [--dry-run]                                   # mark+sweep
```

全 subcommand が remote kernel 必須 (`--remote` か `TAKOSUMI_KERNEL_URL` を
要求)。Source:
[`packages/cli/src/commands/artifact.ts`](https://github.com/tako0614/takosumi/blob/master/packages/cli/src/commands/artifact.ts)

## 関連ページ

- [Manifest](/manifest) — `spec.artifact` の書き方
- [Kernel HTTP API](/reference/kernel-http-api) — `/v1/artifacts/*` endpoint 詳細
- [Runtime-Agent API](/reference/runtime-agent-api) — `acceptedArtifactKinds`
  と `artifactStore` locator の伝搬
- [Lifecycle Protocol](/reference/lifecycle) — apply 経路全体での artifact
  fetch のタイミング
