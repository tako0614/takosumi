# Takosumi admin provider release keys

This directory contains public verification material only. The corresponding
private key and its passphrase are operator-custodied outside every repository.
They must not be copied into GitHub Actions secrets or reused for Takoform,
Takos product releases, or another provider.

`provider-signer.json` is the reviewed identity and rotation descriptor.
`provider-signers.gpg` is the digest-pinned keyring consumed by the hermetic
tag verifier. The armored public key is provided for independent verification.

Before signing a provider tag, verify that the fingerprint, expiry, armored
key digest, keyring digest, and `provider/release/version.json` authority all
agree. Revocation or rotation requires a reviewable forward-only authority
change; an existing release tag or version path is never replaced.
