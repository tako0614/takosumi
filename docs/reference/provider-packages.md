# Reference Provider Package Examples {#provider-packages}

Takosumi reference 実装の provider adapter 方式は
[Provider Implementations](./providers.md)。このページは provider package
inventory の実装例です。Takosumi reference implementation では、operator が必要
な package を import して reference adapter array
(`createPaaSApp({ plugins })`) に attach した ものが provider inventory
になります。互換 implementation は別の registry / controller / operator
inventory から execution binding を構成できます。

When an operator profile adopts the official gateway kind definition and maps
the `gateway` alias, that definition contributes gateway-owned
`spec.listeners` / `spec.routes` vocabulary. manifest core still only sees `kind`, open `spec`,
`publish`, and `listen`. reference provider package は gateway provider factory
を export でき、その内部 lifecycle で `Route53` / `Cloudflare DNS` / `CoreDNS`
などの DNS client / sub-adapter を使えます。DNS provider rows are sub-adapters
used by gateway providers; manifest authors use the alias or descriptor URI
accepted by their operator profile.

Gateway provider capability is explicit. Some current DNS-backed adapters cover
host reservation, DNS ownership, TLS, and public endpoint materialization, but
not arbitrary path routing. If a manifest asks for route features the selected
provider does not declare, resolution fails before provider side effects.

## Reference package mapping {#package-mapping}

| Package id                              | Provider group |
| --------------------------------------- | -------------- |
| `@takos/takosumi-aws-providers`         | AWS            |
| `@takos/takosumi-gcp-providers`         | GCP            |
| `@takos/takosumi-cloudflare-providers`  | Cloudflare     |
| `@takos/takosumi-kubernetes-providers`  | Kubernetes     |
| `@takos/takosumi-deno-deploy-providers` | Deno Deploy    |
| `@takos/takosumi-selfhost-providers`    | Self-host      |

以下の rows は current reference provider package exports を reader-friendly に
並べた inventory です。`provider id` は factory が返す adapter / connector
identity の例で、`factory export` は package から import する関数名です。
manifest portability は matching kind URI、出力の型、operator-selected
support constraints / extension fields、credential、operator の記録が揃う範囲
で成立します。

## AWS examples {#aws}

| provider id          | role                         | declared capabilities                                                                                                                   |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/aws-s3`      | `object-store`               | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/aws-fargate` | `web-service`                | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        |
| `@takos/aws-rds`     | `postgres`                   | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |
| `@takos/aws-route53` | DNS-backed gateway lifecycle | `wildcard`, `alpn-acme`                                                                                                                 |

## GCP examples {#gcp}

| provider id            | role           | declared capabilities                                                                                                                   |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/gcp-gcs`       | `object-store` | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/gcp-cloud-run` | `web-service`  | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               |
| `@takos/gcp-cloud-sql` | `postgres`     | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   |

## Cloudflare examples {#cloudflare}

| factory export                    | provider id example         | role                         | declared capabilities                                       |
| --------------------------------- | --------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `cloudflareR2ObjectStoreProvider` | `@takos/cloudflare-r2`      | `object-store`               | `presigned-urls`, `public-access`, `multipart-upload`       |
| `cloudflareWorkerProvider`        | `@takos/cloudflare-workers` | `worker`                     | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` |
| `cloudflareCustomDomainProvider`  | `@takos/cloudflare-dns`     | DNS-backed gateway lifecycle | `wildcard`                                                  |

## Azure external connector metadata example {#azure}

Azure は external connector metadata example です。別 operator profile が
Azure package を用意する場合、このような provider metadata を operator inventory
に登録できます。

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

| provider id                      | role           | declared capabilities                                                                                            |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@takos/selfhost-filesystem`     | `object-store` | `presigned-urls`                                                                                                 |
| `@takos/selfhost-minio`          | `object-store` | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` |
| `@takos/selfhost-docker-compose` | `web-service`  | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       |
| `@takos/selfhost-systemd`        | `web-service`  | `always-on`, `long-request`                                                                                      |
| `@takos/selfhost-postgres`       | `postgres`     | `ssl-required`, `extensions`                                                                                     |
