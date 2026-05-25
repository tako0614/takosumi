# Specification Boundaries {#specification-boundaries}

Takosumi docs are split into three specification surfaces. They are sibling contracts with different owners and compatibility promises, not one merged specification.

| Surface                | Question it answers                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Takosumi core          | Can this source be installed, deployed, rolled back, and recorded?                                        |
| Kind Catalog           | Which kind, output type, projection, and JSON-LD vocabulary does Takosumi publish?                        |
| Operator configuration | Which account management, provider, billing, identity, and dashboard behavior does this operator provide? |

The Kind Catalog is Takosumi-published vocabulary adjacent to the core spec. The core manifest structure stays small; kind definitions, output type contracts, injection modes, and JSON-LD catalog documents live in catalog docs. Operator configurations such as Takosumi Cloud adopt the core and catalog contracts, then define their own account management behavior in their own docs.

## Takosumi Core Specification {#takosumi-core-specification}

Core answers: what does the installer receive, validate, and record? It is the portable contract a compatible installer implements.

Entry point: [Core Specification](./core-spec.md)

Core defines:

- `.takosumi.yml` root structure: `apiVersion`, `metadata`, `components`
- component fields: `kind`, `spec`, `publish`, `listen`
- same-manifest published output reference: `component.publication`
- platform service reference grammar
- Installation and Deployment lifecycle
- Installer API endpoints
- source input kinds and digest guards

Core parses kind names, output type names, injection mode names, and platform service paths as strings, then records resolution details. Catalogs define kind, output type, and projection vocabulary. Operator or product distribution specs define the inventory of platform service paths.

Core compatibility is based on manifest structure, Installer API behavior, source and digest guards, Deployment records, and publish/listen resolution rules. If a manifest uses Takosumi official catalog terms, catalog compatibility also applies. If it uses operator-provided platform service paths or account management APIs, compatibility with that operator configuration also applies.

## Kind Catalog Specification {#official-type-catalog-specification}

The Kind Catalog answers: which vocabulary does Takosumi publish for describing components and output types?

Entry point: [Kind Catalog](./type-catalog.md)

The catalog defines:

- kind definition URIs such as `https://takosumi.com/kinds/v1/worker`
- kind definition metadata for `spec`, output vocabulary, and expected output format
- output types such as `http-endpoint`, `service-binding`, `identity.oidc@v1`, and `billing.port@v1`
- injection mode descriptions such as `env`, `secret-env`, and `upstream`
- access mode enum, sensitivity level, and safe default access metadata
- public JSON-LD catalog documents such as `https://takosumi.com/contexts/v1.jsonld` and `https://takosumi.com/kinds/v1/*`

A catalog entry describes reusable vocabulary and JSON-LD metadata. Publisher roots, account management URLs, billing owners, identity issuer policy, and dashboard behavior belong to the operator or product distribution that provides those services or APIs.

## Operator Configuration Specifications {#operator-distribution-specifications}

An operator configuration answers: around the Takosumi core installer, which concrete account management, provider, runtime, and admin behavior does this operator provide?

Takosumi Cloud is one operator configuration. Its normative docs live in `takosumi-cloud/docs/`; this docs site keeps only the bridge page: [Takosumi Cloud](./takosumi-cloud.md)

Operator configuration specs define:

- account and Space ownership records
- workload platform service paths
- account management APIs, dashboard, and launch flows
- billing, identity, and policy behavior
- deploy/admin facades around the Installer API
- provider/runtime implementation choices and Deployment record retention

An operator configuration can adopt output types from the official type catalog. The catalog defines reusable output formats. The operator docs define concrete platform service paths, account management lifecycle, approval flows, and runtime delivery behavior.

## Placement Guide {#placement-guide}

| A document touches this                                                        | Normative definition belongs here |
| ------------------------------------------------------------------------------ | --------------------------------- |
| `apiVersion`, `metadata`, `components`                                         | Takosumi core / manifest          |
| `publish`, `listen`, `component.publication`, platform service grammar         | Takosumi core / manifest          |
| `https://takosumi.com/kinds/v1/*`                                              | Kind Catalog                      |
| output type and injection mode vocabulary                                      | Kind Catalog                      |
| `https://takosumi.com/contexts/v1.jsonld` and catalog JSON-LD kind definitions | Kind Catalog                      |
| operator-provided workload platform service path                               | that operator configuration spec  |
| account API, billing flow, identity issuer endpoint, dashboard route           | that operator configuration spec  |
| deploy/admin facade around Installer API                                       | that operator configuration spec  |
| implementation-specific provider loading or provider package wiring            | implementation docs               |

## Reading Order {#reading-order}

1. [Core Specification](./core-spec.md)
2. [Manifest](./manifest.md)
3. [Kind Catalog](./type-catalog.md) when you need concrete kind or output type vocabulary
4. [Platform Services](./external-publications.md) when a manifest consumes output from outside the same manifest
5. Operator configuration docs when you use operator-provided account management services or APIs. Start with [Takosumi Cloud](./takosumi-cloud.md) for Takosumi Cloud.
