# Service Form compatibility state inventory

Resource Shape API/provider/state aliases cannot be removed from evidence that
only inspects this repository. Before deciding a support window, an operator
must inventory every OpenTofu/Terraform state and dependency lock file that it
is authorized to inspect.

Run the inventory offline, in the environment that owns the state:

```bash
bun run service-form:compat-inventory -- \
  --state /operator/path/terraform.tfstate \
  --lock /operator/path/.terraform.lock.hcl \
  --output /operator/evidence/service-form-compatibility-inventory.json
```

`--state` and `--lock` are repeatable. The output file is created with
no-overwrite semantics. The report contains only:

- a SHA-256 digest and input class for each inspected file;
- Takosumi/Takoform provider addresses, versions, constraints, and lock hashes;
- compatibility-relevant resource type, provider address, managed/data mode,
  class, and instance count; and
- counts of unrelated resources/providers without their names.

The report never copies Resource attributes, IDs, names, provider configuration,
state lineage/serial, secret values, local input paths, or unrelated provider
identities. Keep the original state and the report in operator-controlled
evidence storage; neither belongs in this repository.

An empty legacy-state result is not permission to remove an alias. A removal
decision still requires a measured external usage observation window, an
announced minimum support window, no-op state/provider migration fixtures, and
tested rollback artifacts. The report therefore always emits
`removalDecision.eligible: false`; it is one evidence input, not release
authority.
