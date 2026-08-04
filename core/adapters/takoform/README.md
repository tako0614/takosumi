# Takoform host adapter

This directory is a Takosumi host implementation of the independent Takoform
Form Package contract. It is not a second definition authority.

The retained v1alpha1 and current v1alpha2 JSON Schemas are
canonical-JSON-equivalent copies of
`github.com/tako0614/terraform-provider-takoform/formpackage/schemas` at commit
`1b35d7e2005240f6c5530283c75e332ea1b64024`. Exact source and RFC 8785 digests
are recorded in `schema-provenance.json`. Update either profile only with its
owning contract and the host conformance tests.

The `application/vnd.takosumi.takoform-package-install.v1+json` object is an
internal transport envelope for immutable package-index bytes, payload bytes,
file mode evidence, and the Sigstore bundle. It owns no FormRef or package
identity: the signed RFC 8785 package index and canonical Form Definition remain
the only identities. A customer Resource request never creates this envelope,
fetches a package, changes a publisher policy, or activates a form.

The verifier fails closed on strict I-JSON, package/schema digests, Sigstore
certificate/CT/Rekor evidence, publisher identity, package closure, executable
mode or extension, unsupported media, forbidden credential/operator/commercial
fields, open or remote schema authority, and conformance fixture mismatch.

Schema validation is safe for the Cloudflare Workers runtime. Fixed FormRef,
both package-index profiles, Form Definition, and Draft 2020-12 meta-schema validators are
generated ahead of time by `bun run takoform-schema-validators:assets`; the
committed modules are self-contained and import neither Ajv nor runtime codegen.
Portable desired/observed/output/document schemas pass the generated
meta-schema and portability admission first, then use the eval-free shared
Draft 2020-12 interpreter. `bun run takoform-schema-validators:check` fails if
the generated assets are stale or regain an Ajv/runtime-codegen dependency.
