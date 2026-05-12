# @takos/takosumi-plugins

Shape catalog, provider plugins, and compiler templates bundled with Takosumi.
The kernel auto-registers Shape contracts, artifact kinds, and runtime-agent
backed providers on boot. Templates are not kernel manifest input; installer /
compiler layers expand them to `resources[]` before deploy.

Plugins themselves are paper-thin HTTP wrappers around the runtime-agent (see
[`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent)).
They contain no cloud SDK code.

## Install

```typescript
import {
  createTakosumiProductionProviders,
  TAKOSUMI_BUNDLED_SHAPES,
  TAKOSUMI_BUNDLED_TEMPLATES,
} from "@takos/takosumi-plugins/shape-providers/factories";

const providers = createTakosumiProductionProviders({
  agentUrl: "http://agent.internal:8789",
  token: "<TAKOSUMI_AGENT_TOKEN>",
  artifactStore: {
    baseUrl: "http://kernel.internal:8788/v1/artifacts",
    token: "...",
  },
});
```

The kernel calls the Shape/provider registration path on boot via
`registerBundledShapesAndProviders(env)`. Template registration is only for
compiler processes that need authoring macros.

## Shapes (5)

| Shape                  | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `web-service@v1`       | Long-running HTTP service from an OCI image                  |
| `object-store@v1`      | S3-compatible bucket                                         |
| `database-postgres@v1` | Managed Postgres instance                                    |
| `custom-domain@v1`     | DNS record + TLS termination                                 |
| `worker@v1`            | Serverless JS function from an uploaded `js-bundle` artifact |

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

Legacy bare IDs (`aws-fargate`, `cloud-run`, etc.) still resolve with a
deprecation warning. They will be rejected in 0.12.

## Templates (2)

| Template                   | Use case                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| `selfhosted-single-vm@v1`  | All-in-one VM: systemd + docker + filesystem + local Postgres + coredns |
| `web-app-on-cloudflare@v1` | Web service on Cloudflare Container + R2 assets + DNS                   |

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
