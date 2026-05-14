# Takosumi Cloudflare Provider Scaffold

This directory is the deployment scaffold for the Takosumi Cloudflare profile.
The plugin code under `src/providers/cloudflare/` intentionally has no direct
Cloudflare SDK dependency; operators inject production clients that implement
the typed interfaces exported by `@takos-plugins/providers/cloudflare`.

## Files

- `wrangler.toml`: Worker, D1, R2, Queue, Durable Object, and Container binding
  template.
- `src/worker.ts`: Worker entrypoint with edge health routes, routing to the
  coordination Durable Object, and kernel control-plane proxying into a
  Cloudflare Container.
- `Dockerfile`: Deno PaaS container template. Build it from a context that
  includes both `takos` and `takosumi`.

The scaffold proves the binding and routing shape. The included Dockerfile runs
the PaaS API entrypoint; production operators still need to inject real
Cloudflare clients, kernel persistence, object storage, and plugin config before
serving traffic.

## Routing Shape

The Worker is the public front for the Cloudflare deployment profile, but the
Takosumi kernel still runs in a Cloudflare Container. The Worker forwards kernel
control-plane HTTP paths without rewriting method, path, query, body, or auth
headers:

- `/v1/*` for public deploy and artifact APIs.
- `/api/internal/v1/*` for operator/internal APIs and runtime-agent RPC.
- `/health`, `/capabilities`, `/readyz`, `/livez`, `/status/summary`,
  `/openapi.json`, and `/metrics`.

The Worker-local routes remain at the edge:

- `/healthz` reports Worker health only.
- `/coordination/*` routes to `TakosCoordinationObject`.
- `/storage/healthz` checks D1/R2 bindings.
- `/queue/test` verifies Queue producer wiring.
- `/runtime/*` is reserved for direct workload-container routing and keeps the
  existing `?instance=` selection.

Do not replace kernel `/readyz` with a Worker-local response. Kernel readiness
checks include role, storage, plugin, internal secret, and worker-daemon state.

## Binding Clients

The package exports Worker binding helpers from
`@takos-plugins/providers/cloudflare`:

- R2 bindings can be converted to a Takos object-storage adapter.
- Queue bindings support enqueue through the Worker `Queue.send` API. Lease,
  ack, nack, and dead-letter operations require an injected full
  `CloudflareQueueClient`.
- D1 bindings require an injected `CloudflareD1StorageClient` or gateway. The
  helper intentionally refuses to pretend that a raw D1 binding is a complete
  transactional Takos storage driver.
- Durable Object bindings can be converted to the coordination adapter and use
  the endpoints implemented by `TakosCoordinationObject` in `src/worker.ts`.

## Operator Steps

1. Replace placeholder D1/R2/Queue identifiers in `wrangler.toml`.
2. Install the Worker dependency used by the scaffold:
   `npm install @cloudflare/containers`.
3. Configure kernel container environment variables, including
   `TAKOSUMI_PROCESS_ROLE=takosumi-api`, `TAKOSUMI_ENVIRONMENT`,
   `TAKOSUMI_DATABASE_URL`, `TAKOSUMI_SECRET_STORE_PASSPHRASE`,
   `TAKOSUMI_DEPLOY_TOKEN`, `TAKOSUMI_DEPLOY_SPACE_ID`,
   `TAKOSUMI_INTERNAL_API_SECRET`, runtime-agent credentials, and optional
   `TAKOSUMI_METRICS_SCRAPE_TOKEN`.
4. Build the container from the ecosystem root or configure Wrangler with an
   equivalent build context.
5. Build a `KernelPluginClientRegistry` from real bindings and trusted operator
   clients, then create the app with `createPaaSApp` from
   `@takos/takosumi-kernel/bootstrap` when using a custom entrypoint. The
   included Dockerfile runs the default kernel server entrypoint directly.
6. Deploy from this directory with `wrangler deploy`.

Wrangler supports the `containers` field and requires a matching Durable Object
binding for each container class. The scaffold keeps the deploy shape explicit
so provider clients can be implemented outside the Takosumi kernel.
