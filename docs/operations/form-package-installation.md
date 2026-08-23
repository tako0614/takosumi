# Form package installation (superseded)

> Takosumi OSS no longer hosts a Form Registry or installs portable Form
> Packages. The former package-reader, trust-root, FormActivation, and
> operator-install procedure is retained only as historical migration evidence.

The supported OSS deployment is a Git/OpenTofu/Terraform Stack using ordinary
providers. Takoform owns package publication and signatures. A hosted Form
installation, executable implementation, activation/audience policy, target
selection, and backend lifecycle belong to Takosumi hosted service or another external
Host; follow that Host's private runbook and authority checks.

Do not set a package trust policy to make an OSS Form surface appear. The
`TAKOSUMI_FORM_PACKAGE_TRUST_POLICY` and `R2_FORM_PACKAGES` names are retained
implementation/migration vocabulary only and are not a supported OSS
installation path. Installation never follows `latest`, creates an Offering,
or authorizes a Resource.

Old Resource rows may require exact `FormRef` and `packageDigest` evidence for
observe/delete/recovery. Keep that evidence immutable and operator-private;
use the [exact-FormRef migration note](./exact-formref-migration.md) rather
than attempting a new package install.
