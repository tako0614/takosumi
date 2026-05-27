# Changelog

All notable user-visible changes to the published Takosumi packages live here. Packages publish independently and remain pre-1.0 unless their own `deno.json` says otherwise.

## Unreleased — Kind Package Rebaseline

Takosumi's public contract remains AppSpec / Installation / Deployment. Component kind semantics are now owned by package-owned descriptors and operator-selected implementation bindings.

- **Package rename**: provider and adapter packages have been replaced by `@takos/takosumi-kind-*` packages. The package name now identifies the kind being imported.
- **Portable kinds**: `kind-worker`, `kind-web-service`, `kind-postgres`, `kind-object-store`, and `kind-gateway` own the official portable descriptors and generated helper types.
- **Native kinds**: backend bindings live in the sibling `takosumi-plugins` repository, in native packages such as `kind-cloudflare-worker`, `kind-aws-s3-object-store`, `kind-gcp-cloud-run-web-service`, `kind-docker-compose-web-service`, and `kind-coredns-gateway`.
- **Descriptor source**: portable descriptor source moved to `packages/kind-*/spec/kind.jsonld`; native descriptor source lives in `takosumi-plugins/packages/kind-*/spec/kind.jsonld`. The website publishes those documents at `https://takosumi.com/kinds/v1/<name>` and `https://takosumi.com/kinds/v1/<name>.jsonld`.
- **Reference binding**: the reference kernel still accepts `KernelPlugin` factories through `createPaaSApp({ kindAliases, plugins })`. That is an implementation strategy, not a Takosumi conformance requirement.
- **Umbrella package**: `@takos/takosumi` re-exports the core packages and portable kind packages. Native plugin packages are imported directly from their `@takos/takosumi-kind-*` package names.
- **Docs**: README, AGENTS, conventions, package docs, operator docs, website publish docs, and public spec maps now describe portable/native kind packages instead of provider/plugin bundles.

## Unreleased — Current AppSpec Contract

- AppSpec root is `apiVersion: "v1"`, `metadata.id`, `metadata.name`, `components`, and optional root `publish`.
- Component is `{ kind, spec, connect, listen }`.
- `apiVersion` is bare `"v1"`.
- `Component.kind` is an opaque operator-resolved alias or URI.
- `connect` is the same-AppSpec component connection model, `listen.path` consumes platform services, and root `publish` declares Installation output service path exposures.
- `component.build`, root `kind: App`, `use:` edges, placeholder interpolation, `routes`, `interfaces`, and `permissions` are not part of the contract.
- Build/prepare is owned by CI, workflow automation, or an operator build service. Prepared output is submitted to the Installer API as prepared source.
- The public Installer API remains the five `/v1/installations*` endpoints.

## Unreleased — takosumi.com Website

- `takosumi.com` is served by a single Cloudflare Pages project from `takosumi/website/`.
- The Pages artifact merges the Solid Start landing, VitePress docs under `/docs/`, JSON-LD contexts under `/contexts/`, and kind descriptors under `/kinds/v1/`.
- `website/build.sh` collects portable kind descriptors from `packages/kind-*/spec/kind.jsonld` and, when available, native descriptors from `../takosumi-plugins/packages/kind-*/spec/kind.jsonld`, then publishes both extensionless and `.jsonld` variants.

## Historical Release Notes

Earlier pre-release notes were consolidated during the kind package rebaseline. The current source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`, and package-level READMEs.
