# Takosumi {#takosumi-distribution}

Takosumi is a reference operator distribution built on Takosumi. It
owns accounts, billing, OIDC, dashboards, approvals, deploy facades,
PlatformService inventory, and OpenTofu state.

## Ownership

| Surface                                      | Owner                                |
| -------------------------------------------- | ------------------------------------ |
| Source / Installation / Deployment           | [Takosumi](./takosumi-v1.md)      |
| Installer API                                | [Installer API](./installer-api.md)  |
| PlatformService inventory / binding policy   | Takosumi distribution          |
| Accounts / OIDC / billing / dashboard        | Takosumi distribution          |
| OpenTofu state / provider evidence | Takosumi distribution/operator |

Takosumi resolves PlatformServices through Cloud inventory and records
binding snapshots and outputs on Deployments. Cloud-specific service paths,
account-facing projections, approval records, launch tokens, billing behavior,
and dashboard APIs are canonical in the Cloud docs.

## Cloud Docs

- [Takosumi docs](https://accounts.takosumi.com/docs/)
- [Japanese: Takosumi Distribution Contract v1](https://accounts.takosumi.com/docs/ja/spec)
- [English: Takosumi Distribution Contract v1](https://accounts.takosumi.com/docs/en/spec)

In this checkout, maintainer paths are `takosumi/docs/ja/spec.md` and
`takosumi/docs/en/spec.md`.

## Related Pages

- [Specification Boundaries](./spec-boundaries.md)
- [Platform Services](./platform-services.md)
- [Installer API](./installer-api.md)
