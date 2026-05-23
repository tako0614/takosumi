// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/web-service.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

import type { Artifact } from "takosumi-contract";

export interface WebServiceScale {
  readonly max: number;
  readonly min: number;
}

export interface WebServiceResources {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface WebServiceSpec {
  /** Container listen port exposed by the service. */
  readonly port: number;
  /** Replica bounds. `min: 0` requests scale-to-zero when the chosen provider supports it. */
  readonly scale: WebServiceScale;
  /** Resolved artifact descriptor. `oci-image` artifacts typically use `uri`; other provider-supported kinds may use `hash`. */
  readonly artifact?: Artifact;
  /** Provider-specific binding references. */
  readonly bindings?: Readonly<Record<string, string>>;
  /** Environment variables passed to the service. */
  readonly env?: Readonly<Record<string, string>>;
  /** OCI image shorthand for `artifact: { kind: "oci-image", uri: image }`. */
  readonly image?: string;
  /** Provider-portable CPU / memory hints. */
  readonly resources?: WebServiceResources;
  readonly [extension: string]: unknown;
}

export interface WebServiceOutputs {
  /** Allocated public URL (scheme-bearing). */
  readonly url: string;
  /** Provider-local service host. */
  readonly internalHost: string;
  /** Provider-local service port. */
  readonly internalPort: number;
}

export type WebServiceCapability =
  | "always-on"
  | "scale-to-zero"
  | "websocket"
  | "long-request"
  | "sticky-session"
  | "geo-routing"
  | "crons"
  | "private-networking";

export type WebServicePublishesTo = "<app-id>.<component-name>";

export type WebServiceListensFrom = "<sibling-namespace-path>";

export const WEB_SERVICE_CAPABILITIES: readonly WebServiceCapability[] = [
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

export const WEB_SERVICE_ALIASES: readonly string[] = [
  "web-service",
];

export const WEB_SERVICE_PUBLISHES_TO: readonly WebServicePublishesTo[] = [
  "<app-id>.<component-name>",
];

export const WEB_SERVICE_LISTENS_FROM: readonly WebServiceListensFrom[] = [
  "<sibling-namespace-path>",
];

export const WEB_SERVICE_KIND_ID = "web-service";
export const WEB_SERVICE_KIND_VERSION = "v1";
export const WEB_SERVICE_DESCRIPTION =
  "Long-running HTTP service backed by an OCI image or equivalent artifact.";
