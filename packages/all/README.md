# @takos/takosumi

Takosumi の turnkey package。kernel / plugins / cli を 1 つの import で利用可能。

## Self-host

```bash
deno run -A jsr:@takos/takosumi/server   # kernel HTTP server
deno install -gA -n takosumi jsr:@takos/takosumi-cli   # CLI
takosumi deploy ./manifest.yml
```

## Sub-exports

- `jsr:@takos/takosumi` — plugins (shapes / providers / templates) の全部 re-export
- `jsr:@takos/takosumi/kernel` — kernel programmatic API
- `jsr:@takos/takosumi/server` — kernel HTTP server entry (deno run で起動)
- `jsr:@takos/takosumi/plugins` — plugins entry
- `jsr:@takos/takosumi/shapes` — Shape catalog (web-service / object-store / database-postgres / custom-domain)
- `jsr:@takos/takosumi/shape-providers` — provider plugins
- `jsr:@takos/takosumi/shape-providers/factories` — production wiring (`createTakosumiProductionProviders(opts)`)
- `jsr:@takos/takosumi/templates` — template plugins
- `jsr:@takos/takosumi/cli` — CLI module entry

## Sister packages

- `jsr:@takos/takosumi-contract` — canonical types (Shape / Provider / Template)
- `jsr:@takos/takosumi-kernel` — kernel only (server + apply pipeline)
- `jsr:@takos/takosumi-plugins` — plugins only (shapes / providers / templates)
- `jsr:@takos/takosumi-cli` — CLI only
