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

Retained Resource rows are migration data only. The former `/v1` Resource,
TargetPool, and SpacePolicy HTTP families are unconditionally retired (`404`)
with no drain flag or CLI caller. Use typed in-process operations or the
owning external Host for any migration; do not treat an HTTP response as
current Host Support or Offering availability.
