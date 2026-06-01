# Operator Catalog {#catalog}

Takosumi v1 には core-owned backend vocabulary を public source contract として
置きません。catalog は operator distribution が持つ PlatformService inventory /
binding inventory です。

operator catalog が決めること:

- Space で見える PlatformService
- runtime target、database、object storage、queue、OIDC issuer などの service
  capability
- alias、label、service path、visibility
- Terraform/OpenTofu や cloud provider state と binding される implementation
- access mode、approval、quota、billing subject

Takosumi core が catalog から受け取るもの:

- `PlatformService`
- `ResolvedBinding`
- Deployment `bindingsSnapshot`
- Deployment `outputs`

backend-specific adapters、runtime-agent connectors、Terraform modules、provider
controllers は operator implementation です。Takosumi core の public v1 は
Source / Installation / Deployment / PlatformService / InstallPlan に閉じます。

## Related

- [プラットフォームサービス](./platform-services.md)
- [仕様境界](./spec-boundaries.md)
- [Takosumi を拡張する](../extending.md)
