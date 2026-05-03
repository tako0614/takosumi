# Takos Cloudflare Provider Scaffold

This directory is the deployment scaffold for the Takosumi Cloudflare profile.
The plugin code under `src/providers/cloudflare/` intentionally has no direct
Cloudflare SDK dependency; operators inject production clients that implement
the typed interfaces exported by `@takos-plugins/providers/cloudflare`.

## Files

- `wrangler.toml`: Worker, D1, R2, Queue, Durable Object, and Container binding
  template.
- `src/worker.ts`: Worker entrypoint with health routes and routing to the
  coordination Durable Object and workload Container.
- `Dockerfile`: Deno PaaS container template. Build it from a context that
  includes both `takos` and `takosumi`.

The scaffold proves the binding and routing shape. The included Dockerfile runs
the PaaS API entrypoint; production operators still need to inject real
Cloudflare clients and plugin config before serving traffic.

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
3. Build the container from the ecosystem root or configure Wrangler with an
   equivalent build context.
4. Build a `KernelPluginClientRegistry` from real bindings and trusted operator
   clients, then create the app with `createCloudflarePaaSApp` from
   `@takos-plugins/bootstrap`.
5. Deploy from this directory with `wrangler deploy`.

Wrangler supports the `containers` field and requires a matching Durable Object
binding for each container class. The scaffold keeps the deploy shape explicit
so provider clients can be implemented outside the Takosumi kernel.
