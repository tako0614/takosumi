# Retired Takosumi Manifest Page {#retired-v0-manifest}

Takosumi v1 does not use `.takosumi` or any Takosumi-specific source metadata
file. Source repositories use generic repo metadata, and operator-owned
OpenTofu modules can publish evaluated outputs such as app metadata or
PlatformService inventory.

Takosumi consumes the result as Source / Installation / Deployment /
PlatformService evidence. It does not parse HCL, run `tofu apply`, or own
OpenTofu state locks.

Use these current pages instead:

- [Takosumi v1](./takosumi-v1.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)

Historical v0 source-file authoring is not part of the v1 public contract.
