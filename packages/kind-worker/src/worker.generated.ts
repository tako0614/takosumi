// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WorkerSpec {
  /** Source-root-relative worker module path inside the resolved source view. */
  readonly entrypoint: string;
  /** Optional env vars / bindings. */
  readonly env?: Readonly<Record<string, string>>;
  readonly [extension: string]: unknown;
}

export interface WorkerOutputs {
  /** Provider-local upstream URL (scheme-bearing) used by gateway/listener components. */
  readonly url: string;
  /** Provider-scope worker identifier. */
  readonly id: string;
  /** Current deployed worker version. */
  readonly version?: string;
}

export type WorkerCapabilityTerm =
  | "scale-to-zero"
  | "long-request"
  | "geo-routing";

export type WorkerPublicationName = "http";

export type WorkerPublicationContract = "http-endpoint";

export interface WorkerPublicationDescriptor {
  readonly name: WorkerPublicationName;
  readonly contract: WorkerPublicationContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export const WORKER_CAPABILITY_TERMS: readonly WorkerCapabilityTerm[] = [
  "scale-to-zero",
  "long-request",
  "geo-routing",
];

export const WORKER_OUTPUT_FIELDS: readonly string[] = [
  "url",
  "id",
  "version",
];

// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.
export const WORKER_ALIASES: readonly string[] = [
  "worker",
];

export const WORKER_PUBLICATIONS: readonly WorkerPublicationName[] = [
  "http",
];

export const WORKER_PUBLICATION_DESCRIPTORS:
  readonly WorkerPublicationDescriptor[] = [
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
