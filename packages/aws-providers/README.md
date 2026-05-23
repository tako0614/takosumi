# @takos/takosumi-aws-providers

AWS-backed `KernelPlugin` factories for the Takos reference component kinds
(`web-service` / `object-store` / `postgres` / `custom-domain`). Operators
import this package explicitly when they want AWS coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to
`createPaaSApp({ kindAliases, plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  awsFargateWebServiceProvider,
  awsRdsPostgresProvider,
  awsRoute53CustomDomainProvider,
  awsS3ObjectStoreProvider,
} from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    awsFargateWebServiceProvider({
      clusterName: env.ECS_CLUSTER,
      region: env.AWS_REGION,
    }),
    awsS3ObjectStoreProvider({ region: env.AWS_REGION }),
    awsRdsPostgresProvider({ region: env.AWS_REGION }),
    awsRoute53CustomDomainProvider({ hostedZoneId: env.ROUTE53_ZONE_ID }),
  ],
});
```

## Exports

| Factory                          | Kind URI                                      |
| -------------------------------- | --------------------------------------------- |
| `awsFargateWebServiceProvider`   | `https://takosumi.com/kinds/v1/web-service`   |
| `awsS3ObjectStoreProvider`       | `https://takosumi.com/kinds/v1/object-store`  |
| `awsRdsPostgresProvider`         | `https://takosumi.com/kinds/v1/postgres`      |
| `awsRoute53CustomDomainProvider` | `https://takosumi.com/kinds/v1/custom-domain` |

`awsFargateWorkerProvider` remains as a deprecated compatibility alias for
`awsFargateWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factories delegate to.
