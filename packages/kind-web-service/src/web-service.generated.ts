// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WebServiceScale {
  readonly max: number;
  readonly min: number;
}

export interface WebServiceResources {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface WebServiceSpec {
  /** OCI image reference. */
  readonly image: string;
  /** Container listen port exposed by the service. */
  readonly port: number;
  /** Replica bounds. `min: 0` requests scale-to-zero. Operator policy and the selected implementation materialize or reject the request. */
  readonly scale: WebServiceScale;
  /** Environment variables passed to the service. */
  readonly env?: Readonly<Record<string, string>>;
  /** CPU / memory hints consumed by compatible provider bindings. */
  readonly resources?: WebServiceResources;
  readonly [extension: string]: unknown;
}

export interface WebServiceOutputs {
  /** Provider-local upstream URL (scheme-bearing) used by gateway/listener components. */
  readonly url: string;
  /** Provider-local service host. */
  readonly internalHost: string;
  /** Provider-local service port. */
  readonly internalPort: number;
}

export type WebServiceCapabilityTerm =
  | "always-on"
  | "scale-to-zero"
  | "websocket"
  | "long-request"
  | "sticky-session"
  | "geo-routing"
  | "crons"
  | "private-networking";

export type WebServicePublicationName = "http";

export type WebServicePublicationContract = "http-endpoint";

export interface WebServicePublicationDescriptor {
  readonly name: WebServicePublicationName;
  readonly contract: WebServicePublicationContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export const WEB_SERVICE_CAPABILITY_TERMS: readonly WebServiceCapabilityTerm[] =
  [
    "always-on",
    "scale-to-zero",
    "websocket",
    "long-request",
    "sticky-session",
    "geo-routing",
    "crons",
    "private-networking",
  ];

export const WEB_SERVICE_OUTPUT_FIELDS: readonly string[] = [
  "url",
  "internalHost",
  "internalPort",
];

// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.
export const WEB_SERVICE_ALIASES: readonly string[] = [
  "web-service",
];

export const WEB_SERVICE_PUBLICATIONS: readonly WebServicePublicationName[] = [
  "http",
];

export const WEB_SERVICE_PUBLICATION_DESCRIPTORS:
  readonly WebServicePublicationDescriptor[] = [
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
