# @takos/takosumi

Takosumi の turnkey umbrella package。root export は public contract types で、 kernel / plugins / installer / runtime-agent / cli は sub-export から使います。 cloud-backed provider は **別 install** (= `@takos/takosumi-{aws,gcp,cloudflare,kubernetes,
deno-deploy,selfhost}-providers`)。

## Self-host

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788

deno run -A jsr:@takos/takosumi/server --port 8788 &
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi init .takosumi.yml
mkdir -p dist
printf 'export default { fetch() { return new Response("ok") } };\\n' > dist/worker.mjs
takosumi install --source . --space space:personal
```

This stock server path records Installation / Deployment metadata and is useful for local smoke tests. In the reference kernel/server, provider materialization uses an operator bootstrap server that passes `kindAliases` and provider `plugins` to `createPaaSApp()`. Compatible implementations may use another registry, controller, or operator inventory.

## Sub-exports

- `jsr:@takos/takosumi` — public contract types を re-export
- `jsr:@takos/takosumi/contract` — public contract types
- `jsr:@takos/takosumi/installer` — `.takosumi.yml` parser + install client
- `jsr:@takos/takosumi/kernel` — kernel programmatic API (`createPaaSApp`)
- `jsr:@takos/takosumi/server` — kernel HTTP server entry (deno run で起動)
- `jsr:@takos/takosumi/plugins` — reference adapter entry (official catalog descriptor helpers + reference adapter helpers)
- `jsr:@takos/takosumi/kinds` — Takosumi official catalog kind descriptors (`worker` / `web-service` / `postgres` / `object-store` / `gateway`)
- `jsr:@takos/takosumi/cli` — CLI module entry

cloud-backed reference `KernelPlugin` adapter factory は **別 package** に分離されているため、 attach 時は対応 cloud package を直接 import する:

```ts
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
```

## Sister packages

core contract / installer lifecycle:

- `jsr:@takos/takosumi-contract` — current wire types (AppSpec / Installer API)
- `jsr:@takos/takosumi-kernel` — kernel only (server + apply pipeline)
- `jsr:@takos/takosumi-installer` — `.takosumi.yml` parser + git fetch + deploy client
- `jsr:@takos/takosumi-cli` — CLI only

reference helpers / tooling:

- `jsr:@takos/takosumi-plugins` — official catalog helpers and reference adapter helpers
- `jsr:@takos/takosumi-runtime-agent` — lifecycle execution host

cloud provider packages (= 別 install):

- `jsr:@takos/takosumi-cloudflare-providers` — Cloudflare (Workers / R2 / DNS)
- `jsr:@takos/takosumi-aws-providers` — AWS (Fargate / S3 / RDS / Route53)
- `jsr:@takos/takosumi-gcp-providers` — GCP (Cloud Run / GCS / Cloud SQL)
- `jsr:@takos/takosumi-kubernetes-providers` — Kubernetes Deployment + Service
- `jsr:@takos/takosumi-deno-deploy-providers` — Deno Deploy
- `jsr:@takos/takosumi-selfhost-providers` — Self-host (docker / systemd / filesystem / minio)

## Scope note

The `@takos/` JSR scope is the **reference distribution** that Takos publishes for Takosumi. Authority lives in the contract (`@takos/takosumi-contract`), not in the publisher: this umbrella package only re-exports a specific reference implementation of that contract. Contract-compatible alternative publishers such as `@example/takosumi-kernel` can ship their own implementations; current verification covers the reference distribution.
