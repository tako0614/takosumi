# Artifacts And Supply Chain

Takosumi の supply chain は、deploy artifact、runtime-agent connector、kernel
plugin、manifest dependency plugin を分けて考える。artifact は deploy 対象の
payload、plugin は kernel / deploy model の能力拡張、lock は再現性境界である。

## Artifact Store

Takosumi artifact store は content-addressed store である。

基本:

- byte artifact は `sha256:<hex>` で参照する。
- `POST /v1/artifacts` は server side で SHA-256 を再計算する。
- `expectedDigest` mismatch は 400。
- write / delete / GC は `TAKOSUMI_DEPLOY_TOKEN`。
- runtime-agent fetch は scoped な `TAKOSUMI_ARTIFACT_FETCH_TOKEN`。
- max size は `TAKOSUMI_ARTIFACT_MAX_BYTES`、default 50 MiB。
- storage layout は `<bucket>/artifacts/<sha256-hex>`。

`Artifact.kind` は open string である。kernel upload 時点では unknown kind でも
受け付ける。実際に deploy 可能かは runtime-agent connector の
`acceptedArtifactKinds` で決まる。

bundled artifact kinds:

| kind            | Kind type            | Accepted by bundled connectors   |
| --------------- | -------------------- | -------------------------------- |
| `oci-image`     | pointer kind (`uri`) | container / service provider     |
| `js-bundle`     | byte kind (`hash`)   | Cloudflare Workers / Deno Deploy |
| `lambda-zip`    | byte kind reserved   | future Lambda connector          |
| `static-bundle` | byte kind reserved   | future Pages-style connector     |
| `wasm`          | byte kind reserved   | future WASM runtime connector    |

artifact GC は `recordStore.listReferencedArtifactHashes()` を使い、persisted な
deployment records から参照されない blob を削除する。recordStore が wire されて
いない場合、GC は安全側で何も削除しない。

source:

- `docs/reference/artifact-kinds.md`
- `packages/contract/src/runtime-agent-lifecycle.ts`
- `packages/kernel/src/api/artifact_routes.ts`

## Bundled Catalog

現行 `@takos/takosumi-plugins` は標準 plugin set として shape / provider /
template を bundle している。これは次期 model では standard manifest plugins
へ整理する。

Shapes:

- `web-service@v1`
- `object-store@v1`
- `database-postgres@v1`
- `custom-domain@v1`
- `worker@v1`

Provider groups:

| Group       | Providers                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP         | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare  | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure       | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes  | `@takos/kubernetes-deployment`                                                                                                                                            |
| Selfhost    | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |
| Deno Deploy | `@takos/deno-deploy`                                                                                                                                                      |

Deno Deploy provider は default off で、`TAKOSUMI_ENABLE_DENO_DEPLOY_PROVIDER=1`
または `enableDenoDeploy: true` のときだけ登録される。

Templates:

- `selfhosted-single-vm@v1`
- `web-app-on-cloudflare@v1`

現代の manifest では namespaced provider id を canonical とする。legacy bare
provider id は current resolver で reject / rewrite hint の対象である。

source:

- `docs/reference/shapes.md`
- `docs/reference/providers.md`
- `docs/reference/templates.md`
- `packages/plugins/README.md`

## Kernel Plugin System

manifest dependency plugin とは別に、kernel adapter port を差し替える
`kernel plugin` system が既に存在する。

kernel plugin は `TakosumiKernelPluginManifest` を持つ。

```ts
interface TakosumiKernelPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kernelApiVersion: string;
  readonly capabilities: readonly KernelPluginCapability[];
  readonly metadata?: JsonObject;
}
```

current kernel plugin API version:

```text
2026-04-29
```

kernel plugin port:

- `auth`
- `coordination`
- `kms`
- `notification`
- `object-storage`
- `operator-config`
- `provider`
- `queue`
- `router-config`
- `secret-store`
- `source`
- `storage`
- `observability`
- `runtime-agent`

production / staging では reference / noop plugin selection は拒否される。
selected port に対して external I/O が `none` だけの plugin も拒否される。

source:

- `packages/contract/src/plugin.ts`
- `packages/kernel/src/plugins/registry.ts`
- `packages/kernel/src/plugins/types.ts`

## Trusted Kernel Plugin Install

kernel plugin には trusted install flow が実装済みである。

```ts
interface TrustedKernelPluginManifestEnvelope {
  readonly manifest: TakosumiKernelPluginManifest;
  readonly signature: {
    readonly alg: "ECDSA-P256-SHA256";
    readonly keyId: string;
    readonly value: string;
  };
}
```

install policy:

- `enabledPluginIds`
- `trustedKeyIds`
- `allowedPublisherIds`
- `allowedPorts`
- `allowedExternalIo`
- `requireImplementationProvenance`

production / staging では `TAKOSUMI_KERNEL_PLUGIN_MODULES` による dynamic
loading は拒否され、trusted install through operator registry が必要である。

source:

- `packages/kernel/src/plugins/trusted_install.ts`
- `packages/kernel/src/plugins/loader.ts`
- `packages/kernel/src/plugins/trust_marker.ts`

## Manifest Plugin Trust

manifest の `plugins[]` に書く deploy plugin dependency の trust policy は未確定
である。kernel adapter plugin の trusted install と混同しない。

現時点の推奨は `lock + capability`。

理由:

- 任意 URL / Git plugin の自由度を保てる。
- lock により再現性を担保できる。
- plugin が必要権限を宣言できる。
- operator policy で production 実行を制御できる。
- self-host PaaS として現実的な安全境界になる。
- 既存の trusted kernel plugin install と概念を揃えやすい。
