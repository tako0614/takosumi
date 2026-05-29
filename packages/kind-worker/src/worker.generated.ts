// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WorkerSchedule {
  /** Cron expression (5- or 6-field) for one scheduled invocation. The dialect is backend-defined and validated at apply. */
  readonly cron: string;
}

export interface WorkerSpec {
  /** Source-root-relative worker module path inside the resolved source view. */
  readonly entrypoint: string;
  /** Optional env vars / bindings. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional cron-triggered invocation schedules. Each entry names one cron expression; the resolving backend rejects unsupported cron dialects at apply. */
  readonly schedules?: readonly WorkerSchedule[];
}

export interface WorkerOutputs {
  /** Implementation-local upstream URL (scheme-bearing) used by gateway/listener components. */
  readonly url: string;
  /** Implementation-scoped worker identifier. */
  readonly id: string;
  /** Current deployed worker version. */
  readonly version?: string;
}

export type WorkerCapabilityTerm =
  | "serverless-http"
  | "scheduled";

export type WorkerOutputFieldName =
  | "url"
  | "id"
  | "version";

export type WorkerOutputSlotName = "http";

export type WorkerOutputSlotContract = "http-endpoint";

export interface WorkerOutputSlotDescriptor {
  readonly name: WorkerOutputSlotName;
  readonly contract: WorkerOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface WorkerListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const WORKER_CAPABILITY_TERMS: readonly WorkerCapabilityTerm[] = [
  "serverless-http",
  "scheduled",
];

export const WORKER_OUTPUT_FIELDS: readonly WorkerOutputFieldName[] = [
  "url",
  "id",
  "version",
];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const WORKER_ALIASES: readonly string[] = [
  "worker",
];

export const WORKER_OUTPUT_SLOTS: readonly WorkerOutputSlotName[] = [
  "http",
];

export const WORKER_OUTPUT_SLOT_DESCRIPTORS:
  readonly WorkerOutputSlotDescriptor[] = [
    {
      name: "http",
      contract: "http-endpoint",
      exampleMaterialMapping: {
        "targets": [
          {
            "name": "default",
            "url": "$outputs.url",
            "visibility": "private",
          },
        ],
      },
    },
  ];

export const WORKER_LISTEN_SLOTS: readonly WorkerListenSlotDescriptor[] = [
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
export const WORKER_KIND_SHAPE_ID = "worker";
/** @deprecated Use WORKER_KIND_URI for AppSpec kind identity, or WORKER_KIND_SHAPE_ID for legacy Shape.id. */
export const WORKER_KIND_ID = WORKER_KIND_SHAPE_ID;
export const WORKER_KIND_NAME = "worker";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const WORKER_KIND_URI = "https://takosumi.com/kinds/v1/worker";
export const WORKER_KIND_VERSION = "v1";
export const WORKER_DESCRIPTION =
  "Serverless JS function whose entrypoint is read from the resolved source view.";
