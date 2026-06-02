# Resource IDs

Takosumi public Installer API IDs are opaque strings. Clients compare them for equality and pass them back to the API; clients do not parse type prefixes, embedded algorithms, or delimiter structure.

## Public Installer Wire IDs

The public wire carries these ID roles:

| Role             | Example                             | Owner                                   |
| ---------------- | ----------------------------------- | --------------------------------------- |
| `spaceId`        | `space_personal`, `space_acme_prod` | operator account layer / caller context |
| `installationId` | `inst_01HM9N7XK4QY8RT2P5JZF6V3W9`   | Installer API                           |
| `deploymentId`   | `dep_01HM9N7XK4QY8RT2P5JZF6V3WA`    | Installer API                           |

The examples above are conventional opaque strings, not a grammar that clients may parse. Operators may use different opaque strings as long as they remain stable within the API records that reference them.

## Reference Evidence IDs

Reference service evidence, operator tooling, and optional extensions can use their own opaque IDs. These IDs are outside the portable public Installer API shape.

Examples:

```text
journal_01HM9N7XK4QY8RT2P5JZF6V3WB
op_01HM9N7XK4QY8RT2P5JZF6V3WC
res_sha256_b94d27...
desired_sha256_b94d27...
act_01HM9N7XK4QY8RT2P5JZF6V3WD
conn_cloudflare_workers
asset_sha256_e3b0c442...
operator_config_default
```

Reference evidence readers should treat these as opaque too. If a reference implementation chooses a structured storage key internally, that structure is implementation-owned and is not a public Takosumi ID contract.

## Stability

Changing the public API field names (`spaceId`, `installation.id`, `deployment.id`) or the meaning of those fields is a breaking wire change. Changing the human-readable prefix convention used in examples is not a public breaking change as long as the IDs remain opaque to clients.

## Related Pages

- [Enum and Value Index](./closed-enums.md)
- [Storage Schema](./storage-schema.md)
- [Digest Computation](./digest-computation.md)
- [Runtime Handler Guide](./runtime-handler-contract.md)
