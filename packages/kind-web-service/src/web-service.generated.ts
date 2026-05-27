// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WebServiceResources {
  /** Requested CPU size or provider-specific CPU class. */
  readonly cpu?: string;
  /** Requested memory size or provider-specific memory class. */
  readonly memory?: string;
}

export interface WebServiceScale {
  /** Maximum requested replica count. */
  readonly max: number;
  /** Minimum requested replica count. */
  readonly min: number;
}

export interface WebServiceSpec {
  /** OCI image reference. */
  readonly image: string;
  /** Container listen port exposed by the service. */
  readonly port: number;
  /** Environment variables passed to the service. */
  readonly env?: Readonly<Record<string, string>>;
  /** CPU / memory hints consumed by compatible provider bindings. */
  readonly resources?: WebServiceResources;
  /** Replica bounds. `min: 0` requests zero steady replicas. Operator policy and the selected implementation materialize or reject the request. */
  readonly scale?: WebServiceScale;
}

export interface WebServiceOutputs {
  /** Implementation-local upstream URL (scheme-bearing) used by gateway/listener components. */
  readonly url: string;
  /** Implementation-local service host. */
  readonly internalHost: string;
  /** Implementation-local service port. */
  readonly internalPort: number;
}

export type WebServiceCapabilityTerm =
  | "http-service"
  | "oci-image"
  | "replica-scaling";

export type WebServiceOutputFieldName =
  | "url"
  | "internalHost"
  | "internalPort";

export type WebServiceOutputSlotName = "http";

export type WebServiceOutputSlotContract = "http-endpoint";

export interface WebServiceOutputSlotDescriptor {
  readonly name: WebServiceOutputSlotName;
  readonly contract: WebServiceOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface WebServiceListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const WEB_SERVICE_CAPABILITY_TERMS: readonly WebServiceCapabilityTerm[] =
  [
    "http-service",
    "oci-image",
    "replica-scaling",
  ];

export const WEB_SERVICE_OUTPUT_FIELDS: readonly WebServiceOutputFieldName[] = [
  "url",
  "internalHost",
  "internalPort",
];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const WEB_SERVICE_ALIASES: readonly string[] = [
  "web-service",
];

export const WEB_SERVICE_OUTPUT_SLOTS: readonly WebServiceOutputSlotName[] = [
  "http",
];

export const WEB_SERVICE_OUTPUT_SLOT_DESCRIPTORS:
  readonly WebServiceOutputSlotDescriptor[] = [
    {
      name: "http",
      contract: "http-endpoint",
      exampleMaterialMapping: {
        "targets": [
          {
            "name": "default",
            "url": "$outputs.url",
            "host": "$outputs.internalHost",
            "port": "$outputs.internalPort",
            "visibility": "private",
          },
        ],
      },
    },
  ];

export const WEB_SERVICE_LISTEN_SLOTS:
  readonly WebServiceListenSlotDescriptor[] = [
    {
      name: "*",
      accepts: [
        "http-endpoint",
        "service-binding",
        "object-store",
        "event-channel",
        "identity.oidc@v1",
        "billing.port@v1",
        "mcp-server@v1",
      ],
      projectionFamilies: [
        "env",
        "secret-env",
        "config-mount",
        "upstream",
      ],
      projectionMatrix: {
        "http-endpoint": [
          "env",
          "config-mount",
          "upstream",
        ],
        "service-binding": [
          "secret-env",
          "config-mount",
        ],
        "object-store": [
          "secret-env",
          "config-mount",
        ],
        "event-channel": [
          "secret-env",
          "config-mount",
        ],
        "identity.oidc@v1": [
          "secret-env",
          "config-mount",
        ],
        "billing.port@v1": [
          "secret-env",
          "config-mount",
        ],
        "mcp-server@v1": [
          "secret-env",
          "config-mount",
        ],
      },
    },
  ];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const WEB_SERVICE_KIND_SHAPE_ID = "web-service";
/** @deprecated Use WEB_SERVICE_KIND_URI for AppSpec kind identity, or WEB_SERVICE_KIND_SHAPE_ID for legacy Shape.id. */
export const WEB_SERVICE_KIND_ID = WEB_SERVICE_KIND_SHAPE_ID;
export const WEB_SERVICE_KIND_NAME = "web-service";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const WEB_SERVICE_KIND_URI = "https://takosumi.com/kinds/v1/web-service";
export const WEB_SERVICE_KIND_VERSION = "v1";
export const WEB_SERVICE_DESCRIPTION =
  "Long-running HTTP service backed by an OCI image.";
