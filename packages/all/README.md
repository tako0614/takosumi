# @takos/takosumi

Takosumi の turnkey package。kernel / plugins / cli を 1 つの import
で利用可能。

## Self-host

```bash
deno run -A jsr:@takos/takosumi/server   # kernel HTTP server
deno install -gA -n takosumi jsr:@takos/takosumi-cli   # CLI
takosumi install --source . --space space_personal
```

## Sub-exports

- `jsr:@takos/takosumi` — plugins (shapes / providers) の全部 re-export
- `jsr:@takos/takosumi/kernel` — kernel programmatic API
- `jsr:@takos/takosumi/server` — kernel HTTP server entry (deno run で起動)
- `jsr:@takos/takosumi/plugins` — plugins entry
- `jsr:@takos/takosumi/shapes` — component catalog (worker / postgres /
  object-store / oidc / custom-domain)
- `jsr:@takos/takosumi/shape-providers` — provider plugins
- `jsr:@takos/takosumi/shape-providers/factories` — production wiring
  (`createTakosumiProductionProviders(opts)`)
- `jsr:@takos/takosumi/cli` — CLI module entry

## Sister packages

- `jsr:@takos/takosumi-contract` — canonical types (Shape / Provider)
- `jsr:@takos/takosumi-kernel` — kernel only (server + apply pipeline)
- `jsr:@takos/takosumi-plugins` — plugins only (shapes / providers)
- `jsr:@takos/takosumi-cli` — CLI only

## Scope note

The `@takos/` JSR scope is the **reference distribution** that Takos publishes
for Takosumi. Authority lives in the contract (`@takos/takosumi-contract`), not
in the publisher: this umbrella package only re-exports a specific reference
implementation of that contract. Contract-compatible alternative publishers
(e.g., `@example/takosumi-kernel`) are spec-permitted — currently untested, but
they hold no architectural privilege over this reference distribution.
