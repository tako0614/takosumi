# Provider package examples {#provider-packages}

> このページでわかること: reference distribution が publish している provider
> adapter package 例と、それぞれが返す provider id / capability metadata。

reference kernel の provider adapter 方式は
[Provider Implementations](./providers.md) を参照してください。このページは
reference distribution の実装例です。operator が必要な package を import して
reference adapter array (`createPaaSApp({ plugins })`) に attach したものが
provider inventory になります。

`gateway` は listener / TLS / route rule を扱う component kind です。DNS 専用の
connector (`Route53` / `Cloudflare DNS` / `CoreDNS` など) は gateway provider が
内部で使う DNS sub-adapter であり、単独で `gateway` component 全体を実装する
provider ではありません。

## Reference package mapping {#package-mapping}

| Package id                              | Provider group |
| --------------------------------------- | -------------- |
| `@takos/takosumi-aws-providers`         | AWS            |
| `@takos/takosumi-gcp-providers`         | GCP            |
| `@takos/takosumi-cloudflare-providers`  | Cloudflare     |
| `@takos/takosumi-kubernetes-providers`  | Kubernetes     |
| `@takos/takosumi-deno-deploy-providers` | Deno Deploy    |
| `@takos/takosumi-selfhost-providers`    | Self-host      |

## AWS examples {#aws}

| provider id          | role                    | declared capabilities                                                                                                                   |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/aws-s3`      | `object-store`          | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/aws-fargate` | `web-service`           | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        |
| `@takos/aws-rds`     | `postgres`              | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |
| `@takos/aws-route53` | gateway DNS sub-adapter | `wildcard`, `alpn-acme`                                                                                                                 |

## GCP examples {#gcp}

| provider id            | role                    | declared capabilities                                                                                                                   |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/gcp-gcs`       | `object-store`          | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/gcp-cloud-run` | `web-service`           | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               |
| `@takos/gcp-cloud-sql` | `postgres`              | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |
| `@takos/gcp-cloud-dns` | gateway DNS sub-adapter | `wildcard`                                                                                                                              |

## Cloudflare examples {#cloudflare}

| provider id                   | role                    | declared capabilities                                       |
| ----------------------------- | ----------------------- | ----------------------------------------------------------- |
| `@takos/cloudflare-r2`        | `object-store`          | `presigned-urls`, `public-access`, `multipart-upload`       |
| `@takos/cloudflare-container` | `web-service`           | `scale-to-zero`, `geo-routing`                              |
| `@takos/cloudflare-workers`   | `worker`                | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` |
| `@takos/cloudflare-dns`       | gateway DNS sub-adapter | `wildcard`                                                  |

## Azure connector example {#azure}

Azure は external connector example であり、上記 6 つの reference provider
package mapping には含まれません。別 operator distribution が Azure package
を用意する 場合の capability metadata 例です。

| provider id                   | component kind | declared capabilities                                     |
| ----------------------------- | -------------- | --------------------------------------------------------- |
| `@takos/azure-container-apps` | `web-service`  | `always-on`, `scale-to-zero`, `websocket`, `long-request` |

## Kubernetes examples {#kubernetes}

| provider id                    | component kind | declared capabilities                                          |
| ------------------------------ | -------------- | -------------------------------------------------------------- |
| `@takos/kubernetes-deployment` | `web-service`  | `always-on`, `websocket`, `long-request`, `private-networking` |

## Deno Deploy examples {#deno-deploy}

| provider id          | component kind | declared capabilities                          |
| -------------------- | -------------- | ---------------------------------------------- |
| `@takos/deno-deploy` | `worker`       | `scale-to-zero`, `long-request`, `geo-routing` |

`@takos/deno-deploy` は operator が明示的に package と connector credential を
用意したときだけ selectable にします。

## Self-host examples {#self-host}

| provider id                      | role                    | declared capabilities                                                                                            |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@takos/selfhost-filesystem`     | `object-store`          | `presigned-urls`                                                                                                 |
| `@takos/selfhost-minio`          | `object-store`          | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` |
| `@takos/selfhost-docker-compose` | `web-service`           | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       |
| `@takos/selfhost-systemd`        | `web-service`           | `always-on`, `long-request`                                                                                      |
| `@takos/selfhost-postgres`       | `postgres`              | `ssl-required`, `extensions`                                                                                     |
| `@takos/selfhost-coredns`        | gateway DNS sub-adapter | `wildcard`                                                                                                       |
