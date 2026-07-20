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

The protected main workflow accepts only the exact existing
`standard-form-runtime-v1.0.1` tag and source commit, builds the closed release
inventory from a separate tag checkout, keyless-signs the release manifest,
attests every asset, refuses overwrite, and requires repository-enforced
immutable releases. A release remains evidence material only; it does not
admit or activate any Form.
