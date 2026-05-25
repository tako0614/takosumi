// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/gateway.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface GatewayListener {
  /** Listener protocol. */
  readonly protocol: "http" | "https";
  /** Optional requested hostname, such as `notes.example.com`. */
  readonly host?: string;
  /** TLS policy for this listener. */
  readonly tls?: "auto" | "manual" | "off";
  readonly [extension: string]: unknown;
}

export interface GatewayRoute {
  /** Listener name from `listeners`. */
  readonly listener: string;
  /** HTTP path prefix, such as `/` or `/api`. Duplicate route and segment-boundary checks are descriptor semantic validation. */
  readonly path: string;
  /** Local listen binding name that supplies the upstream endpoint. */
  readonly to: string;
  readonly [extension: string]: unknown;
}

export interface GatewaySpec {
  /** Named HTTP listeners. A listener may request an operator-managed host and TLS policy. */
  readonly listeners: Readonly<Record<string, GatewayListener>>;
  /** Path routing rules. Each route sends requests from a listener to one listen binding name. */
  readonly routes: readonly GatewayRoute[];
  readonly [extension: string]: unknown;
}

export interface GatewayOutputs {
  /** Public URL including scheme. */
  readonly url: string;
  /** Resolved public hostname. */
  readonly host: string;
  /** Resolved public scheme (`http` or `https`). */
  readonly scheme: string;
  /** Listener name that produced the public endpoint. */
  readonly listener: string;
  /** Portable route summary with pathPrefix and listen binding target. */
  readonly routes: readonly Record<string, unknown>[];
}

export type GatewayCapabilityTerm =
  | "host-routing"
  | "path-routing"
  | "wildcard"
  | "auto-tls"
  | "sni"
  | "alpn-acme"
  | "http3"
  | "redirects";

export type GatewayPublicationName = "public";

export const GATEWAY_CAPABILITY_TERMS: readonly GatewayCapabilityTerm[] = [
  "host-routing",
  "path-routing",
  "wildcard",
  "auto-tls",
  "sni",
  "alpn-acme",
  "http3",
  "redirects",
];

export const GATEWAY_OUTPUT_FIELDS: readonly string[] = [
  "url",
  "host",
  "scheme",
  "listener",
  "routes",
];

// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.
export const GATEWAY_ALIASES: readonly string[] = [
  "gateway",
];

export const GATEWAY_PUBLICATIONS: readonly GatewayPublicationName[] = [
  "public",
];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const GATEWAY_KIND_SHAPE_ID = "gateway";
/** @deprecated Use GATEWAY_KIND_URI for AppSpec kind identity, or GATEWAY_KIND_SHAPE_ID for legacy Shape.id. */
export const GATEWAY_KIND_ID = GATEWAY_KIND_SHAPE_ID;
export const GATEWAY_KIND_NAME = "gateway";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const GATEWAY_KIND_URI = "https://takosumi.com/kinds/v1/gateway";
export const GATEWAY_KIND_VERSION = "v1";
export const GATEWAY_DESCRIPTION =
  "HTTP listener, TLS, and routing component. A gateway listens to local upstream bindings, carries listener/domain requests in spec, and publishes the public HTTP endpoint it materializes. Operator policy and the selected implementation materialize or reject those requests.";
