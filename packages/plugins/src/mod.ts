/**
 * Compatibility entry point for `@takos/takosumi-plugins`.
 *
 * Phase D extracted provider / external adapter wrappers out of this package
 * into dedicated `@takos/takosumi-<cloud>-providers` and
 * `@takos/takosumi-plugin-<kind>-<backend>` packages so the reference
 * package/server path boots with zero cloud SDK dependency. Operators import
 * provider factories directly from those packages
 * (`@takos/takosumi-cloudflare-providers`, `@takos/takosumi-aws-providers`,
 * etc.) and pass the results to `createPaaSApp({ kindAliases, plugins })`.
 *
 * The documented official helper surface is `./kinds`. The root also re-exports
 * compatibility/reference-kernel helpers for existing operator code.
 *
 * What `@takos/takosumi-plugins` still ships:
 *   - takosumi.com official catalog descriptor helpers (`./kinds`)
 *   - the reference-kernel gateway-side request normalization helpers (`./gateway`)
 *   - the shape-provider host that the provider packages delegate to
 *     (`./shape-providers/*`)
 *
 * The shape-provider internals stay reachable via subpath imports for the
 * runtime-agent + tooling layers that still need them, but are not
 * re-exported here.
 */
// Reference-kernel helper re-export. The official catalog surface is `./kinds`
// and the published JSON-LD descriptors, not this gateway helper API.
export * from "./gateway/mod.ts";
export * from "./kinds/mod.ts";
