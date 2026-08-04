# Form Host Support and activation

Takosumi does not approve Forms as standards. Takoform owns the portable
specification, exact Form identity, package format, and its
Proposal/Experimental/Stable/Legacy lifecycle. Those states describe the
portable project and its published artifacts; they never grant a Takosumi host
permission to execute a Form.

Takosumi answers a different question: **can this exact host execute this exact
Form for this principal now?** The authoritative projection is
`GET /v1/form-availability` (and the equivalent Takoform host API discovery).
Each row reports independent facts for one exact installed reference:

- `definitionKnown`: the exact definition is retained;
- `installed`: its exact immutable package is installed and not revoked;
- `executable`: a compatible implementation, Adapter, and eligible TargetPool
  class are present;
- `activated`: an active operator-owned `FormActivation` pins the exact
  reference;
- `availableToPrincipal`: the activation scope and audience authorize this
  caller.

The stable `executableReason` and `availabilityReason` values explain the first
failed boundary. Unknown definitions, absent or revoked packages, missing
Adapters, inactive activations, unavailable TargetPool classes, and denied
principals fail closed. The response exposes no provider credential, manager,
capacity, price, SKU, billing, or private Target identity.

## Authority boundaries

The lifecycle is deliberately split:

```text
Takoform lifecycle and package publication
  -> Takosumi Form Registry install
  -> executable Target/Adapter evidence
  -> exact operator FormActivation
  -> principal-specific Host Support
  -> optional generic OSS Offering
  -> optional Cloud commercial binding
```

No earlier stage implies a later stage. In particular:

- a Stable or Legacy Form may be unsupported by this host;
- an Experimental Form may be enabled by an operator that accepts that risk;
- installing a package does not activate it;
- activating a Form does not publish an Offering;
- Host Support does not make a Cloud service commercially available.

`FormActivation` is an operator policy record, not a maturity label. It pins an
exact installed Form reference, scope, audience, eligible TargetPool classes,
status, and revision. Activation mutation requires the operator bearer route;
ordinary customer sessions can only read their projected availability.

## Historical package evidence

The immutable `forms/admissions/v1.0.7` tag belongs to Takoform's Legacy
history. Takosumi retains it only as a reproducible publication checkpoint.
`service-form:published-package-host-proof` reads the immutable publication
ledger from that tag, selects the nine explicitly reviewed package kinds, and
replays signature verification, install, reconstruction, and reverification.

The old artifact path and format contain the word `admission` because that was
their published historical name. Takosumi does not parse the historical
`standard-admission-set.json`, export an admission evaluator, or use it to
decide current Host Support. The last historical checkpoint therefore remains
verifiable without becoming a present-day authority.
