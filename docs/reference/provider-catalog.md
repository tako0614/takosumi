# Provider catalog {#provider-catalog}

> このページでわかること: Takosumi に同梱される provider id、対応 kind、主な
> capability。

provider plugin の仕組みは [Provider plugin](./providers.md)
を参照してください。 このページは一覧性を優先した catalog です。

## Package mapping {#package-mapping}

| Package id                              | Provider group |
| --------------------------------------- | -------------- |
| `@takos/takosumi-aws-providers`         | AWS            |
| `@takos/takosumi-gcp-providers`         | GCP            |
| `@takos/takosumi-cloudflare-providers`  | Cloudflare     |
| `@takos/takosumi-kubernetes-providers`  | Kubernetes     |
| `@takos/takosumi-deno-deploy-providers` | Deno Deploy    |
| `@takos/takosumi-selfhost-providers`    | Self-host      |

## AWS {#aws}

| provider id          | component kind  | declared capabilities                                                                                                                   |
| -------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/aws-s3`      | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/aws-fargate` | `web-service`   | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        |
| `@takos/aws-rds`     | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |
| `@takos/aws-route53` | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `alpn-acme`                                                                                              |

## GCP {#gcp}

| provider id            | component kind  | declared capabilities                                                                                                                   |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/gcp-gcs`       | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/gcp-cloud-run` | `web-service`   | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               |
| `@takos/gcp-cloud-sql` | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |
| `@takos/gcp-cloud-dns` | `custom-domain` | `wildcard`, `auto-tls`, `sni`                                                                                                           |

## Cloudflare {#cloudflare}

| provider id                   | component kind  | declared capabilities                                       |
| ----------------------------- | --------------- | ----------------------------------------------------------- |
| `@takos/cloudflare-r2`        | `object-store`  | `presigned-urls`, `public-access`, `multipart-upload`       |
| `@takos/cloudflare-container` | `web-service`   | `scale-to-zero`, `geo-routing`                              |
| `@takos/cloudflare-workers`   | `worker`        | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` |
| `@takos/cloudflare-dns`       | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `http3`                      |

## Azure {#azure}

| provider id                   | component kind | declared capabilities                                     |
| ----------------------------- | -------------- | --------------------------------------------------------- |
| `@takos/azure-container-apps` | `web-service`  | `always-on`, `scale-to-zero`, `websocket`, `long-request` |

## Kubernetes {#kubernetes}

| provider id                    | component kind | declared capabilities                                          |
| ------------------------------ | -------------- | -------------------------------------------------------------- |
| `@takos/kubernetes-deployment` | `web-service`  | `always-on`, `websocket`, `long-request`, `private-networking` |

## Deno Deploy {#deno-deploy}

| provider id          | component kind | declared capabilities                          |
| -------------------- | -------------- | ---------------------------------------------- |
| `@takos/deno-deploy` | `worker`       | `scale-to-zero`, `long-request`, `geo-routing` |

`@takos/deno-deploy` は operator が明示的に package と connector credential を
用意したときだけ selectable にします。

## Self-host {#self-host}

| provider id                      | component kind  | declared capabilities                                                                                            |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@takos/selfhost-filesystem`     | `object-store`  | `presigned-urls`                                                                                                 |
| `@takos/selfhost-minio`          | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` |
| `@takos/selfhost-docker-compose` | `web-service`   | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       |
| `@takos/selfhost-systemd`        | `web-service`   | `always-on`, `long-request`                                                                                      |
| `@takos/selfhost-postgres`       | `postgres`      | `ssl-required`, `extensions`                                                                                     |
| `@takos/selfhost-coredns`        | `custom-domain` | `wildcard`                                                                                                       |
