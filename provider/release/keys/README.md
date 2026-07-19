# Retained Takosumi provider verification keys

This directory contains historical public verification material only. Provider
publication is discontinued and no signing operation is authorized. Any old
private key and passphrase remain operator-custodied outside every repository;
they must not be copied into GitHub Actions secrets or reused for Takoform,
Takos product releases, or another provider.

`provider-signer.json` is the historical identity and rotation descriptor.
`provider-signers.gpg` is the digest-pinned keyring that was consumed by the
removed tag verifier. The armored public key remains only for independent
verification of retained evidence.

The fingerprint, expiry, armored-key digest, and keyring digest are kept so
historical evidence remains independently verifiable. No new provider tag or
version path may be signed, created, or replaced.
