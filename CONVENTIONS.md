# Takosumi Conventions

`kind` is the selector word everywhere in AppSpec. `Component.kind` chooses what
to create. Root `publish.kind` and `listen.kind` name the kind of material being
offered or consumed. The manifest shape stays
`{ apiVersion, metadata, components, publish? }`, and each component stays
`{ kind, spec, connect, listen }`.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Public
manifest and publication selectors use `kind`.

## Kind ownership

- Portable kinds are subpath exports `@takosjp/takosumi/kind/<alias>` and own `spec/kind.jsonld`, helper types, and validators in `packages/kind-<alias>/`.
- Native kinds are sourced in the sibling `takosumi-plugins` repository, exported as `@takosjp/takosumi-plugins/kind/<alias>` subpaths, and own substrate-specific kind definition metadata and adapter factories.
- Kind families such as worker, postgres, object-store, gateway, and web-service are documentation groups, not an manifest field.
- Backend-specific `spec` fields belong to native kinds. Do not hide them behind a portable kind.

## Publication paths

`path` is only for exact Space-visible names. One Space can have at most one
active owner for the same publication path. Pathless publications are
discoverable by `kind` and `labels`; multiple pathless publications with the
same kind are valid. Consumers that intentionally want all visible matches use
`listen.<binding>.kind` with `many: true`.

## Adding a kind package

1. Choose a stable alias such as `cloudflare-worker` or `aws-rds-postgres`.
2. Create `packages/kind-<alias>/deno.json`, `mod.ts`, and `spec/kind.jsonld` in `takosumi/` for portable descriptors or `takosumi-plugins/` for native backend bindings.
3. Export `KIND_NAME`, `KIND_URI`, and `KIND_ALIASES`.
4. Add a `KernelPlugin` factory only when the reference implementation has an adapter.
5. Add the package to the owning repository's `deno.json` workspace and wire its subpath into that repository's npm build (`scripts/build-npm.ts` for portable kinds, `takosumi-plugins/scripts/dnt-build.ts` for native kinds).
6. Update [Kind Packages](docs/reference/kind-packages.md) and examples.

## Reference implementation binding

The reference kernel accepts `KernelPlugin[]` through `createPaaSApp({ kindAliases, plugins })`. This is an implementation strategy. A compatible implementation can bind the same kind URI to a native controller, static registry, workflow engine, or SaaS adapter.

## Build and source

Build recipes live outside manifest. File paths consumed by runtime components live in kind-specific `spec` fields, such as `worker.spec.entrypoint`.
