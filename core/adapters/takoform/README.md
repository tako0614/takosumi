# Takoform host adapter

This directory is a Takosumi host implementation of the independent Takoform
Form Package contract. It is not a second definition authority.

The three JSON Schemas are canonical-JSON-equivalent copies of
`github.com/tako0614/terraform-provider-takoform/formpackage/schemas` at commit
`99c63161e5a321105a489f3ec19b47827dfe53b0`. Exact source and RFC 8785 digests
are recorded in `schema-provenance.json`. Update them only after the independent
project changes its contract and the host conformance tests are updated.

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
package-index, Form Definition, and Draft 2020-12 meta-schema validators are
generated ahead of time by `bun run takoform-schema-validators:assets`; the
committed modules are self-contained and import neither Ajv nor runtime codegen.
Portable desired/observed/output/document schemas pass the generated
meta-schema and portability admission first, then use the eval-free shared
Draft 2020-12 interpreter. `bun run takoform-schema-validators:check` fails if
the generated assets are stale or regain an Ajv/runtime-codegen dependency.
