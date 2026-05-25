# Takosumi Cloud {#takosumi-cloud-distribution}

Takosumi Cloud is a separate operator distribution specification. This page is
only the Takosumi docs entry point for readers who need Cloud-owned
account-plane behavior after reading the Takosumi core and official type catalog
specs.

## Which Spec Owns What

| Surface                                                               | Owner                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| AppSpec / Installation / Deployment / Installer API                   | [Takosumi Core Specification](./core-spec.md)                     |
| kind descriptor vocabulary / material contracts / projection families | [Takosumi Official Type Catalog Specification](./type-catalog.md) |
| Accounts / OIDC / billing / dashboard / launch token / deploy facade  | Takosumi Cloud distribution specification                         |

Takosumi Cloud composes the Takosumi core Installer API with Cloud-owned
account-plane records and APIs. Cloud may adopt material contracts from the
official type catalog, but the Cloud docs own the concrete publication paths,
identity behavior, billing integration, dashboard surface, launch token flow,
account-facing Installation projection, export/materialize actions, and deploy
facade.

## Read The Cloud Spec

The normative Cloud distribution spec is maintained with the Takosumi Cloud
docs:

- [Takosumi Cloud docs index](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/index.md)
- [Takosumi Cloud Specification](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/spec.md)
- [Workload external publications](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/workload-publications.md)
- [Account-plane projections](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/account-plane-projections.md)
- [Deploy facade](https://github.com/tako0614/takos-ecosystem/blob/main/takosumi-cloud/docs/deploy-facade.md)

The local maintainer path in this repository checkout is
`takosumi-cloud/docs/spec.md`.

Read this Takosumi page as a bridge. The Cloud spec is the authority for
Cloud-owned account-plane compatibility; Takosumi core remains the authority for
AppSpec, Installation, Deployment, and the Installer API.

## Related Pages

- [Specification Boundaries](./spec-boundaries.md)
- [External Publications](./external-publications.md)
- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
