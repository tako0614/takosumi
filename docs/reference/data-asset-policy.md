# DataAsset Policy

> このページでわかること: DataAsset のアクセスポリシーとライフサイクル。

本リファレンスは、current v1 実装で Takosumi が DataAsset アップロードと
runtime-agent consume について強制する policy を記録する。

## Current Enforcement Points

Takosumi v1 は DataAsset policy を 3 箇所で強制する。

| Layer               | Enforcement                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Artifact upload     | `POST /v1/artifacts` requires the deploy bearer, computes `sha256`, verifies `expectedDigest`, and enforces size caps. |
| Artifact fetch      | `GET` / `HEAD /v1/artifacts/:hash` accepts either deploy bearer or read-only artifact-fetch bearer.                    |
| Runtime-agent apply | The lifecycle dispatcher checks `spec.artifact.kind` against the connector's `acceptedArtifactKinds`.                  |

kernel は current public deploy path でユーザー build ステップを実行せず、
transform も実行しない。source transform、artifact signing policy、cache warming
に関する将来計画は、対応する operator API と test が存在するまで アクティブな
CLI / HTTP 動作として文書化しない。

## Size Policy

global upload cap は `TAKOSUMI_ARTIFACT_MAX_BYTES` で default は `52428800`
バイト。operator は env を設定するか、artifact route をマウントするときに
`maxBytes` を渡せる。

登録済み artifact kind は `maxSize` を持ちうる。存在する場合、その `maxSize` は
その kind について route default を上書きする。

```ts
registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

未知 / 未登録の kind は global cap を使う。content-length プリフライトは既知の
最大 cap を使い、post-parse body チェックが submit された kind に対して厳密な
cap を強制する。

Failure mode:

| Condition                    | HTTP / code                                                     | Recovery                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Upload exceeds effective cap | `413 resource_exhausted`                                        | raise `TAKOSUMI_ARTIFACT_MAX_BYTES`, register a larger `maxSize`, compress the artifact, or move storage to R2 / S3 / GCS |
| Digest mismatch              | `400 invalid_argument`                                          | re-upload with the computed digest or fix the expected digest                                                             |
| Missing deploy bearer        | `401 unauthenticated` or route `404` when public token is unset | configure `TAKOSUMI_DEPLOY_TOKEN`                                                                                         |

## Accepted-Kind Policy

`Artifact.kind` は protocol 層では open だが、各 connector は受け付けるものを
宣言する。例:

| Connector family                     | Accepted kinds                                        |
| ------------------------------------ | ----------------------------------------------------- |
| OCI-backed web-service connectors    | `oci-image`                                           |
| Cloudflare Workers / Deno Deploy     | `js-bundle`                                           |
| Operator-installed custom connectors | any registered or custom kind they explicitly declare |

runtime-agent は connector コードが動く前に mismatch を reject する。Shape
レベルの validation はより厳しいことがある: `worker@v1` は `hash` 付きの
`js-bundle` のみを受け付ける。

## Auth Policy

artifact surface は意図的に write / read credential を分離する。

| Credential                      | Scope                                                                |
| ------------------------------- | -------------------------------------------------------------------- |
| `TAKOSUMI_DEPLOY_TOKEN`         | upload, list, delete, GC, and read                                   |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | read-only `GET` / `HEAD /v1/artifacts/:hash` for runtime-agent hosts |

runtime-agent は apply のために upload された bytes を fetch するだけで済む
場合は、read-only token を受け取る。deploy bearer は不要であるべきだ。

## Operator Surface

current の operator コントロール:

- `TAKOSUMI_ARTIFACT_MAX_BYTES` for the global upload cap.
- `registerArtifactKind(..., { allowOverride })` during operator-controlled
  bootstrap/plugin loading for discovery metadata and optional per-kind size.
- `takosumi artifact kinds` for read-only discovery.
- `takosumi artifact gc` for mark-and-sweep cleanup of unreferenced blobs.

現在 `takosumi policy artifact ...` コマンドは無い。policy reload コマンド、
transform 承認 workflow、署名検証 backend を追加するには、対応する実装、
test、本リファレンスの更新が必要となる。

## 関連ページ

- [DataAsset Kinds](/reference/artifact-kinds)
- [Connector Contract](/reference/connector-contract)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Environment Variables](/reference/env-vars)
- [Audit Events](/reference/audit-events)
