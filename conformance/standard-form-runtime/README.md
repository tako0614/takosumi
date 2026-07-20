# Standard Form host-conformance runtime artifacts

This directory contains the Takosumi-owned executable fixtures used only to
exercise a real portable-host lifecycle. It is not part of a Takoform Form
Package and grants no host, target, capacity, billing, or admission authority.

`v1.0.1` closes over two local modules and one external OCI manifest:

- a minimal EdgeWorker module;
- a minimal DurableWorkflow module with the `IngestWorkflow` entrypoint;
- the public Docker Hub `linux/amd64` nginx manifest pinned by exact digest for
  the ContainerService lifecycle.

The candidate gate checks the local byte closure and can perform a live OCI
registry readback:

```bash
bun run service-form:runtime-artifacts:check
bun run service-form:runtime-artifacts:oci-readback
```

The main workflow is assigned to the `standard-form-runtime-release`
environment, but is deliberately fail-closed before checkout or any release
mutation while its fixed adapter and evidence envelope remain unregistered in
the ecosystem release-safety registry. Once that registration is reviewed, the
workflow accepts only the exact existing
`standard-form-runtime-v1.0.1` tag and source commit, builds the closed release
inventory from a separate tag checkout, emits a deterministic SPDX 2.3 SBOM
covering both JavaScript modules and the pinned external OCI manifest,
keyless-signs the release manifest, attests every asset plus the SBOM, refuses
overwrite, and requires repository-enforced immutable releases. The SBOM digest
is part of the release manifest and `SHA256SUMS` closure. A release remains
evidence material only; it does not admit or activate any Form.
