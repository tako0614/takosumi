# @takos/takosumi-plugins

Component kind catalog and provider plugins bundled with Takosumi. Operators
attach plugins as a **plain array** to `createPaaSApp({ plugins: [...] })` — the
Vite plugin pattern. Each plugin returns a `KernelPlugin` that declares the kind
URI(s) it provides and registers itself with the kernel on boot.

Plugins are paper-thin HTTP wrappers around the runtime-agent (see
[`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)).
They contain no cloud SDK code.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  awsS3ObjectStoreProvider,
  cloudflareWorkerProvider,
} from "@takos/takosumi-plugins/bundled";

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

Each provider factory is a separate `KernelPlugin` export under
`@takos/takosumi-plugins/bundled`. Old `enableAws: true` /
`createTakosumiProductionProviders(opts)` style switches are retired —
operators choose the providers they need and pass credentials per factory.

## Component kinds (5 frozen)

正本 URI は `https://takosumi.com/kinds/v1/<name>` (JSON-LD で publish)。

| Kind            | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `worker`        | Serverless HTTP service (JS bundle or container artifact)    |
| `postgres`      | Managed PostgreSQL instance                                  |
| `object-store`  | S3-compatible bucket                                         |
| `custom-domain` | DNS record + TLS termination                                 |
| `oidc`          | OIDC consumer mount point (Installation-scoped client)       |

## Providers (21)

All provider IDs use the `@takos/<cloud>-<service>` namespace.

| Cloud      | Providers                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS        | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP        | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure      | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes | `@takos/kubernetes-deployment`                                                                                                                                            |
| Deno       | `@takos/deno-deploy`                                                                                                                                                      |
| Self-host  | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |

Bare provider IDs (`aws-fargate`, `cloud-run`, etc.) are rejected. Use the
namespaced IDs above.

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
