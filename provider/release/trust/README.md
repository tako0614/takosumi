# Provider artifact transparency trust

This directory is the reviewed public trust authority for the Takosumi admin
provider artifact lane. It is independent from the OpenPGP tag signer and from
Takoform publisher policy.

`provider-publisher-policy.json` admits only keyless signatures issued by the
GitHub Actions OIDC issuer to the exact Takosumi provider release workflow on a
`provider/v*` tag. `sigstore-trusted-root.json` is a digest-pinned Sigstore
TrustedRoot used for offline Fulcio, CT log, Rekor SET, checkpoint, and Merkle
inclusion verification. Rotation is a reviewed forward-only authority change;
an existing provider release is never re-signed or replaced.
