# Standard Form host-conformance runtime fixtures

This directory retains the Takosumi-owned executable fixtures used by portable
host conformance. They are not a Form Package, a Takosumi platform release, or
a publication lane, and they grant no host, target, capacity, billing, or
admission authority.

The retained `v1.0.3` manifest closes over:

- a minimal EdgeWorker module;
- a minimal DurableWorkflow module with the `IngestWorkflow` entrypoint; and
- the public Docker Hub `linux/amd64` nginx manifest pinned by exact digest for
  the ContainerService lifecycle fixture.

The local check verifies the exact committed byte closure. The optional OCI
readback also checks the retained registry manifest:

```bash
bun run service-form:runtime-artifacts:check
bun run service-form:runtime-artifacts:oci-readback
```

These commands do not build an SBOM, create a release candidate, sign bytes,
dispatch a workflow, publish a tag or release, or emit promotion evidence. The
former runtime release workflow and its release-artifact builders were retired;
Takosumi's product release is the source/module release described in
`docs/operations/takosumi-v1-release.md`.
