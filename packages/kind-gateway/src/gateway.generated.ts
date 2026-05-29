// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface GatewayListener {
  /** Listener protocol. */
  readonly protocol: "http" | "https";
  /** Optional requested hostname, such as `notes.example.com`. */
  readonly host?: string;
  /** TLS policy for this listener. */
  readonly tls?: "auto" | "manual" | "off";
}

export interface GatewayRoute {
  /** Listener name from `listeners`. */
  readonly listener: string;
  /** HTTP path prefix, such as `/` or `/api`. Duplicate route and dot-segment checks are descriptor semantic validation. */
  readonly path: string;
  /** Local connect binding name that supplies the upstream endpoint. */
  readonly to: string;
}

export interface GatewayRouteSummary {
  /** Materialized path prefix. */
  readonly pathPrefix: string;
  /** Connect binding target name. */
  readonly to: string;
}

export interface GatewaySpec {
  /** Named HTTP listeners. A listener may request an operator-managed host and TLS policy. */
  readonly listeners: Readonly<Record<string, GatewayListener>>;
  /** Path routing rules. Each route sends requests from a listener to one connect binding name. */
  readonly routes: readonly GatewayRoute[];
}

export interface GatewayOutputs {
  /** Public URL including scheme. */
  readonly url: string;
  /** Resolved public hostname. */
  readonly host: string;
  /** Resolved public scheme (`http` or `https`). */
  readonly scheme: "http" | "https";
  /** Listener name that produced the public endpoint. */
  readonly listener: string;
  /** Portable route summary with pathPrefix and connect binding target. */
  readonly routes: readonly GatewayRouteSummary[];
}

export type GatewayCapabilityTerm =
  | "host-routing"
  | "path-routing"
  | "wildcard"
  | "auto-tls";

export type GatewayOutputFieldName =
  | "url"
  | "host"
  | "scheme"
  | "listener"
  | "routes";

export type GatewayOutputSlotName = "public";

export type GatewayOutputSlotContract = "http-endpoint";

export interface GatewayOutputSlotDescriptor {
  readonly name: GatewayOutputSlotName;
  readonly contract: GatewayOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface GatewayListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const GATEWAY_CAPABILITY_TERMS: readonly GatewayCapabilityTerm[] = [
  "host-routing",
  "path-routing",
  "wildcard",
  "auto-tls",
];

export const GATEWAY_OUTPUT_FIELDS: readonly GatewayOutputFieldName[] = [
  "url",
  "host",
  "scheme",
  "listener",
  "routes",
];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const GATEWAY_ALIASES: readonly string[] = [
  "gateway",
];

export const GATEWAY_OUTPUT_SLOTS: readonly GatewayOutputSlotName[] = [
  "public",
];

export const GATEWAY_OUTPUT_SLOT_DESCRIPTORS:
  readonly GatewayOutputSlotDescriptor[] = [
    {
      name: "public",
      contract: "http-endpoint",
      exampleMaterialMapping: {
        "endpoints": [
          {
            "url": "$outputs.url",
            "scheme": "$outputs.scheme",
            "host": "$outputs.host",
            "listener": "$outputs.listener",
            "visibility": "public",
            "primary": true,
            "routes": "$outputs.routes",
          },
        ],
      },
    },
  ];

export const GATEWAY_LISTEN_SLOTS: readonly GatewayListenSlotDescriptor[] = [
  {
    name: "*",
    accepts: [
      "http-endpoint",
    ],
    projectionFamilies: [
      "upstream",
    ],
    requiredWhenReferencedBy: "spec.routes[].to",
  },
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
