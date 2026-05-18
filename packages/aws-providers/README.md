# @takos/takosumi-aws-providers

AWS-backed `KernelPlugin` factories for the canonical Takosumi component kinds
(`worker` / `object-store` / `postgres` / `custom-domain`). Operators import
this package explicitly when they want AWS coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to `createPaaSApp({ plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  awsFargateWorkerProvider,
  awsRdsPostgresProvider,
  awsRoute53CustomDomainProvider,
  awsS3ObjectStoreProvider,
} from "@takos/takosumi-aws-providers";

const { app } = await createPaaSApp({
  plugins: [
    awsFargateWorkerProvider({ clusterName: env.ECS_CLUSTER, region: env.AWS_REGION }),
    awsS3ObjectStoreProvider({ region: env.AWS_REGION }),
    awsRdsPostgresProvider({ region: env.AWS_REGION }),
    awsRoute53CustomDomainProvider({ hostedZoneId: env.ROUTE53_ZONE_ID }),
  ],
});
```

## Exports

| Factory                            | Kind URI                                       |
| ---------------------------------- | ---------------------------------------------- |
| `awsFargateWorkerProvider`         | `https://takosumi.com/kinds/v1/worker`         |
| `awsS3ObjectStoreProvider`         | `https://takosumi.com/kinds/v1/object-store`   |
| `awsRdsPostgresProvider`           | `https://takosumi.com/kinds/v1/postgres`       |
| `awsRoute53CustomDomainProvider`   | `https://takosumi.com/kinds/v1/custom-domain`  |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factories delegate to.
