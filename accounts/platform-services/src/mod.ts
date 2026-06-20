/**
 * `@takosjp/takosumi-platform-services` — platform service resolver helpers
 * shipped with the takosumi distribution.
 *
 * The base Takosumi spec does not define OIDC or billing as component kinds.
 * Takosumi offers them as ordinary platform service paths, and this
 * package exports resolvers an operator can attach to the Takosumi service.
 */
export * from "./bundled/service-graph-material-resolver.ts";
export * from "./opentofu-output-resolver.ts";
