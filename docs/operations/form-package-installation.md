# Installing signed Takoform Form Packages

This runbook covers the optional Takosumi OSS Form Registry host. Takoform owns
the portable FormRef, Form Definition, data-only Form Package, signature
profile, and conformance contract. Takosumi only reads a package selected by an
operator, verifies it, retains its exact identity, and installs that identity in
the existing Form Registry. Plain OpenTofu Stack operation remains zero-form.

## Preconditions

Obtain all release assets from an immutable Takoform or separately approved
publisher release:

- `package-index.json` and every payload it lists;
- the `application/vnd.dev.sigstore.bundle.v0.3+json` keyless blob bundle for
  the RFC 8785 package index;
- the offline Sigstore TrustedRoot JSON selected by operator policy; and
- the independently published provenance, SBOM, and revocation view used by
  the operator release process.

Do not install the current unsigned legacy compatibility packages. They are
fixtures, not production package releases. A customer request path must never
download a package or edit trust policy.

## Workers / D1 composition

Stage the immutable internal install envelope and TrustedRoot in a dedicated
R2 bucket. The envelope carries the exact base64 package-index bytes, a closed
list of `{ path, mode, contentBase64 }` payloads, and the Sigstore bundle. It is
transport only; archive or envelope bytes are not package identity.

Bind the bucket as `R2_FORM_PACKAGES` and set the non-secret policy JSON:

```json
{
  "schemaVersion": 1,
  "artifactPrefix": "packages/",
  "trustedRoot": {
    "key": "trust/sigstore-public-good-root.json",
    "digest": "sha256:<exact-trusted-root-digest>"
  },
  "publishers": [
    {
      "oidcIssuer": "https://token.actions.githubusercontent.com",
      "sourceRepository": "tako0614/terraform-provider-takoform",
      "workflow": ".github/workflows/form-package-release.yml",
      "tagPattern": "refs/tags/forms/*/v*"
    }
  ]
}
```

Set that document as `TAKOSUMI_FORM_PACKAGE_TRUST_POLICY`. The stock platform
composition requires the bucket and policy together. Operators with a custom
store may inject the code-only `TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION` reader /
verifier object instead; a serialized object is rejected.

The operator-only in-process operation calls
`operations.forms.installPackage({ artifactRef: "r2:packages/<asset>",
expectedPackageDigest, actorId })`. It verifies before the D1 transaction. No
public customer mutation route is implied by this composition.

## Bun / Node + Postgres composition

Use `createNodeTakoformPackageHostComposition` with an absolute, private,
immutable-staging directory, relative package and TrustedRoot paths, an exact
TrustedRoot digest, and the same explicit publisher list. Artifact references
use `file:<relative-path>`. The reader resolves under the approved root, rejects
escape and final symlinks, opens with `O_NOFOLLOW`, bounds bytes, and fences a
file changed during the read. Pass the policy through
`ComposedAppInput.takoformPackageTrustPolicy`; explicit custom reader/verifier
ports remain available for other substrates.

## Verification and lifecycle

Installation succeeds only after strict I-JSON/RFC 8785 digest checks,
certificate and transparency verification, exact publisher matching, payload
closure and byte digests, schema validation, data-only policy, executable
mode/extension rejection, and exact FormRef reconstruction. The resulting
package/definition rows are append-only retained evidence. Deprecation or
revocation blocks new admission but does not remove bytes required for
observe/delete/recovery.

After staging, prove an operator-driven install against both the selected
database and artifact store, restart the host, re-verify the retained identity,
and record the exact package digest and actor audit evidence. FormActivation,
an executable implementation, and any Cloud ServiceOffering remain separate
operations.

Production activation is blocked until the independent project publishes a
real signed package and the operator pins its current TrustedRoot, package
digest, provenance, SBOM, and revocation evidence. This repository intentionally
contains no production signing key, package signature, or implicit activation.
