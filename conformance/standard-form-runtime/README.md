# Standard Form host-conformance runtime artifacts

This directory contains the Takosumi-owned executable fixtures used only to
exercise a real portable-host lifecycle. It is not part of a Takoform Form
Package and grants no host, target, capacity, billing, or admission authority.

Runtime release `v1.0.3` closes over two local modules and one external OCI
manifest for the still-unpublished Takoform Form Package `1.0.1` / provider
`0.1.1` evidence set:

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

The ecosystem release-safety registry now owns this exact surface and its fixed
adapter. The workflow has two fail-closed `workflow_dispatch` phases and accepts
only the signed annotated `standard-form-runtime-v1.0.3` tag and its exact source
commit. `candidate` runs the full quality gate, builds the release bytes once,
emits the deterministic SPDX 2.3 SBOM, keyless-signs the release manifest,
attests the assets and SBOM, and uploads one closed Actions artifact without
creating a release.

After staging and a fresh host replica have exercised that exact ordered digest
set, the root controller seals the private evidence envelope and technical
authorization. Its fixed adapter alone dispatches `promote` with the candidate
run id and bound digests. Promotion runs in the
`standard-form-runtime-release` environment and must start within five minutes
of the controller dispatch. The protected environment must carry the exact
per-release controller authorization digest; a direct or replayed dispatch
cannot substitute a syntactically valid value. It also carries a ruleset audit
credential that GitHub permits to read repository settings, including the
otherwise omitted `bypass_actors` field; the workflow uses that credential only
for the immutable-release readback and two ruleset reads. The repository must
have immutable releases enabled and an active, no-bypass tag ruleset named
`standard-form-runtime-release-tags` that denies update and deletion for only
`refs/tags/standard-form-runtime-v*`.

Promotion downloads and revalidates the candidate, verifies its tagged Sigstore
identity and GitHub attestation before mutation, contains no build path, refuses
overwrite or clobber, and publishes only the same bytes plus
`release-safety-readback.json`. The tag signature and exact peeled commit are
checked again immediately before finalization and after publication. The
successful workflow and adapter both read the stable release back, require
repository-enforced immutability, verify the tagged Sigstore identity and GitHub
attestation, and bind the passed checks to the envelope. The SBOM digest is part
of the candidate and `SHA256SUMS` closure. A release remains evidence material
only; it does not admit or activate any Form.
