/**
 * `@takosjp/takosumi-platform-services` — workload platform service
 * resolver helpers shipped with the takosumi distribution.
 *
 * The base Takosumi spec does not define OIDC or billing as component kinds.
 * Takosumi offers them as ordinary platform service paths, and this
 * package exports the resolver an operator can attach to the reference kernel.
 */
export * from "./bundled/workload-platform-services.ts";
