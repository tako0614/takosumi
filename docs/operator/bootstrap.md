# Reference Bootstrap {#operator-bootstrap}

::: info
Public contract は [Installer API](../reference/installer-api.md) です。このページは
reference kernel の起動時 wiring だけを扱います。
:::

Reference Takosumi は `createPaaSApp()` に operator-selected adapter array
を渡して起動します。Source payload は provider を選びません。
install / deploy request、operator policy、account-plane UI が PlatformService
binding selection を決め、operator distribution が実装 adapter を配線します。

## Local Example

```ts
import { createPaaSApp } from "@takosjp/takosumi/kernel";
import { dockerComposeWebServicePlugin } from "@takosjp/takosumi-plugins/kind/docker-compose-web-service";
import { dockerPostgresPlugin } from "@takosjp/takosumi-plugins/kind/docker-postgres";
import { filesystemObjectStorePlugin } from "@takosjp/takosumi-plugins/kind/filesystem-object-store";

const webLifecycle = createDockerComposeLifecycleClient({
  hostBinding: "127.0.0.1",
});
const databaseLifecycle = createDockerPostgresLifecycleClient();
const objectStoreLifecycle = createFilesystemObjectStoreLifecycleClient({
  rootDir: "/var/lib/takos/object-store",
});

const { app } = await createPaaSApp({
  plugins: [
    dockerComposeWebServicePlugin({
      hostBinding: "127.0.0.1",
      lifecycle: webLifecycle,
    }),
    dockerPostgresPlugin({ lifecycle: databaseLifecycle }),
    filesystemObjectStorePlugin({ lifecycle: objectStoreLifecycle }),
  ],
});

Bun.serve({ port: 8788, fetch: app.fetch });
```

この bootstrap は local operator distribution が backend adapters を有効にする例
です。実際の cloud や local substrate binding が必要な operator distribution
は、同じような小さな TypeScript bootstrap を自前で用意してください。

## Adapter Subpaths

Reference adapter factory は `@takosjp/takosumi-plugins` 内の `./kind/*`
compatibility subpath に実装されています。この subpath 名は package API であり、
Takosumi v1 の source authoring vocabulary ではありません。

- `@takosjp/takosumi-plugins/kind/cloudflare-worker`
- `@takosjp/takosumi-plugins/kind/deno-deploy-worker`
- `@takosjp/takosumi-plugins/kind/aws-fargate-web-service`
- `@takosjp/takosumi-plugins/kind/gcp-cloud-run-web-service`
- `@takosjp/takosumi-plugins/kind/kubernetes-web-service`
- `@takosjp/takosumi-plugins/kind/docker-compose-web-service`
- `@takosjp/takosumi-plugins/kind/systemd-web-service`
- `@takosjp/takosumi-plugins/kind/aws-rds-postgres`
- `@takosjp/takosumi-plugins/kind/gcp-cloud-sql-postgres`
- `@takosjp/takosumi-plugins/kind/docker-postgres`
- `@takosjp/takosumi-plugins/kind/cloudflare-r2-object-store`
- `@takosjp/takosumi-plugins/kind/aws-s3-object-store`
- `@takosjp/takosumi-plugins/kind/gcp-gcs-object-store`
- `@takosjp/takosumi-plugins/kind/minio-object-store`
- `@takosjp/takosumi-plugins/kind/filesystem-object-store`
- `@takosjp/takosumi-plugins/kind/cloudflare-dns-gateway`
- `@takosjp/takosumi-plugins/kind/aws-route53-gateway`
- `@takosjp/takosumi-plugins/kind/gcp-cloud-dns-gateway`
- `@takosjp/takosumi-plugins/kind/coredns-gateway`

## Runtime-Agent

Credential や cloud SDK のアクセスは runtime-agent または operator host に留めます。
adapter はテスト用の in-memory lifecycle と本番配線用の lifecycle-client option
を公開できます。どの connector credential を配置するかは operator distribution
が決定します。

## 関連ページ

- [Backend adapters](../reference/kind-packages.md)
- [Adapter implementations](../reference/kind-bindings.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
