# @takos/takosumi-plugins

Reference component kind registry and **materializer host** for Takosumi.
Operators attach materializers as a **plain array** to
`createPaaSApp({ kindAliases, plugins: [...] })` — the Vite plugin pattern — or
as `materializers: [...]` for inline-function form. Each plugin returns a
`KernelPlugin` that declares the kind URI(s) it provides. Operators attach
plugins and alias maps explicitly; the Takosumi contract does not define
component kinds.

This package itself ships **no cloud SDK code**. Cloud-backed `KernelPlugin`
factories live in six independent provider packages
(`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`),
each importable on its own. The materializer host plus Takos reference kind
registry stays core-only.

## Install (cloud provider package 経由)

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
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

## Reference component kinds

Takos publishes a reference registry for five common component kinds. These
descriptors live outside the Takosumi AppSpec contract; operators opt into them
by importing this package and passing aliases such as
`{ web: "https://takosumi.com/kinds/v1/web-service" }`.

Operator distributions can publish their own JSON-LD descriptors on any domain
and map short aliases to those URIs.

| Kind            | Description                                            |
| --------------- | ------------------------------------------------------ |
| `worker`        | JavaScript edge worker from prepared source entrypoint |
| `web-service`   | OCI/container web service with an HTTP port            |
| `postgres`      | Managed PostgreSQL instance                            |
| `object-store`  | S3-compatible bucket                                   |
| `custom-domain` | DNS record + TLS termination                           |

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

## Data assets

Takosumi AppSpec does not define artifact kinds. The optional artifact routes
can still store operator-owned blobs, but `kind` there is external metadata
owned by the operator / connector distribution.

Operators can register discoverable data-asset kinds via `registerArtifactKind`
from [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract).

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)

> The `@takos/` JSR scope is the reference Takosumi distribution published by
> Takos; the contract is the authority, and contract-compatible alternative
> publishers (e.g., `@example/takosumi-plugins`) are spec-permitted — currently
> untested, with no architectural privilege.
