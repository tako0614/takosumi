# Takosumi Conventions

`Component.kind` is an opaque string resolved by the operator. The manifest shape stays `{ apiVersion, metadata, components }`, and each component stays `{ kind, spec, publish, listen }`.

## Kind ownership

- Portable kind packages use `@takos/takosumi-kind-<alias>` and own `spec/kind.jsonld`, helper types, and validators.
- Native kind packages live in the sibling `takosumi-plugins` repository, use the same naming rule, and own substrate-specific kind definition metadata and adapter factories.
- Kind families such as worker, postgres, object-store, gateway, and web-service are documentation groups, not an manifest field.
- Backend-specific `spec` fields belong to native kinds. Do not hide them behind a portable kind.

## Adding a kind package

1. Choose a stable alias such as `cloudflare-worker` or `aws-rds-postgres`.
2. Create `packages/kind-<alias>/deno.json`, `mod.ts`, and `spec/kind.jsonld` in `takosumi/` for portable descriptors or `takosumi-plugins/` for native backend bindings.
3. Export `KIND_NAME`, `KIND_URI`, and `KIND_ALIASES`.
4. Add a `KernelPlugin` factory only when the reference implementation has an adapter.
5. Add the package to the owning repository's `deno.json` workspace and publish/check scripts.
6. Update [Kind Packages](docs/reference/kind-packages.md) and examples.

## Reference implementation binding

The reference kernel accepts `KernelPlugin[]` through `createPaaSApp({ kindAliases, plugins })`. This is an implementation strategy. A compatible implementation can bind the same kind URI to a native controller, static registry, workflow engine, or SaaS adapter.

## Build and source

Build recipes live outside manifest. File paths consumed by runtime components live in kind-specific `spec` fields, such as `worker.spec.entrypoint`.
