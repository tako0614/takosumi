/**
 * Public entry point for `@takos/takosumi-plugins`. Operators consume the
 * Wave 9 Phase D `KernelPlugin` plain-array surface from `./bundled`;
 * shape-provider internals stay reachable via subpath imports for the
 * runtime-agent + tooling layers that still need them, but are not
 * re-exported here.
 */
export * from "./bundled/mod.ts";
export * from "./gateway/mod.ts";
export * from "./kinds/mod.ts";
