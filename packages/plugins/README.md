# @takos/takosumi-plugins

Reference component kind descriptors and provider helper package for the
takosumi.com reference implementation. JSON-LD descriptors carry kind semantics;
provider adapters are the reference kernel's TypeScript adapter API. Operators
attach reference provider adapters as a **plain array** to
`createPaaSApp({ kindAliases, plugins: [...] })` — the Vite plugin pattern. Each
plugin returns a `KernelPlugin` that declares the kind URI(s) it provides.

This package itself ships **no cloud SDK code**. Cloud-backed reference
`KernelPlugin` factories live in six independent provider packages
(`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy,selfhost}-providers`),
each importable on its own. The takosumi.com reference kind examples stay
core-only.

## Install (cloud provider package 経由)

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
    }),
    awsS3ObjectStoreProvider({
      region: env.AWS_REGION,
    }),
  ],
});
```

Operators choose the providers they need and attach them as `plugins` in the
reference kernel. Cloud credentials live on the runtime-agent environment or
operator host, not in public bootstrap factory arguments.

## Reference component kinds

This package includes takosumi.com reference descriptor examples for five common
component kinds. Operators opt into them by importing this package and passing
aliases such as `{ web: "https://takosumi.com/kinds/v1/web-service" }`.

Operator distributions can publish their own JSON-LD descriptors on any domain
and map short aliases to those URIs.

| Kind            | Description                                            |
| --------------- | ------------------------------------------------------ |
| `worker`        | JavaScript edge worker from prepared source entrypoint |
| `web-service`   | OCI/container web service with an HTTP port            |
| `postgres`      | Managed PostgreSQL instance                            |
| `object-store`  | S3-compatible bucket                                   |
| `custom-domain` | DNS record + TLS termination                           |

Takosumi Accounts operator distribution は OIDC issuer を
`operator.identity.oidc` namespace で publish する。worker 側は
`listen.operator.identity.oidc` で標準 env を受け取る。

## Providers (= 別 package、 6 cloud)

cloud-backed reference provider adapter は **独立 JSR package** として publish
される。 各 package は paper-thin な lifecycle client を提供し、 cloud SDK code
/ credential / 副作用は **runtime-agent** の背後に住む。

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

DataAsset metadata kinds are operator metadata. The optional DataAsset routes
store operator-owned blobs, and `kind` is owned by the operator / connector
distribution.

Reference operators can register discoverable data-asset kinds via
`registerArtifactKind` from
[`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract).

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)

> The `@takos/` JSR scope is the reference Takosumi distribution published by
> Takos; the contract is the authority, and contract-compatible alternative
> publishers (e.g., `@example/takosumi-plugins`) are spec-permitted — currently
> untested, with no architectural privilege.
