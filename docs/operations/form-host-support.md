# Form Host support (superseded)

> This runbook described a Takosumi OSS Form Registry/FormActivation and Host
> Support workflow. That workflow is retired. It is retained only as a pointer
> for old migration evidence; it is not an operator procedure for the current
> OSS product.

The current OSS path is one Git/OpenTofu/Terraform Stack with ordinary
providers. Takosumi OSS does not install packages, execute hosted Forms,
publish FormActivation, select TargetPool, or expose Form Host discovery.

Takoform owns portable Form schemas, packages, provider releases, and lifecycle
labels. Takosumi Cloud (or another external Host) owns any hosted Form
registry, executable implementation, activation/audience policy, targets,
backend lifecycle, and commercial offering. Portable maturity or historical
package evidence does not grant runtime support.

For retained Resource rows, use the bounded legacy drain documented in
[Core Spec](../internal/core-spec.md#legacy-resourceform-drain): it is disabled
by default (`404`), and an authenticated operator may opt into list/read,
events/observe/delete plus TargetPool/SpacePolicy `GET`/`HEAD`/`DELETE` only.
Discovery and writes remain unavailable (`404`/`410`). Do not treat a drain
response as current Host Support or Offering availability.
