// Canonical cross-product Interface protocol tokens.
//
// Core keeps `Interface.spec.document` opaque: protocol consumers validate
// their own type-specific document shape. The `spec.type` / `spec.version`
// strings and the well-known permission tokens, however, are shared wire
// vocabulary: producers (install-config blueprints, installed apps) and
// consumers (Takos worker, dashboard) must agree on the exact literals or an
// Interface silently disappears from every exact-match consumer filter.
// These tokens therefore live once on the contract surface. Do not redefine
// them in a product; import them from `takosumi-contract` (or the
// `takosumi-contract/interface-types` subpath) instead.
//
// Bumping a version constant here is a coordinated protocol change: every
// consumer that exact-matches the old version stops seeing the Interface, so
// ship producer and consumer updates together.

/** `spec.type` of an MCP server runtime Interface. */
export const MCP_SERVER_INTERFACE_TYPE = "mcp.server" as const;
/** MCP protocol revision carried in `spec.version` for `mcp.server`. */
export const MCP_SERVER_INTERFACE_VERSION = "2025-11-25" as const;
/** Permission token consumers request to invoke an MCP server. */
export const MCP_SERVER_INVOKE_PERMISSION = "mcp.invoke" as const;

/** `spec.type` of a launcher / embedded UI surface Interface. */
export const UI_SURFACE_INTERFACE_TYPE = "interface.ui.surface" as const;
/** `spec.version` for `interface.ui.surface`. */
export const UI_SURFACE_INTERFACE_VERSION = "1" as const;
/** Permission token consumers request to open a UI surface. */
export const UI_SURFACE_OPEN_PERMISSION = "ui.open" as const;

/** `spec.type` of a file-handler Interface. */
export const FILE_HANDLER_INTERFACE_TYPE = "interface.file.handler" as const;
/** `spec.version` for `interface.file.handler`. */
export const FILE_HANDLER_INTERFACE_VERSION = "1" as const;
/** Permission token consumers request to open a file with a handler. */
export const FILE_HANDLER_OPEN_PERMISSION = "file.open" as const;

/**
 * `spec.type` of the canonical public route Interface a scoped compatibility
 * profile controls for a Ready edge Resource. It lives here with the rest of
 * the shared wire vocabulary rather than inside the profile implementation.
 */
export const COMPATIBILITY_ROUTE_INTERFACE_TYPE = "http.route" as const;
/** `spec.version` for `http.route`. */
export const COMPATIBILITY_ROUTE_INTERFACE_VERSION = "v1alpha1" as const;
/** Permission token consumers request to reach a public route. */
export const COMPATIBILITY_ROUTE_PERMISSION = "edge.request" as const;

// This registry is descriptive, never an allowlist. Core stores, resolves, and
// reads unknown type/version pairs, and per ADR 0002 the declared type
// namespace is open: anyone may define their own type with their own document
// schema without registering it here.
