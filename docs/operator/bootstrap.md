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

const webLifecycle = createDockerComposeLifecycleClient({
  hostBinding: "127.0.0.1",
});
const databaseLifecycle = createDockerPostgresLifecycleClient();
const objectStoreLifecycle = createFilesystemObjectStoreLifecycleClient({
  rootDir: "/var/lib/takos/object-store",
});

const { app } = await createPaaSApp({
  kindAliases: {
    "docker-compose-web-service": WEB_KIND,
    "docker-postgres": DB_KIND,
    "filesystem-object-store": STORE_KIND,
  },
  plugins: [
    dockerComposeWebServicePlugin({
      hostBinding: "127.0.0.1",
      lifecycle: webLifecycle,
    }),
    dockerPostgresPlugin({ lifecycle: databaseLifecycle }),
    filesystemObjectStorePlugin({ lifecycle: objectStoreLifecycle }),
  ],
});

Deno.serve({ port: 8788 }, app.fetch);
```

この bootstrap は native kind alias を有効にする例です。manifest が `docker-compose-web-service`、`docker-postgres`、`filesystem-object-store` を使う場合、それぞれの native schema が `spec` を所有します。manifest が portable `web-service`、`postgres`、`object-store` を使う場合は、それらの portable URI を `kindAliases` に入れ、その portable URI を提供する adapter で backend へ bind します。

`takosumi server` は標準の dev 用 entrypoint です。実際の cloud や local substrate binding が必要な operator distribution は、上記のような小さな TypeScript bootstrap を自前で用意してください。

## Kind package の entrypoint

Reference adapter factory は `takosumi-plugins` 内の native kind package に実装されています。operator distribution が有効にする package だけを install してください。

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

Credential や cloud SDK のアクセスは runtime-agent または operator host に留めます。kind package はテスト用の in-memory lifecycle と本番配線用の lifecycle-client option を公開できます。どの connector credential を配置するかは operator distribution が決定します。

## 関連ページ

- [Kind Packages](../reference/kind-packages.md)
- [Kind Binding Implementations](../reference/kind-bindings.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
