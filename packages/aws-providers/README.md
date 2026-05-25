# @takos/takosumi-aws-providers

AWS-backed reference `KernelPlugin` adapter factories that can bind selected takosumi.com kind URIs (`web-service` / `object-store` / `postgres` / `gateway`) in the reference kernel. Operators import this package explicitly when they want AWS coverage — Takosumi core (`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses which provider packages to attach to the reference adapter array (`createPaaSApp({ kindAliases, plugins: [...] })`).

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
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

AWS credentials are configured on the runtime-agent connector environment or operator host. Provider factory arguments stay limited to non-secret selector settings such as region, cluster name, or hosted zone id.

## Exports

| Factory                          | Kind URI                                     |
| -------------------------------- | -------------------------------------------- |
| `awsFargateWebServiceProvider`   | `https://takosumi.com/kinds/v1/web-service`  |
| `awsS3ObjectStoreProvider`       | `https://takosumi.com/kinds/v1/object-store` |
| `awsRdsPostgresProvider`         | `https://takosumi.com/kinds/v1/postgres`     |
| `awsRoute53CustomDomainProvider` | `https://takosumi.com/kinds/v1/gateway`      |

`awsFargateWorkerProvider` is an alternate export for `awsFargateWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — official catalog descriptor helpers and reference adapter helpers.
