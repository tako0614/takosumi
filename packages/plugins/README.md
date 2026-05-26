# @takos/takosumi-plugins

Compatibility package for Takosumi official catalog descriptor helpers. The documented official helper surface is the `@takos/takosumi-plugins/kinds` subpath. Root exports also include compatibility helpers used by the reference kernel; those exports are implementation wiring, not the catalog specification.

JSON-LD descriptors publish descriptor/type/catalog metadata; runtime behavior lives in operator-selected implementation bindings.

The catalog descriptors are Takosumi official type catalog material. Provider adapters and gateway-side helpers are reference kernel implementation helpers. Operators using the reference kernel can attach provider adapters as a **plain array** to `createPaaSApp({ kindAliases, plugins: [...] })` — the Vite plugin pattern in that implementation. Each adapter returns a `KernelPlugin` that declares the kind URI(s) it provides.

This package itself ships **no cloud SDK code**. Cloud-backed reference `KernelPlugin` factories live in provider packages (`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,deno-deploy}-providers`), and external adapter bindings live in individually importable `@takos/takosumi-plugin-<kind>-<backend>` packages. The official catalog descriptors stay descriptor/helper-only and provider-neutral. The published descriptor identities under `https://takosumi.com/kinds/v1/*` are Takosumi official type catalog entries; the provider adapters are reference implementation wiring.

## Reference Kernel Example

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

This is a reference-kernel bootstrap example, not an AppSpec or Takosumi core requirement. Operators choose the providers they need and attach them as the reference adapter array (`plugins` option) in the reference kernel. Cloud credentials live on the runtime-agent environment or operator host, not in public bootstrap factory arguments.

## Official Catalog Descriptor Helpers

This package includes helper exports for the current `takosumi.com` v1 catalog descriptors. That descriptor set is not a closed built-in kind set. Importing this package is a reference helper convenience. Operators adopt descriptors through policy, visibility, and alias mapping such as `{ web: "https://takosumi.com/kinds/v1/web-service" }`.

Operator distributions can publish their own JSON-LD descriptors on any domain and map short aliases to those URIs.

| Kind           | Description                                            |
| -------------- | ------------------------------------------------------ |
| `worker`       | JavaScript edge worker from resolved source entrypoint |
| `web-service`  | OCI/container web service with an HTTP port            |
| `postgres`     | Managed PostgreSQL instance                            |
| `object-store` | S3-compatible bucket                                   |
| `gateway`      | HTTP listener, routing, host, and TLS policy           |

An operator account-plane distribution can publish OIDC issuer material at a Space-visible external publication path. The generic example below uses a neutral path. Takosumi Cloud defines `operator.identity.oidc` in `takosumi-cloud/docs/workload-publications.md`.

```yaml
listen:
  oidc:
    from: publisher.identity.primary
    as: secret-env
    required: true
```

## Reference provider adapters

reference provider / adapter は **独立 JSR package** として publish される。各 package は paper-thin な lifecycle client を提供し、 cloud SDK code / credential / 副作用は **runtime-agent** または operator-owned external system の背後に住む。

| Package                                             | Cloud / runtime                               |
| --------------------------------------------------- | --------------------------------------------- |
| `@takos/takosumi-cloudflare-providers`              | Cloudflare (Workers / R2 / DNS)               |
| `@takos/takosumi-aws-providers`                     | AWS (Fargate / S3 / RDS / Route53)            |
| `@takos/takosumi-gcp-providers`                     | GCP (Cloud Run / GCS / Cloud SQL / Cloud DNS) |
| `@takos/takosumi-kubernetes-providers`              | Kubernetes Deployment + Service               |
| `@takos/takosumi-deno-deploy-providers`             | Deno Deploy                                   |
| `@takos/takosumi-plugin-web-service-docker-compose` | Docker Compose web-service adapter            |
| `@takos/takosumi-plugin-web-service-systemd`        | systemd web-service adapter                   |
| `@takos/takosumi-plugin-object-store-minio`         | MinIO object-store adapter                    |
| `@takos/takosumi-plugin-object-store-filesystem`    | filesystem object-store adapter               |
| `@takos/takosumi-plugin-postgres-docker`            | Docker Postgres adapter                       |
| `@takos/takosumi-plugin-gateway-coredns`            | CoreDNS gateway adapter                       |

reference provider id root は `@takos/<cloud>-<service>` を使う (= `@takos/aws-s3`, `@takos/cloudflare-r2`, `@takos/gcp-cloud-run` 等)。 operator distribution は自分の provider IDs と validation policy を持てます。

## Data assets

DataAsset metadata values are operator metadata. The optional DataAsset routes store operator-owned blobs, and the current compatibility `kind` field is owned by the operator / connector distribution.

Reference operators can register discoverable DataAsset metadata values via `registerArtifactKind` from `@takos/takosumi-contract/reference/runtime-agent-lifecycle`.

## See also

- [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)
- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)

> The `@takos/` JSR scope is the reference Takosumi distribution published by Takos. Contract-compatible publishers such as `@example/takosumi-plugins` can publish their own descriptors and adapters; current verification covers the reference distribution.
