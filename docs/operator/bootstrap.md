# Reference Bootstrap {#operator-bootstrap}

::: info
Public contract は [Installer API](../reference/installer-api.md) です。このページは reference kernel の起動時 wiring だけを扱います。
:::

Reference Takosumi は `createPaaSApp()` に `kindAliases` と `plugins` を渡して起動します。`kindAliases` は manifest の短い `kind` を kind URI に解決する map です。`plugins` は reference adapter array です。

Native plugin package の source は `takosumi-plugins/` にあります。Takosumi core repo には manifest / Installer API / kernel と portable kind definition package だけを置きます。

## Local example

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import {
  dockerComposeWebServicePlugin,
  KIND_URI as WEB_KIND,
} from "@takos/takosumi-kind-docker-compose-web-service";
import {
  dockerPostgresPlugin,
  KIND_URI as DB_KIND,
} from "@takos/takosumi-kind-docker-postgres";
import {
  filesystemObjectStorePlugin,
  KIND_URI as STORE_KIND,
} from "@takos/takosumi-kind-filesystem-object-store";

const { app } = await createPaaSApp({
  kindAliases: {
    "web-service": WEB_KIND,
    postgres: DB_KIND,
    "object-store": STORE_KIND,
  },
  plugins: [
    dockerComposeWebServicePlugin({ hostBinding: "127.0.0.1" }),
    dockerPostgresPlugin(),
    filesystemObjectStorePlugin(),
  ],
});

Deno.serve({ port: 8788 }, app.fetch);
```

`takosumi server` is the stock dev entrypoint. Operator distributions that need real cloud or local substrate bindings should own a small TypeScript bootstrap like the example above.

## Kind package entrypoints

Reference adapter factories live in native kind packages in `takosumi-plugins`. Install only the packages your operator distribution enables.

- `@takos/takosumi-kind-cloudflare-worker`
- `@takos/takosumi-kind-deno-deploy-worker`
- `@takos/takosumi-kind-aws-fargate-web-service`
- `@takos/takosumi-kind-gcp-cloud-run-web-service`
- `@takos/takosumi-kind-kubernetes-web-service`
- `@takos/takosumi-kind-docker-compose-web-service`
- `@takos/takosumi-kind-systemd-web-service`
- `@takos/takosumi-kind-aws-rds-postgres`
- `@takos/takosumi-kind-gcp-cloud-sql-postgres`
- `@takos/takosumi-kind-docker-postgres`
- `@takos/takosumi-kind-cloudflare-r2-object-store`
- `@takos/takosumi-kind-aws-s3-object-store`
- `@takos/takosumi-kind-gcp-gcs-object-store`
- `@takos/takosumi-kind-minio-object-store`
- `@takos/takosumi-kind-filesystem-object-store`
- `@takos/takosumi-kind-cloudflare-dns-gateway`
- `@takos/takosumi-kind-aws-route53-gateway`
- `@takos/takosumi-kind-gcp-cloud-dns-gateway`
- `@takos/takosumi-kind-coredns-gateway`

## Runtime-agent

Credential and cloud SDK access stay in the runtime-agent or operator host. A kind package may expose an in-memory lifecycle for tests and a lifecycle-client option for production wiring. Operator distributions decide which connector credentials are present.

## Related pages

- [Kind Packages](../reference/kind-packages.md)
- [Kind Binding Implementations](../reference/kind-bindings.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
