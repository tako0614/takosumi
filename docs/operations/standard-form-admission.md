# Standard Form admission

Installing a signed Form Package does not classify its definition as a
portable standard. In particular, the ten historical compatibility kinds do
not become standards through naming, provider schema presence, or successful
legacy state migration.

`evaluateStandardFormAdmission` consumes three already verified inputs:

1. the retained exact `FormDefinition`;
2. its installed `FormPackage` row produced by the injected
   `TakoformDataOnlyPackageVerifier`, plus that injected verifier instance's
   exact id;
3. provider-neutral `StandardFormAdmissionEvidence`.

The admission evaluator compares the retained package verifier id to the exact
injected id; it does not infer trust from an id prefix or free-form name. It
does not read package bytes, resolve a Target, execute
code, create credentials, or persist a second registry. It fails closed unless
the package verifier identity is Takoform's data-only verifier, the package and
schema digests match exactly, the signed definition status is `standard`, and
the definition exposes the complete portable lifecycle.

Evidence must include:

- explicit create/read/update/delete/import/observe/refresh/drift audit;
- immutable-field audit matching the verified definition;
- secret-free desired-state, external credential, and data-only package audit;
- Interface document and external binding-authority audit;
- at least one canonical positive desired/observed/output fixture;
- at least one negative fixture with a stable expected error code;
- exact host and provider conformance proofs covering every fixture.

Evidence rejects private or executable authority fields such as credential,
secret, provider, Target, manager, capacity, price, SKU, billing, command,
script, binary, or executable content. The structural
`conformance.provider` proof is evidence about a client implementation, not a
provider selection field.

Repository tests prove the admission evaluator and host runner. A specific Form
is not GA-approved until release-owned evidence for its exact schema digest is
available and both host and provider proofs pass. This remaining release
evidence cannot be synthesized from the legacy ten-kind compatibility set.
