# @takos/takosumi

Takosumi の turnkey umbrella package。 core 6 つ (contract / kernel / plugins /
installer / runtime-agent / cli) を 1 つの import で利用可能。 cloud-backed
provider は **別 install** (=
`@takos/takosumi-{aws,gcp,cloudflare,kubernetes,
deno-deploy,selfhost}-providers`)。

## Self-host

```bash
deno run -A jsr:@takos/takosumi/server   # kernel HTTP server
deno install -gA -n takosumi jsr:@takos/takosumi-cli   # CLI
takosumi install --source . --space space_personal
```

## Sub-exports

- `jsr:@takos/takosumi` — core plugins (kinds / materializer host) を re-export
- `jsr:@takos/takosumi/kernel` — kernel programmatic API (`createPaaSApp`)
- `jsr:@takos/takosumi/server` — kernel HTTP server entry (deno run で起動)
- `jsr:@takos/takosumi/plugins` — plugins entry (kind catalog + materializer
  host)
- `jsr:@takos/takosumi/kinds` — Takosumi curated component kind catalog (worker
  / postgres / object-store / custom-domain)
- `jsr:@takos/takosumi/cli` — CLI module entry

cloud-backed `KernelPlugin` factory は **別 package** に分離されているため、
attach 時は対応 cloud package を直接 import する:

```ts
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
```

## Sister packages

core:

- `jsr:@takos/takosumi-contract` — canonical types (AppSpec / ComponentKind /
  ProviderPlugin / KernelPlugin)
- `jsr:@takos/takosumi-kernel` — kernel only (server + apply pipeline)
- `jsr:@takos/takosumi-plugins` — plugins only (kinds / materializer host /
  factories)
- `jsr:@takos/takosumi-installer` — `.takosumi.yml` parser + git fetch + deploy
  client
- `jsr:@takos/takosumi-runtime-agent` — runtime-agent (data plane)
- `jsr:@takos/takosumi-cli` — CLI only

cloud provider packages (= 別 install):

- `jsr:@takos/takosumi-cloudflare-providers` — Cloudflare (Workers / R2 / DNS)
- `jsr:@takos/takosumi-aws-providers` — AWS (Fargate / S3 / RDS / Route53)
- `jsr:@takos/takosumi-gcp-providers` — GCP (Cloud Run / GCS / Cloud SQL)
- `jsr:@takos/takosumi-kubernetes-providers` — Kubernetes Deployment + Service
- `jsr:@takos/takosumi-deno-deploy-providers` — Deno Deploy
- `jsr:@takos/takosumi-selfhost-providers` — Self-host (docker / systemd /
  filesystem / minio)

## Scope note

The `@takos/` JSR scope is the **reference distribution** that Takos publishes
for Takosumi. Authority lives in the contract (`@takos/takosumi-contract`), not
in the publisher: this umbrella package only re-exports a specific reference
implementation of that contract. Contract-compatible alternative publishers
(e.g., `@example/takosumi-kernel`) are spec-permitted — currently untested, but
they hold no architectural privilege over this reference distribution.
