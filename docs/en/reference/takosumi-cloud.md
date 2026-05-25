# Takosumi Cloud {#takosumi-cloud-distribution}

Takosumi Cloud is a separate operator configuration specification. This page is
the Takosumi docs entry point for readers who need Cloud account management
behavior after reading the Takosumi core and Kind Catalog specs.

## Ownership {#ownership}

| Surface                                                               | Owner                                         |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Manifest / Installation / Deployment / Installer API                  | [Takosumi Core Specification](./core-spec.md) |
| Kind definition vocabulary / output types / injection modes           | [Kind Catalog](./type-catalog.md)             |
| Accounts / OIDC / billing / dashboard / launch token / deploy facade  | Takosumi Cloud distribution specification     |

Takosumi Cloud composes the Takosumi core Installer API with Cloud
account management records and APIs. Cloud may adopt output types from the
Kind Catalog, but the Cloud docs define concrete platform service paths,
identity behavior, billing integration, dashboard surface, launch token flow,
account-facing Installation projection, export/materialize actions, and deploy
facade.

Cloud platform service paths include examples such as
`operator.identity.oidc` and `operator.billing.default`. Workloads can reference
those Cloud-provided outputs with manifest `listen.from`. Output format belongs
to the Kind Catalog; dotted reference grammar belongs to Takosumi core;
the concrete paths and lifecycles belong to the Cloud distribution spec.

Cloud also defines `operator.platform.deploy` as an account management/admin facade
identifier. It is not workload output. It is the Cloud admin
surface that composes the [Installer API](./installer-api.md) with authorization,
approval, and account management projection.

## Cloud Spec {#cloud-spec}

The normative Cloud distribution spec is maintained with the Takosumi Cloud
docs:

- [Takosumi Cloud docs index](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/index.md)
- [Takosumi Cloud Specification](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/spec.md)
- [Operator account management profile](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/operator-account-plane-profile.md)
- [Workload platform services](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/workload-publications.md)
- [Account layer projections](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/account-plane-projections.md)
- [Deploy facade](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/deploy-facade.md)

In this repository checkout, the local maintainer paths are
`takosumi-cloud/docs/spec.md` and
`takosumi-cloud/docs/operator-account-plane-profile.md`.

Read this Takosumi page as a bridge only. Cloud account management
compatibility is canonical in the Cloud spec. Manifest, Installation, Deployment,
and the Installer API remain canonical in the Takosumi core spec.

## Related Pages {#related-pages}

- [Specification Boundaries](./spec-boundaries.md)
- [Platform Services](./external-publications.md)
- [Manifest](./manifest.md)
- [Installer API](./installer-api.md)
