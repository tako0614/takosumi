# @takos/takosumi-plugins

Component kind catalog and **materializer host** for Takosumi. Operators attach
materializers as a **plain array** to `createPaaSApp({ plugins: [...] })` — the
Vite plugin pattern — or as `materializers: [...]` for inline-function form.
Each plugin returns a `KernelPlugin` that declares the kind URI(s) it provides
and registers itself with the kernel on boot.

This package itself ships **no cloud SDK code**. Cloud-backed `KernelPlugin`
factories live in six independent provider packages
(`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`),
each importable on its own. The materializer host plus kind catalog stays
core-only.

## Install (cloud provider package 経由)

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  plugins: [
    cloudflareWorkerProvider({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
    }),
    awsS3ObjectStoreProvider({
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
  ],
});
```

## Inline materializer (operator-owned 任意 JS)

```typescript
const { app } = await createPaaSApp({
  materializers: [
    {
      kindUri: "https://example.com/kinds/cache@v1",
      apply: async (spec, ctx) => ({ outputs: { endpoint: "redis://..." } }),
      destroy: async (handle, ctx) => {/* ... */},
    },
  ],
});
```

Old `enableAws: true` / `createTakosumiProductionProviders(opts)` style switches
are retired — operators choose the providers they need and pass credentials per
factory.

## Component kinds (Takosumi curated 4)

Catalog は **extensible**。 operator は任意 domain で新 kind を JSON-LD publish

- materializer 実装 で追加できる。 Takosumi curated 4 kind の正本 URI は
  `https://takosumi.com/kinds/v1/<name>` (JSON-LD で publish)。

| Kind            | Description                                               |
| --------------- | --------------------------------------------------------- |
| `worker`        | Serverless HTTP service (JS bundle or container artifact) |
| `postgres`      | Managed PostgreSQL instance                               |
| `object-store`  | S3-compatible bucket                                      |
| `custom-domain` | DNS record + TLS termination                              |

旧 `oidc` kind は takosumi-cloud (= Takosumi Accounts operator distribution)
に移動済。 worker 側は `listen.operator.identity.oidc` で標準 env を受け取る。

## Providers (= 別 package、 6 cloud)

cloud-backed materializer は **独立 JSR package** として publish される。 各
package は paper-thin な lifecycle client を提供し、 cloud SDK code / credential
/ 副作用は **runtime-agent** の背後に住む。

| Package                                 | Cloud / runtime                                   |
| --------------------------------------- | ------------------------------------------------- |
| `@takos/takosumi-cloudflare-providers`  | Cloudflare (Workers / R2 / DNS)                   |
| `@takos/takosumi-aws-providers`         | AWS (Fargate / S3 / RDS / Route53)                |
| `@takos/takosumi-gcp-providers`         | GCP (Cloud Run / GCS / Cloud SQL / Cloud DNS)     |
| `@takos/takosumi-kubernetes-providers`  | Kubernetes Deployment + Service                   |
| `@takos/takosumi-deno-deploy-providers` | Deno Deploy                                       |
| `@takos/takosumi-selfhost-providers`    | Self-host (docker / systemd / filesystem / minio) |

provider id namespace は `@takos/<cloud>-<service>` を使う (= `@takos/aws-s3`,
`@takos/cloudflare-r2`, `@takos/gcp-cloud-run` 等)。 Bare provider IDs
(`aws-fargate`, `cloud-run`, etc.) は reject される。

## Artifact kinds (5 bundled)

The runtime-agent connectors advertise which artifact kinds they accept. Bundled
kinds:

- `oci-image` (URI ref, no upload)
- `js-bundle` (Cloudflare Workers / Deno Deploy)
- `lambda-zip` (future AWS Lambda)
- `static-bundle` (future static site)
- `wasm` (future WASM module)

Operators register additional kinds via `registerArtifactKind` from
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract).

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)

> The `@takos/` JSR scope is the reference Takosumi distribution published by
> Takos; the contract is the authority, and contract-compatible alternative
> publishers (e.g., `@example/takosumi-plugins`) are spec-permitted — currently
> untested, with no architectural privilege.
