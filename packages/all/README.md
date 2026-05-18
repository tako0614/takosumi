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

- `jsr:@takos/takosumi` — plugins (kinds / providers) の全部 re-export
- `jsr:@takos/takosumi/kernel` — kernel programmatic API (`createPaaSApp`)
- `jsr:@takos/takosumi/server` — kernel HTTP server entry (deno run で起動)
- `jsr:@takos/takosumi/plugins` — plugins entry
- `jsr:@takos/takosumi/kinds` — component kind catalog (worker / postgres /
  object-store / oidc / custom-domain)
- `jsr:@takos/takosumi/bundled` — bundled `KernelPlugin` factories
  (`createPaaSApp({ plugins: [cloudflareWorkerProvider(...)] })` の attach 対象)
- `jsr:@takos/takosumi/cli` — CLI module entry

## Sister packages

- `jsr:@takos/takosumi-contract` — canonical types (AppSpec / ComponentKind /
  ProviderPlugin / KernelPlugin)
- `jsr:@takos/takosumi-kernel` — kernel only (server + apply pipeline)
- `jsr:@takos/takosumi-plugins` — plugins only (kinds / providers / bundled
  `KernelPlugin` factories)
- `jsr:@takos/takosumi-cli` — CLI only

## Scope note

The `@takos/` JSR scope is the **reference distribution** that Takos publishes
for Takosumi. Authority lives in the contract (`@takos/takosumi-contract`), not
in the publisher: this umbrella package only re-exports a specific reference
implementation of that contract. Contract-compatible alternative publishers
(e.g., `@example/takosumi-kernel`) are spec-permitted — currently untested, but
they hold no architectural privilege over this reference distribution.
