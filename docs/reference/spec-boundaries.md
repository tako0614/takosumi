# Specification Boundaries {#spec-boundaries}

Takosumi docs use three specification surfaces. Read them as sibling contracts,
not as one merged spec. Each surface has its own reader entry point, owner, and
compatibility promise.

| Surface                        | Compatibility question it answers                                   |
| ------------------------------ | ------------------------------------------------------------------- |
| Takosumi core                  | Can this source be installed, deployed, rolled back, and recorded?  |
| Takosumi official type catalog | What kind / material / projection vocabulary does Takosumi publish? |
| Operator distribution          | What account-plane or provider behavior does this operator provide? |

The official type catalog is Takosumi-published vocabulary. It is adjacent to
the core specification, not part of the core AppSpec envelope. Operator
distributions, including Takosumi Cloud, adopt core and catalog contracts and
define their own account-plane behavior in their own docs.

## Takosumi Core Specification {#takosumi-core-specification}

Core answers: "What does an installer accept and record?" It is the portable
contract every compatible installer implements.

Reader entry: [Takosumi Core Specification](./core-spec.md).

Core owns:

- `.takosumi.yml` root shape: `apiVersion`, `metadata`, `components`
- component fields: `kind`, `spec`, `publish`, `listen`
- same-AppSpec publication references: `component.publication`
- external publication reference grammar, with the full grammar defined in
  [External Publications](./external-publications.md)
- Installation and Deployment lifecycle
- Installer API endpoints
- source input kinds and digest guards

Core parses `kind`, material contract names, projection names, and external
publication paths as strings and records resolution evidence. Catalogs define
vocabulary. Operator distributions choose which catalog entries are visible in a
Space and which implementation bindings or external publication declarations
resolve them. Concrete provider behavior, account APIs, OIDC, billing, and
dashboard flows belong to the operator distribution that composes the core
Installer contract.

Core compatibility is based on the AppSpec shape, Installer API behavior,
source/digest guards, Deployment records, and publish/listen resolution rules.
Using a Takosumi official catalog type adds catalog compatibility. Using an
operator-owned external publication path or account-plane API adds compatibility
with that operator distribution.

## Takosumi Official Type Catalog Specification {#takosumi-official-type-catalog-specification}

The official type catalog answers: "What vocabulary does Takosumi publish for
describing components and material?"

Reader entry: [Takosumi Official Type Catalog Specification](./type-catalog.md).

The catalog owns:

- kind descriptor URIs such as `https://takosumi.com/kinds/v1/worker`
- catalog descriptor metadata for `spec`, publication vocabulary, and expected
  material shape
- material contracts such as `http-endpoint`, `service-binding`, and
  `identity.oidc@v1`
- projection family descriptions such as `env`, `secret-env`, and `upstream`
- access metadata vocabulary such as access mode enum, sensitivity classes, and
  safe default access
- public JSON-LD catalog documents under
  `https://takosumi.com/contexts/v1.jsonld` and
  `https://takosumi.com/kinds/v1/*`

Catalog entries describe reusable vocabulary and JSON-LD publication metadata:
kind descriptor identities, material contract names, projection-family names,
access metadata, and portable material field shapes. Publisher roots,
account-plane URLs, billing owners, identity issuer policy, and dashboard
behavior live in the operator or product distribution spec that offers the
publication or API. An operator distribution chooses which entries are visible
in a Space, which short aliases map to them, and which implementation binding
materializes them.

## Operator Distribution Specifications {#operator-distribution-specifications}

Operator distributions answer: "What concrete account-plane, provider, and
runtime behavior does this operator provide around a Takosumi core installer?"

Takosumi Cloud is one operator distribution. Its normative docs live in
`takosumi-cloud/docs/`; the Takosumi docs site keeps only a bridge page:
[Takosumi Cloud](./takosumi-cloud.md).

Operator distribution specs own:

- account and Space ownership records
- workload external publication paths
- account-plane APIs, dashboards, and launch flows
- billing, identity, and policy behavior
- deploy/admin facades around the Installer API
- provider/runtime implementation choices and evidence retention

An operator distribution can adopt material contracts from the Takosumi official
type catalog. The catalog owns the reusable material shape; the operator docs
own the concrete path, account-plane lifecycle, approval flow, and runtime
delivery behavior.

Repository source paths for maintainers are tracked separately in
[Spec Maintenance Map](./public-spec-source-map.md).

## Placement Guide

| If a document mentions...                                                                       | Put the normative definition in... |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| `apiVersion`, `metadata`, `components`                                                          | Takosumi core / AppSpec            |
| `publish`, `listen`, `component.publication`, external publication grammar                      | Takosumi core / AppSpec            |
| `https://takosumi.com/kinds/v1/*`                                                               | Takosumi official type catalog     |
| material contracts and projection families                                                      | Takosumi official type catalog     |
| `https://takosumi.com/contexts/v1.jsonld` and `https://takosumi.com/kinds/v1/*` catalog JSON-LD | Takosumi official type catalog     |
| workload publication paths offered by an operator                                               | that operator distribution spec    |
| account APIs, billing flows, identity issuer endpoints, dashboard routes                        | that operator distribution spec    |
| deploy/admin facades around the Installer API                                                   | that operator distribution spec    |
| Vite-like plugin loading or provider package wiring                                             | reference implementation docs      |

## Read Order

1. [Takosumi Core Specification](./core-spec.md)
2. [AppSpec](./app-spec.md)
3. [Takosumi Official Type Catalog Specification](./type-catalog.md), when you
   need concrete kind or material vocabulary
4. [External Publications](./external-publications.md), when you consume
   material from outside the AppSpec
5. The operator distribution docs, when you use operator-owned account-plane
   publications or APIs. For Takosumi Cloud, start from
   [Takosumi Cloud](./takosumi-cloud.md).
