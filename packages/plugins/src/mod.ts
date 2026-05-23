/**
 * Public entry point for `@takos/takosumi-plugins`.
 *
 * Phase D extracted every cloud / self-host provider wrapper out of this
 * package into dedicated `@takos/takosumi-<cloud>-providers` packages so
 * the Takosumi core distribution boots with zero cloud SDK dependency.
 * Operators import provider factories directly from those packages
 * (`@takos/takosumi-cloudflare-providers`, `@takos/takosumi-aws-providers`,
 * etc.) and pass the results to `createPaaSApp({ kindAliases, plugins })`.
 *
 * What `@takos/takosumi-plugins` still ships:
 *   - the Takos reference kind registry + JSON-LD bindings (`./kinds`)
 *   - the gateway-side request normalization helpers (`./gateway`)
 *   - the shape-provider host that the provider packages delegate to
 *     (`./shape-providers/*`)
 *
 * The shape-provider internals stay reachable via subpath imports for the
 * runtime-agent + tooling layers that still need them, but are not
 * re-exported here.
 */
export * from "./gateway/mod.ts";
export * from "./kinds/mod.ts";
