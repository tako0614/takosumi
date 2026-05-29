// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WebServiceHealthCheck {
  /** Seconds between health probes. */
  readonly interval?: number;
  /** HTTP path probed for liveness, such as `/healthz`. */
  readonly path?: string;
  /** HTTP path probed for readiness before the instance receives traffic, such as `/readyz`. */
  readonly readinessPath?: string;
  /** Seconds to wait for a single probe response before it counts as a failure. */
  readonly timeout?: number;
  /** Consecutive failed probes before the instance is treated as unhealthy. */
  readonly unhealthyThreshold?: number;
}

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

export interface WebServiceVolume {
  /** Logical volume name or URI resolved by the operator / implementation binding (backend-neutral). */
  readonly source: string;
  /** Absolute container mount path, such as `/var/lib/data`. */
  readonly target: string;
  /** Whether the volume must survive instance restarts. Omitted means the implementation binding decides. */
  readonly persistent?: boolean;
}

export interface WebServiceSpec {
  /** OCI image reference. */
  readonly image: string;
  /** Container listen port exposed by the service. */
  readonly port: number;
  /** Environment variables passed to the service. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional container-subset health probe hint. Container backends use it to gate readiness and restart unhealthy instances; non-container backends (such as the divergent systemd binding) ignore or reject it at apply. */
  readonly healthCheck?: WebServiceHealthCheck;
  /** CPU / memory hints consumed by compatible provider bindings. */
  readonly resources?: WebServiceResources;
  /** Replica bounds. `min: 0` requests zero steady replicas. Operator policy and the selected implementation materialize or reject the request. */
  readonly scale?: WebServiceScale;
  /** Optional container-subset volume mounts. Container backends attach each logical volume at the given mount path; non-container backends (such as the divergent systemd binding) ignore or reject them at apply. */
  readonly volumes?: readonly WebServiceVolume[];
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
  | "replica-scaling"
  | "container-health-check"
  | "persistent-volume";

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
    "container-health-check",
    "persistent-volume",
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
  "Long-running HTTP service. `image` and `scale` are optional container-subset fields; the divergent systemd binding of this kind uses only `port` plus its own command and omits container-only fields. `healthCheck` and `volumes` are likewise OPTIONAL container-subset hints: backends that do not run containers (such as systemd) ignore or reject them at apply, exactly like the existing optional `image` and `scale`. `healthCheck.interval` and `healthCheck.timeout` are in SECONDS. `volumes[].source` is a logical, operator/binding-resolved volume name or URI (backend-neutral) and `volumes[].target` is an absolute container mount path.";
