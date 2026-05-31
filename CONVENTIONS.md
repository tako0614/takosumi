# Takosumi Conventions

`kind` is the selector word everywhere in AppSpec. `Component.kind` chooses what
to create. Root `publish.kind` and `listen.kind` name the kind of material being
offered or consumed. The manifest shape stays
`{ apiVersion, metadata, components, publish? }`, and each component stays
`{ kind, spec, connect, listen }`.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Public
manifest and publication selectors use `kind`.

## Kind ownership

- Official kind descriptors are JSON-LD spec documents in `docs/kinds/v1/<alias>.jsonld`, published at `https://takosumi.com/kinds/v1/<alias>`. They are not runtime package exports.
- Native kind implementations are sourced in the sibling `takosumi-plugins` repository and exported as `@takosjp/takosumi-plugins/kind/<alias>` subpaths.
- Kind families such as worker, postgres, object-store, gateway, and web-service are documentation groups, not an manifest field.
- Backend-specific `spec` fields belong to native kinds. Do not hide them behind a portable kind.

## Publication paths

`path` is only for exact Space-visible names. One Space can have at most one
active owner for the same publication path. Pathless publications are
discoverable by `kind` and `labels`; multiple pathless publications with the
same kind are valid. Consumers that intentionally want all visible matches use
`listen.<binding>.kind` with `many: true`.

## Adding a kind descriptor or binding

1. Choose a stable alias such as `cloudflare-worker` or `aws-rds-postgres`.
2. Add or edit the descriptor JSON-LD in `docs/kinds/v1/<alias>.jsonld`.
3. If the reference implementation needs a backend binding, add or update `takosumi-plugins/src/plugins/<alias>/`.
4. Export `KIND_NAME`, `KIND_URI`, `KIND_ALIASES`, and a `KernelPlugin` factory from that plugin subpath only when the reference implementation has an adapter.
5. Add the plugin export to `takosumi-plugins/package.json` and its npm subpath build.
6. Update [Reference Plugin Exports](docs/reference/reference-plugin-exports.md) and examples.

## Reference implementation binding

The reference kernel accepts `KernelPlugin[]` through `createPaaSApp({ kindAliases, plugins })`. This is an implementation strategy. A compatible implementation can bind the same kind URI to a native controller, static registry, workflow engine, or SaaS adapter.

## Build and source

Build recipes live outside manifest. File paths consumed by runtime components live in kind-specific `spec` fields, such as `worker.spec.entrypoint`.
